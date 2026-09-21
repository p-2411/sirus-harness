import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Session, type SessionStatus } from '../../src/agent_runtime/session';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { pendingApprovals, requestPermission, resolveApproval } from '../../src/agent_runtime/permissions/approvals';
import { loadNotificationPreference, loadMemoryAccessPreference, saveMemoryAccessPreference } from '../../src/persistence';
import { notificationMode, setNotificationMode, shouldNotify, terminalNotificationSequence } from '../../src/frontend/terminal/notifications';
import { parseFocusEvent, recordFocusEvent, resetFocusState } from '../../src/frontend/terminal/window-focus';
import {
  subscribeApprovalNotifications,
  subscribeSessionNotifications,
  subscribeWorkerNotifications,
  turnSummary,
} from '../../src/frontend/useNotifications';
import { notifyCommandSpec } from '../../src/commands/notifications/commands';
import {
  notifySubagents,
  registerSubagent,
  unregisterSubagent,
  type SubagentRun,
} from '../../src/agent_runtime/tools/subagents';

// A worker record as the notifications read it, with only the fields each
// case is about spelled out.
function workerRun(run: Partial<SubagentRun> & { id: string }): SubagentRun {
  return {
    callId: null, sessionId: 'session', owner: 'sirus', worker: null,
    model: 'claude-sonnet-5', thinkingLevel: 'medium', context: 'fresh',
    prompt: 'Work', directory: '/project', branch: null, status: 'working',
    startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(), transcript: [], content: [],
    finalMessage: null, changes: [], error: null, reported: false, dismissed: false,
    ...run,
  };
}

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
    const session = new Session({ name: 'Background work' });
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
    session.addParticipant('reviewer', session.getModel());
    session.append({ role: 'assistant', content: [{ type: 'text', text: 'Old answer.' }] });
    session.append({ role: 'user', content: [{ type: 'text', text: 'New request.' }] });
    expect(turnSummary(session, 'idle')).toBe('Turn finished.');
    session.append({ role: 'assistant', participant: 'reviewer', content: [{ type: 'text', text: 'Current progress.' }] });
    // An entry that is nothing but tool activity has no closing words of its
    // own, so the summary keeps walking back through this turn.
    session.append({ role: 'assistant', participant: 'sirus', content: [{
      type: 'tool_call', id: 'call-1', kind: 'read', title: 'notes.md',
      status: 'completed', locations: [], content: [],
    }] });
    expect(turnSummary(session, 'idle')).toBe('@reviewer: Current progress.');
  });

  test('notifies once for each new approval and uses the latest session list', async () => {
    const session = new Session({ name: 'First name' });
    let sessions: Session[] = [];
    const sent: string[] = [];
    const stop = subscribeApprovalNotifications(() => sessions, (title, body) => sent.push(`${title}: ${body}`));
    const approvals: Promise<RequestPermissionResponse>[] = [];
    const request = (id: string) => requestPermission(
      { sessionId: session.getId(), requester: { participant: 'reviewer' } },
      {
        sessionId: 'acp-session',
        toolCall: { toolCallId: id, kind: 'edit', title: 'example.txt', rawInput: { path: 'example.txt' } },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    );
    try {
      sessions = [session];
      approvals.push(request('first'));
      approvals.push(request('second'));
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('Sirus · First name: @reviewer wants to edit example.txt');
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

  test('announces a worker that finishes while nothing on screen waits for it', () => {
    const session = new Session({ id: 'worker-owner', name: 'Background work' });
    // The record a restart brings back is already terminal before anything
    // subscribes, so reopening the app never announces last session's work.
    const restored = workerRun({ id: 'sub-restored', sessionId: session.getId(), status: 'interrupted' });
    const finishing = workerRun({ id: 'sub-finishing', sessionId: session.getId() });
    const stopped = workerRun({ id: 'sub-stopped', sessionId: session.getId() });
    for (const run of [restored, finishing, stopped]) registerSubagent(run);
    const sent: string[] = [];
    const stop = subscribeWorkerNotifications(() => [session], (title, body) => sent.push(`${title}: ${body}`));
    const lines = (id: string) => sent.filter(line => line.includes(id));
    try {
      notifySubagents();
      expect(sent).toEqual([]);
      finishing.status = 'done';
      finishing.finalMessage = 'Rewrote the loader.\nIt is on its branch.';
      // The user stopped this one themselves and needs no telling.
      stopped.status = 'cancelled';
      notifySubagents();
      expect(lines('sub-finishing')).toEqual([
        'Sirus · Background work: Worker sub-finishing done; its report went to @sirus: Rewrote the loader.',
      ]);
      expect(lines('sub-stopped')).toEqual([]);
      expect(lines('sub-restored')).toEqual([]);
      notifySubagents();
      expect(lines('sub-finishing')).toHaveLength(1);
      stop();
    } finally {
      stop();
      for (const run of [restored, finishing, stopped]) unregisterSubagent(run.id);
    }
  });

  test('leaves a busy session to announce its own turn', () => {
    const session = new Session({ id: 'worker-busy-owner', name: 'Busy' });
    const statusSpy = spyOn(session, 'getStatus').mockImplementation(() => 'working');
    const run = workerRun({ id: 'sub-quiet', sessionId: session.getId() });
    registerSubagent(run);
    const sent: string[] = [];
    const stop = subscribeWorkerNotifications(() => [session], (title, body) => sent.push(`${title}: ${body}`));
    try {
      run.status = 'failed';
      notifySubagents();
      expect(sent.filter(line => line.includes('sub-quiet'))).toEqual([]);
    } finally {
      stop();
      unregisterSubagent(run.id);
      statusSpy.mockRestore();
    }
  });
});
