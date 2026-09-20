import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import { CodexRpc } from '../../src/agent_runtime/providers/openai/codex-account';
import { providerFor } from '../../src/agent_runtime/providers';
import { usageCommand } from '../../src/commands/authentication/behavior';
import { cachedSubscriptionRemaining, readSubscriptionUsage } from '../../src/agent_runtime/providers/usage';
import { loadSubscriptionLimitCache, saveSubscriptionLimitCache } from '../../src/persistence';
import { TurnCancelledError } from '../../src/abort';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

const CONTEXT_MODEL = 'usage-command-model';

describe('/usage subscription allowance', () => {
  let directory: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.SIRUS_DATA_DIR;
    directory = mkdtempSync(path.join(tmpdir(), 'sirus-allowance-'));
    process.env.SIRUS_DATA_DIR = directory;
    providerFor('gpt').sources.addSubscription('default');
  });

  afterEach(() => {
    unbindRuntime(CONTEXT_MODEL);
    mock.restore();
    if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });

  // The account helper starts one app-server per call; this is the only thing
  // standing in for that process.
  function fakeAppServer(limits: () => unknown | Promise<unknown>) {
    const request = mock(async (method: string) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
      if (method === 'account/rateLimits/read') return limits();
      throw new Error(`Unexpected request: ${method}`);
    });
    spyOn(CodexRpc, 'start').mockResolvedValue({
      request, close: mock(() => {}),
    } as unknown as CodexRpc);
    return request;
  }

  test('fetches allowance without a model turn and reports each participant context', async () => {
    const request = fakeAppServer(() => ({ rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    } }));
    bindScriptedRuntime(CONTEXT_MODEL, (_input, emit) => {
      emit({ type: 'context', usage: { tokens: 12_000, window: 200_000 } });
      emit({ type: 'text', text: 'Done' });
    });
    const session = new Session({ name: 'Usage', model: CONTEXT_MODEL });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    const result = await usageCommand(undefined, session);
    // A login recorded before accounts were labelled is identified by asking the provider.
    expect(result.text).toContain('gpt · plus plan · 5h 70%');
    expect(result.text).toContain('session · @sirus ctx 12k (6% of 200k)');
    expect(request.mock.calls.map(([method]) => method).sort())
      .toEqual(['account/rateLimits/read', 'account/read']);
  });

  test('a quota read failure displays unavailable without hiding the session', async () => {
    fakeAppServer(() => { throw new Error('Unavailable'); });
    const result = await usageCommand(undefined, new Session());
    expect(result.text).toContain('gpt · plus plan · 5h unavailable');
    expect(result.text).toContain('session · no context reported yet');
    expect(result.text).not.toContain('100% remaining');
  });

  test('cancels a pending quota read', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    fakeAppServer(() => { started(); return new Promise(() => {}); });
    const controller = new AbortController();
    const pending = readSubscriptionUsage('gpt', controller.signal);
    await ready;
    controller.abort(new TurnCancelledError());
    await expect(pending).rejects.toThrow('Cancelled');
  });

  test('persists successful reads by account and keeps the cache when refresh fails', async () => {
    let fail = false;
    fakeAppServer(() => {
      if (fail) throw new Error('offline');
      return { rateLimits: { secondary: { usedPercent: 100, windowDurationMins: 10080 } } };
    });
    await readSubscriptionUsage('gpt', undefined, 'work');
    expect(loadSubscriptionLimitCache()).toMatchObject([
      { vendor: 'gpt', profile: 'work', period: '7-day', remaining: 0 },
    ]);
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day')).toBe(0);
    expect(cachedSubscriptionRemaining('gpt', 'personal', '7-day')).toBeUndefined();
    expect(cachedSubscriptionRemaining('claude', 'work', '7-day')).toBeUndefined();
    expect(cachedSubscriptionRemaining('gpt', 'work', '5-hour')).toBeUndefined();
    fail = true;
    await readSubscriptionUsage('gpt', undefined, 'work');
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day')).toBe(0);
  });

  test('expires cached windows and clears account values on removal or reauthentication', () => {
    const now = Date.now();
    const current = providerFor('gpt');
    current.sources.addSubscription('work');
    const entry = { vendor: 'gpt' as const, profile: 'work', period: '7-day' as const,
      remaining: 42, checkedAt: now, resetsAt: now + 1000 };
    saveSubscriptionLimitCache([entry]);
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now)).toBe(42);
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now + 1000)).toBeUndefined();
    saveSubscriptionLimitCache([{ ...entry, resetsAt: null }]);
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now + 7 * 86400_000)).toBeUndefined();
    current.sources.addSubscription('work');
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now)).toBeUndefined();
    saveSubscriptionLimitCache([entry]);
    current.sources.remove('work');
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now)).toBeUndefined();
  });
});
