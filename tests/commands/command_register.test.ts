import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach } from 'bun:test';
import {
  commandMenu,
  executeCommand,
  loginMenuItems,
  matchCommands,
  type CommandMenuItem,
} from '../../src/commands/registry';
import { Session } from '../../src/agent_runtime/session';
import { providerFor } from '../../src/agent_runtime/providers/providers';
import { resolveModelReference } from '../../src/commands/agents/behavior';
import type { Feedback } from '../../src/commands/feedback';
import { loadSirusModelPreference, saveSirusModelPreference } from '../../src/persistence';

function runCommand(
  command: string,
  args: string[],
  session: Session = new Session(),
) {
  return executeCommand(command, args, {
    session,
    notify: () => {},
    attachImage: () => {},
    signal: new AbortController().signal,
  });
}

function menuItems(command: string, args: readonly string[]): CommandMenuItem[] {
  return commandMenu(command, args, new Session())?.filter(
    (entry): entry is CommandMenuItem => entry.type === 'item',
  ) ?? [];
}

describe('matchCommands', () => {
  test('bare slash lists every command', () => {
    const all = matchCommands('/');
    expect(all.length).toBeGreaterThan(0);
    expect(all.map(c => c.name)).toContain('model');
    expect(all.map(c => c.name)).toContain('memory');
    expect(all.map(c => c.name)).toContain('thinking');
    expect(all.map(c => c.name)).toContain('update');
  });

  test('filters by typed prefix', () => {
    expect(matchCommands('/mod').map(c => c.name)).toEqual(['model']);
    expect(matchCommands('/model')[0].args).toBe('[agent] <model>');
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
});

describe('executeCommand', () => {
  let settingsDirectory: string;
  let previousDirectory: string | undefined;

  beforeEach(() => {
    settingsDirectory = mkdtempSync(join(tmpdir(), 'sirus-model-command-'));
    previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = settingsDirectory;
  });

  afterEach(() => {
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
    rmSync(settingsDirectory, { recursive: true, force: true });
  });

  test('model command changes only the active populated session', () => {
    const session = new Session();
    const other = new Session();
    session.append({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    saveSirusModelPreference('gpt-5.6-terra');
    expect(runCommand('model', ['claude-fable-5-1'], session)).toEqual({
      kind: 'success',
      text: '@sirus model changed to claude-fable-5-1.',
    });
    expect(session.getModel()).toBe('claude-fable-5-1');
    expect(other.getModel()).toBe('gpt-5.6-luna');
    expect(loadSirusModelPreference()).toBe('gpt-5.6-terra');
    runCommand('model', ['@sirus', 'sol'], session);
    expect(session.getModel()).toBe('gpt-5.6-sol');
    expect(loadSirusModelPreference()).toBe('gpt-5.6-terra');
  });

  test('choosing Sirus in an empty session saves the default without changing peers', () => {
    const session = new Session();
    const other = new Session();
    runCommand('model', ['@Sirus', 'sol'], session);
    expect(session.getModel()).toBe('gpt-5.6-sol');
    expect(loadSirusModelPreference()).toBe('gpt-5.6-sol');
    expect(other.getModel()).toBe('gpt-5.6-luna');
  });

  test('model command changes a named participant and accepts its @ prefix', () => {
    const session = new Session();
    saveSirusModelPreference('gpt-5.6-terra');
    session.addParticipant('reviewer', 'gpt-5.6-terra');
    expect(runCommand('model', ['@reviewer', 'claude-fable-5-1'], session)).toEqual({
      kind: 'success',
      text: '@reviewer model changed to claude-fable-5-1.',
    });
    expect(session.getParticipants()[1]).toEqual({ name: 'reviewer', model: 'claude-fable-5-1' });
    expect(loadSirusModelPreference()).toBe('gpt-5.6-terra');
    expect(session.getModel()).toBe('gpt-5.6-luna');
  });

  test('model command accepts an unambiguous partial model name', () => {
    const session = new Session();
    expect(runCommand('model', ['HAIKU'], session)).toEqual({
      kind: 'success',
      text: '@sirus model changed to claude-haiku-4.5.',
    });
    expect(session.getModel()).toBe('claude-haiku-4.5');
    expect(loadSirusModelPreference()).toBe('claude-haiku-4.5');
  });

  test('model references choose the latest version within one model family', () => {
    const models = ['claude-haiku-4.5', 'claude-haiku-5'];

    expect(resolveModelReference('haiku', models)).toBe('claude-haiku-5');
    expect(resolveModelReference('claude-haiku-5', models)).toBe('claude-haiku-5');
    expect(resolveModelReference('luna', ['gpt-5.6-luna', 'gpt-5.7-luna']))
      .toBe('gpt-5.7-luna');
  });

  test('model command rejects a partial name matching different model families', () => {
    expect(() => runCommand('model', ['claude'])).toThrow(/ambiguous model/i);
    expect(() => runCommand('model', ['claude'])).toThrow(/claude-opus-5/);
  });

  test('model command groups selectable models under provider headings', () => {
    const menu = commandMenu('model', [], new Session())!;
    expect(menu.filter(entry => entry.type === 'heading').map(entry => entry.label)).toEqual([
      'Anthropic',
      'OpenAI',
    ]);
    expect(menuItems('model', []).map(item => item.command)).toEqual([
      '/model claude-opus-5',
      '/model claude-sonnet-5',
      '/model claude-haiku-4.5',
      '/model claude-fable-5-1',
      '/model gpt-5.6-luna',
      '/model gpt-5.6-terra',
      '/model gpt-5.6-sol',
      '/model gpt-6-astra',
    ]);
    expect(menuItems('model', ['@reviewer'])[0].command).toBe('/model @reviewer claude-opus-5');
    expect(commandMenu('model', ['gpt-5.6-sol'], new Session())).toBeNull();
  });

  test('clear command empties only the current session history', () => {
    const current = new Session('Current');
    const other = new Session('Other');
    current.append({ role: 'user', content: [{ type: 'text', text: 'clear me' }] });
    other.append({ role: 'user', content: [{ type: 'text', text: 'keep me' }] });

    expect(runCommand('clear', [], current)).toEqual({
      kind: 'success',
      text: 'Session history cleared.',
    });
    expect(current.getMessages()).toEqual([]);
    expect(other.getMessages()).toHaveLength(1);
  });

  test('rename command updates the current session and rejects an empty name', () => {
    const session = new Session('Session 1');
    expect(runCommand('rename', ['UX', 'work'], session)).toEqual({
      kind: 'success',
      text: 'Session renamed to UX work.',
    });
    expect(session.getName()).toBe('UX work');
    expect(() => runCommand('rename', [], session)).toThrow('Usage: /rename <name>');
  });

  test('help command lists commands and keyboard shortcuts', () => {
    const result = runCommand('help', []) as Feedback;
    expect(result.kind).toBe('info');
    expect(result.showIcon).toBe(false);
    expect(result.text).toContain('/help');
    expect(result.text).toContain('/rename <name>');
    expect(result.text).toContain('/undo');
    expect(result.text).toContain('/rewind');
    expect(result.text).toContain('/image [path]');
    expect(result.text).toContain('/notify');
    expect(result.text).toContain('shift+enter');
    expect(result.text).toContain('switch session');
    expect(() => runCommand('help', ['extra'])).toThrow('Usage: /help');
  });

  test('model command rejects unknown models', () => {
    const session = new Session();
    expect(() => runCommand('model', ['gpt-2'], session)).toThrow(/unknown model/i);
  });

  test('thinking command defaults to high and sets Sirus or a named participant', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'claude-sonnet-5');

    expect(session.getThinkingLevel()).toBe('high');
    expect(runCommand('thinking', ['low'], session)).toEqual({
      kind: 'success',
      text: '@sirus thinking level changed to low.',
    });
    expect(runCommand('thinking', ['@reviewer', 'max'], session)).toEqual({
      kind: 'success',
      text: '@reviewer thinking level changed to max.',
    });
    expect(session.getThinkingLevel()).toBe('low');
    expect(session.getThinkingLevel('reviewer')).toBe('max');
    expect(() => runCommand('thinking', ['turbo'], session)).toThrow(/unknown thinking level/i);
    expect(() => runCommand('thinking', ['sirus', 'turbo'], session)).toThrow(/unknown thinking level/i);
  });

  test('thinking command offers a picker for Sirus or a named participant', () => {
    expect(menuItems('thinking', []).map(item => item.command)).toEqual([
      '/thinking low',
      '/thinking medium',
      '/thinking high',
      '/thinking xhigh',
      '/thinking max',
    ]);
    expect(menuItems('thinking', ['@reviewer'])[2].command).toBe('/thinking @reviewer high');
    expect(commandMenu('thinking', ['low'], new Session())).toBeNull();
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
        text: 'Memory access disabled. Stored memories were not changed.',
      });
      expect(runCommand('memory', [], session)).toEqual({
        kind: 'info',
        text: 'Memory access is off.',
      });
      expect(runCommand('memory', ['on'], session)).toMatchObject({
        kind: 'success',
      });
      expect(() => runCommand('memory', ['maybe'], session)).toThrow('/memory [on|off]');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('unknown command throws instead of silently doing nothing', () => {
    const session = new Session();
    expect(() => runCommand('nope', [], session)).toThrow(/unknown command/i);
  });

  test('update command rejects arguments before running the updater', () => {
    expect(() => runCommand('update', ['now'])).toThrow('Usage: /update');
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
    expect(items.map(item => item.label)).toEqual(['Claude', 'ChatGPT']);
    expect(items.map(item => item.command)).toEqual(['/login claude', '/login gpt']);
    expect(items.every(item => item.secret === undefined)).toBe(true);
  });

  test('/login <provider> offers subscription or API key instead of choosing for the user', () => {
    const items = loginMenuItems(['gpt'])!;
    expect(items.map(item => item.label)).toEqual(['Subscription', 'API key']);
    expect(items.map(item => item.command)).toEqual(['/login gpt subscription', '/login gpt api']);
    expect(items[0].secret).toBeUndefined();
    expect(items[1].secret?.prompt).toMatch(/OpenAI API key/);
    expect(loginMenuItems(['claude'])![1].secret?.prompt).toMatch(/Anthropic API key/);
    expect(loginMenuItems(['gpt', 'subscription'])).toBeNull();
    expect(() => loginMenuItems(['bing'])).toThrow(/unknown provider/i);
    expect(runCommand('login', ['gpt'])).toEqual({
      kind: 'info',
      text: expect.stringMatching(/\/login gpt subscription, \/login gpt api/),
    });
  });

  test('/login alone points at the menu instead of running a browser flow', () => {
    expect(runCommand('login', [])).toEqual({
      kind: 'info',
      text: expect.stringMatching(/\/login claude|\/login gpt/),
    });
  });

  test('/login <provider> api <key> stores the key without echoing it', () => {
    const result = runCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876']);
    expect(result).toEqual({
      kind: 'success',
      text: expect.stringContaining('claude-* models now use'),
    });
    expect((result as { text: string }).text).not.toContain('sk-ant-pasted-key-9876');
    expect((result as { text: string }).text).toContain('9876');
    expect(providerFor('claude').apiKey()).toEqual({ key: 'sk-ant-pasted-key-9876', source: 'settings', masked: 'sk-ant-…9876' });
  });

  test('/login <provider> api without a key explains the usage', () => {
    expect(() => runCommand('login', ['gpt', 'api'])).toThrow(/\/login gpt api <key>/);
    expect(() => runCommand('login', ['gpt', 'browser'])).toThrow(/\/login gpt subscription/);
  });

  test('/info reports each provider and how it is authenticated', async () => {
    process.env.OPENAI_SECRET = 'sk-proj-from-env-4321';
    runCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876']);
    const result = await runCommand('info', []);
    expect(result).toMatchObject({ kind: 'info', showIcon: false });
    const text = (result as { text: string }).text;
    expect(text).toMatch(/claude: API key · sk-ant-…9876/);
    expect(text).toMatch(/gpt: API key · sk-proj-…4321/);
    expect(text).not.toContain('pasted-key');
    expect(text).not.toContain('OPENAI_SECRET');
  });

  test('/info includes session totals and the latest context', async () => {
    const session = new Session('Usage', 'usage', 'gpt-5.6-luna', [
      {
        role: 'assistant', content: [{ type: 'text', text: 'First.' }],
        usage: { inputTokens: 1_000, outputTokens: 200, contextTokens: 1_200, contextWindow: 200_000 },
      },
      {
        role: 'assistant', content: [{ type: 'text', text: 'Second.' }],
        usage: { inputTokens: 2_000, outputTokens: 400, contextTokens: 2_400, contextWindow: 400_000 },
      },
    ]);
    const result = await runCommand('info', [], session);
    expect((result as Feedback).text).toContain('session: 3k in · 600 out · context 2.4k (1% of 400k)');
  });

  test('/info says when a provider has nothing configured', async () => {
    const result = await runCommand('info', []);
    const text = (result as { text: string }).text;
    expect(text).toMatch(/claude: not configured/);
    expect(text).toMatch(/gpt: not configured/);
    expect(text).toContain('session: token usage unavailable');
  });

  test('/logout leaves the subscription when that is active', () => {
    providerFor('gpt').setSource('subscription');
    process.env.OPENAI_SECRET = 'sk-proj-from-env-4321';
    const result = runCommand('logout', ['gpt']);
    expect(providerFor('gpt').source).toBe('api');
    expect(result).toEqual({
      kind: 'success',
      text: expect.stringMatching(/Signed out of the ChatGPT subscription\. gpt-\* models now use the OpenAI API key \(sk-proj-…4321\)/),
    });
  });

  test('/logout removes the stored key when that is active', () => {
    runCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876']);
    const result = runCommand('logout', ['claude']);
    expect(providerFor('claude').apiKey()).toBeNull();
    expect(result).toEqual({
      kind: 'success',
      text: 'Removed your saved Anthropic API key. claude-* models are signed out; run /login to sign in.',
    });
  });

  test('/logout has nothing to do when neither mechanism is active', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    expect(runCommand('logout', ['claude'])).toEqual({
      kind: 'info',
      text: 'Nothing to sign out of for claude.',
    });
    expect(providerFor('claude').apiKey()).not.toBeNull();
  });
});
