import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import { CodexRpc } from '../../src/agent_runtime/providers/openai/codex-rpc';
import { shutdownCodexRuntime } from '../../src/agent_runtime/providers/openai/codex-subscription';
import { providerFor } from '../../src/agent_runtime/providers/providers';
import { infoCommand } from '../../src/commands/authentication/behavior';
import { readSubscriptionUsage } from '../../src/agent_runtime/providers/usage';
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
    expect(result.text).toContain('gpt: subscription · plus plan');
    expect(result.text).toContain('70% remaining · 30% used');
    expect(result.text).toContain('session: 1k in · 200 out · context 1.2k');
    expect(request.mock.calls.map(([method]) => method).sort())
      .toEqual(['account/rateLimits/read', 'account/read']);
  });

  test('a quota read failure does not hide account or session data', async () => {
    fakeRuntime(() => { throw new Error('Unavailable'); });
    const result = await infoCommand(undefined, new Session());
    expect(result.text).toContain('plus plan');
    expect(result.text).toContain('allowance unavailable');
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
});
