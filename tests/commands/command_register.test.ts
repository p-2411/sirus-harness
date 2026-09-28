import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, statSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach } from 'bun:test';
import {
  commandMenu,
  commandRegistry,
  executeCommand,
  matchCommands,
  parseCommandLine,
  promptContent,
  splitPrompt,
  vendorCommandFor,
  type CommandMenuItem,
  type CommandSession,
} from '../../src/commands/registry';
import { nativePrompt, rememberNativeCommands, type NativeCommand } from '../../src/agent_runtime/runtime/commands';
import { nextPermissionMode } from '../../src/agent_runtime/permissions/policy';
import { THINKING_LEVELS } from '../../src/agent_runtime/types';
import { loginMenuItems } from '../../src/commands/authentication/behavior';
import { Session } from '../../src/agent_runtime/session';
import { providerFor } from '../../src/agent_runtime/providers';
import { resolveModelReference } from '../../src/commands/agents/behavior';
import { MODELS, VENDORS, rememberListedModels } from '../../src/agent_runtime/providers/catalog';
import type { SubagentRun } from '../../src/agent_runtime/tools/subagents';
import type { Feedback } from '../../src/commands/feedback';
import { openSettings } from '../../src/persistence/settings';
import { bindScriptedRuntime, textTurn, unbindRuntime } from '../support/runtime';
import { backgroundTaskFrom, type BackgroundTask } from '../../src/agent_runtime/runtime/runtime';
import { rememberModelFacts } from '../../src/agent_runtime/providers/catalog';
import { closeAllMemoryStores, openMemoryStore } from '../../src/memory/store';

function runCommand(
  command: string,
  args: string[],
  session: CommandSession = new Session(),
) {
  return executeCommand(command, args, {
    session,
    notify: () => {},
    attachImage: () => {},
    exit: () => {},
    signal: new AbortController().signal,
  });
}

// Both vendors signed in with API keys, so the model picker offers both.
function signIn(): void {
  providerFor('claude').sources.addApiKey('sk-ant-model-menu-1234');
  providerFor('gpt').sources.addApiKey('sk-proj-model-menu-1234');
}

function syncCommandMenu(...args: Parameters<typeof commandMenu>) {
  const menu = commandMenu(...args);
  if (menu instanceof Promise) throw new Error('Expected a synchronous command menu');
  return menu;
}

function menuItems(command: string, args: readonly string[]): CommandMenuItem[] {
  return syncCommandMenu(command, args, new Session())?.filter(
    (entry): entry is CommandMenuItem => entry.type === 'item',
  ) ?? [];
}

function seedVendorModels(): void {
  for (const vendor of VENDORS) {
    rememberListedModels(vendor, MODELS.filter(model => model.vendor === vendor)
      .map(model => ({ id: model.id, description: model.profile.strengths })));
  }
}

describe('matchCommands', () => {
  test('bare slash lists every command', () => {
    const all = matchCommands('/');
    expect(all.length).toBeGreaterThan(0);
    expect(all.map(c => c.name)).toContain('model');
    expect(all.map(c => c.name)).toContain('memory');
    expect(all.map(c => c.name)).toContain('thinking');
    expect(all.map(c => c.name)).toContain('update');
    expect(all.map(c => c.name)).toContain('doctor');
  });

  test('filters by typed prefix', () => {
    expect(matchCommands('/mod').map(c => c.name)).toEqual(['model']);
    expect(matchCommands('/model')[0].args).toBe('[agent|subagent] <model> [thinking]');
  });

  test('returns nothing for a non-matching prefix', () => {
    expect(matchCommands('/zzz')).toEqual([]);
  });

  test('returns nothing for plain text or empty input', () => {
    expect(matchCommands('hello')).toEqual([]);
    expect(matchCommands('')).toEqual([]);
  });

  test('closes once args are being typed', () => {
    expect(matchCommands('/model ')).toEqual([]);
    expect(matchCommands('/model gpt')).toEqual([]);
  });

  test('routes the vendors\' commands by name or vendor prefix, running the ones that only report aside', () => {
    const commands: NativeCommand[] = [
      { name: 'context', description: 'Show current context usage', invocation: '/context', vendor: 'claude' },
      { name: 'mcp', description: 'Manage MCP servers', invocation: '/mcp', vendor: 'claude' },
      { name: 'agents', description: 'Manage agents', invocation: '/agents', vendor: 'claude' },
      { name: 'status', description: 'Display session configuration', invocation: '/status', vendor: 'gpt' },
    ];
    expect(vendorCommandFor('/context', commands)).toMatchObject({ vendor: 'claude', reporting: true, args: '' });
    // Sirus's /mcp and /agents win the bare names; the prefix reaches Claude's.
    expect(vendorCommandFor('/mcp', commands)).toBeNull();
    expect(vendorCommandFor('/claude:mcp', commands)).toMatchObject({ reporting: true });
    expect(vendorCommandFor('/claude:mcp reconnect github', commands)).toMatchObject({ reporting: false, args: 'reconnect github' });
    expect(vendorCommandFor('/claude:agents', commands)).toMatchObject({ vendor: 'claude', reporting: false });
    expect(vendorCommandFor('/codex:status', commands)).toMatchObject({ vendor: 'gpt', reporting: true });
    expect(vendorCommandFor('/codex:context', commands)).toBeNull();
    expect(matchCommands('/age', commands).map(match => [match.name, match.vendor])).toEqual([
      ['agents', undefined], ['claude:agents', 'claude'],
    ]);
  });

  test('sends Sirus\'s /init and /review, and a prefixed vendor command, in the words the participant reads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-native-prompt-'));
    const previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    try {
      rememberNativeCommands('gpt', directory, [
        { name: 'review', description: 'Review changes', invocation: '/review' },
        { name: 'skill', description: 'A skill', invocation: '$skill' },
      ]);
      rememberNativeCommands('claude', directory, [{ name: 'agents', description: 'Manage agents', invocation: '/agents' }]);
      expect(nativePrompt('/init keep it short', 'claude', directory)).toStartWith('Set up this repository\'s agent instructions');
      expect(nativePrompt('/init keep it short', 'claude', directory)).toEndWith('The user added: keep it short');
      // Codex runs its own dedicated review; Claude gets Sirus's prompt.
      expect(nativePrompt('/review the parser', 'gpt', directory)).toBe('/review the parser');
      expect(nativePrompt('/review', 'claude', directory)).toStartWith('Review the current code changes');
      expect(nativePrompt('/claude:agents list them', 'claude', directory)).toBe('/agents list them');
      expect(nativePrompt('/codex:skill go', 'gpt', directory)).toBe('$skill go');
      expect(nativePrompt('/claude:init', 'claude', directory)).toBe('/claude:init');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('/init leaves CLAUDE.md importing the AGENTS.md the agent wrote', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-init-'));
    try {
      const session = new Session({ directory });
      const sent: string[] = [];
      const context = {
        session, signal: new AbortController().signal, notify() {},
        sendPrompt: async (text: string) => {
          sent.push(text);
          writeFileSync(join(directory, 'AGENTS.md'), '# Guide\n');
        },
      };
      expect(await executeCommand('init', ['be', 'brief'], context)).toMatchObject({ kind: 'success' });
      expect(sent).toEqual(['/init be brief']);
      expect(readFileSync(join(directory, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
      // A CLAUDE.md the agent left without the import gets it at the top.
      writeFileSync(join(directory, 'CLAUDE.md'), 'Claude-only notes.\n');
      await executeCommand('init', [], context);
      expect(readFileSync(join(directory, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n\nClaude-only notes.\n');
      expect(await executeCommand('init', [], context)).toEqual({ kind: 'success', text: 'AGENTS.md is written, and CLAUDE.md imports it.' });
      rmSync(join(directory, 'AGENTS.md'));
      expect(await executeCommand('init', [], { ...context, sendPrompt: async () => {} }))
        .toMatchObject({ kind: 'warning', text: expect.stringContaining('did not write AGENTS.md') });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('/init refuses a linked or non-regular CLAUDE.md without writing its target', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-init-safe-'));
    const outside = mkdtempSync(join(tmpdir(), 'sirus-init-outside-'));
    try {
      writeFileSync(join(directory, 'AGENTS.md'), '# Guide\n');
      const target = join(outside, 'notes.md');
      writeFileSync(target, 'Keep this text.\n');
      const claude = join(directory, 'CLAUDE.md');
      symlinkSync(target, claude);
      const context = { session: new Session({ directory }), signal: new AbortController().signal, notify() {}, sendPrompt: async () => {} };
      await expect(executeCommand('init', [], context)).rejects.toThrow('regular file');
      expect(readFileSync(target, 'utf8')).toBe('Keep this text.\n');
      rmSync(claude);
      mkdirSync(claude);
      await expect(executeCommand('init', [], context)).rejects.toThrow('regular file');
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('commands written in a prompt', () => {
  const simplify: NativeCommand = { name: 'simplify', description: 'Simplify code', invocation: '/simplify', vendor: 'claude' };
  const split = (text: string) => {
    const { commands, prompt } = splitPrompt(text, [simplify], new Session());
    return { commands: commands.map(command => [command.name, ...command.args]), prompt };
  };

  beforeEach(seedVendorModels);

  test('a command takes the words its grammar reads, wherever it is, and the rest is the prompt', () => {
    expect(split('/model claude-fable-5-1 refactor the parser')).toEqual({
      commands: [['model', 'claude-fable-5-1']], prompt: 'refactor the parser',
    });
    expect(split('/model haiku high refactor the parser')).toEqual({
      commands: [['model', 'haiku', 'high']], prompt: 'refactor the parser',
    });
    expect(split('please fix the bug /model @sirus haiku')).toEqual({
      commands: [['model', '@sirus', 'haiku']], prompt: 'please fix the bug',
    });
    expect(split('fix /thinking max the bug /usage')).toEqual({
      commands: [['thinking', 'max'], ['usage']], prompt: 'fix the bug',
    });
    // A grammar reads only the command's own line.
    expect(split('/model haiku\nhigh level plan')).toEqual({ commands: [['model', 'haiku']], prompt: 'high level plan' });
  });

  test('a prompt that is only a command reads as it always has', () => {
    expect(split('/model haiku')).toEqual({ commands: [['model', 'haiku']], prompt: '' });
    expect(split('/model not a model')).toEqual({ commands: [['model', 'not', 'a', 'model']], prompt: '' });
    expect(split('/rename the parser work')).toEqual({ commands: [['rename', 'the', 'parser', 'work']], prompt: '' });
    expect(split('/clear')).toEqual({ commands: [['clear']], prompt: '' });
  });

  test('paths, unknown names, code and standalone commands past the start stay prose', () => {
    for (const text of ['use and/or /tmp/x', 'see /nope first', 'explain `/model haiku` please', 'then /usage.', 'fix it /new']) {
      expect(split(text)).toEqual({ commands: [], prompt: text });
    }
  });

  test('a vendor command written after the start leads the prompt it was written in', () => {
    expect(split('tidy the parser /simplify')).toEqual({ commands: [], prompt: '/simplify tidy the parser' });
    expect(split('/simplify the parser /thinking high')).toEqual({ commands: [['thinking', 'high']], prompt: '/simplify the parser' });
    expect(split('/simplify the parser, then /simplify again')).toEqual({ commands: [], prompt: '/simplify the parser, then /simplify again' });
  });

  test('the same cut applies to a draft\'s blocks around its images', () => {
    const image = { type: 'image' as const, path: '/tmp/shot.png', mediaType: 'image/png' as const, bytes: 1 };
    const content = [{ type: 'text' as const, text: 'fix ' }, image, { type: 'text' as const, text: ' /model haiku now' }];
    expect(promptContent(content, splitPrompt('fix  /model haiku now', [], new Session()))).toEqual([
      { type: 'text', text: 'fix ' }, image, { type: 'text', text: ' now' },
    ]);
  });

  test('the menu offers commands for a slash typed mid-prompt, at the cursor', () => {
    expect(matchCommands('fix the bug /mod').map(match => match.name)).toEqual(['model']);
    expect(matchCommands('fix /mod the bug', [], 8).map(match => match.name)).toEqual(['model']);
    expect(matchCommands('and/mod')).toEqual([]);
    expect(matchCommands('fix the bug /ne').map(match => match.name)).toEqual([]);
  });
});

describe('executeCommand', () => {
  let settingsDirectory: string;
  let previousDirectory: string | undefined;

  beforeEach(() => {
    settingsDirectory = mkdtempSync(join(tmpdir(), 'sirus-model-command-'));
    previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = settingsDirectory;
    seedVendorModels();
  });

  afterEach(() => {
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
    rmSync(settingsDirectory, { recursive: true, force: true });
  });

  test('permissions ask explains what each vendor approves', () => {
    const description = 'Claude asks before writes. Codex asks before leaving the workspace; edits inside it are not asked.';
    expect(menuItems('permissions', []).find(item => item.key === 'ask')?.description).toBe(description);
    const session = new Session();
    expect(runCommand('permissions', ['ask'], session)).toBeUndefined();
    expect(session.getPermissionMode()).toBe('ask');
    expect(runCommand('permissions', [], session)).toEqual({
      kind: 'info',
      text: `Permission mode is ask for approval. ${description}`,
    });
  });

  test('model command changes only the active populated session', () => {
    const session = new Session();
    const other = new Session();
    session.append({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    openSettings().set({ sirusModel: 'gpt-5.6-terra' });
    expect(runCommand('model', ['claude-fable-5-1'], session)).toEqual({
      kind: 'warning',
      text: 'Switching @sirus to claude-fable-5-1 restarts its session; it keeps the conversation as text.',
    });
    expect(session.getModel()).toBe('claude-fable-5-1');
    expect(other.getModel()).toBe('gpt-5.6-luna');
    expect(openSettings().get('sirusModel')).toBe('gpt-5.6-terra');
    runCommand('model', ['@sirus', 'sol'], session);
    expect(session.getModel()).toBe('gpt-6-sol');
    expect(openSettings().get('sirusModel')).toBe('gpt-5.6-terra');
  });

  test('warns before a cross-vendor model change and in the model picker', () => {
    signIn();
    const session = new Session();
    session.append({ role: 'user', content: [{ type: 'text', text: 'Keep this context' }] });
    const menu = syncCommandMenu('model', [], session)!;
    expect(menu.find((item): item is CommandMenuItem => item.type === 'item' && item.key === 'claude-sonnet-5')?.description)
      .toContain('restarts its session; it keeps the conversation as text');
    expect(menu.find((item): item is CommandMenuItem => item.type === 'item' && item.key === 'gpt-6-sol')?.description ?? '')
      .not.toContain('restarts its session');
    const notices: string[] = [];
    executeCommand('model', ['claude-sonnet-5'], {
      session,
      notify: text => {
        expect(session.getModel()).toBe('gpt-5.6-luna');
        notices.push(text);
      },
      signal: new AbortController().signal,
    });
    expect(notices).toEqual(['Switching @sirus to claude-sonnet-5 restarts its session; it keeps the conversation as text.']);
    expect(session.getModel()).toBe('claude-sonnet-5');
  });

  test('choosing Sirus in an empty session saves the default without changing peers', () => {
    const session = new Session();
    const other = new Session();
    runCommand('model', ['@Sirus', 'sol'], session);
    expect(session.getModel()).toBe('gpt-6-sol');
    expect(openSettings().get('sirusModel')).toBe('gpt-6-sol');
    expect(other.getModel()).toBe('gpt-5.6-luna');
  });

  test('model command changes a named participant and accepts its @ prefix', () => {
    const session = new Session();
    openSettings().set({ sirusModel: 'gpt-5.6-terra' });
    session.addParticipant('reviewer', 'gpt-5.6-terra');
    expect(runCommand('model', ['@reviewer', 'claude-fable-5-1'], session)).toEqual({
      kind: 'success',
      text: '@reviewer model set to claude-fable-5-1.',
    });
    expect(session.getParticipants()[1]).toEqual({ name: 'reviewer', model: 'claude-fable-5-1' });
    expect(openSettings().get('sirusModel')).toBe('gpt-5.6-terra');
    expect(session.getModel()).toBe('gpt-5.6-luna');
  });

  test('model command sets a thinking level after the model', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'claude-sonnet-5');
    expect(runCommand('model', ['haiku', 'high'], session)).toMatchObject({ text: expect.stringContaining('@sirus thinking set to high.') });
    expect(session.getThinkingLevel()).toBe('high');
    runCommand('model', ['@reviewer', 'claude-fable-5-1', 'low'], session);
    expect(session.getParticipants().find(participant => participant.name === 'reviewer')?.model).toBe('claude-fable-5-1');
    expect(session.getThinkingLevel('reviewer')).toBe('low');
  });

  test('model command accepts an unambiguous partial model name', () => {
    const session = new Session();
    expect(runCommand('model', ['HAIKU'], session)).toEqual({
      kind: 'success',
      text: '@sirus model set to claude-haiku-4-5.',
    });
    expect(session.getModel()).toBe('claude-haiku-4-5');
    expect(openSettings().get('sirusModel')).toBe('claude-haiku-4-5');
  });

  test('model references choose the latest version within one model family', () => {
    const models = ['claude-haiku-4-5', 'claude-haiku-5'];

    expect(resolveModelReference('haiku', models)).toBe('claude-haiku-5');
    expect(resolveModelReference('claude-haiku-5', models)).toBe('claude-haiku-5');
    expect(resolveModelReference('luna', ['gpt-5.6-luna', 'gpt-5.7-luna']))
      .toBe('gpt-5.7-luna');
  });

  test('model command rejects a partial name matching different model families', () => {
    expect(() => runCommand('model', ['claude'])).toThrow(/ambiguous model/i);
    expect(() => runCommand('model', ['claude'])).toThrow(/claude-opus-5/);
  });

  test('opus keeps working after Claude reports its qualified family alias', () => {
    const session = new Session();
    runCommand('model', ['opus'], session);
    expect(session.getModel()).toBe('claude-opus-5-5');

    rememberListedModels('claude', [
      { id: 'opus[1m]', description: 'Opus with 1M context' },
      { id: 'sonnet', description: 'Sonnet' },
    ]);
    runCommand('model', ['OPUS'], session);
    expect(session.getModel()).toBe('opus[1m]');
    expect(openSettings().get('sirusModel')).toBe('opus[1m]');

    session.addParticipant('reviewer', 'claude-sonnet-5');
    runCommand('model', ['@reviewer', 'opus'], session);
    expect(session.getParticipants().find(p => p.name === 'reviewer')?.model).toBe('opus[1m]');
    runCommand('model', ['subagent', 'opus'], session);
    expect(session.getSubagentModel()).toBe('opus[1m]');
    expect(() => resolveModelReference('claude-opus-5')).toThrow(/unknown model/i);
    signIn();
    expect(menuItems('model', []).filter(item => item.key.includes('opus')).map(item => item.key))
      .toEqual(['opus[1m]']);
  });

  test('an empty vendor list never falls back to built-in models', () => {
    for (const vendor of VENDORS) rememberListedModels(vendor, []);
    signIn();
    expect(menuItems('model', [])).toEqual([]);
    expect(() => runCommand('model', ['opus'])).toThrow('No vendor models available yet');
  });

  test('model references prefer exact aliases and reject competing context variants', () => {
    expect(resolveModelReference('opus', ['opus[1m]', 'opus'])).toBe('opus');
    expect(resolveModelReference('opus[1m]', ['opus[1m]', 'opus'])).toBe('opus[1m]');
    expect(() => resolveModelReference('opus', ['opus[1m]', 'opus[2m]']))
      .toThrow(/ambiguous model/i);
  });

  test('model command groups selectable models under provider headings', () => {
    signIn();
    const menu = syncCommandMenu('model', [], new Session())!;
    expect(menu.filter(entry => entry.type === 'heading').map(entry => entry.label)).toEqual([
      'Claude',
      'Codex',
    ]);
    expect(menuItems('model', []).map(item => item.command)).toEqual([
      '/model claude-opus-5',
      '/model claude-sonnet-5',
      '/model claude-haiku-4-5',
      '/model claude-fable-5-1',
      '/model claude-opus-5-5',
      '/model gpt-5.5',
      '/model gpt-5.6-luna',
      '/model gpt-5.6-terra',
      '/model gpt-5.6-sol',
      '/model gpt-6-luna',
      '/model gpt-6-sol',
      '/model gpt-6-astra',
    ]);
    expect(menuItems('model', ['@reviewer'])[0].command).toBe('/model @reviewer claude-opus-5');
    expect(syncCommandMenu('model', ['gpt-5.6-sol'], new Session())).toBeNull();
  });

  test('the model picker offers signed-in vendors only and marks the current model where the vendor lists it or not', () => {
    expect(() => syncCommandMenu('model', [], new Session())).toThrow(/No vendor is signed in/);
    providerFor('claude').sources.addApiKey('sk-ant-model-menu-1234');
    // The vendor's own ids are what is offered. A session from before them,
    // on a catalog id, still finds its own model under its vendor.
    rememberListedModels('claude', [
      { id: 'opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { id: 'claude-fable-5-1[1m]', description: 'Fable 5.1 with 1M context' },
      { id: 'haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
    ]);
    const session = new Session({ model: 'claude-haiku-4-5' });
    const menu = syncCommandMenu('model', [], session)!;
    expect(menu.filter(entry => entry.type === 'heading').map(entry => entry.label)).toEqual(['Claude']);
    const items = menu.filter((entry): entry is CommandMenuItem => entry.type === 'item');
    expect(items.map(item => item.key)).toEqual(['claude-haiku-4-5', 'opus', 'claude-fable-5-1[1m]', 'haiku']);
    expect(items.filter(item => item.current).map(item => item.key)).toEqual(['claude-haiku-4-5']);
    // On a listed model, that row is the one marked, and nothing is added.
    session.changeParticipantModel('sirus', 'opus');
    const onAlias = syncCommandMenu('model', [], session)!.filter((entry): entry is CommandMenuItem => entry.type === 'item');
    expect(onAlias.map(item => item.key)).toEqual(['opus', 'claude-fable-5-1[1m]', 'haiku']);
    expect(onAlias.filter(item => item.current).map(item => item.key)).toEqual(['opus']);
  });

  test('/clear and /new request a fresh session and preserve the conversation', () => {
    const session = new Session({ name: 'Current' });
    session.append({ role: 'user', content: [{ type: 'text', text: 'keep me' }] });
    let fresh = 0;
    for (const command of ['clear', 'new']) executeCommand(command, [], {
      session, signal: new AbortController().signal, notify() {}, newSession() { fresh++; },
    });
    expect(fresh).toBe(2);
    expect(session.getMessages()).toHaveLength(1);
    // A command that takes no arguments turns them away instead of running.
    expect(() => executeCommand('clear', ['junk'], {
      session, signal: new AbortController().signal, notify() {}, newSession() { fresh++; },
    })).toThrow('Usage: /clear');
    expect(fresh).toBe(2);
  });

  test('rename accepts a title or derives one from content', async () => {
    const session = new Session({ name: 'Session 1' });
    expect(runCommand('rename', ['UX', 'work'], session)).toEqual({ kind: 'success', text: 'Renamed to UX work.' });
    await expect(runCommand('rename', [], session)).rejects.toThrow('Send a message first');
    session.append({ role: 'user', content: [{ type: 'text', text: 'Fix session storage' }] });
    await runCommand('rename', [], session);
    expect(session.getName()).toBe('Fix session storage');
  });

  test('export, copy, and fork preserve the source conversation', async () => {
    const session = new Session({ name: 'Source', directory: settingsDirectory });
    session.append({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    session.append({ role: 'assistant', content: [{ type: 'text', text: 'The reply.' }] });
    runCommand('export', ['chat.md'], session);
    expect(readFileSync(join(settingsDirectory, 'chat.md'), 'utf8')).toContain('## You\n\nHello\n\n## Assistant\n\nThe reply.');
    executeCommand('export', ['my', 'notes.md'], {
      session, signal: new AbortController().signal, notify() {}, argumentText: 'my  notes.md',
    });
    expect(readFileSync(join(settingsDirectory, 'my  notes.md'), 'utf8')).toContain('## You');
    expect(statSync(join(settingsDirectory, 'my  notes.md')).mode & 0o777).toBe(0o600);
    let copied = '';
    let fork: ReturnType<Session['fork']> | undefined;
    const context = { session, signal: new AbortController().signal, notify() {}, copy(text: string) { copied = text; }, openSession(snapshot: ReturnType<Session['fork']>) { fork = snapshot; } };
    executeCommand('copy', [], context);
    executeCommand('fork', [], context);
    expect(copied).toBe('The reply.');
    expect(fork!.id).not.toBe(session.getId());
    expect(fork!.messages).toEqual(session.getMessages());
    fork!.messages[0].content = [];
    expect(session.getMessages()[0].content).toHaveLength(1);
  });

  test('/delete requires confirmation', async () => {
    let removed = 0;
    for (const accepted of [false, true]) {
      await executeCommand('delete', [], {
        session: new Session(), signal: new AbortController().signal, notify() {},
        confirm: async () => accepted, deleteSession() { removed++; },
      });
      expect(removed).toBe(accepted ? 1 : 0);
    }
  });

  test('help command lists commands and keyboard shortcuts', () => {
    const result = runCommand('help', []) as Feedback;
    expect(result.kind).toBe('info');
    expect(result.showIcon).toBe(false);
    expect(result.text).toContain('/help');
    expect(result.text).toContain('/rename [name]');
    expect(result.text).toContain('/undo');
    expect(result.text).toContain('/rewind');
    expect(result.text).toContain('/image [path]');
    expect(result.text).toContain('/notify');
    expect(result.text).toContain('shift+enter');
    expect(result.text).toContain('switch session');
    expect(() => runCommand('help', ['extra'])).toThrow('Usage: /help');
  });

  test('a usage error writes the command out as /help lists it', () => {
    const listed = (name: string) => {
      const spec = commandRegistry.find(candidate => candidate.name === name)!;
      return `Usage: /${spec.name} ${spec.args}`;
    };
    const session = new Session();
    expect(() => runCommand('model', ['sirus', 'haiku', 'extra'], session)).toThrow(listed('model'));
    expect(() => runCommand('thinking', ['@sirus', 'high', 'extra'], session)).toThrow(listed('thinking'));
    expect(() => runCommand('notify', ['loud'], session)).toThrow(listed('notify'));
    expect(() => runCommand('notify', ['off', 'extra'], session)).toThrow(listed('notify'));
    expect(() => runCommand('undo', ['everything'], session)).toThrow(listed('undo'));
    expect(() => runCommand('undo', ['all', 'extra'], session)).toThrow(listed('undo'));
  });

  test('model command rejects unknown models', () => {
    const session = new Session();
    expect(() => runCommand('model', ['gpt-2'], session)).toThrow(/unknown model/i);
  });

  test('thinking command starts at the model’s default and sets Sirus or a named participant', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'claude-sonnet-5');

    expect(session.getThinkingLevel()).toBeUndefined();
    expect(runCommand('thinking', [], session)).toEqual({ kind: 'info', text: '@sirus thinking is default.' });
    expect(runCommand('thinking', ['low'], session)).toEqual({
      kind: 'success',
      text: '@sirus thinking set to low.',
    });
    expect(runCommand('thinking', ['@reviewer', 'max'], session)).toEqual({
      kind: 'success',
      text: '@reviewer thinking set to max.',
    });
    expect(session.getThinkingLevel()).toBe('low');
    expect(session.getThinkingLevel('reviewer')).toBe('max');
    expect(runCommand('thinking', ['@reviewer', 'default'], session)).toEqual({
      kind: 'success',
      text: '@reviewer thinking set to its model\'s default.',
    });
    expect(session.getThinkingLevel('reviewer')).toBeUndefined();
    expect(session.getParticipants().find(participant => participant.name === 'reviewer')).toEqual({ name: 'reviewer', model: 'claude-sonnet-5' });
    expect(() => runCommand('thinking', ['turbo'], session)).toThrow(/unknown thinking level/i);
    expect(() => runCommand('thinking', ['sirus', 'turbo'], session)).toThrow(/unknown thinking level/i);
  });

  test('thinking command offers a picker for Sirus or a named participant', () => {
    expect(menuItems('thinking', []).map(item => item.command)).toEqual([
      '/thinking default',
      '/thinking low',
      '/thinking medium',
      '/thinking high',
      '/thinking xhigh',
      '/thinking max',
    ]);
    expect(menuItems('thinking', []).filter(item => item.current).map(item => item.key)).toEqual(['default']);
    expect(menuItems('thinking', ['@reviewer'])[3].command).toBe('/thinking @reviewer high');
    expect(syncCommandMenu('thinking', ['low'], new Session())).toBeNull();
  });

  test('thinking offers only the levels the model offers and records the level it runs at', () => {
    // What runtimes on these models listed for their effort option.
    rememberModelFacts('gpt-5.6-terra', { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' });
    rememberModelFacts('claude-haiku-4-5', { efforts: [] });
    const session = new Session({ model: 'gpt-5.6-luna' });
    session.setThinkingLevel('xhigh');
    const items = (syncCommandMenu('thinking', [], session) ?? []).filter((entry): entry is CommandMenuItem => entry.type === 'item');
    expect(items.map(item => item.key)).toEqual(['default', ...THINKING_LEVELS]);

    // A model without xhigh runs at high, and the switch says so.
    expect(runCommand('model', ['gpt-5.6-terra'], session)).toEqual({
      kind: 'warning',
      text: '@sirus model set to gpt-5.6-terra. gpt-5.6-terra does not offer xhigh thinking, so @sirus thinks at high.',
    });
    expect(session.getThinkingLevel()).toBe('high');
    const offered = (syncCommandMenu('thinking', [], session) ?? []).filter((entry): entry is CommandMenuItem => entry.type === 'item');
    expect(offered.map(item => item.key)).toEqual(['default', 'low', 'medium', 'high']);
    expect(offered.find(item => item.current)?.key).toBe('high');
    expect(() => runCommand('thinking', ['max'], session)).toThrow(/does not offer max thinking. Try: low, medium, high/);

    // Back to the model's default, which a runtime on it has shown.
    expect(runCommand('thinking', ['default'], session)).toEqual({
      kind: 'success', text: '@sirus thinking set to its model\'s default (medium).',
    });
    const reset = (syncCommandMenu('thinking', [], session) ?? []).filter((entry): entry is CommandMenuItem => entry.type === 'item');
    expect(reset.find(item => item.current)).toMatchObject({ key: 'default', description: 'whatever the model picks, medium' });

    // A model with no effort option has no levels to choose from.
    runCommand('model', ['claude-haiku-4-5'], session);
    expect(() => syncCommandMenu('thinking', [], session)).toThrow('claude-haiku-4-5 has no thinking levels to choose from.');
  });

  test('memory command reports and persists on/off access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-memory-command-'));
    const previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    try {
      const session = new Session();
      expect(runCommand('memory', [], session)).toEqual({
        kind: 'info',
        text: 'Memory access is on.',
      });
      expect(runCommand('memory', ['off'], session)).toEqual({
        kind: 'success',
        text: 'Memory access set to off.',
      });
      expect(runCommand('memory', [], session)).toEqual({
        kind: 'info',
        text: 'Memory access is off.',
      });
      expect(runCommand('memory', ['on'], session)).toMatchObject({
        kind: 'success',
      });
      expect(() => runCommand('memory', ['maybe'], session)).toThrow('/memory [on|off|list|forget');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('memory command lists what this directory can recall and forgets one by name', async () => {
    const project = join(settingsDirectory, 'project');
    // Saving embeds, which the command never does; a stand-in embedder seeds
    // the store the command then opens.
    const seeding = openMemoryStore({
      databasePath: join(settingsDirectory, 'sirus.db'),
      embedder: { model: 'test-embedding', dimensions: 2, embed: async () => new Float32Array([1, 0]) },
    });
    await seeding.save({ scope: 'global', directory: '' }, { name: 'tone', content: 'Prefers short answers.\nNo emoji.' });
    await seeding.save({ scope: 'project', directory: project }, { name: 'tests', content: 'Run bun test with a scratch HOME.' });
    await seeding.save({ scope: 'project', directory: project }, { name: 'tone', content: 'Project tone differs.' });
    await seeding.save({ scope: 'project', directory: join(settingsDirectory, 'other') }, { name: 'secret', content: 'Another project.' });
    seeding.close();
    try {
      const session = new Session({ directory: project });
      const listed = runCommand('memory', ['list'], session) as Feedback;
      expect(listed.text).toContain('global\n  tone · Prefers short answers. No emoji.');
      expect(listed.text).toContain('this project\n  tests · Run bun test with a scratch HOME.\n  tone · Project tone differs.');
      expect(listed.text).not.toContain('secret');
      expect(() => runCommand('memory', ['forget', 'tone'], session)).toThrow(/Say which: \/memory forget project tone/);
      expect(() => runCommand('memory', ['forget', 'secret'], session)).toThrow(/No memory named "secret"/);
      expect(runCommand('memory', ['forget', 'global', 'tone'], session)).toEqual({ kind: 'success', text: 'Forgot the global memory "tone".' });
      expect(runCommand('memory', ['forget', 'tests'], session)).toEqual({ kind: 'success', text: 'Forgot the project memory "tests".' });
      expect(syncCommandMenu('memory', ['forget'], session)?.map(entry => entry.label)).toEqual(['project · tone']);
      expect((runCommand('memory', ['list'], session) as Feedback).text).not.toContain('global');
    } finally {
      closeAllMemoryStores();
    }
  });

  test('unknown command throws instead of silently doing nothing', () => {
    const session = new Session();
    expect(() => runCommand('nope', [], session)).toThrow(/unknown command/i);
  });

  test('update command rejects arguments before running the updater', () => {
    expect(() => runCommand('update', ['now'])).toThrow('Usage: /update');
    expect(() => runCommand('doctor', ['now'])).toThrow('Usage: /doctor');
  });
});

describe('credential commands', () => {
  let directory: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sirus-credential-command-'));
    previous = {
      SIRUS_DATA_DIR: process.env.SIRUS_DATA_DIR,
      ANTHROPIC_API: process.env.ANTHROPIC_API,
      OPENAI_SECRET: process.env.OPENAI_SECRET,
    };
    process.env.SIRUS_DATA_DIR = directory;
    delete process.env.ANTHROPIC_API;
    delete process.env.OPENAI_SECRET;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test('/login asks for the provider first', () => {
    const items = loginMenuItems()!;
    expect(items.map(item => item.label)).toEqual(['Claude', 'Codex']);
    expect(items.map(item => item.command)).toEqual(['/login claude', '/login codex']);
    expect(items.every(item => item.secret === undefined)).toBe(true);
  });

  test('/login <provider> offers subscription or API key instead of choosing for the user', () => {
    // The stored key still names Codex, for older habits and scripts.
    expect(loginMenuItems(['gpt'])).toEqual(loginMenuItems(['codex']));
    const items = loginMenuItems(['codex'])!;
    expect(items.map(item => item.label)).toEqual(['Subscription', 'API key']);
    expect(items.map(item => item.command)).toEqual(['/login codex subscription', '/login codex api']);
    expect(items[0].description).toBe('sign in with your ChatGPT account in the browser');
    expect(items[0].secret).toBeUndefined();
    expect(items[1].secret?.prompt).toBe('API key for Codex');
    expect(loginMenuItems(['claude'])![1].secret?.prompt).toBe('API key for Claude');
    expect(loginMenuItems(['codex', 'subscription'])).toBeNull();
    expect(() => loginMenuItems(['bing'])).toThrow(/unknown provider.*claude, codex/i);
    expect(runCommand('login', ['codex'])).toEqual({
      kind: 'info',
      text: expect.stringMatching(/\/login codex subscription · \/login codex api/),
    });
  });

  test('/login alone points at the menu instead of running a browser flow', () => {
    expect(runCommand('login', [])).toEqual({
      kind: 'info',
      text: expect.stringMatching(/\/login claude · \/login codex/),
    });
  });

  test('/login <provider> api <key> stores the key without echoing it', () => {
    const result = runCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876']);
    expect(result).toEqual({
      kind: 'success',
      text: 'Saved Claude API key sk-ant-…9876.',
    });
    expect((result as { text: string }).text).not.toContain('sk-ant-pasted-key-9876');
    expect((result as { text: string }).text).toContain('9876');
    expect(providerFor('claude').activeSource()).toMatchObject({ kind: 'api', key: 'sk-ant-pasted-key-9876' });
  });

  test('a secret containing a space reaches the command intact', () => {
    // Regression test for the old string re-entry bug: Chat.tsx used to put a
    // chosen secret back through the input as text and re-split it on spaces,
    // so a key containing a space broke into extra arguments. It now parses
    // the menu item's command once with parseCommandLine and appends the
    // secret as a single trailing argument — reproduce that composition here
    // rather than calling executeCommand directly with a pre-split array.
    const item = loginMenuItems(['codex'])!.find(entry => entry.secret)!;
    const { name, args } = parseCommandLine(item.command);
    expect(name).toBe('login');
    expect(args).toEqual(['codex', 'api']);

    const result = runCommand(name, [...args, 'sk-test with space']);
    expect(result).toMatchObject({ kind: 'success' });
    expect((result as { text: string }).text).not.toContain('sk-test with space');
    expect(providerFor('gpt').activeSource()).toMatchObject({
      kind: 'api',
      key: 'sk-test with space',
    });
  });

  test('/login <provider> api without a key explains the usage', () => {
    expect(() => runCommand('login', ['codex', 'api'])).toThrow(/\/login codex api <key>/);
    expect(() => runCommand('login', ['gpt', 'browser'])).toThrow(/\/login codex subscription/);
  });

  test('/usage reports each provider and how it is authenticated', async () => {
    process.env.OPENAI_SECRET = 'sk-proj-from-env-4321';
    runCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876']);
    const result = await runCommand('usage', []);
    expect(result).toMatchObject({ kind: 'info', showIcon: false });
    const text = (result as { text: string }).text;
    expect(text).toContain('Claude · sk-ant-…9876 · API key');
    expect(text).toContain('Codex · sk-proj-…4321 · API key (env)');
    expect(text).not.toContain('pasted-key');
    expect(text).not.toContain('OPENAI_SECRET');
    expect(() => runCommand('usage', ['now'])).toThrow('Usage: /usage');
  });

  test('/logout lists removable sources by account and removes the chosen one', () => {
    process.env.OPENAI_SECRET = 'sk-proj-from-env-4321';
    runCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876']);
    const items = menuItems('logout', []);
    expect(items.map(item => item.label)).toEqual(['Claude · sk-ant-…9876']);
    expect(runCommand('logout', items[0].command.split(' ').slice(1))).toEqual({
      kind: 'success',
      text: 'Removed Claude · sk-ant-…9876.',
    });
    expect(syncCommandMenu('logout', [], new Session())).toBeNull();
    expect(runCommand('logout', [])).toEqual({ kind: 'info', text: 'Nothing to sign out of.' });
  });

  test('/version shows the installed version', () => {
    expect(runCommand('version', [])).toMatchObject({ kind: 'info', text: expect.stringMatching(/^sirus \d+\.\d+\.\d+/) });
    expect(() => runCommand('version', ['latest'])).toThrow('Usage: /version');
  });

  test('/usage reports every participant window its runtime has reported', async () => {
    const models = { sirus: 'usage-register-sirus', reviewer: 'usage-register-reviewer' };
    bindScriptedRuntime(models.sirus, (_input, emit) => {
      emit({ type: 'context', usage: { tokens: 12_000, window: 200_000 } });
      emit({ type: 'text', text: 'First.' });
      emit({ type: 'usage', usage: { totalTokens: 1_500, inputTokens: 1_000, outputTokens: 500, costUsd: 0.02 } });
    });
    // A Codex turn of several model calls reports a total and no breakdown.
    let reviewerTurns = 0;
    bindScriptedRuntime(models.reviewer, (_input, emit) => {
      emit({ type: 'context', usage: { tokens: 8_000, window: 400_000 } });
      emit({ type: 'text', text: 'Second.' });
      emit({ type: 'usage', usage: ++reviewerTurns === 1
        ? { totalTokens: 400, inputTokens: 300, outputTokens: 100 }
        : { totalTokens: 600 } });
    });
    try {
      const session = new Session({ id: 'usage', name: 'Usage', model: models.sirus });
      session.addParticipant('reviewer', models.reviewer);
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@sirus @reviewer hello' }] });
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@reviewer again' }] });
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'again' }] });
      const result = await runCommand('usage', [], session);
      // Usage is summed over the participant's turns, a figure of the
      // breakdown only when every turn reported it.
      expect((result as Feedback).text).toContain(
        'session · @sirus 3k tokens (2k in, 1k out) · $0.04, ctx 12k (6% of 200k) · @reviewer 1k tokens, ctx 8k (2% of 400k)');
      expect(session.getTurnUsage('reviewer')).toEqual({ totalTokens: 1_000 });
      expect(session.getTurnUsage('sirus')).toEqual({ totalTokens: 3_000, inputTokens: 2_000, outputTokens: 1_000, costUsd: 0.04 });
      const status = (await runCommand('status', [], session) as Feedback).text;
      expect(status).toContain('@sirus · usage-register-sirus · thinking default');
      expect(status).toMatch(/context\s+12k of 200k \(6% used, 94% left\)/);
      expect(status).toMatch(/tokens\s+3k tokens \(2k in, 1k out\) · \$0\.04/);
      expect(status).toMatch(/@reviewer · usage-register-reviewer · thinking default\n\s+context\s+8k of 400k/);
      expect(status).toMatch(/permissions\s+auto approve/);
    } finally {
      unbindRuntime(models.sirus);
      unbindRuntime(models.reviewer);
    }
  });

  test('/usage says when a provider has nothing configured', async () => {
    const result = await runCommand('usage', []);
    const text = (result as { text: string }).text;
    expect(text).toContain('Claude · not configured');
    expect(text).toContain('Codex · not configured');
    expect(text).toContain('session · no usage reported yet');
  });

  test('/logout leaves the subscription when that is active', () => {
    providerFor('gpt').sources.addSubscription('default');
    process.env.OPENAI_SECRET = 'sk-proj-from-env-4321';
    const result = runCommand('logout', ['gpt']);
    expect(providerFor('gpt').activeSource()).toMatchObject({ kind: 'api', fromEnv: true });
    expect(result).toEqual({
      kind: 'success',
      text: 'Removed Codex · subscription.',
    });
  });

  test('/logout removes the stored key when that is active', () => {
    runCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876']);
    const result = runCommand('logout', ['claude']);
    expect(providerFor('claude').sources.list()).toEqual([]);
    expect(result).toEqual({
      kind: 'success',
      text: 'Removed Claude · sk-ant-…9876.',
    });
  });

  test('/logout has nothing to do when neither mechanism is active', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    expect(runCommand('logout', ['claude'])).toEqual({
      kind: 'info',
      text: 'Nothing to sign out of for Claude.',
    });
    expect(providerFor('claude').sources.list()).not.toEqual([]);
  });
});

describe('compact command', () => {
  test('asks the participant runtime to fold its own conversation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-compact-command-'));
    const previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    const model = 'test-compact-command';
    const binding = bindScriptedRuntime(model, (_input, emit) => {
      emit({ type: 'compaction', status: 'completed', summary: 'Summary.' });
    });
    try {
      const session = new Session({ model });
      session.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
      session.append({ role: 'assistant', model, content: [{ type: 'text', text: 'hi' }] });

      expect(await runCommand('compact', [], session)).toEqual({
        kind: 'success',
        text: 'Compacted @sirus\'s context.',
      });
      // The vendors take /compact as a prompt; nothing else asks for it.
      expect(binding.runtimes[0].prompts[0].text).toEndWith('/compact');
      expect(session.getMessages().at(-1)?.content).toEqual([{ type: 'compaction', summary: 'Summary.' }]);

      // What follows /compact tells the vendor what the summary should keep.
      await runCommand('compact', ['keep', 'the', 'API', 'notes'], session);
      expect(binding.runtimes[0].prompts[1].text).toEndWith('/compact keep the API notes');
      expect(matchCommands('/comp').map(command => command.name)).toEqual(['compact']);
    } finally {
      unbindRuntime(model);
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('subagent model command', () => {
  // Models resolve against what the vendors last listed, which lives in the
  // data directory; seed the vendor response for these command tests.
  let directory: string;
  let previousDirectory: string | undefined;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sirus-subagent-model-'));
    previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    seedVendorModels();
  });
  afterEach(() => {
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });

  test('sets, shows and clears the model spawned subagents run on', () => {
    const session = new Session();
    expect(runCommand('model', ['subagent'], session))
      .toEqual({ kind: 'info', text: 'Subagents run on the caller’s choice, agent definition, or participant’s own model.' });
    expect(runCommand('model', ['subagent', 'haiku'], session))
      .toEqual({ kind: 'success', text: 'Subagents run on claude-haiku-4-5.' });
    expect(session.getSubagentModel()).toBe('claude-haiku-4-5');
    expect(session.getModel()).toBe('gpt-5.6-luna');
    expect(runCommand('model', ['subagent'], session))
      .toEqual({ kind: 'info', text: 'Subagents run on claude-haiku-4-5.' });
    expect(runCommand('model', ['subagent', 'default'], session))
      .toEqual({ kind: 'success', text: 'Subagents run on the caller’s choice, agent definition, or participant’s own model.' });
    expect(session.getSubagentModel()).toBeNull();
    expect(() => runCommand('model', ['subagent', 'nope'], session)).toThrow(/unknown model/i);
    expect(() => runCommand('model', ['subagent', 'haiku', 'extra'], session)).toThrow('Usage: /model subagent');
  });
});

describe('/agents', () => {
  // A worker record with only the fields each case is about spelled out, and
  // a conversation the panel can render.
  function worker(run: Partial<SubagentRun> & { id: string }): SubagentRun {
    return {
      callId: null, sessionId: 'session', owner: 'sirus', worker: null,
      model: 'gpt-5.6-terra', thinkingLevel: 'high', context: 'fresh',
      prompt: 'Rewrite the loader', directory: '/project', branch: null,
      status: 'working', startedAt: Date.now() - 130_000, finishedAt: null, updatedAt: Date.now(),
      transcript: [], content: [], finalMessage: null, changes: [],
      error: null, reported: false, dismissed: false,
      ...run,
    };
  }

  // The session as `/agents` sees it, recording what it was asked to do.
  function workerSession(workers: readonly SubagentRun[]) {
    const asked: string[] = [];
    const session = {
      getWorkers: () => [...workers],
      cancelWorker: async (id: string) => { asked.push(`cancel ${id}`); },
      messageWorker: async (id: string, text: string) => { asked.push(`message ${id}: ${text}`); },
      dismissWorker: (id: string) => { asked.push(`dismiss ${id}`); },
    } as unknown as CommandSession;
    return { session, asked };
  }

  function items(args: readonly string[], session: CommandSession): CommandMenuItem[] {
    return syncCommandMenu('agents', args, session)?.filter(
      (entry): entry is CommandMenuItem => entry.type === 'item',
    ) ?? [];
  }

  test('lists the session workers, running ones first', () => {
    const { session } = workerSession([
      worker({ id: 'sub-done', status: 'done', startedAt: 0, finishedAt: 45_000 }),
      worker({ id: 'sub-gone', status: 'done', dismissed: true }),
      worker({ id: 'sub-live' }),
    ]);
    expect(items([], session).map(item => item.label)).toEqual([
      'sub-live · gpt-5.6-terra · working 2m10s',
      'sub-done · gpt-5.6-terra · done 45s',
    ]);
    expect(items([], session).map(item => item.description)).toEqual([
      'Rewrite the loader', 'Rewrite the loader',
    ]);
    expect(items([], session).map(item => item.command)).toEqual(['/agents sub-live', '/agents sub-done']);
    // Run rather than opened as a menu, it says the same as one panel of text.
    expect((runCommand('agents', [], session) as Feedback).text)
      .toContain('sub-live · gpt-5.6-terra · working 2m10s · Rewrite the loader');
  });

  test('says so plainly when the session has no workers', () => {
    const { session } = workerSession([]);
    expect(syncCommandMenu('agents', [], session)).toBeNull();
    expect(runCommand('agents', [], session)).toEqual({ kind: 'info', text: 'No workers in this session.' });
  });

  test('offers only what can be done to that worker', () => {
    const { session } = workerSession([
      worker({ id: 'sub-live' }),
      worker({ id: 'sub-done', status: 'done' }),
    ]);
    expect(items(['sub-live'], session).map(item => item.command))
      .toEqual(['/agents show sub-live', '/agents message sub-live', '/agents cancel sub-live']);
    expect(items(['sub-done'], session).map(item => item.command))
      .toEqual(['/agents show sub-done', '/agents message sub-done', '/agents dismiss sub-done']);
    // The message action asks for the text in the input bar, in the open.
    const message = items(['sub-live'], session).find(item => item.key === 'message')!;
    expect(message.input?.prompt).toMatch(/sub-live/);
    expect(message.secret).toBeUndefined();
    // An action already chosen runs instead of opening another menu.
    expect(syncCommandMenu('agents', ['show', 'sub-live'], session)).toBeNull();
    expect(() => syncCommandMenu('agents', ['sub-nope'], session)).toThrow(/no worker "sub-nope"/i);
  });

  test('shows a worker record and the conversation it has had', () => {
    const { session } = workerSession([worker({
      id: 'sub-live', branch: 'sirus/sub-live',
      transcript: [
        { seq: 0, role: 'user', content: [{ type: 'text', text: 'Rewrite the loader' }] },
        {
          seq: 1, role: 'assistant', participant: 'sub-live', content: [
            { type: 'tool_call', id: 'one', kind: 'edit', title: 'src/loader.ts', status: 'completed', locations: [], content: [] },
            { type: 'text', text: 'Halfway there.' },
          ],
        },
      ],
    })]);
    const result = runCommand('agents', ['show', 'sub-live'], session) as Feedback;
    expect(result).toMatchObject({ kind: 'info', panel: true, showIcon: false });
    expect(result.text).toContain('sub-live · working · 2m10s');
    expect(result.text).toContain('task: Rewrite the loader');
    expect(result.text).toContain('model: gpt-5.6-terra · high');
    expect(result.text).toContain('branch: sirus/sub-live');
    expect(result.text).toContain('› sub-live');
    expect(result.text).toContain('✓ edit src/loader.ts');
    expect(result.text).toContain('Halfway there.');
  });

  test('says where a worker without a branch is working', () => {
    const { session } = workerSession([worker({ id: 'sub-live' })]);
    expect((runCommand('agents', ['show', 'sub-live'], session) as Feedback).text)
      .toContain('branch: none · works in /project');
  });

  test('steers a working worker with the text the input bar collected', async () => {
    const { session, asked } = workerSession([worker({ id: 'sub-live' })]);
    const item = items(['sub-live'], session).find(entry => entry.input)!;
    const { name, args } = parseCommandLine(item.command);
    expect(name).toBe('agents');
    expect(args).toEqual(['message', 'sub-live']);
    expect(await runCommand(name, [...args, 'also check the tests'], session))
      .toEqual({ kind: 'success', text: 'Sent to sub-live.' });
    expect(asked).toEqual(['message sub-live: also check the tests']);
    expect(() => runCommand('agents', ['message', 'sub-live'], session))
      .toThrow('Usage: /agents message sub-live <message>');
  });

  test('resumes a worker that has stopped', async () => {
    const { session, asked } = workerSession([worker({ id: 'sub-done', status: 'failed' })]);
    expect(await runCommand('agents', ['message', 'sub-done', 'carry on'], session))
      .toEqual({ kind: 'success', text: 'Sent to sub-done.' });
    expect(asked).toEqual(['message sub-done: carry on']);
  });

  test('cancels a working worker and leaves a finished one alone', async () => {
    const { session, asked } = workerSession([
      worker({ id: 'sub-live' }),
      worker({ id: 'sub-done', status: 'done' }),
    ]);
    expect(await runCommand('agents', ['cancel', 'sub-live'], session))
      .toEqual({ kind: 'success', text: 'Cancelled sub-live.' });
    expect(runCommand('agents', ['cancel', 'sub-done'], session))
      .toEqual({ kind: 'info', text: 'sub-done is already done.' });
    expect(asked).toEqual(['cancel sub-live']);
  });

  test('clears a finished worker from the strip, never a working one', () => {
    const { session, asked } = workerSession([
      worker({ id: 'sub-live' }),
      worker({ id: 'sub-done', status: 'cancelled' }),
    ]);
    expect(runCommand('agents', ['dismiss', 'sub-done'], session))
      .toEqual({ kind: 'success', text: 'Dismissed sub-done.' });
    expect(() => runCommand('agents', ['dismiss', 'sub-nope'], session)).toThrow(/no worker/i);
    expect(() => runCommand('agents', ['dismiss', 'sub-live'], session))
      .toThrow('sub-live is still working. Cancel it first, or leave it to finish.');
    expect(asked).toEqual(['dismiss sub-done']);
  });

  test('names a worker by the name its owner gave it, with the id secondary', async () => {
    const { session, asked } = workerSession([
      worker({ id: 'sub-1a2b3c4d', name: 'greet-jsdoc', description: 'Add JSDoc to greet' }),
      worker({ id: 'sub-done', name: 'loader', status: 'done' }),
    ]);
    expect(items([], session).map(item => [item.label, item.description, item.command])).toEqual([
      ['greet-jsdoc · gpt-5.6-terra · working 2m10s', 'Add JSDoc to greet · sub-1a2b3c4d', '/agents sub-1a2b3c4d'],
      ['loader · gpt-5.6-terra · done 2m10s', 'Rewrite the loader · sub-done', '/agents sub-done'],
    ]);
    expect(syncCommandMenu('agents', ['greet-jsdoc'], session)?.[0]).toMatchObject({ label: 'greet-jsdoc (sub-1a2b3c4d) · working' });
    const shown = (runCommand('agents', ['show', 'greet-jsdoc'], session) as Feedback).text;
    expect(shown).toStartWith('greet-jsdoc (sub-1a2b3c4d) · working · 2m10s');
    expect((runCommand('agents', [], session) as Feedback).text)
      .toContain('greet-jsdoc (sub-1a2b3c4d) · gpt-5.6-terra · working 2m10s · Add JSDoc to greet');
    expect(await runCommand('agents', ['message', 'greet-jsdoc', 'also the tests'], session))
      .toEqual({ kind: 'success', text: 'Sent to greet-jsdoc.' });
    expect(await runCommand('agents', ['cancel', 'sub-1a2b3c4d'], session))
      .toEqual({ kind: 'success', text: 'Cancelled greet-jsdoc.' });
    expect(runCommand('agents', ['dismiss', 'loader'], session))
      .toEqual({ kind: 'success', text: 'Dismissed loader.' });
    expect(asked).toEqual(['message sub-1a2b3c4d: also the tests', 'cancel sub-1a2b3c4d', 'dismiss sub-done']);
  });

  test('is offered in the command menu and in /help', () => {
    expect(matchCommands('/ag').map(command => command.name)).toEqual(['agents']);
    expect(matchCommands('/agents')[0].args).toBe('[show|message|cancel|dismiss] [name]');
    expect((runCommand('help', []) as Feedback).text)
      .toContain('/agents [show|message|cancel|dismiss] [name]');
  });
});

test('removed routing command is absent from help and suggestions', () => {
  expect(matchCommands('/jev')).toEqual([]);
  expect((runCommand('help', []) as Feedback).text).not.toContain('/jev');
});


test('permission cycling goes ask, auto, bypass and round again', () => {
  expect(nextPermissionMode('ask')).toBe('auto');
  expect(nextPermissionMode('auto')).toBe('bypass');
  expect(nextPermissionMode('bypass')).toBe('ask');
  expect(menuItems('permissions', []).some(item => item.command === '/permissions bypass')).toBe(true);
});

test('/quit calls the app exit capability and rejects arguments', () => {
  let exited = false;
  executeCommand('quit', [], { session: new Session(), notify: () => {},
    signal: new AbortController().signal, exit: () => { exited = true; } });
  expect(exited).toBe(true);
  expect(() => runCommand('quit', ['extra'])).toThrow('Usage: /quit');
});

describe('background tasks', () => {
  test('merges AIR task progress and terminal metadata without reopening a finished task', () => {
    const spawned = backgroundTaskFrom({
      sessionUpdate: 'async_task_spawned', asyncTaskId: 'shell-1', name: 'sleep 20',
      canStop: true, toolCallId: 'tool-1',
    })!;
    const progress = backgroundTaskFrom({
      sessionUpdate: 'async_task_progress', asyncTaskId: 'shell-1', outputFilePath: '/tmp/output',
    }, spawned)!;
    expect(progress).toMatchObject({ name: 'sleep 20', toolCallId: 'tool-1', state: 'running', canStop: true });
    const finished = backgroundTaskFrom({
      sessionUpdate: 'async_task_state_update', asyncTaskId: 'shell-1', state: 'completed', summary: 'Done',
    }, progress)!;
    expect(finished).toMatchObject({ state: 'completed', canStop: false, outputFilePath: '/tmp/output', summary: 'Done' });
    expect(backgroundTaskFrom({
      sessionUpdate: 'async_task_progress', asyncTaskId: 'shell-1', outputFilePath: '/tmp/final',
    }, finished)).toMatchObject({ state: 'completed', canStop: false, outputFilePath: '/tmp/final' });
    expect(backgroundTaskFrom({ sessionUpdate: 'agent_message_chunk' })).toBeNull();
  });

  test('/tasks separates participant task ids and routes stop to the chosen runtime', async () => {
    const models = ['tasks-owner-test', 'tasks-reviewer-test'];
    const task: BackgroundTask = { id: 'shell-1', name: 'sleep 20', state: 'running', canStop: true };
    const bindings = models.map(model => bindScriptedRuntime(model, (_input, emit) => {
      emit({ type: 'async_task', task });
      emit({ type: 'text', text: 'Started.' });
    }));
    const session = new Session({ id: 'tasks-routing', name: 'Tasks', model: models[0] });
    try {
      session.addParticipant('reviewer', models[1]);
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@sirus @reviewer start' }] });
      expect(session.getBackgroundTasks().map(task => task.participant)).toEqual(['sirus', 'reviewer']);
      const menu = syncCommandMenu('tasks', [], session)!;
      expect(menu).toHaveLength(2);
      expect(menu.map(entry => entry.type === 'item' ? entry.command : '')).toEqual([
        '/tasks @sirus shell-1', '/tasks @reviewer shell-1',
      ]);
      expect(syncCommandMenu('tasks', ['@reviewer', 'shell-1'], session)).toMatchObject([
        { command: '/tasks stop @reviewer shell-1' },
      ]);
      expect(await runCommand('tasks', ['stop', '@reviewer', 'shell-1'], session)).toMatchObject({ kind: 'success' });
      expect(bindings[0].runtimes[0].stoppedTasks).toEqual([]);
      expect(bindings[1].runtimes[0].stoppedTasks).toEqual(['shell-1']);
      bindings[0].starts[0].onUpdate({ type: 'async_task', task: { ...task, state: 'completed', canStop: false } });
      expect(session.getBackgroundTasks().find(task => task.participant === 'sirus')?.state).toBe('completed');
      expect(session.getNotice()?.notice.title).toContain('completed');
      bindings[0].starts[0].onUpdate({ type: 'async_task', task: { ...task, state: 'completed', canStop: false, outputFilePath: '/tmp/final' } });
      expect(session.getMessages().flatMap(entry => entry.content).filter(block =>
        block.type === 'notice' && block.title.includes('shell-1 completed'))).toHaveLength(1);
      expect(JSON.stringify(session.toSnapshot())).toContain('shell-1 completed');
      expect(await runCommand('tasks', ['stop', '@sirus', 'shell-1'], session)).toMatchObject({ kind: 'info' });
      expect(bindings[0].runtimes[0].stoppedTasks).toEqual([]);
    } finally {
      await session.dispose();
      for (const model of models) unbindRuntime(model);
    }
  });
});
