import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import type { Message } from '../../src/agent_runtime/types';
import Chat, { formatElapsed, promptHistory, turnPhase } from '../../src/frontend/chat/Chat';

test('Escape dismisses help, command suggestions, login stages and secret entry', async () => {
  const session = new Session();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 60 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(createElement(Chat, { currSession: session }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  const type = async (input: string) => {
    stdin.write(input);
    // Ink buffers bare Escape briefly to distinguish it from arrow sequences.
    if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
    await flush();
  };
  try {
    await flush();
    await type('/help');
    await type('\r');
    expect(output).toContain('keyboard shortcuts');
    await type('\u001b');
    expect(output).not.toContain('keyboard shortcuts');

    await type('/log');
    expect(output).toContain('sign in with a subscription');
    await type('\u001b');
    expect(output).not.toContain('sign in with a subscription');
    expect(session.getInputContent()).toBe('/log');
    await type('i');
    expect(output).toContain('sign in with a subscription');
    await type('\r');
    expect(output).toContain('ChatGPT');
    await type('\u001b');
    expect(output).not.toContain('ChatGPT');

    await type('/login');
    await type('\r');
    await type('\r');
    expect(output).toContain('Subscription');
    await type('\u001b');
    expect(output).not.toContain('Subscription');

    await type('/login');
    await type('\r');
    await type('\r');
    await type('\u001b[B');
    await type('\r');
    expect(output).toContain('Paste your Anthropic API key');
    await type('not-a-real-key');
    await type('\u001b');
    expect(output).not.toContain('Paste your Anthropic API key');
    expect(session.getMessages()).toEqual([]);
  } finally {
    app.unmount();
    stdin.destroy();
    stdout.destroy();
  }
});

describe('chat input history', () => {
  test('collects user prompts in order and removes immediate duplicates', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];
    expect(promptHistory(messages)).toEqual(['first', 'second']);
  });
});

describe('turn status', () => {
  test('distinguishes thinking, tool activity, and writing', () => {
    expect(turnPhase([])).toBe('thinking');
    expect(turnPhase([{
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call-1', name: 'RunShell', arguments: { command: 'bun test' } }],
    }])).toBe('running RunShell');
    expect(turnPhase([{
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'call-1', name: 'RunShell', arguments: { command: 'bun test' } },
        { type: 'tool_result', callId: 'call-1', result: 'ok', isError: false },
        { type: 'text', text: 'All done' },
      ],
    }])).toBe('writing');
  });

  test('formats elapsed seconds and minutes', () => {
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
  });
});
