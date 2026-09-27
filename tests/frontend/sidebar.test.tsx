import { describe, expect, test } from 'bun:test';
import { Box, render as renderApp, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';
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
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import { lineToRow } from '../../src/frontend/terminal/screen';

const noOp = () => {};

function mountSidebar() {
  let sessions = Array.from({ length: 30 }, (_, index) => new Session({
    id: `scroll-${index}`, name: `Session ${String(index).padStart(2, '0')}`,
    timing: { conversationStartedAt: 30 - index },
  }));
  const allSessions = sessions;
  let selected = sessions[0]!;
  let height = 14;
  let collapsed = false;
  let added = 0;
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 30 });
  let frame = '';
  stdout.on('data', chunk => { if (chunk.toString().trim()) frame = stripAnsi(chunk.toString()); });
  const view = () => <Box height={height} width={40}>
    <Sidebar sessions={sessions} currSession={selected} selectSession={session => {
      selected = session;
      app.rerender(view());
    }} addSession={() => { added++; }} deleteSession={noOp} collapsed={collapsed} />
  </Box>;
  const app = renderApp(view(), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  const type = async (input: string) => { stdin.write(input); await flush(); };
  return {
    flush, type,
    frame: () => frame,
    selected: () => selected,
    added: () => added,
    async wheel(direction: 'up' | 'down', column = 3, line = 4) {
      await type(`\x1b[<${direction === 'up' ? 64 : 65};${column};${lineToRow(line)}M`);
    },
    async resize(next: number) { height = next; app.rerender(view()); await flush(); },
    async collapse() { collapsed = true; app.rerender(view()); await flush(); },
    async keepFirst(count: number) {
      sessions = sessions.slice(0, count);
      if (!sessions.includes(selected)) selected = sessions[0]!;
      app.rerender(view());
      await flush();
    },
    async close() {
      app.unmount();
      await app.waitUntilExit();
      stdin.destroy();
      stdout.destroy();
      for (const session of allSessions) await session.dispose();
    },
  };
}

describe('sidebar scrolling', () => {
  test('wheel scrolling reaches the last session, keeps controls fixed, and clicks the visible row', async () => {
    const app = mountSidebar();
    try {
      await app.flush();
      const initial = app.frame();
      expect(initial).toContain('Session 00');
      expect(initial).not.toContain('Session 29');
      const footerLine = initial.split('\n').findIndex(line => line.includes('new session'));
      await app.wheel('down', 30); // Over chat, not the sidebar.
      await app.wheel('down', 3, 0); // Over the fixed header.
      expect(app.frame()).toBe(initial);
      for (let index = 0; index < 12; index++) await app.wheel('down');
      expect(app.frame()).toContain('Session 29');
      expect(app.frame()).not.toContain('Session 00');
      expect(app.frame().split('\n')[footerLine]).toContain('new session');
      expect(app.frame().split('\n')[0]).toContain('sirus');
      expect(app.frame()).toContain('┃');
      const bottom = app.frame();
      await app.wheel('down');
      expect(app.frame()).toBe(bottom);
      const row = app.frame().split('\n').findIndex(line => line.includes('Session 29'));
      expect(pressAt({ col: 3, line: row })).toBe(true);
      expect(releaseAt({ col: 3, line: row })).toBe(true);
      await app.flush();
      expect(app.selected().getName()).toBe('Session 29');
      // Hidden rows must not intercept the fixed footer's click.
      pressAt({ col: 3, line: footerLine });
      releaseAt({ col: 3, line: footerLine });
      expect(app.added()).toBe(1);
      for (let index = 0; index < 12; index++) await app.wheel('up');
      expect(app.frame()).toContain('Session 00');
      expect(app.frame()).not.toContain('Session 29');
    } finally {
      await app.close();
    }
  });

  test('keyboard switching follows selection through wraparound, resize, and list removal', async () => {
    const app = mountSidebar();
    try {
      await app.flush();
      await app.type('\x1b[1;3A');
      expect(app.selected().getName()).toBe('Session 29');
      expect(app.frame()).toContain('Session 29');
      await app.resize(11);
      expect(app.frame()).toContain('Session 29');
      expect(app.frame()).toContain('new session');
      await app.type('\x1b[1;3B');
      expect(app.selected().getName()).toBe('Session 00');
      expect(app.frame()).toContain('Session 00');
      for (let index = 0; index < 12; index++) await app.type('\x1b[1;3B');
      expect(app.frame()).toContain('Session 12');
      await app.keepFirst(3);
      expect(app.frame()).toContain('Session 00');
      expect(app.frame()).toContain('Session 02');
      expect(app.frame()).not.toContain('┃');
    } finally {
      await app.close();
    }
  });

  test('the collapsed sidebar can scroll and select sessions beyond the first page', async () => {
    const app = mountSidebar();
    try {
      await app.flush();
      await app.collapse();
      for (let index = 0; index < 12; index++) await app.wheel('down', 2);
      const rows = app.frame().split('\n').flatMap((line, index) => line.includes('○') ? [index] : []);
      expect(rows.length).toBeGreaterThan(0);
      pressAt({ col: 1, line: rows.at(-1)! });
      releaseAt({ col: 1, line: rows.at(-1)! });
      await app.flush();
      expect(app.selected().getName()).toBe('Session 29');
    } finally {
      await app.close();
    }
  });
});

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

  test('sorts by conversation start rather than latest activity without mutating the source list', () => {
    const older = Session.fromSnapshot({ ...new Session({ name: 'Older' }).toSnapshot(), updatedAt: 9_000, conversationStartedAt: 1_000 });
    const newer = Session.fromSnapshot({ ...new Session({ name: 'Newer' }).toSnapshot(), updatedAt: 2_000, conversationStartedAt: 2_000 });
    const source = [older, newer];
    expect(sessionsByRecency(source)).toEqual([newer, older]);
    expect(source).toEqual([older, newer]);
  });

  test('shows the session name and activity time on one line without its directory', () => {
    const session = new Session({ id: 'work', name: 'Work', directory: '/projects/sirus-harness', timing: { updatedAt: 1_000 } });
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
    expect(output).toContain('Work');
    expect(output).not.toContain('sirus-harness');
    expect(output).toContain('1m');
    expect(output.trim().split('\n')).toHaveLength(1);
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
    expect(render(new Session({ name: 'Idle' }))).toContain('○ Idle');
  });

  test('shows a hollow circle while working and a filled circle after an error', async () => {
    const model = 'sidebar-status-model';
    let finish!: () => void;
    let started!: () => void;
    // Starting a runtime is asynchronous now, so wait for the turn itself.
    const running = new Promise<void>(resolve => { started = resolve; });
    bindScriptedRuntime(model, async () => {
      started();
      await new Promise<void>(resolve => { finish = resolve; });
      throw new Error('runtime failed');
    });
    const session = new Session({ id: 'status-id', name: 'Active', model });

    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Go' }] });
    await running;
    expect(render(session)).toContain('○ Active');

    finish();
    await expect(turn).rejects.toThrow('refused or could not complete');
    expect(render(session)).toContain('● Active');

    session.dispose();
    unbindRuntime(model);
  });
});
