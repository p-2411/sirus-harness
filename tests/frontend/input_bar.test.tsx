import { describe, expect, test } from 'bun:test';
import { render as renderInk, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import { useState, useSyncExternalStore } from 'react';
import stripAnsi from 'strip-ansi';
import { InputBar } from '../../src/frontend/chat/InputBar';
import { ApprovalPrompt, approvalChoices } from '../../src/frontend/chat/ApprovalPrompt';
import { EntryInput, InputFeedback, QueuedRow } from '../../src/frontend/chat/InputRows';
import { SubagentStatusRow } from '../../src/frontend/chat/StatusRow';
import { WorkerStrip } from '../../src/frontend/chat/WorkerStrip';
import {
  applyInputEdit,
  normalizeNewlines,
  onFirstLine,
  onLastLine,
  type InputState,
} from '../../src/frontend/chat/editor';
import { moveSelection, SelectMenu } from '../../src/frontend/chat/SelectMenu';
import type { CommandMenuEntry, CommandMenuItem } from '../../src/commands/registry';
import type { Feedback } from '../../src/commands/feedback';
import { Session } from '../../src/agent_runtime/session';
import Sidebar from '../../src/frontend/Sidebar';
import type { ApprovalRequest } from '../../src/agent_runtime/permissions/approvals';
import type { PermissionOption } from '@agentclientprotocol/sdk';
import { notifySubagents, type SubagentRun } from '../../src/agent_runtime/tools/subagents';
import type { ToolCallBlock } from '../../src/agent_runtime/types';

describe('session input drafts', () => {
  test('edits and restores drafts when switching session panes with Option+arrows', async () => {
    const first = new Session();
    const second = new Session();
    first.setInputContent('First draft');
    second.setInputContent('Second draft');
    const sent: string[] = [];
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {},
      ref() {},
      unref() {},
    });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    let output = '';
    stdout.on('data', chunk => {
      const frame = stripAnsi(chunk.toString());
      if (frame.trim()) output = frame;
    });

    function Pane({ session }: { session: Session }) {
      useSyncExternalStore(cb => session.subscribe(cb), () => session.getVersion());
      return <InputBar
        inputContent={session.getInputContent()}
        setInputContent={value => session.setInputContent(value)}
        send={value => sent.push(value)}
        disabled={false}
        feedback={null}
        participants={[]}
      />;
    }

    function Workspace() {
      const [session, setSession] = useState(first);
      return <>
        <Sidebar
          sessions={[first, second]}
          currSession={session}
          selectSession={setSession}
          addSession={() => {}}
          deleteSession={() => {}}
        />
        <Pane key={session.getId()} session={session} />
      </>;
    }

    const app = renderInk(<Workspace />, {
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
    const type = async (input: string) => { stdin.write(input); await flush(); };
    try {
      await flush();
      expect(output).toContain('First draft▌');
      await type('!');
      expect(first.getInputContent()).toBe('First draft!');
      expect(output).toContain('First draft!▌');

      await type('\u001b[1;3B');
      expect(output).toContain('Second draft▌');
      await type('\u007f');
      expect(second.getInputContent()).toBe('Second draf');

      await type('\u001b[1;3A');
      expect(output).toContain('First draft!▌');
      await type('\r');
      expect(sent).toEqual(['First draft!']);
      expect(first.getInputContent()).toBe('');
      expect(second.getInputContent()).toBe('Second draf');

      // An open command menu must not capture the session shortcut.
      await type('/');
      await type('\u001b[1;3B');
      expect(output).toContain('Second draf▌');
      await type('\u001b[1;3A');
      expect(first.getInputContent()).toBe('/');
      expect(output).toContain('/▌');
    } finally {
      app.unmount();
      stdin.destroy();
      stdout.destroy();
    }
  });
});

function render(feedback: Feedback | null): string {
  return stripAnsi(renderToString(
    <InputFeedback feedback={feedback} />,
    { columns: 80 },
  ));
}

describe('input feedback', () => {
  test('renders successful commands with a check', () => {
    expect(render({ kind: 'success', text: 'Session history cleared.' }))
      .toContain('✓ Session history cleared.');
  });

  test('renders status updates with an arrow', () => {
    expect(render({ kind: 'info', text: 'Opening your browser…' }))
      .toContain('→ Opening your browser…');
  });

  test('can render informational output without an arrow', () => {
    expect(render({ kind: 'info', text: 'claude: not configured', showIcon: false }))
      .toBe('   claude: not configured');
  });

  test('renders errors with an exclamation mark', () => {
    expect(render({ kind: 'error', text: 'Login failed' })).toContain('! Login failed');
  });

  test('takes no vertical space when there is no feedback', () => {
    expect(render(null)).toBe('');
  });
});

describe('input status', () => {
  test('shows the active model and thinking level together', () => {
    const output = stripAnsi(renderToString(
      <SubagentStatusRow model="gpt-5.6-sol" thinkingLevel="high" />,
      { columns: 80 },
    ));
    expect(output).toContain('gpt-5.6-sol · high');
  });

  test('shows context usage beside the model', () => {
    const output = stripAnsi(renderToString(
      <SubagentStatusRow
        contextUsage={{ tokens: 150_000, window: 200_000 }}
        model="claude-sonnet-5"
      />,
      { columns: 100 },
    ));
    expect(output).toContain('ctx 150k (75%) · claude-sonnet-5');
  });

  test('qualifies the mode with what the vendor made of it', () => {
    const notice = 'auto approve is unavailable on claude-haiku-4-5; the agent is on Manual';
    const output = stripAnsi(renderToString(
      <SubagentStatusRow permissionMode="auto" modeNotice={notice} />,
      { columns: 120 },
    ));
    expect(output).toContain(`auto approve · ${notice} · shift+tab`);
    expect(stripAnsi(renderToString(
      <SubagentStatusRow permissionMode="auto" modeNotice={null} />,
      { columns: 120 },
    ))).toContain('auto approve · shift+tab');
  });

  test('lists queued messages in order on single lines', () => {
    const output = stripAnsi(renderToString(
      <QueuedRow messages={['fix the test', 'then update\nthe readme']} />,
      { columns: 100 },
    ));
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('⋮ fix the test');
    expect(lines[1]).toContain('⋮ then update the readme');
    expect(output).not.toContain('queued');
    expect(renderToString(<QueuedRow messages={[]} />, { columns: 100 })).toBe('');
  });
});

describe('input cursor editing', () => {
  test('moves left and right and inserts at the cursor', () => {
    let state: InputState = { text: 'helo', cursor: 4 };
    state = applyInputEdit(state, { type: 'left' });
    state = applyInputEdit(state, { type: 'insert', text: 'l' });
    expect(state).toEqual({ text: 'hello', cursor: 4 });

    state = applyInputEdit(state, { type: 'right' });
    expect(state.cursor).toBe(5);
  });

  test('backspace edits before the cursor without damaging Unicode', () => {
    let state: InputState = { text: 'a🐎b', cursor: 3 };
    state = applyInputEdit(state, { type: 'left' });
    expect(state.cursor).toBe(1);
    state = applyInputEdit(state, { type: 'right' });
    expect(state.cursor).toBe(3);
    state = applyInputEdit(state, { type: 'backspace' });
    expect(state).toEqual({ text: 'ab', cursor: 1 });
  });

  test('moves vertically through multiline prompts and detects their edges', () => {
    let state: InputState = { text: 'one\ntwelve\nxyz', cursor: 8 };
    expect(onFirstLine(state)).toBe(false);
    expect(onLastLine(state)).toBe(false);

    state = applyInputEdit(state, { type: 'up' });
    expect(state.cursor).toBe(3);
    expect(onFirstLine(state)).toBe(true);

    state = applyInputEdit(state, { type: 'down' });
    state = applyInputEdit(state, { type: 'down' });
    expect(state.cursor).toBe(14);
    expect(onLastLine(state)).toBe(true);
  });

  test('vertical movement preserves Unicode characters before editing', () => {
    let state: InputState = { text: 'ab\n🐎b', cursor: 1 };
    state = applyInputEdit(state, { type: 'down' });
    expect(state.cursor).toBe(5);
    state = applyInputEdit(state, { type: 'backspace' });
    expect(state).toEqual({ text: 'ab\nb', cursor: 3 });

    state = applyInputEdit({ text: '🐎b\nab', cursor: 5 }, { type: 'up' });
    expect(state.cursor).toBe(2);
  });

  test('vertical movement handles a leading empty line at cursor zero', () => {
    const state = { text: '\nnext', cursor: 0 };
    expect(applyInputEdit(state, { type: 'up' })).toEqual(state);
    expect(applyInputEdit(state, { type: 'down' }).cursor).toBe(1);
  });

  test('normalizes pasted Windows and classic Mac line endings', () => {
    expect(normalizeNewlines('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });
});

describe('approval prompt', () => {
  // Both adapters offer all four options; the prompt follows their order.
  const OPTIONS: PermissionOption[] = [
    { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
    { optionId: 'always', name: 'Yes, and don’t ask again', kind: 'allow_always' },
    { optionId: 'reject', name: 'No', kind: 'reject_once' },
    { optionId: 'never', name: 'No, and don’t ask again', kind: 'reject_always' },
  ];

  function approval(toolCall: ToolCallBlock, options: PermissionOption[] = OPTIONS): ApprovalRequest {
    return {
      id: 'approval-1',
      sessionId: 'session-1',
      requester: { participant: 'sirus' },
      toolCall,
      options,
    };
  }

  const render = (request: ApprovalRequest, waiting = 0) => stripAnsi(renderToString(
    <ApprovalPrompt request={request} waiting={waiting} selected={0} />,
    { columns: 100 },
  ));

  test('names the call the way the transcript does and lists the vendor’s options', () => {
    const output = render(approval({
      type: 'tool_call',
      id: 'call-1',
      kind: 'edit',
      title: 'src/app.ts',
      status: 'pending',
      locations: [{ path: 'src/app.ts' }],
      content: [{ type: 'diff', path: 'src/app.ts', oldText: 'old', newText: 'new' }],
    }), 1);

    expect(output).toContain('@sirus wants to edit src/app.ts · 1 more waiting');
    expect(output).toContain('src/app.ts');
    expect(output).toContain('- old');
    expect(output).toContain('+ new');
    for (const label of ['Allow once', 'Allow for this session', 'Deny', 'Deny for this session']) {
      expect(output).toContain(label);
    }
  });

  test('offers only what the vendor offered', () => {
    const output = render(approval({
      type: 'tool_call',
      id: 'call-2',
      kind: 'execute',
      title: 'bun test',
      status: 'pending',
      locations: [],
      content: [],
      input: { command: 'bun test --coverage' },
    }, OPTIONS.filter(option => option.kind !== 'allow_always')));

    expect(output).toContain('@sirus wants to run bun test');
    expect(output).toContain('$ bun test --coverage');
    expect(output).not.toContain('Allow for this session');
    // Keys and decisions follow the option kinds, in the vendor's order.
    expect(approvalChoices(approval({
      type: 'tool_call', id: 'call-2', kind: 'execute', title: 'bun test',
      status: 'pending', locations: [], content: [],
    })).map(choice => `${choice.key}:${choice.decision}`))
      .toEqual(['y:allow', 'a:allow-session', 'n:deny', 'd:deny']);
  });

  test('cuts an unrecognised input down to a readable line', () => {
    const output = render(approval({
      type: 'tool_call',
      id: 'call-3',
      kind: 'other',
      title: 'sirus - SaveMemory',
      status: 'pending',
      locations: [],
      content: [],
      input: { note: 'x'.repeat(400) },
    }));

    expect(output).toContain('@sirus wants to tool sirus - SaveMemory');
    expect(output).toContain('…');
    expect(output).not.toContain('x'.repeat(300));
  });
});

describe('select menu', () => {
  const items: CommandMenuItem[] = [
    { type: 'item', key: 'a', label: 'Claude · subscription', description: 'browser sign-in', command: '/login claude' },
    { type: 'item', key: 'b', label: 'Anthropic · API key', description: 'paste a key', command: '/login claude api', secret: { prompt: 'Paste your Anthropic API key' } },
  ];

  test('marks only the selected item', () => {
    const output = stripAnsi(renderToString(<SelectMenu items={items} selected={1} />, { columns: 80 }));
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/^\s{2,}Claude · subscription\s+browser sign-in/);
    expect(lines[1]).toMatch(/^\s*› Anthropic · API key\s+paste a key/);
  });

  test('moves the selection with wrap-around', () => {
    expect(moveSelection(0, 1, 2)).toBe(1);
    expect(moveSelection(1, 1, 2)).toBe(0);
    expect(moveSelection(0, -1, 2)).toBe(1);
  });

  test('renders headings without making them selectable', () => {
    const grouped: CommandMenuEntry[] = [
      { type: 'heading', key: 'anthropic', label: 'Anthropic' },
      { type: 'item', key: 'claude', label: 'claude-sonnet-5', command: '/model claude-sonnet-5' },
      { type: 'heading', key: 'openai', label: 'OpenAI' },
      { type: 'item', key: 'gpt', label: 'gpt-5.6-sol', command: '/model gpt-5.6-sol' },
    ];
    const output = stripAnsi(renderToString(<SelectMenu items={grouped} selected={1} />, { columns: 80 }));
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toEqual([
      '   Anthropic',
      '     claude-sonnet-5',
      '   OpenAI',
      '   › gpt-5.6-sol',
    ]);
  });
});

describe('entry input', () => {
  test('shows the prompt and one dot per character, never the value', () => {
    const output = stripAnsi(renderToString(
      <EntryInput prompt="Paste your Anthropic API key" value="sk-ant-1234" masked />,
      { columns: 80 },
    ));
    expect(output).toContain('Paste your Anthropic API key');
    expect(output).toContain('•'.repeat('sk-ant-1234'.length));
    expect(output).not.toContain('sk-ant');
  });

  test('shows an ordinary value as it is typed', () => {
    const output = stripAnsi(renderToString(
      <EntryInput prompt="Message for sub-1234" value="check the tests too" masked={false} />,
      { columns: 80 },
    ));
    expect(output).toContain('Message for sub-1234: check the tests too');
    expect(output).not.toContain('•');
  });
});

// A worker record as the strip reads it: everything the session would carry,
// so each case writes only the fields it is about.
function worker(run: Partial<SubagentRun> & { id: string }): SubagentRun {
  return {
    callId: null, sessionId: 'session', owner: 'sirus', worker: null,
    model: 'claude-sonnet-5', thinkingLevel: 'medium', context: 'fresh',
    prompt: 'Work', directory: '/project', branch: null, status: 'working',
    startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(), transcript: [], content: [],
    finalMessage: null, changes: [], error: null, reported: false, dismissed: false,
    ...run,
  };
}

describe('worker strip', () => {
  const now = Date.now();
  const running = [
    worker({
      id: 'sub-one', model: 'gpt-5.6-terra', thinkingLevel: 'high',
      startedAt: now - 45_000, updatedAt: now - 2_000, branch: 'sirus/sub-one',
      content: [
        { type: 'tool_call', id: 'one', kind: 'read', title: 'notes.md', status: 'completed', locations: [], content: [] },
        { type: 'tool_call', id: 'two', kind: 'execute', title: 'bun test', status: 'pending', locations: [], content: [] },
      ],
    }),
    worker({ id: 'sub-two', startedAt: now - 45_000, updatedAt: now - 1_000 }),
    worker({ id: 'sub-three', startedAt: now - 45_000, updatedAt: now }),
  ];

  test('shows the run that changed last, and how many are behind it', () => {
    const lines = stripAnsi(renderToString(
      <WorkerStrip workers={[running[0], running[1]]} />,
      { columns: 120 },
    )).split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1/2 ● sub-two · claude-sonnet-5 medium · 45s · starting');
    // Alone, a run needs no counter.
    expect(stripAnsi(renderToString(<WorkerStrip workers={[running[0]]} />, { columns: 120 })))
      .toContain('● sub-one · gpt-5.6-terra high · 45s · Run bun test · sirus/sub-one');
  });

  test('takes no vertical space without workers to show', () => {
    expect(renderToString(<WorkerStrip workers={[]} />, { columns: 120 })).toBe('');
    expect(renderToString(
      <WorkerStrip workers={[worker({ id: 'sub-gone', status: 'done', dismissed: true })]} />,
      { columns: 120 },
    )).toBe('');
  });

  test('keeps a finished line for a second, saying how it ended', () => {
    const line = (finishedAt: number) => stripAnsi(renderToString(
      <WorkerStrip workers={[worker({
        id: 'sub-done', status: 'done', startedAt: finishedAt - 45_000, finishedAt,
      })]} />,
      { columns: 120 },
    ));
    expect(line(Date.now())).toContain('● sub-done · claude-sonnet-5 medium · 45s · done');
    // A second later the strip belongs to the runs still working; `/agents`
    // still lists the one that ended.
    expect(line(Date.now() - 2_000)).toBe('');
  });

  test('says a worker is starting until its first tool call', () => {
    const output = stripAnsi(renderToString(
      <WorkerStrip workers={[worker({ id: 'sub-new', startedAt: Date.now() })]} />,
      { columns: 120 },
    ));
    expect(output).toContain('sub-new · claude-sonnet-5 medium · 0s · starting');
    expect(output).not.toContain('·  · ');
  });
});

describe('walking the worker strip from the input bar', () => {
  // A worker as the strip reads it, each one fresher than the last, so the
  // order the arrows walk is known.
  function runs(): SubagentRun[] {
    const now = Date.now();
    return [
      worker({ id: 'sub-one', startedAt: now - 45_000, updatedAt: now - 2_000 }),
      worker({ id: 'sub-two', startedAt: now - 45_000, updatedAt: now - 1_000 }),
      worker({ id: 'sub-three', startedAt: now - 45_000, updatedAt: now }),
    ];
  }

  function Bar({ workers, send }: { workers: readonly SubagentRun[]; send: (text: string) => void }) {
    const [draft, setDraft] = useState('');
    return <InputBar
      inputContent={draft}
      setInputContent={setDraft}
      send={send}
      disabled={false}
      feedback={null}
      participants={[]}
      workers={workers}
    />;
  }

  test('↓ selects the freshest run, the arrows walk a frozen order, enter opens it', async () => {
    const workers = runs();
    const sent: string[] = [];
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode() {}, ref() {}, unref() {},
    });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    let output = '';
    stdout.on('data', chunk => {
      const frame = stripAnsi(chunk.toString());
      if (frame.trim()) output = frame;
    });
    const app = renderInk(<Bar workers={workers} send={text => sent.push(text)} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const flush = async () => {
      await new Promise(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
    };
    // The strip's own line, told apart from the input box that shares the ›.
    const line = () => output.split('\n').find(text => text.includes('sub-')) ?? '';
    const press = async (key: string) => { stdin.write(key); await flush(); };
    const down = () => press('\u001b[B');
    const up = () => press('\u001b[A');
    // Ink holds a lone escape briefly in case a longer sequence follows it.
    const escape = async () => {
      stdin.write('\u001b');
      await new Promise(resolve => setTimeout(resolve, 40));
      await flush();
    };
    try {
      await flush();
      expect(line()).toContain('1/3 ● sub-three');
      expect(line()).not.toContain('›');

      await down();
      expect(line()).toContain('› 1/3 ● sub-three');
      await down();
      expect(line()).toContain('› 2/3 ● sub-two');
      await down();
      expect(line()).toContain('› 3/3 ● sub-one');
      // ↓ past the last line stays where it is.
      await down();
      expect(line()).toContain('› 3/3 ● sub-one');
      await up();
      expect(line()).toContain('› 2/3 ● sub-two');

      // Nothing moves under the user: a run that finishes while selected only
      // changes its status word, and a fresher run does not take its place.
      workers[0].updatedAt = Date.now();
      workers[1].status = 'cancelled';
      workers[1].finishedAt = Date.now();
      notifySubagents();
      await flush();
      expect(line()).toContain('› 2/3 ● sub-two');
      expect(line()).toContain('cancelled');

      // Escape gives the draft the keyboard back, and the strip follows the
      // freshest run again.
      await escape();
      expect(line()).not.toContain('›');
      expect(line()).toContain('● sub-one');

      // Enter sends the run's actions down the path typing them would take.
      await down();
      expect(line()).toContain('› 1/');
      await press('\r');
      expect(sent).toEqual(['/agents sub-one']);
      expect(line()).not.toContain('›');

      // Typing carries on in the draft, character included.
      await down();
      expect(line()).toContain('›');
      await press('h');
      expect(line()).not.toContain('›');
      expect(output).toContain('h▌');
    } finally {
      app.unmount();
      await app.waitUntilExit();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
