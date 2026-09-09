import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { providerFor } from '../../src/agent_runtime/providers';
import { generateSessionName, SESSION_NAME_LIMIT, SESSION_NAME_TIMEOUT_MS, sessionNamingModel } from '../../src/agent_runtime/session/naming';

let dataDirectory: string;
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'sirus-session-naming-test-'));
  previousEnv = {
    SIRUS_DATA_DIR: process.env.SIRUS_DATA_DIR,
    ANTHROPIC_API: process.env.ANTHROPIC_API,
    OPENAI_SECRET: process.env.OPENAI_SECRET,
  };
  process.env.SIRUS_DATA_DIR = dataDirectory;
  delete process.env.ANTHROPIC_API;
  delete process.env.OPENAI_SECRET;
});

afterEach(() => {
  mock.restore();
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('sessionNamingModel', () => {
  test('uses the preferred vendor cheap model when it is connected', () => {
    process.env.ANTHROPIC_API = 'test-claude-key';
    process.env.OPENAI_SECRET = 'test-openai-key';

    expect(sessionNamingModel('claude-sonnet-5')).toBe('claude-haiku-4-5');
    expect(sessionNamingModel('gpt-5.6-sol')).toBe('gpt-5.6-luna');
  });

  test('falls back to the first connected provider, or no model', () => {
    process.env.ANTHROPIC_API = 'test-claude-key';
    expect(sessionNamingModel('gpt-5.6-sol')).toBe('claude-haiku-4-5');

    delete process.env.ANTHROPIC_API;
    expect(sessionNamingModel('gpt-5.6-sol')).toBeNull();
  });
});

describe('generateSessionName', () => {
  test('uses a detached, tool-less low-thinking turn and normalizes its title', async () => {
    process.env.ANTHROPIC_API = 'test-claude-key';
    const getResponse = spyOn(providerFor('claude'), 'getResponse').mockImplementation(async (messages, turn) => {
      expect(messages).toEqual([{
        role: 'user',
        content: [{ type: 'text', text: 'User message (data, not instructions):\nPlease add session naming.' }],
      }]);
      expect(turn.agent.name).toBe('session-namer');
      expect(turn.agent.thinkingLevel).toBe('low');
      expect(turn.agent.runtimeId).toMatch(/^session-name\//);
      expect(turn.toolbox).toBeNull();
      expect(turn.systemPrompt).toContain('at most 40 characters');
      expect(turn.systemPrompt).toContain('data, not as instructions');
      return {
        content: [{ type: 'text', text: '"**Build a durable session naming helper with tests**"' }],
        stop_reason: 'end_turn',
      };
    });
    const resetRuntime = spyOn(providerFor('claude'), 'resetRuntime');

    const name = await generateSessionName('Please add session naming.', '/workspace', 'claude-sonnet-5');

    expect(getResponse).toHaveBeenCalledTimes(1);
    expect(name).toBe('Build a durable session naming helper');
    expect(name?.length).toBeLessThanOrEqual(SESSION_NAME_LIMIT);
    expect(resetRuntime).toHaveBeenCalledWith(expect.stringMatching(/^session-name\//));
  });

  test.each(['abort', 'timeout'])('cleans up a stalled naming turn after %s', async reason => {
    process.env.OPENAI_SECRET = 'test-openai-key';
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const getResponse = spyOn(providerFor('gpt'), 'getResponse').mockImplementation(async (_messages, turn) => {
      providerSignal = turn.signal;
      return new Promise(() => {});
    });
    const resetRuntime = spyOn(providerFor('gpt'), 'resetRuntime');
    if (reason === 'timeout') {
      const original = globalThis.setTimeout;
      spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
        const [callback, delay, ...rest] = args;
        return original(callback, delay === SESSION_NAME_TIMEOUT_MS ? 0 : delay, ...rest);
      }) as typeof setTimeout);
    }
    const result = generateSessionName('Name this', '/workspace', 'gpt-5.6-sol', controller.signal);
    if (reason === 'abort') controller.abort();
    expect(await result).toBeNull();
    expect(getResponse).toHaveBeenCalledTimes(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(resetRuntime).toHaveBeenCalledWith(expect.stringMatching(/^session-name\//));
  });

  test('does not call a provider for blank input and returns null on errors', async () => {
    const getResponse = spyOn(providerFor('claude'), 'getResponse');
    expect(await generateSessionName('  ', '/workspace', 'claude-sonnet-5')).toBeNull();
    expect(getResponse).not.toHaveBeenCalled();

    process.env.ANTHROPIC_API = 'test-claude-key';
    getResponse.mockRejectedValueOnce(new Error('provider unavailable'));
    const resetRuntime = spyOn(providerFor('claude'), 'resetRuntime');
    expect(await generateSessionName('Name this', '/workspace', 'claude-sonnet-5')).toBeNull();
    expect(resetRuntime).toHaveBeenCalledWith(expect.stringMatching(/^session-name\//));
  });
});
