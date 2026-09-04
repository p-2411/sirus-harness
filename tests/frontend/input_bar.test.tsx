import { describe, expect, test } from 'bun:test';
import { render as renderInk, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import { useSyncExternalStore } from 'react';
import stripAnsi from 'strip-ansi';
import {
  applyInputEdit,
  InputBar,
  ApprovalPrompt,
  InputFeedback,
  normalizeNewlines,
  onFirstLine,
  onLastLine,
  SecretInput,
  SubagentStatusRow,
  type InputState,
} from '../../src/frontend/chat/InputBar';
import { moveSelection, SelectMenu } from '../../src/frontend/chat/SelectMenu';
import type { CommandMenuEntry, CommandMenuItem } from '../../src/commands/registry';
import type { Feedback } from '../../src/commands/feedback';
import { Session } from '../../src/agent_runtime/session';
import type { ApprovalRequest } from '../../src/agent_runtime/permissions/permissions';

describe('session input drafts', () => {
  test('edits and restores drafts when switching session panes', async () => {
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

    const app = renderInk(<Pane key={first.getId()} session={first} />, {
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

      app.rerender(<Pane key={second.getId()} session={second} />);
      await flush();
      expect(output).toContain('Second draft▌');
      await type('\u007f');
      expect(second.getInputContent()).toBe('Second draf');

      app.rerender(<Pane key={first.getId()} session={first} />);
      await flush();
      expect(output).toContain('First draft!▌');
      await type('\r');
      expect(sent).toEqual(['First draft!']);
      expect(first.getInputContent()).toBe('');
      expect(second.getInputContent()).toBe('Second draf');
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

  test('shows queued messages and context usage', () => {
    const output = stripAnsi(renderToString(
      <SubagentStatusRow
        queued={2}
        contextUsage={{ tokens: 150_000, window: 200_000 }}
        model="claude-sonnet-5"
      />,
      { columns: 100 },
    ));
    expect(output).toContain('2 queued · esc discards');
    expect(output).toContain('ctx 150k · 75% · claude-sonnet-5');
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
  test('renders removed and added edit lines inline', () => {
    const request: ApprovalRequest = {
      id: 'approval-1',
      sessionId: 'session-1',
      requester: { participant: 'sirus' },
      call: {
        type: 'tool_call',
        id: 'call-1',
        name: 'EditFile',
        arguments: { path: 'src/app.ts', old_text: 'old', new_text: 'new' },
      },
      toolClass: 'write',
      reason: 'write',
      detail: ['src/app.ts', '- old', '+ new'],
      allowanceKey: 'write:src/app.ts',
    };
    const output = stripAnsi(renderToString(
      <ApprovalPrompt request={request} waiting={1} selected={0} />,
      { columns: 100 },
    ));
    expect(output).toContain('@sirus wants to run EditFile · 1 more waiting');
    expect(output).toContain('- old');
    expect(output).toContain('+ new');
    expect(output).toContain('Allow once');
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

describe('secret input', () => {
  test('shows the prompt and one dot per character, never the value', () => {
    const output = stripAnsi(renderToString(
      <SecretInput prompt="Paste your Anthropic API key" value="sk-ant-1234" />,
      { columns: 80 },
    ));
    expect(output).toContain('Paste your Anthropic API key');
    expect(output).toContain('•'.repeat('sk-ant-1234'.length));
    expect(output).not.toContain('sk-ant');
  });
});
