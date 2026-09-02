import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { modelStrategies } from '../../src/agent/chat';
import { Session } from '../../src/runtime/session';
import {
  SESSION_STATUS_APPEARANCE,
  formatSidebarTime,
  sessionStatusAppearance,
  SessionItem,
} from '../../src/frontend/Sidebar';
import Sidebar from '../../src/frontend/Sidebar';
import { theme } from '../../src/frontend/theme';

const noOp = () => {};

function render(session: Session): string {
  return stripAnsi(renderToString(
    <SessionItem
      session={session}
      isSelected={false}
      onSelect={noOp}
      onDelete={noOp}
    />,
    { columns: 40 },
  ));
}

describe('sidebar header', () => {
  test('left-aligns the name and right-aligns the 12-hour clock with no subtitle', () => {
    const output = stripAnsi(renderToString(
      <Sidebar
        sessions={[]}
        currSession={null}
        selectSession={noOp}
        addSession={noOp}
        deleteSession={noOp}
      />,
      { columns: 40 },
    ));
    const line = output.split('\n').find(candidate => candidate.includes('sirus'))!;
    const content = line.replace(/│$/, '');
    expect(output).not.toContain('agent workspace');
    expect(line).toMatch(/^ sirus/);
    expect(line).toMatch(/\d{1,2}:\d{2} (?:AM|PM)/);
    expect(content.trimEnd()).toMatch(/\d{1,2}:\d{2} (?:AM|PM)$/);
  });

  test('formats midnight and afternoon with AM/PM', () => {
    expect(formatSidebarTime(new Date(2026, 0, 1, 0, 5))).toBe('12:05 AM');
    expect(formatSidebarTime(new Date(2026, 0, 1, 13, 7))).toBe('1:07 PM');
  });
});

describe('sidebar session status', () => {
  test('maps idle, working, and error to the requested symbols and colors', () => {
    expect(SESSION_STATUS_APPEARANCE).toEqual({
      idle: { symbol: '○', color: theme.textSubtle },
      unread: { symbol: '●', color: theme.textSubtle },
      working: { symbol: '○', color: theme.pending },
      error: { symbol: '●', color: theme.danger },
    });
  });

  test('uses filled grey only for unread idle sessions', () => {
    expect(sessionStatusAppearance('idle', true)).toEqual({
      symbol: '●',
      color: theme.textSubtle,
    });
    expect(sessionStatusAppearance('working', true)).toBe(SESSION_STATUS_APPEARANCE.working);
    expect(sessionStatusAppearance('error', true)).toBe(SESSION_STATUS_APPEARANCE.error);
  });

  test('shows an empty circle while idle', () => {
    expect(render(new Session('Idle'))).toContain('○ Idle');
  });

  test('shows a hollow circle while working and a filled circle after an error', async () => {
    const model = 'sidebar-status-model';
    let finish!: () => void;
    modelStrategies[model] = {
      getResponse: async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        throw new Error('provider failed');
      },
    };
    const session = new Session('Active', 'status-id', model);

    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Go' }] });
    await Promise.resolve();
    expect(render(session)).toContain('○ Active');

    finish();
    await expect(turn).rejects.toThrow('provider failed');
    expect(render(session)).toContain('● Active');

    delete modelStrategies[model];
  });
});
