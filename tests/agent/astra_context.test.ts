import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { SessionAgent } from '../../src/agent_runtime/agent';
import { TurnContext } from '../../src/agent_runtime/turn';
import { Session } from '../../src/agent_runtime/session';
import { contextWindowFor } from '../../src/agent_runtime/providers/providers';
import { CodexRpc } from '../../src/agent_runtime/providers/openai/codex-rpc';
import { subscriptionTransport, shutdownCodexRuntime } from '../../src/agent_runtime/providers/openai/codex-subscription';
import catalog from '../../src/agent_runtime/providers/openai/codex-models.json';

const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }];

describe('Astra context configuration', () => {
  afterEach(() => { shutdownCodexRuntime(); mock.restore(); });

  test('catalog enables the large window without enabling built-in execution tools', () => {
    const astra = catalog.models.find(model => model.slug === 'gpt-6-astra');
    expect(astra).toMatchObject({
      context_window: 1_050_000, max_context_window: 1_050_000,
      auto_compact_token_limit: 900_000, effective_context_window_percent: 95,
      shell_type: 'disabled', apply_patch_tool_type: null, tool_mode: 'direct',
    });
    expect(catalog.models.filter(model => model.slug !== 'gpt-6-astra')
      .every(model => model.context_window === 272_000 && model.max_context_window === 872_000)).toBe(true);
  });

  test('API fallback is model-specific and never replaces provider-reported windows', () => {
    expect(contextWindowFor('gpt-6-astra')).toBe(1_050_000);
    expect(contextWindowFor('gpt-5.6-sol')).toBe(400_000);
    expect(contextWindowFor('claude-sonnet-5')).toBe(200_000);
    expect(contextWindowFor('unknown')).toBeUndefined();
    const session = new Session('Astra', 'astra-window', 'gpt-6-astra');
    session.append({ role: 'assistant', model: 'gpt-6-astra', content: [],
      usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120 } });
    expect(session.getContextUsage()?.window).toBe(1_050_000);
    session.append({ role: 'assistant', model: 'gpt-6-astra', content: [],
      usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120, contextWindow: 284_000 } });
    expect(session.getContextUsage()?.window).toBe(284_000);
  });

  test('large budgets stay on Astra threads and model switches start fresh threads', async () => {
    shutdownCodexRuntime();
    const listeners = new Set<(method: string, params: Record<string, any>) => void>();
    const emit = (method: string, params: Record<string, any>) => {
      for (const listener of listeners) listener(method, params);
    };
    let thread = 0;
    const request = mock(async (method: string, params: Record<string, any> = {}) => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: `thread-${++thread}` } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          emit('thread/tokenUsage/updated', { threadId: params.threadId, tokenUsage: {
            total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            last: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            modelContextWindow: 997_500,
          } });
          emit('item/completed', { threadId: params.threadId, item: { type: 'agentMessage', text: 'Done' } });
          emit('turn/completed', { threadId: params.threadId, turn: { status: 'completed' } });
        });
        return { turn: { id: 'turn' } };
      }
      throw new Error(`Unexpected request ${method}`);
    });
    const start = spyOn(CodexRpc, 'start').mockResolvedValue({
      isAlive: true, close() {}, request,
      onNotification(handler: (method: string, params: Record<string, any>) => void) {
        listeners.add(handler); return () => { listeners.delete(handler); };
      },
      onRequest() {},
    } as unknown as CodexRpc);
    const agent = new SessionAgent({ name: 'sirus', model: 'gpt-6-astra', runtimeId: 'astra-budget' });
    const run = (tools: boolean) => subscriptionTransport.getResponse(messages,
      new TurnContext(agent, { directory: '/tmp', tools }));
    const response = await run(true);
    expect(response.usage?.contextWindow).toBe(997_500);
    await run(true); // reuse only while the model matches
    agent.model = 'gpt-5.6-sol';
    await run(true);
    agent.model = 'gpt-6-astra';
    await run(true);
    await run(false);
    agent.model = 'gpt-5.6-sol';
    await run(false);
    const threads = request.mock.calls.filter(([method]) => method === 'thread/start').map(([, params]) => params!);
    expect(threads.map(params => params.model)).toEqual([
      'gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra', 'gpt-5.6-sol',
    ]);
    for (const params of threads) {
      if (params.model === 'gpt-6-astra') expect(params.config).toMatchObject({
        model_context_window: 1_050_000, model_auto_compact_token_limit: 900_000,
      });
      else {
        expect(params.config.model_context_window).toBeUndefined();
        expect(params.config.model_auto_compact_token_limit).toBeUndefined();
      }
    }
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]?.model_context_window).toBeUndefined();
  });
});
