import { expect, test } from 'bun:test';
import { Box, render, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { TurnStatus, turnPhase } from '../../src/frontend/chat/Chat';
import { ChatHistory } from '../../src/frontend/chat/ChatMessage';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import type { Message, ThoughtBlock, ToolCallBlock } from '../../src/agent_runtime/types';

const status = { awaitingApproval: false, awaitingAnswer: false, compacting: false, startedAt: Date.now() - 190_000, quietFor: () => 0 };
const thought: Message = { seq: 1, role: 'assistant', content: [{ type: 'thought', text: '**Inspecting helper AST limits**\nChecking unresolved edges.' }] };

test('uses current thought prose, with a fallback only when no thought is available', () => {
  expect(turnPhase([thought])).toBe('Inspecting helper AST limits');
  expect(turnPhase([{ ...thought, content: [{ type: 'thought', text: 'Checking\n  unresolved edges.' }] }])).toBe('Checking unresolved edges.');
  expect(turnPhase([{ ...thought, content: [{ type: 'thought', text: '  ' }] }])).toBe('thinking');
  expect(turnPhase([{ ...thought, content: [{ type: 'text', text: 'I will check.' }, ...thought.content] }])).toBe('Inspecting helper AST limits');
  expect(turnPhase([{ ...thought, content: [{ type: 'text', text: 'I will check.' }, { type: 'thought', text: '  ' }] }])).toBe('thinking');
  expect(turnPhase([{ ...thought, content: [...thought.content, { type: 'text', text: 'Result' }] }])).toBe('writing');
  const tool: ToolCallBlock = { type: 'tool_call', id: 'call', title: 'bun test', kind: 'execute', status: 'in_progress', locations: [], content: [] };
  expect(turnPhase([{ ...thought, content: [tool, ...thought.content] }])).toBe('running Run bun test');
  expect(turnPhase([{ ...thought, content: [...thought.content, { ...tool, status: 'completed' }] }])).toBe('thinking');
});

test('shows the live thought once, beside the spinner and elapsed time, within the terminal width', () => {
  for (const columns of [40, 80, 120]) {
    for (const text of ['**Inspecting helper AST limits**\nDetails', `**${'Unbroken'.repeat(40)}**\nDetails`]) {
      const message: Message = { ...thought, content: [{ type: 'thought', text }] };
      const output = stripAnsi(renderToString(<Box flexDirection="column" width={columns}>
        <ChatHistory messages={[message]} participants={[]} sessionId="test" participantColors={new Map()}
          isMessageLive={() => true} />
        <TurnStatus {...status} messages={[message]} />
      </Box>, { columns }));
      const lines = output.split('\n').filter(line => line.trim());
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/⠋.* · 3m \d+s/);
      expect(output).not.toContain('thinking');
      expect(output).not.toContain('**');
      expect(stringWidth(lines[0])).toBeLessThanOrEqual(columns);
    }
  }
});

test('thinking stays in the status line through tools, completion, and restored history', async () => {
  const first: ThoughtBlock = { type: 'thought', text: '**First step**\nFirst details.', startedAt: 0 };
  const next: ThoughtBlock = { type: 'thought', text: '**Next step**\nNext details.', startedAt: 7_000 };
  const tool: ToolCallBlock = { type: 'tool_call', id: 'call', title: 'bun test', kind: 'execute', status: 'in_progress', locations: [], content: [] };
  const message: Message = { seq: 1, role: 'assistant', content: [{ type: 'text', text: 'I will check.' }, first] };
  const stdout = Object.assign(new PassThrough(), { columns: 100 });
  let frame = '';
  stdout.on('data', data => { frame = stripAnsi(data.toString()); });
  const view = (live: boolean, entry = message) => <Box flexDirection="column">
    <ChatHistory messages={[entry]} participants={[]} sessionId="test" participantColors={new Map()} isMessageLive={() => live} />
    {live && <TurnStatus {...status} messages={[entry]} />}
  </Box>;
  const app = render(view(true), {
    stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const checkThoughts = () => {
    expect(frame).not.toContain('∴');
    expect(frame).not.toContain('Thought for');
    expect(frame).not.toContain('First details.');
    expect(frame).not.toContain('Next details.');
  };
  try {
    await app.waitUntilRenderFlush();
    expect(frame.match(/First step/g)).toHaveLength(1);
    checkThoughts();

    first.endedAt = 7_000;
    app.rerender(view(true));
    await app.waitUntilRenderFlush();
    expect(frame.match(/First step/g)).toHaveLength(1);
    checkThoughts();

    message.content.push(tool);
    app.rerender(view(true));
    await app.waitUntilRenderFlush();
    expect(frame).toContain('running Run bun test');
    expect(frame).not.toContain('First step');
    checkThoughts();

    tool.status = 'completed';
    message.content.push(next);
    app.rerender(view(true));
    await app.waitUntilRenderFlush();
    expect(frame.match(/Next step/g)).toHaveLength(1);
    expect(frame).not.toContain('First step');
    checkThoughts();

    next.endedAt = 10_000;
    message.content.push({ type: 'text', text: 'The final answer.' });
    app.rerender(view(true));
    await app.waitUntilRenderFlush();
    expect(frame).toContain('writing');
    expect(frame).not.toContain('Next step');
    checkThoughts();

    message.finishedAt = Date.now();
    for (const entry of [message, JSON.parse(JSON.stringify(message)) as Message]) {
      app.rerender(view(false, entry));
      await app.waitUntilRenderFlush();
      expect(frame).toContain('The final answer.');
      expect(frame).not.toContain('First step');
      expect(frame).not.toContain('Next step');
      checkThoughts();
    }
    expect(message.content.filter(block => block.type === 'thought')).toEqual([first, next]);
  } finally {
    app.unmount();
    await app.waitUntilExit();
    app.cleanup();
    stdout.destroy();
  }
});

test('sanitizes thought text in the status line', () => {
  const text = 'fetch 50%\r100% done\x07 \x1b]8;;https://elsewhere.example\x1b\\docs.example.com\x1b]8;;\x1b\\';
  const output = renderToString(<TurnStatus {...status} messages={[{ ...thought, content: [{ type: 'thought', text }] }]} />, { columns: 120 });
  expect(output).not.toMatch(/[\r\x07\x08]|\x1b\]/);
  expect(stripAnsi(output)).toContain('100% done docs.example.com');
  expect(stripAnsi(output)).not.toContain('50%');
  expect(stripAnsi(output)).not.toContain('elsewhere.example');
});

test('thought status expands on click and yields to approval, answers, and compaction', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 100 });
  let frame = '';
  stdout.on('data', data => { frame = stripAnsi(data.toString()); });
  const app = render(<TurnStatus {...status} messages={[thought]} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await app.waitUntilRenderFlush();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(frame).not.toContain('Checking unresolved edges.');
    const lines = frame.split('\n');
    const line = lines.findIndex(text => text.includes('Inspecting'));
    const cell = { line, col: lines[line]!.indexOf('Inspecting') + 1 };
    expect(pressAt(cell)).toBe(true);
    expect(releaseAt(cell)).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
    expect(frame).toContain('Checking unresolved edges.');
    for (const [flag, label] of [
      ['awaitingApproval', 'waiting for your approval'],
      ['awaitingAnswer', 'waiting for your answer'],
      ['compacting', 'compacting context'],
    ] as const) {
      app.rerender(<TurnStatus {...status} {...{ [flag]: true }} messages={[thought]} />);
      await app.waitUntilRenderFlush();
      expect(frame).toContain(label);
      expect(frame).not.toContain('Inspecting');
      expect(frame).not.toContain('Checking unresolved edges.');
    }
  } finally {
    app.unmount();
    await app.waitUntilExit();
    app.cleanup();
    stdout.destroy();
  }
});
