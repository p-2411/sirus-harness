import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { Box, render } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import type { Message } from '../../src/agent_runtime/types';
import Chat, { formatElapsed, promptHistory, turnPhase } from '../../src/frontend/chat/Chat';
import { infoCommandSpec } from '../../src/commands/authentication/commands';

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
  const app = render(createElement(Box, { height: 60, width: 140 },
    createElement(Chat, { currSession: session })), {
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

test('help and usage stay scrollable above the editor in an 80 by 24 terminal', async () => {
  const session = new Session();
  session.append({
    role: 'assistant', content: [{ type: 'text', text: [
      'Conversation remains available.',
      ...Array.from({ length: 24 }, (_, i) => `Conversation row ${i}.`),
    ].join('\n\n') }],
    usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120, contextWindow: 400_000 },
  });
  const originalMessages = [...session.getMessages()];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(createElement(Box, { width: 80, height: 24 },
    createElement(Box, { width: 26, flexShrink: 0 }),
    createElement(Chat, { currSession: session })), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  const type = async (input: string) => {
    stdin.write(input);
    if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
    await flush();
  };
  const expectEditor = () => {
    expect(output.split('\n').length).toBeLessThanOrEqual(24);
    expect(output).toContain('enter ↵');
    expect(output).toContain('ctx 120');
    expect(output).toContain('esc closes');
  };
  // The command layer has separate provider tests. Keep this rendering test
  // offline while exercising the same asynchronous /info completion path.
  const info = spyOn(infoCommandSpec, 'run').mockImplementation(() => Promise.resolve({
    kind: 'info' as const, showIcon: false,
    text: ['claude: subscription', ...Array.from({ length: 24 }, (_, i) => `window ${i}: 70% remaining`),
      'gpt: resets in 2h', 'session: 100 in · 20 out'].join('\n'),
  }));
  try {
    await flush();
    await type('\u001b[H');
    expect(output).toContain('Conversation remains available.');
    await type('/help');
    await type('\r');
    expect(output).toContain('commands');
    expect(output).not.toContain('ctrl+u');
    expectEditor();
    const firstPage = output;
    await type('\u001b[6~');
    expect(output).not.toBe(firstPage);
    expectEditor();
    await type('\u001b[5~');
    expect(output).toBe(firstPage);
    await type('\u001b[F');
    expect(output).toContain('ctrl+u');
    expect(output).toContain('delete the previous word');
    expectEditor();
    await type('\u001b[H');
    expect(output).toBe(firstPage);
    await type('\u001b');
    expect(output).toContain('Conversation remains available.');
    expect(output).not.toContain('esc closes');

    await type('/info');
    await type('\r');
    expect(info).toHaveBeenCalledTimes(1);
    expect(output).toContain('claude: subscription');
    expect(output).not.toContain('session: 100 in');
    expectEditor();
    await type('\u001b[F');
    expect(output).toContain('gpt: resets in 2h');
    expect(output).toContain('session: 100 in · 20 out');
    expectEditor();
    await type('\u001b');
    expect(output).toContain('Conversation remains available.');
    expect(session.getMessages()).toEqual(originalMessages);
  } finally {
    info.mockRestore();
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
