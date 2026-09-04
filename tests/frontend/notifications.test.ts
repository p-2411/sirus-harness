import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Session, type SessionStatus } from '../../src/agent_runtime/session';
import { authorizeToolCall, pendingApprovals, resolveApproval } from '../../src/agent_runtime/permissions/permissions';
import { loadNotificationPreference, loadMemoryAccessPreference, saveMemoryAccessPreference } from '../../src/persistence';
import { notificationMode, setNotificationMode, shouldNotify, terminalNotificationSequence } from '../../src/frontend/terminal/notifications';
import { parseFocusEvent, recordFocusEvent, resetFocusState } from '../../src/frontend/terminal/window-focus';
import { subscribeApprovalNotifications, subscribeSessionNotifications, turnSummary } from '../../src/frontend/useNotifications';
import { notifyCommandSpec } from '../../src/commands/notifications/commands';

let directory: string;
let previousDirectory: string | undefined;
let previousTmux: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sirus-notifications-'));
  previousDirectory = process.env.SIRUS_DATA_DIR;
  previousTmux = process.env.TMUX;
  process.env.SIRUS_DATA_DIR = directory;
  delete process.env.TMUX;
  resetFocusState();
  setNotificationMode('background');
});
afterEach(() => {
  setNotificationMode('background');
  resetFocusState();
  if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = previousDirectory;
  if (previousTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = previousTmux;
  rmSync(directory, { recursive: true, force: true });
});

describe('notification settings and delivery', () => {
  test('background mode waits for reported loss of focus', () => {
    expect(shouldNotify()).toBe(false);
    for (const input of ['\x1b[O', '[O']) expect(parseFocusEvent(input)).toBe('out');
    for (const input of ['\x1b[I', '[I']) expect(parseFocusEvent(input)).toBe('in');
    expect(parseFocusEvent('hello')).toBeNull();
    recordFocusEvent('out');
    expect(shouldNotify()).toBe(true);
    recordFocusEvent('in');
    expect(shouldNotify()).toBe(false);
    setNotificationMode('always');
    expect(shouldNotify()).toBe(true);
    setNotificationMode('off');
    recordFocusEvent('out');
    expect(shouldNotify()).toBe(false);
  });

  test('persists the selected mode and preserves other settings', () => {
    saveMemoryAccessPreference(false);
    setNotificationMode('always');
    expect(loadNotificationPreference()).toBe('always');
    expect(loadMemoryAccessPreference()).toBe(false);
    saveMemoryAccessPreference(true);
    expect(loadNotificationPreference()).toBe('always');
  });

  test('failed persistence leaves the previous mode active', () => {
    const blockedPath = join(directory, 'file');
    writeFileSync(blockedPath, 'not a directory');
    process.env.SIRUS_DATA_DIR = blockedPath;
    try {
      expect(() => setNotificationMode('off')).toThrow('Could not save');
      expect(notificationMode()).toBe('background');
    } finally {
      process.env.SIRUS_DATA_DIR = directory;
    }
  });

  test('rejects extra command arguments before changing preferences', () => {
    expect(() => notifyCommandSpec.run(['off', 'extra'], {} as never)).toThrow('Usage');
    expect(notificationMode()).toBe('background');
  });

  test('sanitizes terminal controls and supports terminal notification protocols', () => {
    expect(terminalNotificationSequence('Sirus;title\x1b', 'done\n\x07now', { TERM_PROGRAM: 'WezTerm' }))
      .toBe('\x1b]777;notify;Sirus,title;done now\x1b\\');
    expect(terminalNotificationSequence('Sirus', 'done', { TERM_PROGRAM: 'iTerm.app' }))
      .toBe('\x1b]9;Sirus: done\x1b\\');
    const kitty = terminalNotificationSequence('Sirus', 'done', { KITTY_WINDOW_ID: '1' });
    expect(kitty).toMatch(/^\x1b\]99;i=([a-f0-9]{8}):d=0;Sirus\x1b\\\x1b\]99;i=\1:p=body;done\x1b\\$/);
    expect(terminalNotificationSequence('Sirus', 'done', {})).toBeNull();
  });

  test('wraps notifications for tmux passthrough', () => {
    process.env.TMUX = '/tmp/tmux';
    expect(terminalNotificationSequence('Sirus', 'done', { TERM_PROGRAM: 'iTerm.app' }))
      .toBe('\x1bPtmux;\x1b\x1b]9;Sirus: done\x1b\x1b\\\x1b\\');
  });
});

describe('notification event subscriptions', () => {
  test('notifies each completed session once, reports errors, skips cancellation, and cleans up', () => {
    const session = new Session('Background work');
    let status: SessionStatus = 'idle';
    let cancelled = false;
    const statusSpy = spyOn(session, 'getStatus').mockImplementation(() => status);
    const cancelSpy = spyOn(session, 'wasLastTurnCancelled').mockImplementation(() => cancelled);
    const sent: string[] = [];
    const stop = subscribeSessionNotifications([session], (title, body) => sent.push(`${title}: ${body}`));
    const change = (next: SessionStatus) => {
      status = next;
      session.append({ role: 'assistant', content: [{ type: 'text', text: 'Finished the update.\nMore detail.' }] });
    };
    try {
      change('working');
      change('idle');
      change('idle');
      expect(sent).toEqual(['Sirus · Background work: @sirus: Finished the update.']);
      change('working');
      change('error');
      expect(sent[1]).toBe('Sirus · Background work: The turn failed.');
      change('working');
      cancelled = true;
      change('idle');
      expect(sent).toHaveLength(2);
      stop();
      cancelled = false;
      change('working');
      change('idle');
      expect(sent).toHaveLength(2);
    } finally {
      stop();
      statusSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });

  test('never uses a previous turn as the completion summary', () => {
    const session = new Session();
    session.append({ role: 'assistant', content: [{ type: 'text', text: 'Old answer.' }] });
    session.append({ role: 'user', content: [{ type: 'text', text: 'New request.' }] });
    expect(turnSummary(session, 'idle')).toBe('Turn finished.');
    session.append({ role: 'assistant', participant: 'reviewer', content: [{ type: 'text', text: 'Current progress.' }] });
    session.append({ role: 'user', content: [{ type: 'tool_result', callId: '1', result: 'done', isError: false }] });
    expect(turnSummary(session, 'idle')).toBe('@reviewer: Current progress.');
  });

  test('notifies once for each new approval and uses the latest session list', async () => {
    const session = new Session('First name');
    let sessions: Session[] = [];
    const sent: string[] = [];
    const stop = subscribeApprovalNotifications(() => sessions, (title, body) => sent.push(`${title}: ${body}`));
    const approvals: Promise<string | null>[] = [];
    const request = (id: string) => authorizeToolCall(
      { type: 'tool_call', id, name: 'WriteFile', arguments: { path: 'example.txt', content: 'test' } },
      directory,
      { sessionId: session.getId(), mode: () => 'ask', requester: { participant: 'reviewer' }, model: session.getModel() },
    );
    try {
      sessions = [session];
      approvals.push(request('first'));
      approvals.push(request('second'));
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('Sirus · First name: @reviewer wants to run WriteFile');
      for (const approval of pendingApprovals(session.getId())) resolveApproval(approval.id, 'allow');
      await Promise.all(approvals);
      expect(sent).toHaveLength(2);
      stop();
      approvals.push(request('after-unsubscribe'));
      expect(sent).toHaveLength(2);
    } finally {
      stop();
      for (const approval of pendingApprovals(session.getId())) resolveApproval(approval.id, 'deny');
      await Promise.all(approvals);
    }
  });
});
