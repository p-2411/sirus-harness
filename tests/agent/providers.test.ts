import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  authStatus,
  clearApiKey,
  findApiKey,
  maskApiKey,
  requireApiKey,
  setApiKey,
} from '../../src/agent/credentials';
import { isSubscriptionEnabled, setSubscriptionEnabled } from '../../src/agent/subscriptions';
import {
  AnthropicProvider,
  anthropicThinkingConfig,
  toAnthropicMessages,
} from '../../src/agent/providers/anthropic/api';
import { OpenAIProvider, toOpenAIContinuationInput, toOpenAIInput } from '../../src/agent/providers/openai/api';
import type { Message, ToolResultBlock } from '../../src/data/data';

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
    expect(findApiKey('claude')).toBeNull();
    expect(authStatus('claude')).toEqual({ mode: 'none' });
    expect(() => requireApiKey('claude')).toThrow(/\/login/);
    expect(() => requireApiKey('claude')).not.toThrow(/ANTHROPIC_API/);
  });

  test('falls back to the environment variable', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    expect(findApiKey('claude')).toEqual({ key: 'sk-ant-from-env-1234', source: 'env' });
    expect(authStatus('claude')).toEqual({ mode: 'api', source: 'env', masked: 'sk-ant-…1234' });
  });

  test('prefers a stored key over the environment variable', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    setApiKey('claude', '  sk-ant-stored-abcd  ');
    expect(requireApiKey('claude')).toBe('sk-ant-stored-abcd');
    expect(authStatus('claude')).toEqual({ mode: 'api', source: 'settings', masked: 'sk-ant-…abcd' });
  });

  test('storing a key switches the provider off its subscription', () => {
    setSubscriptionEnabled('claude', true);
    expect(authStatus('claude')).toEqual({ mode: 'subscription' });
    setApiKey('claude', 'sk-ant-stored-abcd');
    expect(isSubscriptionEnabled('claude')).toBe(false);
  });

  test('rejects an empty key and never stores it', () => {
    expect(() => setApiKey('claude', '   ')).toThrow(/empty/i);
    expect(findApiKey('claude')).toBeNull();
  });

  test('clearing a stored key reports whether one existed and restores the env fallback', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    setApiKey('claude', 'sk-ant-stored-abcd');
    expect(clearApiKey('claude')).toBe(true);
    expect(clearApiKey('claude')).toBe(false);
    expect(findApiKey('claude')).toEqual({ key: 'sk-ant-from-env-1234', source: 'env' });
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
    const context = { sessionId: 'test', directory: '/tmp' };
    await expect(AnthropicProvider.getResponse(messages, 'claude-sonnet-5', context))
      .rejects.toThrow(/No Anthropic API key. Run \/login/);
    await expect(OpenAIProvider.getResponse(messages, 'gpt-5.6-sol', context))
      .rejects.toThrow(/No OpenAI API key. Run \/login/);
  });
});
