import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import { CodexRpc } from '../../src/agent_runtime/providers/openai/codex-rpc';
import { shutdownCodexRuntime } from '../../src/agent_runtime/providers/openai/codex-subscription';
import { providerFor } from '../../src/agent_runtime/providers/providers';
import { infoCommand } from '../../src/commands/authentication/behavior';
import { cachedSubscriptionRemaining, readSubscriptionUsage } from '../../src/agent_runtime/providers/usage';
import { loadSubscriptionLimitCache, saveSubscriptionLimitCache } from '../../src/persistence';
import { TurnCancelledError } from '../../src/abort';

describe('/info subscription allowance', () => {
  let directory: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.SIRUS_DATA_DIR;
    directory = mkdtempSync(path.join(tmpdir(), 'sirus-allowance-'));
    process.env.SIRUS_DATA_DIR = directory;
    providerFor('gpt').setSource('subscription');
    shutdownCodexRuntime();
  });

  afterEach(async () => {
    shutdownCodexRuntime();
    await Promise.resolve();
    mock.restore();
    if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });

  function fakeRuntime(limits: () => unknown | Promise<unknown>) {
    const request = mock(async (method: string) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
      if (method === 'account/rateLimits/read') return limits();
      throw new Error(`Unexpected request: ${method}`);
    });
    spyOn(CodexRpc, 'start').mockResolvedValue({
      isAlive: true, request, close: mock(() => {}),
      onNotification: mock(() => () => {}), onRequest: mock(() => {}),
    } as unknown as CodexRpc);
    return request;
  }

  test('fetches allowance without a model turn and includes session token totals', async () => {
    const request = fakeRuntime(() => ({ rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    } }));
    const session = new Session('Usage');
    session.append({ role: 'assistant', content: [{ type: 'text', text: 'Done' }],
      usage: { inputTokens: 1000, outputTokens: 200, contextTokens: 1200, contextWindow: 400_000 } });
    const result = await infoCommand(undefined, session);
    expect(result.text).toContain('gpt: subscription · default');
    expect(result.text).toContain('5 hour: 70%');
    expect(result.text).toContain('session: 1k in · 200 out · context 1.2k');
    expect(request.mock.calls.map(([method]) => method).sort())
      .toEqual(['account/rateLimits/read']);
  });

  test('a quota read failure displays unavailable without hiding session data', async () => {
    fakeRuntime(() => { throw new Error('Unavailable'); });
    const result = await infoCommand(undefined, new Session());
    expect(result.text).toContain('gpt: subscription');
    expect(result.text).toContain('5 hour: unavailable');
    expect(result.text).toContain('session: token usage unavailable');
    expect(result.text).not.toContain('100% remaining');
  });

  test('cancels a pending quota read', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    fakeRuntime(() => { started(); return new Promise(() => {}); });
    const controller = new AbortController();
    const pending = readSubscriptionUsage('gpt', controller.signal);
    await ready;
    controller.abort(new TurnCancelledError());
    await expect(pending).rejects.toThrow('Cancelled');
  });

  test('persists successful reads by account and keeps the cache when refresh fails', async () => {
    let fail = false;
    fakeRuntime(() => {
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
    current.addSubscription('work');
    const entry = { vendor: 'gpt' as const, profile: 'work', period: '7-day' as const,
      remaining: 42, checkedAt: now, resetsAt: now + 1000 };
    saveSubscriptionLimitCache([entry]);
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now)).toBe(42);
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now + 1000)).toBeUndefined();
    saveSubscriptionLimitCache([{ ...entry, resetsAt: null }]);
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now + 7 * 86400_000)).toBeUndefined();
    current.addSubscription('work');
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now)).toBeUndefined();
    saveSubscriptionLimitCache([entry]);
    current.removeSource('work');
    expect(cachedSubscriptionRemaining('gpt', 'work', '7-day', now)).toBeUndefined();
  });
});
