import { expect, test } from 'bun:test';
import { Box, render, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { TurnStatus, turnPhase } from '../../src/frontend/chat/Chat';
import { ChatHistory } from '../../src/frontend/chat/ChatMessage';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import type { Message, ToolCallBlock } from '../../src/agent_runtime/types';

const status = { awaitingApproval: false, awaitingAnswer: false, compacting: false, startedAt: Date.now() - 190_000, quietFor: () => 0 };
const thought: Message = { seq: 1, role: 'assistant', content: [{ type: 'thought', text: '**Inspecting helper AST limits**\nChecking unresolved edges.' }] };

test('uses current thought prose, with a fallback only when no thought is available', () => {
  expect(turnPhase([thought])).toBe('Inspecting helper AST limits');
  expect(turnPhase([{ ...thought, content: [{ type: 'thought', text: 'Checking\n  unresolved edges.' }] }])).toBe('Checking unresolved edges.');
  expect(turnPhase([{ ...thought, content: [{ type: 'thought', text: '  ' }] }])).toBe('thinking');
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
          isMessageLive={() => true} hideThoughtFor={message.seq} />
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
