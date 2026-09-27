import { expect, test } from 'bun:test';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Box, render, renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import Chat, { ChatHeader } from '../../src/frontend/chat/Chat';
import { Session } from '../../src/agent_runtime/session';
import { textOf } from '../../src/agent_runtime/types';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';
import { saveSessionSnapshot, loadSessionSnapshot } from '../../src/persistence/sessions';
import { pendingApprovals, requestPermission, resolveApproval } from '../../src/agent_runtime/permissions/approvals';

function screen(session: Session, columns = 100, rows = 32) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns, rows });
  let output = '';
  stdout.on('data', chunk => { if (stripAnsi(chunk.toString()).trim()) output = stripAnsi(chunk.toString()); });
  const app = render(<Box width={columns} height={rows}><Chat currSession={session} sidebarWidth={0} /></Box>, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await app.waitUntilRenderFlush(); };
  return {
    output: () => output,
    flush,
    async press(key: string) { stdin.write(key); await flush(); },
    async select(direction: 'left' | 'right') {
      stdin.write(direction === 'left' ? '\x1b[D' : '\x1b[C'); await flush();
    },
    async waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 2500;
      while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); await flush(); }
      expect(predicate()).toBe(true);
    },
    async close() { app.unmount(); await app.waitUntilExit(); app.cleanup(); stdin.destroy(); stdout.destroy(); },
  };
}

test('agent tabs switch transcripts and preserve drafts and cursor editing', async () => {
  const session = new Session();
  session.addParticipant('reviewer', 'claude-sonnet-5');
  session.append({ role: 'assistant', participant: 'sirus', content: [{ type: 'text', text: 'Builder-only answer' }] });
  session.append({ role: 'assistant', participant: 'reviewer', content: [{ type: 'text', text: 'Reviewer-only answer' }] });
  const chat = screen(session);
  try {
    await chat.flush();
    expect(chat.output()).toContain('Builder-only answer');
    expect(chat.output()).not.toContain('Reviewer-only answer');
    await chat.press('build draft');
    await chat.press('\x1bb'); // Word movement remains available while arrows switch agents.
    await chat.select('right');
    expect(session.getSelectedParticipant()).toBe('reviewer');
    expect(chat.output()).toContain('Reviewer-only answer');
    expect(chat.output()).not.toContain('Builder-only answer');
    expect(chat.output()).toContain('claude-sonnet-5');
    await chat.press('review draft');
    await chat.select('left');
    await chat.press('!');
    expect(session.getInputContent('sirus')).toBe('build !draft');
    expect(session.getInputContent('reviewer')).toBe('review draft');
    expect(session.getSelectedParticipant()).toBe('sirus');
  } finally { await chat.close(); await session.dispose(); }
});

test('background streaming cannot change the selected history or its reading position', async () => {
  const model = 'test-tabs-background';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let update!: () => void;
  bindScriptedRuntime(model, async (_input, emit) => {
    update = () => emit({ type: 'text', text: '\nBACKGROUND '.repeat(100) });
    emit({ type: 'text', text: 'Reviewer started' });
    await gate;
  });
  const session = new Session();
  session.addParticipant('reviewer', model);
  session.append({ role: 'assistant', participant: 'sirus', content: [{ type: 'text', text: Array.from({ length: 100 }, (_, i) => `Stable line ${i}`).join('\n\n') }] });
  const chat = screen(session);
  const turn = session.sendMessage({ role: 'user', to: ['reviewer'], content: [{ type: 'text', text: 'Review' }] });
  try {
    await chat.waitFor(() => Boolean(update));
    await chat.press('\x1b[5~');
    const reading = chat.output().split('\n').filter(line => line.includes('Stable line'));
    expect(reading.length).toBeGreaterThan(0);
    update();
    await chat.flush();
    expect(chat.output().split('\n').filter(line => line.includes('Stable line'))).toEqual(reading);
    expect(chat.output()).not.toContain('BACKGROUND');
    release(); await turn; await chat.flush();
    expect(chat.output().split('\n')[0]).toContain('reviewer.');
    await chat.select('right');
    expect(chat.output()).toContain('BACKGROUND');
    await chat.select('left');
    expect(chat.output().split('\n').filter(line => line.includes('Stable line'))).toEqual(reading);
  } finally { release(); await turn.catch(() => {}); await chat.close(); await session.dispose(); unbindRuntime(model); }
});

test('an idle selected agent can answer while its peer runs and queued messages keep their destination', async () => {
  const builder = 'test-tabs-builder', reviewer = 'test-tabs-reviewer';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received: string[] = [];
  bindScriptedRuntime(builder, async (_input, emit) => { emit({ type: 'text', text: 'Builder working' }); await gate; });
  bindScriptedRuntime(reviewer, (input, emit) => { received.push(input.text); emit({ type: 'text', text: 'Independent review done' }); });
  const session = new Session({ model: builder });
  session.addParticipant('reviewer', reviewer);
  const chat = screen(session);
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Build' }] });
  try {
    await chat.waitFor(() => session.isParticipantWorking('sirus'));
    await chat.press('Builder follow-up'); await chat.press('\r');
    expect(session.getQueuedMessages()[0].to).toEqual(['sirus']);
    await chat.select('right');
    await chat.press('Review this'); await chat.press('\r');
    await chat.waitFor(() => received.length === 1);
    expect(session.isParticipantWorking('sirus')).toBe(true);
    expect(chat.output()).not.toContain('Builder working');
    release(); await turn;
    await chat.waitFor(() => session.getStatus() === 'idle');
    expect(received).toHaveLength(1);
    expect(session.getMessages('sirus').some(message => textOf(message) === 'Builder follow-up')).toBe(true);
    expect(session.getMessages('reviewer').some(message => textOf(message) === 'Builder follow-up')).toBe(false);
  } finally { release(); await turn.catch(() => {}); await chat.close(); await session.dispose(); unbindRuntime(builder); unbindRuntime(reviewer); }
});

test('handoffs are attributed and visible in both participating conversations', async () => {
  const builder = 'test-tabs-handoff-builder', reviewer = 'test-tabs-handoff-reviewer';
  bindScriptedRuntime(builder, (_input, emit) => emit({ type: 'text', text: '@reviewer Please check this change.' }));
  bindScriptedRuntime(reviewer, (_input, emit) => emit({ type: 'text', text: 'Review complete.' }));
  const session = new Session({ model: builder }); session.addParticipant('reviewer', reviewer);
  const chat = screen(session);
  try {
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Build it' }] }); await chat.flush();
    expect(chat.output()).toContain('→ @reviewer');
    expect(chat.output()).not.toContain('Review complete.');
    await chat.select('right');
    expect(chat.output()).toContain('Please check this change.');
    expect(chat.output()).toContain('Review complete.');
  } finally { await chat.close(); await session.dispose(); unbindRuntime(builder); unbindRuntime(reviewer); }
});

test('many agents fit a narrow header and keep the selected tab visible', () => {
  const session = new Session();
  for (let i = 0; i < 12; i++) session.addParticipant(`reviewer-${i}`, 'claude-sonnet-5');
  session.selectParticipant('reviewer-9');
  const output = stripAnsi(renderToString(<ChatHeader session={session} width={50} />, { columns: 50 }));
  expect(output).toContain('reviewer-9');
  expect(output).toContain('‹');
  expect(output).toContain('›');
  expect(output).not.toMatch(/[┌┐└┘│]/);
  expect(output.split('\n')).toHaveLength(1);
  expect(output.split('\n').every(line => stringWidth(line) <= 50)).toBe(true);
});

test('a background approval marks its agent without taking over the selected input', async () => {
  const session = new Session(); session.addParticipant('reviewer', 'claude-sonnet-5');
  const chat = screen(session);
  const approval = requestPermission({ sessionId: session.getId(), requester: { participant: 'reviewer' } }, {
    sessionId: 'runtime', toolCall: { toolCallId: 'background-write', title: 'Write reviewed file', kind: 'edit' },
    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  });
  try {
    await chat.flush();
    expect(chat.output().split('\n')[0]).toContain('reviewer!');
    expect(chat.output()).not.toContain('Write reviewed file');
    await chat.press('Keep my draft');
    await chat.select('right');
    expect(chat.output()).toContain('Write reviewed file');
    await chat.select('left');
    expect(session.getSelectedParticipant()).toBe('sirus');
    expect(session.getInputContent()).toBe('Keep my draft');
    expect(pendingApprovals(session.getId())).toHaveLength(1);
  } finally {
    for (const request of pendingApprovals(session.getId())) resolveApproval(request.id, 'deny');
    await approval; await chat.close(); await session.dispose();
  }
});

test('model and reasoning commands configure the selected agent', async () => {
  const session = new Session(); session.addParticipant('reviewer', 'claude-sonnet-5');
  const original = session.getModel();
  const chat = screen(session);
  try {
    await chat.flush(); await chat.select('right');
    await chat.press('/thinking low'); await chat.press('\r');
    expect(session.getThinkingLevel('reviewer')).toBe('low');
    expect(session.getThinkingLevel('sirus')).not.toBe('low');
    await chat.press('/model gpt-5.6-luna'); await chat.press('\r');
    expect(session.getParticipants().find(participant => participant.name === 'reviewer')!.model).toBe('gpt-5.6-luna');
    expect(session.getModel()).toBe(original);
  } finally { await chat.close(); await session.dispose(); }
});

test('a queued command keeps explicit recipients when its text mentions other agents', async () => {
  const builder = 'test-tabs-queue-builder', reviewer = 'test-tabs-queue-reviewer';
  const calls: string[] = [];
  bindScriptedRuntime(builder, () => { calls.push('sirus'); });
  bindScriptedRuntime(reviewer, () => { calls.push('reviewer'); });
  const session = new Session({ model: builder }); session.addParticipant('reviewer', reviewer);
  session.queueMessage('/inspect @sirus and @reviewer', undefined, undefined, ['reviewer']);
  const chat = screen(session);
  try {
    await chat.waitFor(() => session.getStatus() === 'idle' && calls.length > 0);
    expect(calls).toEqual(['reviewer']);
    expect(session.getMessages('sirus')).toHaveLength(0);
  } finally { await chat.close(); await session.dispose(); unbindRuntime(builder); unbindRuntime(reviewer); }
});

test('selected agent and independent drafts survive saving and reopening', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sirus-agent-tabs-'));
  const session = new Session(); session.addParticipant('reviewer', 'claude-sonnet-5');
  session.append({ role: 'user', content: [{ type: 'text', text: 'Task' }] });
  session.setInputContent('builder draft');
  session.selectParticipant('reviewer'); session.setInputContent('reviewer draft');
  try {
    expect(saveSessionSnapshot(session.toSnapshot(), directory)).toBe(true);
    const snapshot = loadSessionSnapshot(session.getId(), directory)!;
    const restored = Session.fromSnapshot(snapshot);
    expect(restored.getSelectedParticipant()).toBe('reviewer');
    expect(restored.getInputContent()).toBe('reviewer draft');
    expect(restored.getInputContent('sirus')).toBe('builder draft');
    await restored.dispose();
  } finally { await session.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
