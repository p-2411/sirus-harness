import { describe, expect, test } from 'bun:test';
import { render, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import stripAnsi from 'strip-ansi';
import {
  callDetail,
  ChatMessage,
  messageSegments,
  toolLine,
  ToolRunGroup,
} from '../../src/frontend/chat/ChatMessage';
import {
  registerSubagent,
  unregisterSubagent,
  type SubagentRun,
} from '../../src/agent_runtime/tools/subagents';
import type { MessageBlock, ToolCallBlock } from '../../src/agent_runtime/types';

// Everything ACP guarantees on a tool call, so each case writes only the
// fields it is about.
function toolCall(call: Partial<ToolCallBlock> & { id: string }): ToolCallBlock {
  return {
    type: 'tool_call',
    kind: 'other',
    title: '',
    status: 'completed',
    locations: [],
    content: [],
    ...call,
  };
}

const calls: ToolCallBlock[] = [
  toolCall({ id: 'call-1', kind: 'read', title: 'one.ts' }),
  toolCall({ id: 'call-2', kind: 'execute', title: 'bun test' }),
];

// Where a marker sits in a rendered frame, so a click lands on the row that
// carries it rather than on a line number the layout might move.
function cellOf(frame: string, marker: string): { col: number; line: number } {
  const lines = frame.split('\n');
  const line = lines.findIndex(text => text.includes(marker));
  expect(line).toBeGreaterThanOrEqual(0);
  return { col: lines[line].indexOf(marker) + 1, line };
}

describe('chat message', () => {
  test('renders the participant that produced an assistant message', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{
        seq: 0,
        role: 'assistant',
        participant: 'reviewer',
        content: [{ type: 'text', text: 'Looks good.' }],
      }} />,
      { columns: 120 },
    ));

    expect(output).toContain('reviewer');
    expect(output).not.toContain('@reviewer');
  });

  test('renders the producing model next to an assistant participant', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage
        message={{
          seq: 0,
          role: 'assistant',
          participant: 'codex',
          content: [{ type: 'text', text: 'Done.' }],
        }}
        model="gpt-5.6-sol"
      />,
      { columns: 120 },
    ));

    expect(output).toContain('codex gpt-5.6-sol');
    expect(output).not.toContain('@codex');
  });

  test('does not render a model next to user messages', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage
        message={{ seq: 0, role: 'user', content: [{ type: 'text', text: 'Hello' }] }}
        model="gpt-5.6-sol"
      />,
      { columns: 120 },
    ));

    expect(output).toContain('you');
    expect(output).not.toContain('gpt-5.6-sol');
  });

  test('aligns user messages right and assistant messages left', () => {
    const userOutput = stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'user', content: [{ type: 'text', text: 'Hello' }] }} />,
      { columns: 40 },
    ));
    const assistantOutput = stripAnsi(renderToString(
      <ChatMessage message={{ seq: 1, role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }} />,
      { columns: 40 },
    ));
    const userLines = userOutput.split('\n');
    const assistantLines = assistantOutput.split('\n');

    expect(userLines[0].indexOf('you')).toBeGreaterThan(assistantLines[0].indexOf('sirus'));
    expect(userLines[1].indexOf('Hello')).toBeGreaterThan(assistantLines[1].indexOf('Hello'));
    expect(assistantLines[0]).toStartWith('   sirus');
    expect(assistantLines[1]).toStartWith('   Hello');
  });

  test('leads a tool row with the kind’s verb and the vendor’s title, not its input', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{
        seq: 0,
        role: 'assistant',
        content: [toolCall({
          id: 'call-1',
          kind: 'search',
          title: 'abcdefghijk',
          input: { query: 'abcdefghijk', limit: 5 },
        })],
      }} />,
      { columns: 120 },
    ));

    expect(output).toContain('● Search abcdefghijk');
    expect(output).not.toContain('limit');
  });

  test('names every ACP kind by its verb', () => {
    expect(toolLine({ kind: 'read', title: 'one.ts' })).toBe('Read one.ts');
    expect(toolLine({ kind: 'delete', title: 'old.ts' })).toBe('Delete old.ts');
    expect(toolLine({ kind: 'move', title: 'a → b' })).toBe('Move a → b');
    expect(toolLine({ kind: 'think', title: '' })).toBe('Think');
    expect(toolLine({ kind: 'fetch', title: 'https://example.com' })).toBe('Fetch https://example.com');
    expect(toolLine({ kind: 'switch_mode', title: 'auto' })).toBe('Mode auto');
    expect(toolLine({ kind: 'other', title: 'sirus - SpawnAgent' })).toBe('Tool sirus - SpawnAgent');
    // A title the caller has less room for than a row does.
    expect(toolLine({ kind: 'execute', title: 'bun test --coverage' }, 8)).toBe('Run bun tes…');
  });

  test('shows a file change as its line counts until expanded', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{
        seq: 0,
        role: 'assistant',
        content: [toolCall({
          id: 'call-1',
          kind: 'edit',
          title: 'src/app.ts',
          locations: [{ path: 'src/app.ts' }],
          content: [{ type: 'diff', path: 'src/app.ts', oldText: 'a\nb', newText: 'a\nb\nc\nd' }],
        })],
      }} />,
      { columns: 120 },
    ));

    expect(output).toContain('● Edit src/app.ts +4 −2');
    expect(output).not.toMatch(/[›⌄]/);
    expect(output).not.toContain('- a');
    expect(output).not.toContain('+ c');
  });

  test('shows file changes inside grouped tool activity as line counts', () => {
    const edit = toolCall({
      id: 'edit-1',
      kind: 'edit',
      title: 'src/new.ts',
      content: [{ type: 'diff', path: 'src/new.ts', oldText: null, newText: 'first\nsecond' }],
    });
    const output = stripAnsi(renderToString(
      <ToolRunGroup calls={[calls[0], edit]} />,
      { columns: 120 },
    ));

    expect(output).toContain('● Edit src/new.ts +2');
    expect(output).not.toContain('−');
    expect(output).not.toMatch(/[›⌄]/);
    expect(output).not.toContain('+ first');
  });

  test('reveals file rows when a running group completes, diffs on click, and respects manual collapse', async () => {
    const edit = toolCall({
      id: 'live-edit',
      kind: 'edit',
      title: 'new.ts',
      status: 'in_progress',
      content: [{ type: 'diff', path: 'new.ts', oldText: null, newText: 'new content' }],
    });
    const pending = [calls[0], edit];
    const completed = [calls[0], { ...edit, status: 'completed' as const }];
    const stdout = Object.assign(new PassThrough(), { columns: 120 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const app = render(<ToolRunGroup calls={pending} />, {
      stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('new.ts');
      app.rerender(<ToolRunGroup calls={completed} />);
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('● Edit new.ts +1');
      expect(frames.at(-1)).not.toMatch(/[›⌄]/);
      expect(frames.at(-1)).not.toContain('+ new content');

      await new Promise<void>(resolve => setImmediate(resolve));
      const row = cellOf(frames.at(-1)!, '● Edit new.ts');
      expect(pressAt(row)).toBe(true);
      expect(releaseAt(row)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('● Edit new.ts +1');
      expect(frames.at(-1)).not.toMatch(/[›⌄]/);
      expect(frames.at(-1)).toContain('+ new content');

      const summary = cellOf(frames.at(-1)!, 'Ran 2 commands');
      expect(pressAt(summary)).toBe(true);
      expect(releaseAt(summary)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('new.ts');
      app.rerender(<ToolRunGroup calls={[...completed]} />);
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('new.ts');
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });

  test('collapses consecutive tool calls only when there are two or more', () => {
    const content: MessageBlock[] = [
      { type: 'text', text: 'First' },
      calls[0],
      calls[1],
      { type: 'text', text: 'Second' },
      { ...calls[0], id: 'call-3' },
    ];

    const segments = messageSegments(content);

    expect(segments.map(segment => segment.type)).toEqual([
      'text',
      'tool_run',
      'text',
      'tool_call',
    ]);
  });

  test('summarizes completed and running tool groups while collapsed', () => {
    const completed = stripAnsi(renderToString(
      <ToolRunGroup calls={calls} />,
      { columns: 120 },
    ));
    const running = stripAnsi(renderToString(
      <ToolRunGroup calls={[calls[0], { ...calls[1], status: 'in_progress' }]} />,
      { columns: 120 },
    ));

    expect(completed).toContain('Ran 2 commands');
    expect(completed).not.toContain('one.ts');
    expect(running).toContain('Running 2 commands.');
    expect(running).not.toContain('bun test');
  });

  test('counts a failed call as finished', () => {
    const output = stripAnsi(renderToString(
      <ToolRunGroup calls={[calls[0], { ...calls[1], status: 'failed' }]} />,
      { columns: 120 },
    ));

    expect(output).toContain('Ran 2 commands');
  });

  test('expands a tool group into compact indented one-line calls', () => {
    const output = stripAnsi(renderToString(
      <ToolRunGroup calls={calls} defaultExpanded />,
      { columns: 120 },
    ));
    const lines = output.split('\n');

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('Ran 2 commands');
    expect(lines[2]).toContain('● Read one.ts');
    expect(lines[3]).toContain('● Run bun test');
    expect(lines[4]).toBe('');
    expect(lines[2].indexOf('●')).toBeGreaterThan(lines[1].indexOf('Ran'));
    expect(output).not.toMatch(/[›⌄]/);
  });

});

describe('what an expanded row reveals', () => {
  test('shows the diff of a change, then what the call produced', () => {
    expect(callDetail(toolCall({
      id: 'call-1',
      kind: 'edit',
      title: 'src/app.ts',
      content: [
        { type: 'diff', path: 'src/app.ts', oldText: 'a', newText: 'b' },
        { type: 'text', text: 'written' },
      ],
      input: { path: 'src/app.ts' },
    }))).toEqual([
      { sign: '-', text: 'a' },
      { sign: '+', text: 'b' },
      { sign: ' ', text: 'written' },
    ]);
  });

  test('falls back to a string output, then to the input', () => {
    expect(callDetail(toolCall({ id: 'call-2', kind: 'execute', title: 'bun test', output: '12 pass' })))
      .toEqual([{ sign: ' ', text: '12 pass' }]);
    expect(callDetail(toolCall({
      id: 'call-3',
      kind: 'fetch',
      title: 'example.com',
      input: { url: 'https://example.com', timeout: 30 },
    }))).toEqual([
      { sign: ' ', text: 'url: https://example.com' },
      { sign: ' ', text: 'timeout: 30' },
    ]);
  });

  test('cuts a long preview and says how much is left', () => {
    const detail = callDetail(toolCall({
      id: 'call-4',
      kind: 'read',
      title: 'long.txt',
      content: [{ type: 'text', text: Array.from({ length: 11 }, (_, index) => `line ${index}`).join('\n') }],
    }));

    expect(detail).toHaveLength(9);
    expect(detail.at(-1)).toEqual({ sign: '…', text: '3 more lines' });
  });
});

describe('thinking', () => {
  const message = {
    seq: 3,
    role: 'assistant' as const,
    content: [{ type: 'thought' as const, text: 'Weighing\nthe options carefully.' }],
  };

  test('collapses a thought to one line and expands it on a click', async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 120 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const app = render(<ChatMessage message={message} />, {
      stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('thinking Weighing the options carefully.');
      await new Promise<void>(resolve => setImmediate(resolve));
      const row = cellOf(frames.at(-1)!, 'thinking');
      expect(pressAt(row)).toBe(true);
      expect(releaseAt(row)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('thinking Weighing');
      expect(frames.at(-1)).toContain('Weighing');
      expect(frames.at(-1)).toContain('the options carefully.');
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });
});

describe('compaction rule', () => {
  const message = {
    seq: 7,
    role: 'assistant' as const,
    participant: 'sirus',
    content: [{ type: 'compaction' as const, summary: 'Earlier conversation: the summary body.' }],
  };

  test('renders a compaction block as a rule across the message', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={message} model="gpt-5.6-sol" />,
      { columns: 120 },
    ));
    expect(output).toContain('── context compacted · show summary ──');
    expect(output).not.toContain('the summary body');
  });

  test('offers no summary when the runtime reported none', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{ ...message, content: [{ type: 'compaction' }] }} />,
      { columns: 120 },
    ));
    expect(output).toContain('── context compacted ──');
    expect(output).not.toContain('summary');
  });

  test('shows the summary on a click and hides it on the next', async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 120 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const app = render(<ChatMessage message={message} />, {
      stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('the summary body');
      await new Promise<void>(resolve => setImmediate(resolve));
      const rule = cellOf(frames.at(-1)!, 'context compacted');
      expect(pressAt(rule)).toBe(true);
      expect(releaseAt(rule)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('hide summary');
      expect(frames.at(-1)).toContain('the summary body');

      expect(pressAt(rule)).toBe(true);
      expect(releaseAt(rule)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('show summary');
      expect(frames.at(-1)).not.toContain('the summary body');
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });
});

// A worker record as the chat reads it, with only the fields each case is
// about spelled out.
function workerRun(run: Partial<SubagentRun> & { id: string; callId: string }): SubagentRun {
  return {
    sessionId: 'session', owner: 'sirus', worker: null,
    model: 'claude-sonnet-5', thinkingLevel: 'medium', context: 'fresh',
    prompt: 'Work', directory: '/project', branch: null, status: 'working',
    startedAt: Date.now(), finishedAt: null, transcript: [], content: [],
    finalMessage: null, changes: [], error: null, reported: false, dismissed: false,
    ...run,
  };
}

describe('the SpawnAgent row', () => {
  const call: ToolCallBlock = toolCall({ id: 'spawn-call', title: 'sirus - SpawnAgent' });
  const row = (sessionId?: string) => renderToString(
    <ChatMessage message={{ seq: 0, role: 'assistant', content: [call] }} sessionId={sessionId} />,
    { columns: 140 },
  );

  test('names the run it started and follows it to the end', () => {
    const run = workerRun({
      id: 'sub-1234', callId: call.id, status: 'done', branch: 'sirus/sub-1234',
    });
    registerSubagent(run);
    try {
      expect(stripAnsi(row('session')))
        .toContain('● Tool claude-sonnet-5 sirus - SpawnAgent · sub-1234 · done · sirus/sub-1234');
      // A run of another session never decorates this one's row.
      expect(stripAnsi(row('elsewhere'))).not.toContain('sub-1234');
    } finally {
      unregisterSubagent(run.id);
    }
  });

  test('names a run the process left behind by that status', () => {
    const run = workerRun({ id: 'sub-5678', callId: call.id, status: 'interrupted' });
    registerSubagent(run);
    try {
      expect(stripAnsi(row('session'))).toContain('· sub-5678 · interrupted');
    } finally {
      unregisterSubagent(run.id);
    }
  });

  test('says nothing of a run no record survives', () => {
    const output = stripAnsi(row('session'));
    expect(output).toContain('● Tool sirus - SpawnAgent');
    expect(output).not.toContain('·');
  });
});

describe('a worker report', () => {
  const report = (participant: string) => stripAnsi(renderToString(
    <ChatMessage message={{
      seq: 0, role: 'assistant', participant,
      content: [{ type: 'text', text: 'Done; the branch is ready.' }],
    }} />,
    { columns: 120 },
  ));

  test('says who wrote it without borrowing a participant name', () => {
    expect(report('sub-1234')).toContain('sub-1234 · worker');
    expect(report('sub-1234')).toContain('Done; the branch is ready.');
    expect(report('reviewer')).not.toContain('worker');
  });
});
