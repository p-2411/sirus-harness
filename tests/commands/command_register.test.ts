import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach } from 'bun:test';
import { commandMenu, executeCommand, loginMenuItems, matchCommands } from '../../src/commands/command_register';
import { Session } from '../../src/data/data';
import { findApiKey } from '../../src/agent/credentials';
import { isSubscriptionEnabled, setSubscriptionEnabled } from '../../src/agent/subscriptions';

describe('matchCommands', () => {
  test('bare slash lists every command', () => {
    const all = matchCommands('/');
    expect(all.length).toBeGreaterThan(0);
    expect(all.map(c => c.name)).toContain('model');
    expect(all.map(c => c.name)).toContain('memory');
    expect(all.map(c => c.name)).toContain('thinking');
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
  test('model command sets the session model', () => {
    const session = new Session();
    expect(executeCommand('model', ['claude-fable-5'], session)).toEqual({
      kind: 'success',
      text: '@sirus model changed to claude-fable-5.',
    });
    expect(session.getModel()).toBe('claude-fable-5');
  });

  test('model command delegates Sirus changes to the workspace when available', () => {
    const session = new Session();
    let globalModel: string | undefined;
    expect(executeCommand(
      'model',
      ['gpt-5.6-sol'],
      session,
      undefined,
      undefined,
      { changeSirusModel: model => { globalModel = model; } },
    )).toEqual({
      kind: 'success',
      text: '@sirus model changed to gpt-5.6-sol.',
    });
    expect(globalModel).toBe('gpt-5.6-sol');
    expect(session.getModel()).toBe('gpt-5.6-luna');
  });

  test('model command changes a named participant and accepts its @ prefix', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'gpt-5.6-terra');
    expect(executeCommand('model', ['@reviewer', 'claude-fable-5'], session)).toEqual({
      kind: 'success',
      text: '@reviewer model changed to claude-fable-5.',
    });
    expect(session.getParticipants()[1]).toEqual({ name: 'reviewer', model: 'claude-fable-5' });
  });

  test('clear command empties only the current session history', () => {
    const current = new Session('Current');
    const other = new Session('Other');
    current.append({ role: 'user', content: [{ type: 'text', text: 'clear me' }] });
    other.append({ role: 'user', content: [{ type: 'text', text: 'keep me' }] });

    expect(executeCommand('clear', [], current)).toEqual({
      kind: 'success',
      text: 'Session history cleared.',
    });
    expect(current.getMessages()).toEqual([]);
    expect(other.getMessages()).toHaveLength(1);
  });

  test('model command rejects unknown models', () => {
    const session = new Session();
    expect(() => executeCommand('model', ['gpt-2'], session)).toThrow(/unknown model/i);
  });

  test('thinking command defaults to high and sets Sirus or a named participant', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'claude-sonnet-5');

    expect(session.getThinkingLevel()).toBe('high');
    expect(executeCommand('thinking', ['low'], session)).toEqual({
      kind: 'success',
      text: '@sirus thinking level changed to low.',
    });
    expect(executeCommand('thinking', ['@reviewer', 'max'], session)).toEqual({
      kind: 'success',
      text: '@reviewer thinking level changed to max.',
    });
    expect(session.getThinkingLevel()).toBe('low');
    expect(session.getThinkingLevel('reviewer')).toBe('max');
    expect(() => executeCommand('thinking', ['turbo'], session)).toThrow(/unknown thinking level/i);
    expect(() => executeCommand('thinking', ['sirus', 'turbo'], session)).toThrow(/unknown thinking level/i);
  });

  test('thinking command offers a picker for Sirus or a named participant', () => {
    expect(commandMenu('thinking', [])?.map(item => item.command)).toEqual([
      '/thinking low',
      '/thinking medium',
      '/thinking high',
      '/thinking xhigh',
      '/thinking max',
    ]);
    expect(commandMenu('thinking', ['@reviewer'])?.[2].command).toBe('/thinking @reviewer high');
    expect(commandMenu('thinking', ['low'])).toBeNull();
  });

  test('memory command reports and persists on/off access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-memory-command-'));
    const previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    try {
      const session = new Session();
      expect(executeCommand('memory', [], session)).toEqual({
        kind: 'info',
        text: 'Memory access is on.',
      });
      expect(executeCommand('memory', ['off'], session)).toEqual({
        kind: 'success',
        text: 'Memory access disabled. Stored memories were not changed.',
      });
      expect(executeCommand('memory', [], session)).toEqual({
        kind: 'info',
        text: 'Memory access is off.',
      });
      expect(executeCommand('memory', ['on'], session)).toMatchObject({
        kind: 'success',
      });
      expect(() => executeCommand('memory', ['maybe'], session)).toThrow('/memory [on|off]');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('unknown command throws instead of silently doing nothing', () => {
    const session = new Session();
    expect(() => executeCommand('nope', [], session)).toThrow(/unknown command/i);
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
    expect(executeCommand('login', ['gpt'], new Session())).toEqual({
      kind: 'info',
      text: expect.stringMatching(/\/login gpt subscription, \/login gpt api/),
    });
  });

  test('/login alone points at the menu instead of running a browser flow', () => {
    expect(executeCommand('login', [], new Session())).toEqual({
      kind: 'info',
      text: expect.stringMatching(/\/login claude|\/login gpt/),
    });
  });

  test('/login <provider> api <key> stores the key without echoing it', () => {
    const result = executeCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876'], new Session());
    expect(result).toEqual({
      kind: 'success',
      text: expect.stringContaining('claude-* models now use'),
    });
    expect((result as { text: string }).text).not.toContain('sk-ant-pasted-key-9876');
    expect((result as { text: string }).text).toContain('9876');
    expect(findApiKey('claude')).toEqual({ key: 'sk-ant-pasted-key-9876', source: 'settings' });
  });

  test('/login <provider> api without a key explains the usage', () => {
    expect(() => executeCommand('login', ['gpt', 'api'], new Session())).toThrow(/\/login gpt api <key>/);
    expect(() => executeCommand('login', ['gpt', 'browser'], new Session())).toThrow(/\/login gpt subscription/);
  });

  test('/info reports each provider and how it is authenticated', async () => {
    process.env.OPENAI_SECRET = 'sk-proj-from-env-4321';
    executeCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876'], new Session());
    const result = await executeCommand('info', [], new Session());
    expect(result).toMatchObject({ kind: 'info', showIcon: false });
    const text = (result as { text: string }).text;
    expect(text).toMatch(/claude: API key · sk-ant-…9876/);
    expect(text).toMatch(/gpt: API key · sk-proj-…4321/);
    expect(text).not.toContain('pasted-key');
    expect(text).not.toContain('OPENAI_SECRET');
  });

  test('/info says when a provider has nothing configured', async () => {
    const result = await executeCommand('info', [], new Session());
    const text = (result as { text: string }).text;
    expect(text).toMatch(/claude: not configured/);
    expect(text).toMatch(/gpt: not configured/);
  });

  test('/logout leaves the subscription when that is active', () => {
    setSubscriptionEnabled('gpt', true);
    process.env.OPENAI_SECRET = 'sk-proj-from-env-4321';
    const result = executeCommand('logout', ['gpt'], new Session());
    expect(isSubscriptionEnabled('gpt')).toBe(false);
    expect(result).toEqual({
      kind: 'success',
      text: expect.stringMatching(/Signed out of the ChatGPT subscription\. gpt-\* models now use the OpenAI API key \(sk-proj-…4321\)/),
    });
  });

  test('/logout removes the stored key when that is active', () => {
    executeCommand('login', ['claude', 'api', 'sk-ant-pasted-key-9876'], new Session());
    const result = executeCommand('logout', ['claude'], new Session());
    expect(findApiKey('claude')).toBeNull();
    expect(result).toEqual({
      kind: 'success',
      text: 'Removed your saved Anthropic API key. claude-* models are signed out; run /login to sign in.',
    });
  });

  test('/logout has nothing to do when neither mechanism is active', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    expect(executeCommand('logout', ['claude'], new Session())).toEqual({
      kind: 'info',
      text: 'Nothing to sign out of for claude.',
    });
    expect(findApiKey('claude')).not.toBeNull();
  });
});
