import { describe, expect, spyOn, test } from 'bun:test';
import { render, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import stripAnsi from 'strip-ansi';
import * as markdown from '../../src/frontend/markdown/Markdown';
import {
  callDetail,
  ChatMessage,
  ChatHistory,
  messageSegments,
  PlanChecklist,
  toolLine,
  ToolRunGroup,
} from '../../src/frontend/chat/ChatMessage';
import {
  registerSubagent,
  notifySubagents,
  unregisterSubagent,
  type SubagentRun,
} from '../../src/agent_runtime/tools/subagents';
import { planCall, type Message, type MessageBlock, type PlanEntry, type ToolCallBlock } from '../../src/agent_runtime/types';

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
  test('memoises finished content without hiding streamed edits or late worker reports', async () => {
    const text = { type: 'text' as const, text: 'Initial reply' };
    const call = toolCall({ id: 'memo-worker', title: 'SpawnAgent' });
    const message: Message = { seq: 0, role: 'assistant', content: [text, call] };
    const markdownRender = spyOn(markdown, 'Markdown');
    const stdout = Object.assign(new PassThrough(), { columns: 120 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const history: Message = { seq: -1, role: 'user', content: [{ type: 'text', text: 'Earlier prompt' }] };
    const view = (live = false) => <ChatHistory messages={[history, message]} sessionId="session"
      participants={[{ name: 'sirus', model: 'gpt-5.6-luna' }]} isMessageLive={entry => entry === message && live}
      participantColors={new Map([['sirus', '#aaaaaa']])} />;
    const app = render(view(), { stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await app.waitUntilRenderFlush();
      const initialRenders = markdownRender.mock.calls.length;
      app.rerender(view());
      await app.waitUntilRenderFlush();
      expect(markdownRender.mock.calls.length).toBe(initialRenders);

      text.text = 'Streamed reply';
      app.rerender(view(true));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Streamed reply');
      expect(markdownRender.mock.calls.length).toBe(initialRenders + 1);
      text.text += ' continues';
      app.rerender(view(true));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Streamed reply continues');

      message.content.push({ type: 'thought', text: 'Still thinking' });
      app.rerender(view(true));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Still thinking');
      app.rerender(view());
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('Still thinking');

      call.output = 'Worker finished the review';
      app.rerender(view());
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Worker finished the review');
      message.content.push({ type: 'notice', severity: 'error', title: 'Connection lost' });
      app.rerender(view());
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Connection lost');
    } finally {
      markdownRender.mockRestore();
      app.unmount();
      await app.waitUntilExit();
    }
  });

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

  test('keeps every SpawnAgent row out of the group around it', () => {
    // A turn that delegates twice leaves two rows, each following its own run
    // and carrying its report, rather than one "Ran N commands" summary with
    // the reports folded away inside it.
    const spawn = (id: string, worker: string) => toolCall({
      id,
      kind: 'other',
      title: 'sirus - SpawnAgent',
      output: `Subagent ${worker} done after 45s.`,
    });
    const content: MessageBlock[] = [
      calls[0],
      calls[1],
      spawn('call-spawn-one', 'sub-1234'),
      spawn('call-spawn-two', 'sub-5678'),
    ];

    expect(messageSegments(content).map(segment => segment.type))
      .toEqual(['tool_run', 'tool_call', 'tool_call']);

    const output = stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'assistant', content }} sessionId="session" />,
      { columns: 140 },
    ));
    expect(output).toContain('Ran 2 commands');
    expect(output).toContain('Subagent sub-1234 done after 45s.');
    expect(output).toContain('Subagent sub-5678 done after 45s.');
  });

  test('recognizes Codex’s execute-kind MCP SpawnAgent title', () => {
    // Codex records an MCP call's arguments under `arguments`.
    const spawn = toolCall({
      id: 'mcp-spawn-call',
      kind: 'execute',
      title: 'mcp.sirus.SpawnAgent',
      content: [{ type: 'text', text: '{"id":"sub-1234"}' }],
      input: { server: 'sirus', tool: 'SpawnAgent', arguments: { prompt: 'Rewrite it', description: 'Loader rewrite', name: 'loader' } },
      output: 'Subagent loader (sub-1234) done.',
    });

    expect(messageSegments([calls[0], spawn, calls[1]]).map(segment => segment.type))
      .toEqual(['tool_call', 'tool_call', 'tool_call']);
    const output = stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'assistant', content: [spawn] }} sessionId="session" />,
      { columns: 140 },
    ));
    expect(output).toContain('● loader(Loader rewrite)');
    expect(output).toContain('Subagent loader (sub-1234) done.');
    expect(output).not.toContain('{"id":"sub-1234"}');
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

  test('leads with what a call produced rather than its raw output', () => {
    expect(callDetail(toolCall({
      id: 'call-6',
      kind: 'execute',
      title: 'bun test',
      content: [{ type: 'text', text: '12 pass' }],
      output: 'raw output',
    }))).toEqual([{ sign: ' ', text: '12 pass' }]);
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

  test('hides finished thoughts without leaving a speaker row', () => {
    expect(stripAnsi(renderToString(<ChatMessage message={message} />))).toBe('');
  });

  test('shows only the current thought and removes it when text or a tool follows', () => {
    const content: MessageBlock[] = [
      { type: 'thought', text: 'Earlier step' },
      { type: 'thought', text: '**Checking the result**\nDetails of the check.' },
    ];
    const output = () => stripAnsi(renderToString(
      <ChatMessage message={{ ...message, content }} live />, { columns: 120 },
    ));
    expect(output()).toContain('Checking the result');
    expect(output()).not.toContain('Earlier step');
    expect(output()).not.toContain('Details of the check');
    content.push(calls[0]!);
    expect(output()).not.toContain('Checking the result');
    expect(output()).toContain('one.ts');
    content.push({ type: 'thought', text: 'One last check' });
    expect(output()).toContain('One last check');
    content.push({ type: 'text', text: 'The final answer.' });
    expect(output()).not.toContain('One last check');
    expect(output()).toContain('The final answer.');
  });

  test('collapses a thought to one line and expands it on a click', async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 120 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const app = render(<ChatMessage message={message} live />, {
      stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Weighing the options carefully.');
      expect(frames.at(-1)).not.toContain('thinking');
      await new Promise<void>(resolve => setImmediate(resolve));
      const row = cellOf(frames.at(-1)!, 'Weighing');
      expect(pressAt(row)).toBe(true);
      expect(releaseAt(row)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('Weighing the options');
      expect(frames.at(-1)).toContain('Weighing');
      expect(frames.at(-1)).toContain('the options carefully.');
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });
});

describe('plan updates', () => {
  const entries: PlanEntry[] = [
    { content: 'Read the code', status: 'completed' },
    { content: 'Make the change', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' },
  ];
  const message = {
    seq: 4,
    role: 'assistant' as const,
    content: [planCall(entries)],
  };

  test('keeps each plan update out of the tool groups around it', () => {
    const content = [calls[0], calls[1], message.content[0], calls[0], calls[1], planCall([])];
    expect(messageSegments(content).map(segment => segment.type))
      .toEqual(['tool_run', 'plan', 'tool_run', 'plan']);
    const output = stripAnsi(renderToString(
      <ChatMessage message={{ ...message, content }} />, { columns: 120 },
    ));
    expect(output).toContain('Updated plan · 1 of 3 done');
    expect(output).toContain('Updated plan · 0 of 0 done');
    for (const entry of entries) expect(output).not.toContain(entry.content);
  });

  test('reveals the checklist on a click and collapses it on the next', async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 120 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const app = render(<ChatMessage message={message} />, {
      stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Updated plan · 1 of 3 done');
      expect(frames.at(-1)).not.toContain('Read the code');
      await new Promise<void>(resolve => setImmediate(resolve));
      const row = cellOf(frames.at(-1)!, 'Updated plan');
      expect(pressAt(row)).toBe(true);
      expect(releaseAt(row)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('✔ Read the code');
      expect(frames.at(-1)).toContain('▸ Make the change');
      expect(frames.at(-1)).toContain('○ Run the tests');

      expect(pressAt(row)).toBe(true);
      expect(releaseAt(row)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('Updated plan · 1 of 3 done');
      for (const entry of entries) expect(frames.at(-1)).not.toContain(entry.content);
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });
});

describe('vendor notices', () => {
  test('shows the title and description on one line, in their place in the reply', () => {
    const content: MessageBlock[] = [
      calls[0],
      { type: 'notice', severity: 'warning', title: 'Model\nfallback', description: 'Using\tthe available model.' },
      calls[1],
      { type: 'notice', severity: 'error', title: 'Task stopped' },
      { type: 'notice', severity: 'vendor-specific', title: 'Hook finished' },
    ];
    expect(messageSegments(content).map(segment => segment.type))
      .toEqual(['tool_call', 'notice', 'tool_call', 'notice', 'notice']);
    const output = stripAnsi(renderToString(
      <ChatMessage message={{ seq: 5, role: 'assistant', content }} />, { columns: 120 },
    ));
    expect(output).toContain('Model fallback · Using the available model.');
    expect(output.indexOf('one.ts')).toBeLessThan(output.indexOf('Model fallback'));
    expect(output.indexOf('Model fallback')).toBeLessThan(output.indexOf('bun test'));
    expect(output).toContain('Task stopped');
    expect(output).toContain('Hook finished');
  });

  test('truncates a long notice instead of wrapping its description', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{ seq: 6, role: 'assistant', content: [{
        type: 'notice', severity: 'info', title: 'Notice',
        description: 'A vendor update with a long description that must stay on one line.',
      }] }} />, { columns: 40 },
    ));
    const lines = output.split('\n').filter(line => line.trim());
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Notice · A vendor update');
    expect(output).not.toContain('must stay on one line.');
  });
});

describe('text from outside Sirus', () => {
  // What an agent or a tool can put in its text that the terminal would act
  // on: a progress bar's carriage return, a bell, and a link that shows one
  // address and opens another.
  const hostile = 'fetch 50%\r100% done\x07 \x1b]8;;https://elsewhere.example\x1b\\docs.example.com\x1b]8;;\x1b\\';
  const expectInert = (output: string) => {
    expect(output).not.toMatch(/[\r\x07\x08]|\x1b\]/);
    expect(stripAnsi(output)).toContain('100% done docs.example.com');
    expect(stripAnsi(output)).not.toContain('50%');
    expect(stripAnsi(output)).not.toContain('elsewhere.example');
  };
  // A thought shows only while it is the reply's current step.
  const rendered = (content: MessageBlock[]) => renderToString(
    <ChatMessage message={{ seq: 0, role: 'assistant', content }} sessionId="session" live />,
    { columns: 140 },
  );

  test('reaches the terminal as plain text in replies, thoughts, tool rows, plans and reports', () => {
    expectInert(rendered([{ type: 'text', text: hostile }]));
    expectInert(rendered([{ type: 'thought', text: hostile }]));
    expectInert(rendered([toolCall({ id: 'hostile-title', kind: 'execute', title: hostile })]));
    expectInert(renderToString(<PlanChecklist entries={[{ content: hostile, status: 'pending' }]} />, { columns: 140 }));
    const run = workerRun({ id: 'sub-hostile', callId: 'hostile-report', status: 'done' });
    registerSubagent(run);
    try {
      expectInert(rendered([toolCall({ id: 'hostile-report', title: 'sirus - SpawnAgent', output: hostile })]));
    } finally {
      unregisterSubagent(run.id);
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
    const app = render(<ChatMessage message={message} live />, {
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
    startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(), transcript: [], content: [],
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

  test('names the run it started by its task and follows it to the end', () => {
    const edit = toolCall({ id: 'edit', kind: 'edit', title: 'src/loader.ts', status: 'completed' });
    const read = toolCall({ id: 'read', kind: 'read', title: 'src/loader.ts', status: 'completed' });
    const run = workerRun({
      id: 'sub-1234', callId: call.id, status: 'done', branch: 'sirus/sub-1234', name: 'loader',
      description: 'Rewrite the loader', content: [read, edit], tokens: 12_300, startedAt: 0, finishedAt: 45_000,
    });
    registerSubagent(run);
    try {
      const output = stripAnsi(row('session'));
      // Claude Code's shape: the agent and its task, then how it went.
      expect(output).toContain('● loader(Rewrite the loader) · claude-sonnet-5 medium · sub-1234 · sirus/sub-1234');
      expect(output).toContain('⎿ Done (2 tool uses · 12k tokens · 45s)');
      // A run of another session never decorates this one's row.
      expect(stripAnsi(row('elsewhere'))).not.toContain('sub-1234');
    } finally {
      unregisterSubagent(run.id);
    }
  });

  test('counts what failed, and says why a spawn or a run failed', () => {
    const run = workerRun({
      id: 'sub-2468', callId: call.id, status: 'failed', error: 'Vendor refused the request', startedAt: 0, finishedAt: 3_000,
      content: [toolCall({ id: 'broken', kind: 'execute', title: 'bun test', status: 'failed' })],
    });
    registerSubagent(run);
    try {
      expect(stripAnsi(row('session'))).toContain('⎿ Failed (1 tool use · 1 failed · 3s): Vendor refused the request');
    } finally {
      unregisterSubagent(run.id);
    }
    // No worker was ever started: the tool's error is the reason.
    const refused = toolCall({
      id: 'refused-spawn', title: 'mcp__sirus__SpawnAgent', status: 'failed',
      input: { prompt: 'Review it', name: 'helper' },
      content: [{ type: 'text', text: 'Subagent name "helper" is already in use.' }],
    });
    expect(stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'assistant', content: [refused] }} sessionId="session" />,
      { columns: 140 },
    ))).toContain('● helper(Review it)\n        ⎿ Failed: Subagent name "helper" is already in use.');
  });

  test('updates a worker inside memoised history without a parent repaint', async () => {
    const run = workerRun({ id: 'sub-memo', callId: call.id });
    registerSubagent(run);
    const stdout = Object.assign(new PassThrough(), { columns: 140 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const app = render(<ChatHistory
      messages={[{ seq: 0, role: 'assistant', content: [call] }]}
      participants={[]} sessionId="session" participantColors={new Map()} isMessageLive={() => false}
    />, { stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('⎿ Working (0 tool uses)');
      run.status = 'done';
      notifySubagents();
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('⎿ Done (0 tool uses');
    } finally {
      app.unmount();
      await app.waitUntilExit();
      unregisterSubagent(run.id);
    }
  });

  test('names a run the process left behind by that status', () => {
    const run = workerRun({ id: 'sub-5678', callId: call.id, status: 'interrupted' });
    registerSubagent(run);
    try {
      expect(stripAnsi(row('session'))).toContain('⎿ Interrupted (0 tool uses · 0s): Sirus quit while it was working');
    } finally {
      unregisterSubagent(run.id);
    }
  });

  test('says nothing of a run no record survives', () => {
    const output = stripAnsi(row('session'));
    expect(output).toContain('● Agent');
    expect(output).not.toContain('·');
    expect(output).not.toContain('⎿');
  });

  test('sits directly under a neighbouring tool row', () => {
    const twins = [call, toolCall({ id: 'spawn-call-2', title: 'sirus - SpawnAgent' })];
    const lines = stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'assistant', content: twins }} />,
      { columns: 140 },
    )).split('\n');
    const rows = lines.flatMap((line, index) => line.includes('● Agent') ? [index] : []);
    expect(rows).toHaveLength(2);
    expect(rows[1] - rows[0]).toBe(1);
  });
});

describe('a worker report', () => {
  const report = ['Subagent sub-1234 done after 45s on claude-sonnet-5 (medium).', 'Task: Rewrite the loader'];
  const reported = (output: string) => toolCall({
    id: 'reported-call',
    title: 'sirus - SpawnAgent',
    content: [{ type: 'text', text: '{"id":"sub-1234","status":"working"}' }],
    output,
  });
  const row = (call: ToolCallBlock) => stripAnsi(renderToString(
    <ChatMessage message={{ seq: 0, role: 'assistant', content: [call] }} sessionId="session" />,
    { columns: 140 },
  ));

  test('shows under the row of the call that started the worker, not as a message', () => {
    const run = workerRun({ id: 'sub-1234', callId: 'reported-call', status: 'done' });
    registerSubagent(run);
    try {
      const output = row(reported(report.join('\n')));
      // Open without asking: the run has ended and this is what was waited for.
      for (const line of report) expect(output).toContain(line);
      expect(output).not.toContain('"status":"working"');
      // Its author is a run id, never a name on the roster, so no message of
      // the worker's own is written anywhere in the history.
      expect(output).not.toContain('sub-1234 · worker');
    } finally {
      unregisterSubagent(run.id);
    }
  });

  test('is shown whole, as Markdown', () => {
    const run = workerRun({ id: 'sub-1234', callId: 'reported-call', status: 'done' });
    registerSubagent(run);
    try {
      const lines = Array.from({ length: 11 }, (_, index) => `- line ${index}`).join('\n');
      const output = row(reported(`Final message:\n\n**Rewrote** the loader.\n\n${lines}`));
      expect(output).toContain('line 10');
      expect(output).not.toContain('more lines');
      expect(output).toContain('Rewrote the loader.');
      expect(output).not.toContain('**');
    } finally {
      unregisterSubagent(run.id);
    }
  });
});
