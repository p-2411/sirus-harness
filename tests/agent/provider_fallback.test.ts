import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createProvider, type Transport } from '../../src/agent_runtime/providers/provider';
import { disposeAll, providerFor } from '../../src/agent_runtime/providers';
import { VENDOR_INFO } from '../../src/agent_runtime/providers/catalog';
import type { SubscriptionSource } from '../../src/agent_runtime/providers/sources';
import { saveApiKeys, saveSubscriptionPreferences, saveMemoryAccessPreference } from '../../src/persistence';
import { subscriptionEnvironment } from '../../src/agent_runtime/providers/profiles';
import { TurnContext } from '../../src/agent_runtime/turn';
import { SessionAgent } from '../../src/agent_runtime/agent';
import { TurnCancelledError } from '../../src/abort';
import type { Message, MessageBlock } from '../../src/agent_runtime/types';
import type { Response } from '../../src/agent_runtime/chat';
import { CodexRpc } from '../../src/agent_runtime/providers/openai/codex-rpc';
import { getCodexRpc } from '../../src/agent_runtime/providers/openai/codex-subscription';
import * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
import { readClaudeSubscriptionUsage } from '../../src/agent_runtime/providers/anthropic/claude-subscription';

const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Help' }] }];
const answer: Response = { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
const turn = (id = 'test') => new TurnContext(new SessionAgent({ name: 'sirus', model: 'gpt-test', runtimeId: id }), { directory: '/tmp' });

describe('multiple provider sources', () => {
  let directory: string;
  let previous: NodeJS.ProcessEnv;
  beforeEach(() => {
    previous = { ...process.env };
    directory = mkdtempSync(path.join(tmpdir(), 'sirus-fallback-'));
    process.env.SIRUS_DATA_DIR = directory;
    delete process.env.TEST_PROVIDER_KEY;
  });
  afterEach(() => {
    disposeAll();
    mock.restore();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(directory, { recursive: true, force: true });
  });
  function provider(request: (id: string, history: readonly Message[], context: TurnContext) => Promise<Response>) {
    const subscriptionFor = (id: string): Transport =>
      ({ toolExecution: 'delegated', getResponse: (history, context) => request(id, history, context) });
    return createProvider({
      vendor: { ...VENDOR_INFO.gpt, displayName: 'Test', apiKeyEnv: 'TEST_PROVIDER_KEY' },
      api: key => ({ toolExecution: 'host', getResponse: (history, context) => request(key(), history, context) }),
      subscriptionFor,
    });
  }
  const subscriptionsOf = (vendor: 'claude' | 'gpt'): SubscriptionSource[] =>
    providerFor(vendor).sources.list().filter((source): source is SubscriptionSource => source.kind === 'subscription');

  test('migrates legacy sources, saves multiple keys, and preserves unrelated settings', () => {
    saveApiKeys({ gpt: 'old-key' });
    saveSubscriptionPreferences({ gpt: true, claude: false });
    const current = provider(async () => answer);
    current.sources.addApiKey('new-key');
    current.sources.addApiKey('new-key');
    current.sources.addSubscription('second');
    saveMemoryAccessPreference(false);
    expect(provider(async () => answer).sources.list().map(source => source.kind))
      .toEqual(['subscription', 'api', 'subscription', 'api']);
    const file = path.join(directory, 'settings.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).memory.enabled).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('tries all keys and then the environment, keeping the successful source for the runtime', async () => {
    process.env.TEST_PROVIDER_KEY = 'env-key';
    const attempted: string[] = [];
    const current = provider(async key => { attempted.push(key); if (key !== 'env-key') throw new Error('429'); return answer; });
    current.sources.addApiKey('first'); current.sources.addApiKey('second');
    expect(await current.getResponse(messages, turn())).toEqual(answer);
    expect(attempted).toEqual(['second', 'first', 'env-key']);
    attempted.length = 0;
    await current.getResponse(messages, turn());
    expect(attempted).toEqual(['env-key']);
  });

  test('falls through isolated subscriptions and API sources', async () => {
    const attempted: string[] = [];
    const current = provider(async id => { attempted.push(id); if (id !== 'key') throw new Error('limit reached'); return answer; });
    current.sources.addApiKey('key'); current.sources.addSubscription('account-one'); current.sources.addSubscription('account-two');
    await current.getResponse(messages, turn());
    expect(attempted).toEqual(['account-two', 'account-one', 'key']);
  });

  test('reports exhaustion once with masked credentials', async () => {
    const request = mock(async (key: string) => { throw new Error(`invalid ${key}`); });
    const current = provider(request);
    current.sources.addApiKey('secret-first-1234'); current.sources.addApiKey('secret-second-5678');
    const failure = await current.getResponse(messages, turn()).catch(error => error as Error);
    if (!(failure instanceof Error)) throw new Error('Expected exhaustion');
    expect(failure.message).toContain('All Test sources failed (2)');
    expect(failure.message).not.toContain('secret-');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('never falls back after cancellation', async () => {
    const request = mock(async (_id: string, _history: readonly Message[], context: TurnContext) => {
      context.cancel(); throw new TurnCancelledError();
    });
    const current = provider(request);
    current.sources.addApiKey('one'); current.sources.addApiKey('two');
    await expect(current.getResponse(messages, turn())).rejects.toThrow('Cancelled');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('concurrent requests keep their own key while another request falls back', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const current = provider(async (key, _history, context) => {
      if (context.agent.runtimeId === 'slow') { await waiting; seen.push(key); return answer; }
      if (key === 'two') throw new Error('failed');
      release(); return answer;
    });
    current.sources.addApiKey('one'); current.sources.addApiKey('two');
    await Promise.all([current.getResponse(messages, turn('slow')), current.getResponse(messages, turn('fast'))]);
    expect(seen).toEqual(['two']);
  });

  test('removes one source without resurrecting a migrated key or dropping others', () => {
    saveApiKeys({ gpt: 'old-key' });
    const current = provider(async () => answer);
    current.sources.addApiKey('new-key');
    const storedKey = () => current.sources.list().find(source => source.kind === 'api' && !source.fromEnv);
    expect(current.sources.remove(storedKey()!.id)).toBe(true);
    expect(storedKey()).toMatchObject({ key: 'old-key' });
    expect(current.sources.remove(storedKey()!.id)).toBe(true);
    expect(current.sources.list()).toEqual([]);
    expect(provider(async () => answer).sources.list()).toEqual([]);
    expect(readFileSync(path.join(directory, 'settings.json'), 'utf8')).not.toContain('old-key');
  });

  test('retries a failed API tool continuation with its completed tool results', async () => {
    const tool: MessageBlock = { type: 'tool_call', id: 'call', name: 'WriteFile', arguments: {} };
    const result: MessageBlock = { type: 'tool_result', callId: 'call', result: 'saved', isError: false };
    let retried: readonly Message[] = [];
    const current = provider(async (id, history) => {
      if (id === 'two') return { content: [tool], stop_reason: 'tool_use',
        continueWithToolResults: async () => { throw new Error('quota'); } };
      retried = history; return answer;
    });
    current.sources.addApiKey('one'); current.sources.addApiKey('two');
    const context = turn();
    const response = await current.getResponse(messages, context);
    context.commit([tool, result]);
    expect(await response.continueWithToolResults!([result])).toEqual(answer);
    expect(retried.flatMap(message => message.content)).toContainEqual(result);
  });

  test('preserves completed subscription tools but clears failed draft text', async () => {
    const completed: MessageBlock[] = [
      { type: 'tool_call', id: 'call', name: 'WriteFile', arguments: {} },
      { type: 'tool_result', callId: 'call', result: 'saved', isError: false },
    ];
    let retried: readonly Message[] = [];
    const current = provider(async (id, history, context) => {
      if (id === 'two') { context.updateStream(completed); throw new Error('quota'); }
      retried = history; return answer;
    });
    current.sources.addSubscription('one'); current.sources.addSubscription('two');
    const context = turn();
    await current.getResponse(messages, context);
    expect(context.content).toEqual(completed);
    expect(retried.flatMap(message => message.content)).toContainEqual(completed[1]);
  });

  test('does not replay a subscription tool whose outcome is unknown', async () => {
    const request = mock(async (_id: string, _history: readonly Message[], context: TurnContext) => {
      context.updateStream([{ type: 'tool_call', id: 'call', name: 'WriteFile', arguments: {} }]);
      throw new Error('connection lost');
    });
    const current = provider(request);
    current.sources.addSubscription('one'); current.sources.addSubscription('two');
    await expect(current.getResponse(messages, turn())).rejects.toThrow('connection lost');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('profile environments are isolated and never mutate the parent', () => {
    process.env.ANTHROPIC_API_KEY = 'api-secret';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token';
    const one = subscriptionEnvironment('claude', 'one');
    const two = subscriptionEnvironment('claude', 'two');
    expect(one.CLAUDE_CONFIG_DIR).not.toBe(two.CLAUDE_CONFIG_DIR);
    expect(one.ANTHROPIC_API_KEY).toBeUndefined();
    expect(one.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe('api-secret');
    expect(subscriptionEnvironment('gpt', 'one').CODEX_HOME).not.toBe(one.CLAUDE_CONFIG_DIR);
    expect(() => subscriptionEnvironment('gpt', '../escape')).toThrow();
  });

  test('starts separate Codex servers per profile and closes all of them', async () => {
    const closes: ReturnType<typeof mock>[] = [];
    const start = spyOn(CodexRpc, 'start').mockImplementation(async () => {
      const close = mock(() => {}); closes.push(close);
      return { isAlive: true, close, onNotification: mock(() => () => {}), onRequest: mock(() => {}) } as unknown as CodexRpc;
    });
    const [one, two, oneAgain] = await Promise.all([getCodexRpc('one'), getCodexRpc('two'), getCodexRpc('one')]);
    expect(one).toBe(oneAgain); expect(one).not.toBe(two);
    expect(start.mock.calls[0]?.[2]?.CODEX_HOME).not.toBe(start.mock.calls[1]?.[2]?.CODEX_HOME);
    expect(start.mock.calls[0]?.[1]?.cli_auth_credentials_store).toBe('file');
    disposeAll(); await Promise.resolve();
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  test('repeating subscription login adds a profile instead of replacing the first account', async () => {
    const start = spyOn(CodexRpc, 'start').mockImplementation(async () => ({
      isAlive: true, close: mock(() => {}), onNotification: mock(() => () => {}), onRequest: mock(() => {}),
      request: mock(async () => ({ account: { type: 'chatgpt', email: 'test@example.com' } })),
    } as unknown as CodexRpc));
    await providerFor('gpt').login(() => {}); await providerFor('gpt').login(() => {});
    const sources = subscriptionsOf('gpt');
    expect(sources).toHaveLength(2);
    expect(sources[0]!.profile).not.toBe(sources[1]!.profile);
    expect(start.mock.calls[1]?.[2]?.CODEX_HOME).toContain(sources[0]!.profile);
  });

  test('reads Claude allowance from the requested isolated profile', async () => {
    const query = spyOn(ClaudeSdk, 'query').mockImplementation(() => ({
      initializationResult: async () => ({}), close: mock(() => {}),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true }),
    } as unknown as ClaudeSdk.Query));
    await Promise.all([readClaudeSubscriptionUsage(undefined, 'one'), readClaudeSubscriptionUsage(undefined, 'two')]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0].options?.env?.CLAUDE_CONFIG_DIR).toBe(path.join(directory, 'subscriptions', 'claude', 'one'));
    expect(query.mock.calls[1]?.[0].options?.env?.CLAUDE_CONFIG_DIR).toBe(path.join(directory, 'subscriptions', 'claude', 'two'));
  });
});
