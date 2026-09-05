import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { maskApiKey } from '../../src/agent_runtime/providers/provider';
import {
  AnthropicProvider,
  OpenAIProvider,
  providerFor,
} from '../../src/agent_runtime/providers/providers';
import {
  anthropicThinkingConfig,
  anthropicUsage,
  toAnthropicMessages,
} from '../../src/agent_runtime/providers/anthropic/api';
import { openAIUsage, toOpenAIContinuationInput, toOpenAIInput } from '../../src/agent_runtime/providers/openai/api';
import { codexTurnUsage, shutdownCodexRuntime } from '../../src/agent_runtime/providers/openai/codex-subscription';
import { modelStrategies } from '../../src/agent_runtime/chat';
import { SessionAgent } from '../../src/agent_runtime/agent';
import { TurnContext } from '../../src/agent_runtime/turn';
import type { Message, ToolResultBlock } from '../../src/agent_runtime/types';

const toolHistory: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Read a file' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will read it.' },
      {
        type: 'tool_call',
        id: 'call_123',
        name: 'ReadFile',
        arguments: { path: 'hello.txt' },
      },
      {
        type: 'tool_result',
        callId: 'call_123',
        result: 'hello',
        isError: false,
      },
      { type: 'text', text: 'The file says hello.' },
    ],
  },
];

describe('provider tool history', () => {
  test('maps shared thinking levels to adaptive and legacy Claude requests', () => {
    expect(modelStrategies['claude-fable-5-1']).toBe(AnthropicProvider);
    expect(anthropicThinkingConfig('claude-fable-5-1', 'max')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    });
    expect(anthropicThinkingConfig('claude-opus-5', 'xhigh')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    });
    expect(anthropicThinkingConfig('claude-haiku-4.5', 'high')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });
  });

  test('labels named participants in provider history', () => {
    const history: Message[] = [{
      role: 'assistant',
      participant: 'reviewer',
      content: [{ type: 'text', text: 'I found an issue.' }],
    }];

    expect(toOpenAIInput(history)).toEqual([
      { role: 'assistant', content: '[Response from @reviewer]' },
      { role: 'assistant', content: 'I found an issue.' },
    ]);
    expect(toAnthropicMessages(history)).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: '[Response from @reviewer]' },
        { type: 'text', text: 'I found an issue.' },
      ],
    }]);
  });

  test('OpenAI receives function calls and matching outputs', () => {
    expect(toOpenAIInput(toolHistory)).toEqual([
      { role: 'user', content: 'Read a file' },
      { role: 'assistant', content: 'I will read it.' },
      {
        type: 'function_call',
        call_id: 'call_123',
        name: 'ReadFile',
        arguments: '{"path":"hello.txt"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'hello',
      },
      { role: 'assistant', content: 'The file says hello.' },
    ]);
  });

  test('OpenAI manually replays raw output before tool results', () => {
    const input = toOpenAIInput([
      { role: 'user', content: [{ type: 'text', text: 'Read a file' }] },
    ]);
    const output = [{
      type: 'function_call' as const,
      id: 'fc_123',
      call_id: 'call_123',
      name: 'ReadFile',
      arguments: '{"path":"hello.txt"}',
      status: 'completed' as const,
    }];
    const toolResults: ToolResultBlock[] = [{
      type: 'tool_result',
      callId: 'call_123',
      result: 'hello',
      isError: false,
    }];

    expect(toOpenAIContinuationInput(input, output, toolResults)).toEqual([
      { role: 'user', content: 'Read a file' },
      output[0],
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'hello',
      },
    ]);
  });

  test('Anthropic counts cached input and the completed output in context', () => {
    expect(anthropicUsage({
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 200,
      output_tokens: 300,
    })).toEqual({ inputTokens: 1_200, outputTokens: 300, contextTokens: 1_500 });
    expect(anthropicUsage({
      input_tokens: 100, output_tokens: 300, cache_read_input_tokens: null, cache_creation_input_tokens: null,
    }))
      .toEqual({ inputTokens: 100, outputTokens: 300, contextTokens: 400 });
  });

  test('OpenAI counts the completed output in context', () => {
    expect(openAIUsage({ input_tokens: 100, output_tokens: 300 }))
      .toEqual({ inputTokens: 100, outputTokens: 300, contextTokens: 400 });
  });

  test('Codex keeps the complete latest request as active context', () => {
    expect(codexTurnUsage(
      { totalTokens: 1_000, inputTokens: 800, outputTokens: 200, reasoningOutputTokens: 75 },
      { totalTokens: 350, inputTokens: 250, outputTokens: 100, reasoningOutputTokens: 75 },
      { totalTokens: 400, inputTokens: 300, outputTokens: 100, reasoningOutputTokens: 20 },
      400_000,
    )).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      contextTokens: 350,
      contextWindow: 400_000,
    });
  });

  test('Anthropic receives tool use and matching tool results', () => {
    expect(toAnthropicMessages(toolHistory)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Read a file' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will read it.' },
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'ReadFile',
            input: { path: 'hello.txt' },
          },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_123',
          content: 'hello',
          is_error: false,
        }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'The file says hello.' }],
      },
    ]);
  });
});

describe('provider credentials', () => {
  let directory: string;
  let previousDataDirectory: string | undefined;
  let previousEnvKey: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-credentials-test-'));
    previousDataDirectory = process.env.SIRUS_DATA_DIR;
    previousEnvKey = process.env.ANTHROPIC_API;
    process.env.SIRUS_DATA_DIR = directory;
    delete process.env.ANTHROPIC_API;
  });

  afterEach(() => {
    if (previousDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDataDirectory;
    if (previousEnvKey === undefined) delete process.env.ANTHROPIC_API;
    else process.env.ANTHROPIC_API = previousEnvKey;
    rmSync(directory, { recursive: true, force: true });
  });

  test('reports no credentials when neither a stored key nor the env var exists', () => {
    expect(providerFor('claude').apiKey()).toBeNull();
    expect(providerFor('claude').authStatus()).toEqual({ mode: 'none' });
    expect(() => providerFor('claude').requireApiKey()).toThrow(/\/login/);
    expect(() => providerFor('claude').requireApiKey()).not.toThrow(/ANTHROPIC_API/);
  });

  test('falls back to the environment variable', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    expect(providerFor('claude').apiKey()).toEqual({ key: 'sk-ant-from-env-1234', source: 'env', masked: 'sk-ant-…1234' });
    expect(providerFor('claude').authStatus()).toEqual({ mode: 'api', source: 'env', masked: 'sk-ant-…1234' });
  });

  test('prefers a stored key over the environment variable', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    providerFor('claude').setApiKey('  sk-ant-stored-abcd  ');
    expect(providerFor('claude').requireApiKey()).toBe('sk-ant-stored-abcd');
    expect(providerFor('claude').authStatus()).toEqual({ mode: 'api', source: 'settings', masked: 'sk-ant-…abcd' });
  });

  test('storing a key switches the provider off its subscription', () => {
    providerFor('claude').setSource('subscription');
    expect(providerFor('claude').authStatus()).toEqual({ mode: 'subscription' });
    providerFor('claude').setApiKey('sk-ant-stored-abcd');
    expect(providerFor('claude').source).toBe('api');
  });

  test('rejects an empty key and never stores it', () => {
    expect(() => providerFor('claude').setApiKey('   ')).toThrow(/empty/i);
    expect(providerFor('claude').apiKey()).toBeNull();
  });

  test('clearing a stored key reports whether one existed and restores the env fallback', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    providerFor('claude').setApiKey('sk-ant-stored-abcd');
    expect(providerFor('claude').clearApiKey()).toBe(true);
    expect(providerFor('claude').clearApiKey()).toBe(false);
    expect(providerFor('claude').apiKey()).toEqual({ key: 'sk-ant-from-env-1234', source: 'env', masked: 'sk-ant-…1234' });
  });

  test('masks short keys without revealing them', () => {
    expect(maskApiKey('sk-ant-api03-verylongkeyvalue9876')).toBe('sk-ant-…9876');
    expect(maskApiKey('sk-proj-openai-key-value-5555')).toBe('sk-proj-…5555');
    expect(maskApiKey('abc')).toBe('…');
  });
});

describe('API providers without credentials', () => {
  let directory: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-provider-test-'));
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

  test('fail before any request with a hint to /login', async () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const turnFor = (model: string) => new TurnContext(
      new SessionAgent({ name: 'sirus', model, runtimeId: 'test' }),
      { directory: '/tmp' },
    );
    await expect(AnthropicProvider.getResponse(messages, turnFor('claude-sonnet-5')))
      .rejects.toThrow(/No Anthropic API key. Run \/login/);
    await expect(OpenAIProvider.getResponse(messages, turnFor('gpt-5.6-sol')))
      .rejects.toThrow(/No OpenAI API key. Run \/login/);
  });
});

describe('Codex subscription runtime lifecycle', () => {
  beforeEach(async () => {
    // Other tests can populate the process-wide runtime before this suite runs.
    shutdownCodexRuntime();
    await Promise.resolve();
  });

  afterEach(async () => {
    shutdownCodexRuntime();
    await Promise.resolve();
    mock.restore();
  });

  test('closes the process-wide app-server when the frontend exits', async () => {
    const { CodexRpc } = await import('../../src/agent_runtime/providers/openai/codex-rpc');
    const { getCodexRpc, shutdownCodexRuntime } = await import(
      '../../src/agent_runtime/providers/openai/codex-subscription'
    );
    const close = mock(() => {});
    const rpc = {
      isAlive: true,
      close,
      onNotification: mock(() => () => {}),
      onRequest: mock(() => {}),
    } as unknown as Awaited<ReturnType<typeof CodexRpc.start>>;
    const start = spyOn(CodexRpc, 'start').mockResolvedValue(rpc);

    await getCodexRpc();
    shutdownCodexRuntime();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    // Cleanup is safe if more than one exit path observes the same shutdown.
    shutdownCodexRuntime();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('starts tool-enabled threads with workspace write access', async () => {
    const { CodexRpc } = await import('../../src/agent_runtime/providers/openai/codex-rpc');
    const { subscriptionTransport, shutdownCodexRuntime } = await import(
      '../../src/agent_runtime/providers/openai/codex-subscription'
    );

    let notify: (method: string, params: Record<string, unknown>) => void = () => {};
    const request = mock(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: 'thread-write-test' } };
      if (method === 'turn/start') {
        queueMicrotask(() => notify('turn/completed', {
          threadId: 'thread-write-test',
          turn: { status: 'completed' },
        }));
        return { turn: { id: 'turn-write-test' } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const rpc = {
      isAlive: true,
      close: mock(() => {}),
      request,
      onNotification: mock((handler: typeof notify) => {
        notify = handler;
        return () => {};
      }),
      onRequest: mock(() => {}),
    } as unknown as Awaited<ReturnType<typeof CodexRpc.start>>;
    spyOn(CodexRpc, 'start').mockResolvedValue(rpc);

    const turn = new TurnContext(
      new SessionAgent({ name: 'worker', model: 'gpt-5.6-sol', runtimeId: 'write-test' }),
      { directory: '/tmp', tools: true },
    );
    await subscriptionTransport.getResponse(
      [{ role: 'user', content: [{ type: 'text', text: 'Edit the file' }] }],
      turn,
    );

    const threadStart = request.mock.calls.find(([method]) => method === 'thread/start');
    expect(threadStart?.[1]).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect((threadStart?.[1]?.dynamicTools as Array<{ name: string }>).map(tool => tool.name))
      .toContain('WriteFile');
  });
});
