import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { modelStrategies } from '../../src/agent_runtime/chat';
import { Session } from '../../src/agent_runtime/session';
import {
  SESSION_STATUS_APPEARANCE,
  formatRelativeTime,
  formatSidebarTime,
  sessionStatusAppearance,
  sessionsByRecency,
  SessionItem,
} from '../../src/frontend/Sidebar';
import Sidebar from '../../src/frontend/Sidebar';
import { theme } from '../../src/frontend/styles/theme';

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

  test('replaces the clock with the green /update command when an update is available', () => {
    const output = renderToString(
      <Sidebar
        sessions={[]}
        currSession={null}
        selectSession={noOp}
        addSession={noOp}
        deleteSession={noOp}
        updateAvailable
      />,
      { columns: 40 },
    );
    expect(stripAnsi(output)).toMatch(/^ sirus\s+\/update │$/m);
    expect(stripAnsi(output)).not.toMatch(/\d{1,2}:\d{2} (?:AM|PM)/);
    expect(theme.success).toBe('#00C853');
  });
});

describe('sidebar session metadata', () => {
  test('formats recent activity compactly', () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    expect(formatRelativeTime(now - 20_000, now)).toBe('now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m');
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h');
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d');
    expect(formatRelativeTime(0, now)).toBe('');
  });

  test('sorts sessions by latest activity without mutating the source list', () => {
    const older = new Session('Older', 'older', undefined, [], '/projects/older', [], 'sirus', undefined, 1_000);
    const newer = new Session('Newer', 'newer', undefined, [], '/projects/newer', [], 'sirus', undefined, 2_000);
    const source = [older, newer];
    expect(sessionsByRecency(source)).toEqual([newer, older]);
    expect(source).toEqual([older, newer]);
  });

  test('shows the owning directory basename and activity time', () => {
    const session = new Session('Work', 'work', undefined, [], '/projects/sirus-harness', [], 'sirus', undefined, 1_000);
    const output = stripAnsi(renderToString(
      <SessionItem
        session={session}
        isSelected={false}
        onSelect={noOp}
        onDelete={noOp}
        now={61_000}
      />,
      { columns: 40 },
    ));
    expect(output).toContain('sirus-harness');
    expect(output).toContain('1m');
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
