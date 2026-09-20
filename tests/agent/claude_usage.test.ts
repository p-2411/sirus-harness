import { describe, expect, test } from 'bun:test';
import type { SDKControlGetUsageResponse, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeSubscriptionUsageReader } from '../../src/agent_runtime/providers/anthropic/claude-account';
import { SIRUS_CLIENT_ID } from '../../src/version';

const usage: SDKControlGetUsageResponse = {
  session: {
    total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0,
    total_lines_added: 0, total_lines_removed: 0, model_usage: {},
  },
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 25, resets_at: '2026-09-05T08:00:00Z' } },
  behaviors: null,
};

function fakeQuery(readUsage: () => Promise<SDKControlGetUsageResponse> = async () => usage) {
  let closed = false;
  return {
    get closed() { return closed; },
    close() { closed = true; },
    async initializationResult() {
      return { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] };
    },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: readUsage,
  };
}

describe('Claude subscription usage', () => {
  test('asks on a query that receives no prompt, in the profile environment, and closes it', async () => {
    let inputFinished = false;
    let inputCount = 0;
    let consumeInput: Promise<void> | undefined;
    const temporary = fakeQuery(async () => {
      expect(inputFinished).toBe(false);
      expect(inputCount).toBe(0);
      return usage;
    });
    const read = createClaudeSubscriptionUsageReader({
      environment: () => ({ CLAUDE_CONFIG_DIR: '/profiles/work' }),
      createQuery: ({ prompt, options }) => {
        expect(options?.tools).toEqual([]);
        expect(options?.settingSources).toEqual([]);
        expect(options?.settings).toEqual({ disableAllHooks: true });
        expect(options?.persistSession).toBe(false);
        expect(options?.env).toEqual({
          CLAUDE_CONFIG_DIR: '/profiles/work',
          CLAUDE_AGENT_SDK_CLIENT_APP: SIRUS_CLIENT_ID,
        });
        consumeInput = (async () => {
          for await (const _ of prompt as AsyncIterable<SDKUserMessage>) inputCount++;
          inputFinished = true;
        })();
        return temporary;
      },
    });
    expect(await read()).toEqual(usage);
    await consumeInput;
    expect(inputFinished).toBe(true);
    expect(inputCount).toBe(0);
    expect(temporary.closed).toBe(true);
  });

  test('cleans up on an unsupported SDK or a failed request', async () => {
    for (const supported of [false, true]) {
      const temporary = fakeQuery(async () => { throw new Error('not authenticated'); });
      const read = createClaudeSubscriptionUsageReader({
        createQuery: () => supported ? temporary : {
          close: () => temporary.close(),
          initializationResult: temporary.initializationResult,
        },
      });
      await expect(read()).rejects.toThrow(supported ? 'not authenticated' : 'does not support subscription usage');
      expect(temporary.closed).toBe(true);
    }
  });

  test('bounds a stalled read', async () => {
    const stalled = fakeQuery(() => new Promise(() => {}));
    const read = createClaudeSubscriptionUsageReader({ createQuery: () => stalled, timeoutMs: 10 });
    await expect(read()).rejects.toThrow('Claude usage request timed out');
    expect(stalled.closed).toBe(true);
  });

  test('waits for initialization and bounds a stalled startup before requesting usage', async () => {
    let calls = 0;
    const temporary = fakeQuery(async () => { calls++; return usage; });
    temporary.initializationResult = () => new Promise(() => {});
    const read = createClaudeSubscriptionUsageReader({ createQuery: () => temporary, timeoutMs: 10 });
    await expect(read()).rejects.toThrow('Claude usage request timed out');
    expect(calls).toBe(0);
    expect(temporary.closed).toBe(true);
  });

  test('cancels a pending query and avoids launching for already-cancelled requests', async () => {
    const controller = new AbortController();
    const temporary = fakeQuery(() => new Promise(() => {}));
    let launches = 0;
    const read = createClaudeSubscriptionUsageReader({
      createQuery: () => { launches++; return temporary; },
    });
    const pending = read(controller.signal);
    controller.abort(new Error('cancel usage'));
    await expect(pending).rejects.toThrow('cancel usage');
    expect(temporary.closed).toBe(true);
    await expect(read(controller.signal)).rejects.toThrow('cancel usage');
    expect(launches).toBe(1);
  });
});
