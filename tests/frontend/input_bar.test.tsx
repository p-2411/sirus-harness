import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Box, render as renderInk, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import { useState, useSyncExternalStore } from 'react';
import stripAnsi from 'strip-ansi';
import { InputBar } from '../../src/frontend/chat/InputBar';
import { ApprovalPrompt, approvalChoices } from '../../src/frontend/chat/ApprovalPrompt';
import { PromptBar, type PromptMode } from '../../src/frontend/chat/PromptBar';
import { QuestionCard } from '../../src/frontend/chat/QuestionCard';
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
import { lastDecision, pendingApprovals, requestPermission, resolveApproval, type ApprovalDecision, type ApprovalRequest } from '../../src/agent_runtime/permissions/approvals';
import type { QuestionAnswer, QuestionField, QuestionRequest } from '../../src/agent_runtime/permissions/questions';
import type { PermissionOption } from '@agentclientprotocol/sdk';
import { notifySubagents, type SubagentRun } from '../../src/agent_runtime/tools/subagents';
import type { ToolCallBlock } from '../../src/agent_runtime/types';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import stringWidth from 'string-width';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';
import { editInExternalEditor } from '../../src/frontend/chat/externalEditor';

describe('external draft editor', () => {
  let directory: string;
  let previousVisual: string | undefined;
  let previousEditor: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-editor-test-'));
    previousVisual = process.env.VISUAL;
    previousEditor = process.env.EDITOR;
  });

  afterEach(() => {
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    rmSync(directory, { recursive: true, force: true });
  });

  function editorCommand(source: string, ...args: string[]): string {
    const script = path.join(directory, 'fake editor.ts');
    writeFileSync(script, source);
    return [process.execPath, script, ...args].map(value => JSON.stringify(value)).join(' ');
  }

  test('VISUAL accepts quoted paths and arguments and edits a private temporary draft', async () => {
    const report = path.join(directory, 'report.json');
    process.env.EDITOR = 'missing-editor';
    process.env.VISUAL = editorCommand(`
      import { readFileSync, writeFileSync, statSync } from 'fs';
      import path from 'path';
      const file = process.argv.at(-1)!;
      writeFileSync(process.argv[2]!, JSON.stringify({
        file, fileMode: statSync(file).mode & 0o777,
        directoryMode: statSync(path.dirname(file)).mode & 0o777,
        original: readFileSync(file, 'utf8'), argument: process.argv[3],
      }));
      writeFileSync(file, 'edited\\ntext');
    `, report, 'an argument with spaces');
    const terminal: string[] = [];
    const edited = await editInExternalEditor('original\ndraft', async callback => {
      terminal.push('suspend');
      try { await callback(); } finally { terminal.push('resume'); }
    });
    expect(edited).toBe('edited\ntext');
    expect(terminal).toEqual(['suspend', 'resume']);
    const metadata = JSON.parse(readFileSync(report, 'utf8'));
    expect(metadata).toMatchObject({
      original: 'original\ndraft', argument: 'an argument with spaces',
      fileMode: 0o600, directoryMode: 0o700,
    });
    expect(existsSync(path.dirname(metadata.file))).toBe(false);
  });

  test('falls back to EDITOR and preserves an intentionally empty edited draft', async () => {
    delete process.env.VISUAL;
    process.env.EDITOR = editorCommand(`
      import { writeFileSync } from 'fs';
      writeFileSync(process.argv.at(-1)!, '');
    `);
    expect(await editInExternalEditor('draft', callback => callback())).toBe('');
  });

  test('rejects editor failure after restoring the terminal and removing its draft', async () => {
    const report = path.join(directory, 'draft-path');
    process.env.VISUAL = editorCommand(`
      import { writeFileSync } from 'fs';
      writeFileSync(process.argv[2]!, process.argv.at(-1)!);
      process.exit(7);
    `, report);
    let restored = false;
    await expect(editInExternalEditor('draft', async callback => {
      try { await callback(); } finally { restored = true; }
    })).rejects.toThrow('Editor exited with status 7.');
    expect(restored).toBe(true);
    expect(existsSync(path.dirname(readFileSync(report, 'utf8')))).toBe(false);
  });

  test('reports unavailable executables and malformed editor commands', async () => {
    process.env.VISUAL = path.join(directory, 'missing-editor');
    await expect(editInExternalEditor('draft', callback => callback())).rejects.toThrow('Could not open editor');
    process.env.VISUAL = '"unclosed';
    await expect(editInExternalEditor('draft', callback => callback())).rejects.toThrow('unclosed quote');
  });
});

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
      expect(output).toContain('› First draft');
      await type('!');
      expect(first.getInputContent()).toBe('First draft!');
      expect(output).toContain('› First draft!');

      await type('\u001b[1;3B');
      expect(output).toContain('› Second draft');
      await type('\u007f');
      expect(second.getInputContent()).toBe('Second draf');

      await type('\u001b[1;3A');
      expect(output).toContain('› First draft!');
      await type('\r');
      expect(sent).toEqual(['First draft!']);
      expect(first.getInputContent()).toBe('');
      expect(second.getInputContent()).toBe('Second draf');

      // An open command menu must not capture the session shortcut.
      await type('/');
      await type('\u001b[1;3B');
      expect(output).toContain('› Second draf');
      await type('\u001b[1;3A');
      expect(first.getInputContent()).toBe('/');
      expect(output).toContain('› /');
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
  test('makes the vendor difference in ask mode visible', () => {
    const codex = stripAnsi(renderToString(
      <SubagentStatusRow permissionMode="ask" model="gpt-5.6-luna" />,
      { columns: 120 },
    ));
    expect(codex).toContain('ask for approval (workspace edits allowed)');
    const claude = stripAnsi(renderToString(
      <SubagentStatusRow permissionMode="ask" model="claude-sonnet-5" />,
      { columns: 120 },
    ));
    expect(claude).toContain('ask for approval (asks before writes)');
  });

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
    const notice = 'auto approve is unavailable to @sirus, which is on Manual';
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

    expect(output).toContain('@sirus wants to edit src/app.ts');
    expect(output).toMatch(/1 more ─╮/);
    expect(output).toContain('src/app.ts');
    expect(output).toContain('- old');
    expect(output).toContain('+ new');
    for (const option of OPTIONS) expect(output).toContain(option.name);
  });

  test('keeps vendor options and adds rejection with feedback', () => {
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
    expect(output).not.toContain('Yes, and don’t ask again');
    // Keys follow the option kinds, in the vendor's order, and each choice
    // answers with its own option.
    const call: ToolCallBlock = {
      type: 'tool_call', id: 'call-2', kind: 'execute', title: 'bun test',
      status: 'pending', locations: [], content: [],
    };
    expect(approvalChoices(approval(call)).map(choice => `${choice.key}:${JSON.stringify(choice.decision)}`))
      .toEqual(['y:{"optionId":"allow"}', 'a:{"optionId":"always"}', 'n:{"optionId":"reject"}', 'd:{"optionId":"never"}', 'tab:"deny"']);
    // Two options of one kind are both offered, numbered.
    expect(approvalChoices(approval(call, [
      { optionId: 'once', name: 'Yes, proceed', kind: 'allow_once' },
      { optionId: 'decline', name: 'No, continue without running it', kind: 'reject_once' },
      { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
    ])).map(choice => `${choice.key}:${choice.label}`))
      .toEqual(['1:Yes, proceed', '2:No, continue without running it', '3:No, and tell Codex what to do differently', 'tab:No, and tell it what to do instead']);
    expect(output).toContain('No, and tell it what to do instead');
    expect(output).toContain('esc decline');
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

  test.each(['escape', 'feedback', 'feedback-escape', 'selection'] as const)('answers a worker approval through %s across streaming updates', async action => {
    const request = approval({
      type: 'tool_call', id: 'worker-call', kind: 'execute', title: 'bun test',
      status: 'pending', locations: [], content: [],
    });
    request.requester = { subagent: 'sub-worker-id' };
    const decisions: { decision: ApprovalDecision; feedback?: string }[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 35 });
    let output = '';
    stdout.on('data', chunk => { const frame = stripAnsi(chunk.toString()); if (frame.trim()) output = frame; });
    const view = () => {
      const mode: PromptMode = {
        type: 'approval', request, waiting: 0, requesterName: 'Reader',
        onDecide: (decision, feedback) => decisions.push({ decision, feedback }),
      };
      return <PromptBar mode={mode} feedback={null} queuedMessages={[]} workers={[]} status={{}} />;
    };
    const app = renderInk(view(), {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await app.waitUntilRenderFlush(); };
    const type = async (input: string) => {
      stdin.write(input);
      if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 60));
      await flush();
    };
    try {
      await flush();
      expect(output).toContain('Reader wants to run bun test');
      expect(output).not.toContain('sub-worker-id');
      if (action === 'feedback' || action === 'feedback-escape') {
        await type('\t');
        await type('Read it');
        app.rerender(view());
        await flush();
        expect(output).toContain('Read it▌');
        await type(' first');
      } else if (action === 'selection') {
        await type('\u001b[B');
        app.rerender(view());
        await flush();
      }
      await type(action === 'feedback' || action === 'selection' ? '\r' : '\u001b');
      expect(decisions).toEqual([{
        decision: action === 'selection' ? { optionId: 'always' } : 'deny',
        feedback: action === 'feedback' ? 'Read it first' : undefined,
      }]);
      await type('\u001b');
      expect(decisions).toHaveLength(1);
    } finally {
      app.unmount(); await app.waitUntilExit(); app.cleanup(); stdin.destroy(); stdout.destroy();
    }
  });

  test.each(['allow_once', 'reject_always'] as const)('denial cancels only the request when the vendor offers only %s', async kind => {
    const sessionId = 'approval-without-reject';
    const response = requestPermission({ sessionId, requester: { participant: 'sirus' } }, {
      sessionId: 'runtime', toolCall: { toolCallId: 'allow-only-call', title: 'Write file' },
      options: [{ optionId: 'only-option', name: 'Only option', kind }],
    });
    const [request] = pendingApprovals(sessionId);
    expect(resolveApproval(request.id, 'deny')).toBe(true);
    expect(await response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(lastDecision('allow-only-call', sessionId)).toBe('deny');
  });
});

describe('question card', () => {
  const choices = [
    { value: 'fast', label: 'Fast', description: 'A small change with a quick check.' },
    { value: 'careful', label: 'Careful', description: 'A detailed review before making changes.' },
    { value: 'manual', label: 'Manual', description: 'Work through every step yourself.' },
  ];
  const choice = (field: Partial<Extract<QuestionField, { kind: 'choice' }>> = {}): QuestionField => ({
    kind: 'choice', key: 'approach', title: 'Which approach?', options: choices,
    multiple: false, required: true, ...field,
  });

  function card(fields: QuestionField[], columns = 90, rows = 30, inPane = false) {
    const request: QuestionRequest = {
      id: 'question-1', sessionId: 'session-1', requester: { participant: 'sirus' },
      message: fields.length === 1 ? fields[0].title : 'Choose how to proceed.', fields,
    };
    const answers: QuestionAnswer[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { columns, rows });
    let output = '';
    stdout.on('data', chunk => {
      const frame = stripAnsi(chunk.toString());
      if (frame.trim()) output = frame;
    });
    const view = () => {
      const question = <QuestionCard request={request} waiting={0} onAnswer={answer => answers.push(answer)} />;
      return inPane ? (
        <Box width={stdout.columns} height={stdout.rows}>
          <Box width={26} flexShrink={0} />
          <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} height="100%" minHeight={0}>
            <Box flexGrow={1} minHeight={0} />
            {question}
          </Box>
        </Box>
      ) : question;
    };
    const app = renderInk(view(), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    const flush = async () => {
      await new Promise(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
    };
    const cellOf = (text: string) => {
      const lines = output.split('\n');
      const line = lines.findIndex(value => value.includes(text));
      expect(line).toBeGreaterThanOrEqual(0);
      return { line, col: stringWidth(lines[line].slice(0, lines[line].indexOf(text))) + 1 };
    };
    return {
      answers,
      output: () => output,
      cellOf,
      flush,
      async type(input: string) { stdin.write(input); await flush(); },
      async resize(columns: number, rows: number) {
        stdout.columns = columns;
        stdout.rows = rows;
        stdout.emit('resize');
        if (inPane) app.rerender(view());
        await flush();
      },
      async click(text: string) {
        await new Promise(resolve => setImmediate(resolve));
        const cell = cellOf(text);
        expect(pressAt(cell)).toBe(true);
        expect(releaseAt(cell)).toBe(true);
        await flush();
      },
      async close() {
        app.unmount();
        await app.waitUntilExit();
        app.cleanup();
        stdin.destroy();
        stdout.destroy();
      },
    };
  }

  test('Escape declines a partially answered form once without submitting its answers', async () => {
    const view = card([choice(), { kind: 'text', key: 'note', title: 'What else?', required: true, secret: false }]);
    try {
      await view.flush();
      await view.type('2');
      await view.type('An unfinished note');
      await view.type('\u001b');
      await new Promise(resolve => setTimeout(resolve, 60));
      await view.flush();
      expect(view.answers).toEqual([{ action: 'decline' }]);
      await view.type('\r');
      expect(view.answers).toHaveLength(1);
    } finally {
      await view.close();
    }
  });

  test('numbers the choices and immediately submits a clicked single answer', async () => {
    const view = card([choice()]);
    try {
      await view.flush();
      expect(view.output()).toMatch(/1[.)]\s+Fast/);
      expect(view.output()).toMatch(/2[.)]\s+Careful/);
      expect(view.output()).toContain('A detailed review before making changes.');
      await view.click('Careful');
      expect(view.answers).toEqual([{ action: 'accept', content: { approach: 'careful' } }]);
    } finally {
      await view.close();
    }
  });

  test('edits a typed answer at the cursor without splitting Unicode characters', async () => {
    const view = card([{ kind: 'text', key: 'answer', title: 'Your answer?', required: true, secret: false }]);
    try {
      await view.flush();
      await view.type('\r');
      expect(view.answers).toEqual([]);
      expect(view.output()).toContain('Enter your answer.');
      await view.type('A🐎B');
      await view.type('\u001b[D');
      await view.type('\u007f');
      await view.type('é');
      expect(view.output()).toContain('Aé▌B');
      await view.type('\r');
      expect(view.answers).toEqual([{ action: 'accept', content: { answer: 'AéB' } }]);
    } finally {
      await view.close();
    }
  });

  test.each([['Claude', undefined], ['Codex', 'None of the above']] as const)('sends a custom choice in the %s form', async (_vendor, value) => {
    const other = { key: 'custom', ...(value ? { value } : {}) };
    const view = card([choice({ other })]);
    try {
      await view.flush();
      await view.click('Other…');
      await view.type('A different approach');
      await view.type('\r');
      expect(view.answers).toEqual([{
        action: 'accept', content: { custom: 'A different approach', ...(value ? { approach: value } : {}) },
      }]);
    } finally {
      await view.close();
    }
  });

  test('validates multiple choices on Continue and submits the toggled values', async () => {
    const view = card([choice({ multiple: true, minimum: 2, maximum: 2 })]);
    try {
      await view.flush();
      await view.click('Continue');
      expect(view.answers).toEqual([]);
      expect(view.output()).toMatch(/at least 2/i);
      await view.type('1');
      await view.type('\t');
      expect(view.answers).toEqual([]);
      expect(view.output()).toMatch(/at least 2/i);
      await view.type('2');
      await view.click('Manual');
      await view.type('\t');
      expect(view.answers).toEqual([]);
      expect(view.output()).toMatch(/at most 2/i);
      await view.click('Manual');
      await view.click('Continue');
      expect(view.answers).toEqual([{ action: 'accept', content: { approach: ['fast', 'careful'] } }]);
    } finally {
      await view.close();
    }
  });

  test('does not send an empty required selection', async () => {
    const view = card([choice({ multiple: true })]);
    try {
      await view.flush();
      await view.type('\t');
      expect(view.answers).toEqual([]);
      expect(view.output()).toMatch(/at least (?:one|1)/i);
      await view.type(' ');
      await view.click('Continue');
      expect(view.answers).toEqual([{ action: 'accept', content: { approach: ['fast'] } }]);
    } finally {
      await view.close();
    }
  });

  test('reviews several answers before submitting, lets an answer be edited, and masks secrets', async () => {
    const view = card([
      choice(),
      { kind: 'text', key: 'token', title: 'Access token?', required: true, secret: true },
    ]);
    try {
      await view.flush();
      expect(view.output()).toMatch(/1 of 2/);
      await view.type('1');
      expect(view.output()).toMatch(/2 of 2/);
      await view.type('private-token');
      expect(view.output()).not.toContain('private-token');
      expect(view.output()).toContain('••••');
      await view.type('\r');
      expect(view.answers).toEqual([]);
      expect(view.output()).toContain('Submit answers');
      expect(view.output()).toContain('Fast');
      expect(view.output()).not.toContain('private-token');
      expect(view.output()).toContain('••••');

      await view.click('Which approach?');
      await view.click('Careful');
      expect(view.answers).toEqual([]);
      expect(view.output()).toContain('Submit answers');
      expect(view.output()).toContain('Careful');
      expect(view.output()).not.toContain('private-token');
      await view.type('\r');
      expect(view.answers).toEqual([{ action: 'accept', content: { approach: 'careful', token: 'private-token' } }]);
    } finally {
      await view.close();
    }
  });

  test('keeps custom text, selected options, and unfinished drafts when going back', async () => {
    const view = card([
      choice({ multiple: true, other: { key: 'custom' } }),
      { kind: 'text', key: 'reason', title: 'Why this approach?', required: true, secret: false },
    ]);
    try {
      await view.flush();
      await view.type(' ');
      await view.click('Other…');
      await view.type('Custom source');
      await view.type('\r');
      expect(view.output()).toContain('Why this approach?');
      await view.type('Remember this');

      await view.type('\u001b[Z');
      expect(view.output()).toContain('Custom source▌');
      await view.click('Back to options');
      expect(view.output()).toContain('[x] Fast');
      await view.click('Other…');
      expect(view.output()).toContain('Custom source▌');
      await view.type('\u001b[H');
      await view.type('A ');
      await view.type('\r');
      expect(view.output()).toContain('Remember this▌');

      await view.click('Back');
      expect(view.output()).toContain('A ▌Custom source');
      await view.type('\r');
      await view.type('\r');
      expect(view.answers).toEqual([]);
      expect(view.output()).toContain('Submit answers');
      expect(view.output()).toContain('Fast, A Custom source');
      expect(view.output()).toContain('Remember this');
      await view.type('\r');
      expect(view.answers).toEqual([{
        action: 'accept', content: { approach: ['fast'], custom: 'A Custom source', reason: 'Remember this' },
      }]);
    } finally {
      await view.close();
    }
  });

  test('wraps option descriptions and keeps the selected row visible in a narrow terminal', async () => {
    const description = 'A longer explanation that stays readable across several narrow rows, right through its final words.';
    const options = Array.from({ length: 12 }, (_, index) => ({
      value: `value-${index}`, label: `Choice ${index + 1}`,
      description: index === 0 ? description : `Details for choice ${index + 1}.`,
    }));
    const view = card([choice({ options })], 48, 24);
    try {
      await view.flush();
      const words = view.output().replace(/[│\n]/g, ' ').replace(/\s+/g, ' ');
      expect(words).toContain(description);
      for (const line of view.output().split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(48);
      for (let index = 1; index < 12; index++) await view.type('\u001b[B');
      expect(view.output()).toContain('Choice 12');
      expect(view.output()).not.toContain('Choice 1 ');
      expect(view.output().split('\n').length).toBeLessThanOrEqual(24);
      await view.type('\r');
      expect(view.answers).toEqual([{ action: 'accept', content: { approach: 'value-11' } }]);
    } finally {
      await view.close();
    }
  });

  test('scrolled-out choices cannot intercept clicks on Back or the footer', async () => {
    const options = Array.from({ length: 20 }, (_, index) => ({ value: `${index}`, label: `Choice ${index + 1}` }));
    const view = card([
      { kind: 'text', key: 'context', title: 'Your context?', required: true, secret: false },
      choice({ options }),
    ], 70, 24);
    try {
      await view.flush();
      await view.type('Keep this context');
      await view.type('\r');
      for (let index = 0; index < 11; index++) await view.type('\u001b[B');
      expect(view.output()).toContain('Choice 12');
      expect(view.output()).not.toContain('Choice 20');
      // Hidden rows still have layout boxes below the viewport, where the
      // frame and Back sit. Those boxes must not remain mouse targets.
      const footer = view.cellOf('esc declines');
      expect(pressAt(footer)).toBe(false);
      expect(releaseAt(footer)).toBe(false);
      await view.click('Back');
      expect(view.output()).toContain('Your context?');
      expect(view.output()).toContain('Keep this context▌');
      expect(view.answers).toEqual([]);
    } finally {
      await view.close();
    }
  });

  test('keeps a short review compact after resizing and editing an answer', async () => {
    const view = card([choice(), choice({ key: 'checks', title: 'Which checks?' })], 150, 48, true);
    try {
      await view.flush();
      await view.type('1');
      await view.resize(80, 24);
      await view.type('2');
      expect(view.output()).toContain('Submit answers');
      await view.resize(150, 48);
      await view.type('1');
      await view.type('2');
      const lines = view.output().split('\n');
      const submit = lines.findIndex(line => line.includes('Submit answers'));
      const footer = lines.findIndex(line => line.includes('╰'));
      expect(submit).toBeGreaterThanOrEqual(0);
      expect(footer - submit).toBe(2);
      expect(view.answers).toEqual([]);
      await view.type('\r');
      expect(view.answers).toEqual([{ action: 'accept', content: { approach: 'careful', checks: 'careful' } }]);
    } finally {
      await view.close();
    }
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
  test('shows the run that changed last, and how many are behind it', () => {
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
      expect(output).toContain('› h');
    } finally {
      app.unmount();
      await app.waitUntilExit();
      stdin.destroy();
      stdout.destroy();
    }
  });
});


function renderQueueInput(session: Session, history: readonly string[] = []) {
  const events: string[] = [];
  let interrupt = false;
  let output = '';
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 35 });
  stdout.on('data', chunk => { const frame = stripAnsi(chunk.toString()); if (frame.trim()) output = frame; });
  function Harness() {
    useSyncExternalStore(listener => session.subscribe(listener), () => session.getVersion());
    return <InputBar
      inputContent={session.getInputContent()}
      setInputContent={text => session.setInputContent(text)}
      send={text => events.push(`send:${text}`)}
      disabled={session.getStatus() === 'working'}
      feedback={null}
      participants={[]}
      history={history}
      queuedMessages={session.getQueuedMessages()}
      onBeginQueuedEdit={id => { session.beginQueuedMessageEdit(id); }}
      onCancelQueuedEdit={id => session.cancelQueuedMessageEdit(id)}
      onUpdateQueued={(id, text) => session.commitQueuedMessageEdit(id, text)}
      onEscape={() => events.push('escape')}
      onRewind={() => events.push('rewind')}
      onInterrupt={() => { if (interrupt) events.push('interrupt'); return interrupt; }}
      onExit={() => events.push('exit')}
      onExitHint={() => events.push('exit-hint')}
    />;
  }
  const app = renderInk(<Harness />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await app.waitUntilRenderFlush(); };
  return {
    events,
    get output() { return output; },
    set interrupt(value: boolean) { interrupt = value; },
    flush,
    async press(input: string) {
      stdin.write(input);
      if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 60));
      await flush();
    },
    unmount() { app.unmount(); stdin.destroy(); stdout.destroy(); },
  };
}

describe('input queue and interrupt precedence', () => {
  test('keeps queue edits private until Enter and restores the original on Escape', async () => {
    const session = new Session({ name: 'Queue input' });
    session.setInputContent('saved draft');
    // Commands remain queued when the editor releases them in an idle session.
    session.queueMessage('/first');
    session.queueMessage('/second');
    const ids = session.getQueuedMessages().map(item => item.id);
    const bar = renderQueueInput(session);
    try {
      await bar.flush();
      await bar.press('\u001b[A');
      await bar.press(' unfinished');
      expect(bar.output).toContain('› /second unfinished');
      expect(session.getQueuedMessages().map(item => item.text)).toEqual(['/first', '/second']);
      expect(session.getQueuedMessages()[1]!.editing).toBe(true);
      expect(session.getInputContent()).toBe('saved draft');
      await bar.press('\u001b');
      expect(session.getQueuedMessages().map(item => item.id)).toEqual(ids);
      expect(session.getQueuedMessages()[1]!.editing).toBeUndefined();
      expect(bar.output).toContain('› saved draft');
      expect(bar.events).toEqual([]);
      await bar.press('\u001b[A');
      await bar.press(' completed');
      await bar.press('\r');
      expect(session.getQueuedMessages().map(item => item.text)).toEqual(['/first', '/second completed']);
      expect(session.getQueuedMessages()[1]!.editing).toBeUndefined();
      expect(bar.output).toContain('› saved draft');
      expect(bar.events).toEqual([]);
    } finally {
      bar.unmount();
      await session.dispose();
    }
  });

  test('walks from the queue into prompt history and restores the draft', async () => {
    const session = new Session({ name: 'Queue history' });
    session.setInputContent('draft');
    session.queueMessage('/first');
    session.queueMessage('/second');
    const bar = renderQueueInput(session, ['older prompt', 'recent prompt']);
    try {
      await bar.flush();
      await bar.press('\u001b[A');
      expect(bar.output).toContain('› /second');
      await bar.press('\u001b[A');
      expect(bar.output).toContain('› /first');
      expect(session.getQueuedMessages()[1]!.editing).toBeUndefined();
      await bar.press('\u001b[A');
      expect(session.getInputContent()).toBe('recent prompt');
      expect(session.getQueuedMessages().every(item => !item.editing)).toBe(true);
      await bar.press('\u001b[A');
      expect(session.getInputContent()).toBe('older prompt');
      await bar.press('\u001b[B');
      expect(session.getInputContent()).toBe('recent prompt');
      await bar.press('\u001b[B');
      expect(session.getInputContent()).toBe('draft');
    } finally {
      bar.unmount();
      await session.dispose();
    }
  });

  test('never drains the visible half-written queue item when a real session turn ends', async () => {
    const model = 'test-input-queue-reservation';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const binding = bindScriptedRuntime(model, async () => { await gate; });
    const session = new Session({ name: 'Reserved prompt', model });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    session.queueMessage('Other queued prompt');
    session.queueMessage('Original');
    const bar = renderQueueInput(session);
    try {
      await bar.flush();
      await bar.press('\u001b[A');
      await bar.press(' half');
      release();
      await turn;
      const deadline = Date.now() + 2000;
      while (session.getStatus() !== 'idle' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      await bar.flush();
      expect(session.getStatus()).toBe('idle');
      expect(binding.runtimes[0]!.prompts.map(prompt => prompt.text)).toEqual(['Start', 'Other queued prompt']);
      expect(session.getQueuedMessages()).toHaveLength(1);
      expect(session.getQueuedMessages()[0]!.text).toBe('Original');
      expect(session.getQueuedMessages()[0]!.editing).toBe(true);
      expect(bar.output).toContain('› Original half');
      await bar.press(' finished');
      await bar.press('\r');
      const commitDeadline = Date.now() + 2000;
      while (session.getStatus() !== 'idle' && Date.now() < commitDeadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(binding.runtimes[0]!.prompts.map(prompt => prompt.text)).toEqual(['Start', 'Other queued prompt', 'Original half finished']);
      expect(session.getQueuedMessages()).toHaveLength(0);
    } finally {
      release();
      bar.unmount();
      await turn.catch(() => {});
      await session.dispose();
      unbindRuntime(model);
    }
  });

  test('Escape dismisses a command menu before invoking the chat fallback', async () => {
    const session = new Session({ name: 'Menu Escape' });
    const bar = renderQueueInput(session);
    try {
      await bar.flush();
      await bar.press('/help');
      await bar.press('\u001b');
      expect(bar.events).toEqual([]);
      expect(session.getInputContent()).toBe('/help');
      await bar.press('\u001b');
      expect(bar.events).toEqual(['escape']);
      expect(session.getInputContent()).toBe('/help');
    } finally {
      bar.unmount();
      await session.dispose();
    }
  });

  test('double Escape clears a recallable draft and opens rewind when empty', async () => {
    const session = new Session({ name: 'Double Escape' });
    const bar = renderQueueInput(session);
    try {
      await bar.flush();
      await bar.press('keep this draft');
      await bar.press('\u001b');
      expect(session.getInputContent()).toBe('keep this draft');
      await bar.press('\u001b');
      expect(session.getInputContent()).toBe('');
      expect(bar.events).toEqual(['escape']);
      await bar.press('\u001b[A');
      expect(session.getInputContent()).toBe('keep this draft');
      await bar.press('\u0015');
      await bar.press('\u001b');
      await bar.press('\u001b');
      expect(bar.events).toEqual(['escape', 'escape', 'rewind']);
    } finally {
      bar.unmount();
      await session.dispose();
    }
  });

  test('keeps cleared drafts before prompts sent later in recall history', async () => {
    const session = new Session({ name: 'Recall order' });
    const history: string[] = [];
    const bar = renderQueueInput(session, history);
    try {
      await bar.flush();
      await bar.press('cleared draft');
      await bar.press('\u0003');
      await bar.press('later prompt');
      history.push('later prompt');
      await bar.press('\r');
      session.setInputContent('');
      await bar.flush();
      await bar.press('\u001b[A');
      expect(session.getInputContent()).toBe('later prompt');
      await bar.press('\u001b[A');
      expect(session.getInputContent()).toBe('cleared draft');
    } finally {
      bar.unmount();
      await session.dispose();
    }
  });

  test('Ctrl+C interrupts first, then clears for recall, and only a consecutive empty press exits', async () => {
    const session = new Session({ name: 'Control C' });
    const bar = renderQueueInput(session);
    try {
      await bar.flush();
      await bar.press('keep this draft');
      bar.interrupt = true;
      await bar.press('\u0003');
      expect(bar.events).toEqual(['interrupt']);
      expect(session.getInputContent()).toBe('keep this draft');
      bar.interrupt = false;
      await bar.press('\u0003');
      expect(session.getInputContent()).toBe('');
      expect(bar.events).toEqual(['interrupt', 'exit-hint']);
      await bar.press('\u001b[A');
      expect(session.getInputContent()).toBe('keep this draft');
      await bar.press('\u0003');
      await bar.press('\u0003');
      expect(bar.events).toEqual(['interrupt', 'exit-hint', 'exit-hint', 'exit']);
    } finally {
      bar.unmount();
      await session.dispose();
    }
  });
});
