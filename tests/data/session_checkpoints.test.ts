import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Session, type Draft } from '../../src/agent_runtime/session';
import type { RuntimeOptions } from '../../src/agent_runtime/runtime/runtime';
import type { SubagentRun } from '../../src/agent_runtime/tools/subagents';
import { checkSubagent } from '../../src/agent_runtime/tools/subagents/run';
import { enableCheckpoints } from '../../src/checkpoints';
import { TurnCancelledError } from '../../src/abort';
import { bindScriptedRuntime, unbindRuntime, type ScriptedBinding } from '../support/runtime';

const model = 'test-checkpoint-session';
const originalDataDirectory = process.env.SIRUS_DATA_DIR;
let root: string;
let project: string;
let session: Session;
const prompt: Draft = { role: 'user', content: [{ type: 'text', text: 'Change the file' }] };
const isWorker = (options: RuntimeOptions) => options.systemPrompt.includes('You are a Sirus subagent');

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'sirus-session-checkpoints-'));
  project = path.join(root, 'project');
  mkdirSync(project);
  writeFileSync(path.join(project, 'file.txt'), 'user draft');
  process.env.SIRUS_DATA_DIR = path.join(root, 'state');
  enableCheckpoints();
  session = new Session({ id: 'checkpoint-session', name: 'Checkpoint test', directory: project, model });
  session.setPermissionMode('bypass');
});

afterEach(() => {
  enableCheckpoints(false);
  unbindRuntime(model);
  if (originalDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = originalDataDirectory;
  rmSync(root, { recursive: true, force: true });
});

// The vendor runs its own tools now: the scripted turn edits the file itself
// and reports the call the way an adapter would.
function writeResponse(content: string = 'agent edit'): ScriptedBinding {
  return bindScriptedRuntime(model, (_input, emit, options) => {
    writeFileSync(path.join(options.directory, 'file.txt'), content);
    emit({ type: 'tool_call', call: {
      type: 'tool_call', id: `write-${content}`, title: 'file.txt', kind: 'edit', status: 'completed',
      locations: [{ path: path.join(options.directory, 'file.txt') }],
      content: [{ type: 'diff', path: path.join(options.directory, 'file.txt'), oldText: null, newText: content }],
    } });
    emit({ type: 'text', text: 'Edited.' });
  });
}

describe('session checkpoint integration', () => {
  test('the snapshot is taken before the runtime is prompted, and rewind restores files and history', async () => {
    const binding = writeResponse();
    await session.sendMessage(prompt);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('agent edit');
    const [checkpoint] = session.getCheckpoints();
    expect(checkpoint.seq).toBe(0);
    const result = await session.rewind(checkpoint.id, { files: true, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
    expect(result.droppedMessages).toBe(2);
    expect(result.files?.restored).toEqual(['file.txt']);
    expect(session.getMessages()).toEqual([]);
    expect(session.getCheckpoints()).toEqual([]);
    // The runtime's conversation must not outlive the record it mirrored.
    expect(binding.runtimes[0].disposed).toBe(true);
  });

  test('file-only and chat-only rewinds preserve the unselected scope', async () => {
    writeResponse();
    await session.sendMessage(prompt);
    const [checkpoint] = session.getCheckpoints();
    const history = [...session.getMessages()];
    await session.rewind(checkpoint.id, { files: true, chat: false });
    expect(session.getMessages()).toEqual(history);
    expect(session.getCheckpoints()).toEqual([checkpoint]);
    writeFileSync(path.join(project, 'file.txt'), 'new user edit');
    await session.rewind(checkpoint.id, { files: false, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('new user edit');
    expect(session.getMessages()).toEqual([]);
  });

  test('a chat rewind rebuilds the runtime from what is left of the record', async () => {
    let turn = 0;
    const binding = bindScriptedRuntime(model, (_input, emit) => {
      turn++;
      emit({ type: 'text', text: `Response ${turn}` });
      emit({ type: 'context', usage: { tokens: turn * 110, window: 200_000 } });
    });
    await session.sendMessage(prompt);
    await session.sendMessage(prompt);
    expect(session.getContextUsage()).toEqual({ tokens: 220, window: 200_000 });
    const checkpoints = session.getCheckpoints();
    expect(checkpoints.map(checkpoint => checkpoint.seq)).toEqual([0, 2]);

    await session.rewind(checkpoints[1].id, { files: true, chat: false });
    expect(binding.runtimes[0].disposed).toBe(false);
    expect(session.getContextUsage()).toEqual({ tokens: 220, window: 200_000 });

    await session.rewind(checkpoints[1].id, { files: false, chat: true });
    expect(binding.runtimes[0].disposed).toBe(true);
    expect(session.getMessages()).toHaveLength(2);
    await session.sendMessage(prompt);
    expect(binding.runtimes[1].prompts[0].text).toBe([
      'Earlier conversation, for context:',
      'User: Change the file',
      '@sirus: Response 1',
      '',
      'Change the file',
    ].join('\n'));
    expect(session.getContextUsage()).toEqual({ tokens: 330, window: 200_000 });
  });

  test('queued prompts capture their own pre-turn files and history position', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let turnNumber = 0;
    bindScriptedRuntime(model, async (_input, emit, options) => {
      const number = ++turnNumber;
      if (number === 1) await firstGate;
      writeFileSync(path.join(options.directory, 'file.txt'), `edit ${number}`);
      emit({ type: 'tool_call', call: {
        type: 'tool_call', id: `write-${number}`, title: 'file.txt', kind: 'edit', status: 'completed',
        locations: [{ path: path.join(options.directory, 'file.txt') }], content: [],
      } });
      emit({ type: 'text', text: `Response ${number}` });
    });
    let unsubscribe = () => {};
    const completed = new Promise<void>(resolve => {
      unsubscribe = session.subscribe(() => {
        if (session.getStatus() === 'idle' && session.getCheckpoints().length === 2) resolve();
      });
    });
    try {
      const first = session.sendMessage(prompt);
      session.queueMessage('Second queued change');
      releaseFirst();
      await first;
      await completed;
    } finally {
      unsubscribe();
    }

    const checkpoints = session.getCheckpoints();
    expect(checkpoints.map(checkpoint => checkpoint.seq)).toEqual([0, 2]);
    expect(checkpoints.map(checkpoint => checkpoint.summary)).toEqual(['Change the file', 'Second queued change']);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('edit 2');
    expect(session.getQueuedMessageCount()).toBe(0);

    await session.rewind(checkpoints[1].id, { files: true, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('edit 1');
    expect(session.getMessages()).toHaveLength(2);

    await session.rewind(checkpoints[0].id, { files: true, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
    expect(session.getMessages()).toHaveLength(0);
  });

  test.each([new Error('runtime failed'), new TurnCancelledError()])(
    'settles a snapshot before a failed or cancelled turn can be cleared: %s', async error => {
      bindScriptedRuntime(model, () => { throw error; });
      await expect(session.sendMessage(prompt)).rejects.toThrow(error.message);
      expect(session.getCheckpoints()).toHaveLength(1);
      expect(session.getStatus()).toBe(error.name === 'AbortError' ? 'idle' : 'error');
      expect(session.wasLastTurnCancelled()).toBe(error.name === 'AbortError');
      session.clear();
      expect(session.getCheckpoints()).toEqual([]);
      expect(session.getMessages()).toEqual([]);
    },
  );

  test('prevents new turns, clearing, and overlapping rewinds while restoring files', async () => {
    writeResponse();
    await session.sendMessage(prompt);
    const [checkpoint] = session.getCheckpoints();
    const rewind = session.rewind(checkpoint.id, { files: true, chat: true });
    await expect(session.sendMessage(prompt)).rejects.toThrow('Wait for the rewind');
    expect(() => session.clear()).toThrow('Wait for the current operation');
    await expect(session.rewind(checkpoint.id, { files: false, chat: true }))
      .rejects.toThrow('Wait for the current rewind');
    await rewind;
    expect(session.getMessages()).toEqual([]);
    await session.sendMessage(prompt);
    expect(session.getMessages()).toHaveLength(2);
  });

  test('leaves history intact when file restoration fails', async () => {
    const invalidCheckpoint = { id: 'a'.repeat(40), seq: 0, summary: 'Unavailable', createdAt: Date.now() };
    session = new Session({
      id: 'missing',
      name: 'Missing checkpoint',
      directory: project,
      model,
      messages: [prompt],
      checkpoints: [invalidCheckpoint],
      permissionMode: 'auto',
    });
    await expect(session.rewind(invalidCheckpoint.id, { files: true, chat: true })).rejects.toThrow();
    expect(session.getMessages()).toEqual([{ ...prompt, seq: 0 }]);
    expect(session.getCheckpoints()).toEqual([invalidCheckpoint]);
    await session.rewind(invalidCheckpoint.id, { files: false, chat: true });
    expect(session.getMessages()).toEqual([]);
  });

  test('protects a shared directory while another session is working or restoring files', async () => {
    writeResponse();
    await session.sendMessage(prompt);
    const [checkpoint] = session.getCheckpoints();
    const other = new Session({ id: 'other', name: 'Other session', directory: project, model });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    bindScriptedRuntime(model, async (_input, emit) => {
      await gate;
      emit({ type: 'text', text: 'Done' });
    });
    const turn = other.sendMessage(prompt);
    try {
      await expect(session.rewind(checkpoint.id, { files: true, chat: true }))
        .rejects.toThrow('Another session is working');
    } finally {
      finish();
      await turn;
    }
    const restore = session.rewind(checkpoint.id, { files: true, chat: true });
    await expect(other.sendMessage(prompt)).rejects.toThrow('Wait for the rewind');
    await restore;
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
  });

  test.each(['same session', 'another session'])(
    'blocks file rewind while a detached worker from %s is still running', async ownerScope => {
      writeResponse();
      await session.sendMessage(prompt);
      const [checkpoint] = session.getCheckpoints();
      const owner = ownerScope === 'same session'
        ? session : new Session({ id: 'detached-other', name: 'Other session', directory: project, model });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let worker!: SubagentRun;
      bindScriptedRuntime(model, async (_input, emit, options) => {
        if (isWorker(options)) await gate;
        else worker = owner.subagentHostFor('sirus')!.spawn('Keep working', { callId: 'spawn' }) as SubagentRun;
        emit({ type: 'text', text: 'Done' });
      });
      try {
        await owner.sendMessage(prompt);
        expect(owner.getStatus()).toBe('idle');
        expect(worker.status).toBe('working');
        expect(worker.directory).toBe(project);
        await expect(session.rewind(checkpoint.id, { files: true, chat: false }))
          .rejects.toThrow('Subagents are working in this directory');
        expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('agent edit');
        if (owner === session) {
          await expect(session.rewind(checkpoint.id, { files: false, chat: true }))
            .rejects.toThrow('subagents to finish');
        }
        expect(worker.status).toBe('working');
      } finally {
        release();
        if (worker) await checkSubagent(worker, true);
      }
      await session.rewind(checkpoint.id, { files: true, chat: true });
      expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
      expect(session.getMessages()).toEqual([]);
    },
  );

  test('allows rewind while another session has a detached worker in a different directory', async () => {
    writeResponse();
    await session.sendMessage(prompt);
    const [checkpoint] = session.getCheckpoints();
    const otherProject = path.join(root, 'other-project');
    mkdirSync(otherProject);
    const other = new Session({ id: 'detached-unrelated', name: 'Other project', directory: otherProject, model });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let worker!: SubagentRun;
    bindScriptedRuntime(model, async (_input, emit, options) => {
      if (isWorker(options)) await gate;
      else worker = other.subagentHostFor('sirus')!.spawn('Keep working', { callId: 'spawn' }) as SubagentRun;
      emit({ type: 'text', text: 'Done' });
    });
    try {
      await other.sendMessage(prompt);
      expect(other.getStatus()).toBe('idle');
      await session.rewind(checkpoint.id, { files: true, chat: true });
      expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
      expect(session.getMessages()).toEqual([]);
      expect(worker.status).toBe('working');
    } finally {
      release();
      if (worker) await checkSubagent(worker, true);
    }
  });
});
