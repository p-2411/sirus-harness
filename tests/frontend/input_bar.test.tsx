import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import {
  applyInputEdit,
  InputFeedback,
  SecretInput,
  SubagentStatusRow,
  type InputState,
} from '../../src/frontend/chat/InputBar';
import { moveSelection, SelectMenu } from '../../src/frontend/chat/SelectMenu';
import type { CommandMenuItem } from '../../src/commands/command_register';
import type { Feedback } from '../../src/feedback';

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
});

describe('select menu', () => {
  const items: CommandMenuItem[] = [
    { key: 'a', label: 'Claude · subscription', description: 'browser sign-in', command: '/login claude' },
    { key: 'b', label: 'Anthropic · API key', description: 'paste a key', command: '/login claude api', secret: { prompt: 'Paste your Anthropic API key' } },
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
