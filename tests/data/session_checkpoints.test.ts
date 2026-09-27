import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Session, type Draft } from '../../src/agent_runtime/session';
import type { RuntimeOptions } from '../../src/agent_runtime/runtime/runtime';
import { subagentDone } from '../../src/agent_runtime/tools/subagents/run';
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

const git = (directory: string, args: readonly string[]) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });

// A worker that ends wakes its owner, and nobody awaits that turn.
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

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
    const oldText = readFileSync(path.join(options.directory, 'file.txt'), 'utf8');
    writeFileSync(path.join(options.directory, 'file.txt'), content);
    emit({ type: 'tool_call', call: {
      type: 'tool_call', id: `write-${content}`, title: 'file.txt', kind: 'edit', status: 'completed',
      locations: [{ path: path.join(options.directory, 'file.txt') }],
      content: [{ type: 'diff', path: path.join(options.directory, 'file.txt'), oldText, newText: content }],
    } });
    emit({ type: 'text', text: 'Edited.' });
  });
}

describe('session checkpoint integration', () => {
  test('rewind restores proven agent files and forks without changing the source', async () => {
    const binding = writeResponse();
    await session.sendMessage(prompt);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('agent edit');
    const [checkpoint] = session.getCheckpoints();
    expect(checkpoint.seq).toBe(0);
    const result = await session.rewind(checkpoint.id, { files: true, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
    expect(result.droppedMessages).toBe(2);
    expect(result.files?.restored).toEqual(['file.txt']);
    expect(session.getMessages()).toHaveLength(2);
    expect(session.getCheckpoints()).toEqual([checkpoint]);
    expect(result.fork?.messages).toEqual([]);
    expect(result.fork?.checkpoints).toEqual([]);
    expect(result.fork?.inputContent).toBe('Change the file');
    expect(result.fork?.id).not.toBe(session.getId());
    expect(binding.runtimes[0].disposed).toBe(false);
  });

  test('location-only calls preserve edits made by the user while the tool ran', async () => {
    bindScriptedRuntime(model, (_input, emit) => {
      emit({ type: 'tool_call', call: { type: 'tool_call', id: 'edit', title: 'Edit', kind: 'edit', status: 'in_progress', locations: [{ path: 'file.txt' }], content: [] } });
      writeFileSync(path.join(project, 'file.txt'), 'user edit during tool');
      emit({ type: 'tool_call', call: { type: 'tool_call', id: 'edit', title: 'Edit', kind: 'edit', status: 'completed', locations: [{ path: 'file.txt' }], content: [] } });
      emit({ type: 'text', text: 'Done' });
    });
    await session.sendMessage(prompt);
    const checkpoint = session.getCheckpoints()[0];
    const preview = await session.previewRewind(checkpoint.id, { files: true, chat: false });
    expect(preview.files?.conflicts).toEqual(['file.txt']);
    expect((await session.rewind(checkpoint.id, { files: true, chat: false })).files?.restored).toEqual([]);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user edit during tool');
  });

  test('in-place worker diffs belong to the checkpoint before the worker started', async () => {
    let spawned = false;
    bindScriptedRuntime(model, async (_input, emit, options) => {
      if (isWorker(options)) {
        writeFileSync(path.join(project, 'file.txt'), 'worker edit');
        emit({ type: 'tool_call', call: { type: 'tool_call', id: 'worker-edit', title: 'Edit', kind: 'edit', status: 'completed', locations: [{ path: 'file.txt' }],
          content: [{ type: 'diff', path: 'file.txt', oldText: 'user draft', newText: 'worker edit' }],
        } });
      } else if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Edit file', { context: 'fresh', runInBackground: false }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Done' });
    });
    await session.sendMessage(prompt);
    const checkpoint = session.getCheckpoints()[0];
    expect(checkpoint.changes).toHaveLength(1);
    const restored = Session.fromSnapshot({ ...structuredClone(session.toSnapshot()), id: 'worker-evidence-reloaded' });
    restored.setInputContent('trigger notification');
    expect(restored.getCheckpoints()[0].changes).toHaveLength(1);
    const result = await restored.rewind(checkpoint.id, { files: true, chat: true });
    expect(result.files?.restored).toEqual(['file.txt']);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
    await restored.dispose();
  });

  test('restored evidence stays independent and detects edits after a preview', async () => {
    writeResponse();
    await session.sendMessage(prompt);
    const snapshot = structuredClone(session.toSnapshot());
    const checkpoint = session.getCheckpoints()[0];
    const originalCount = checkpoint.changes?.length;
    const restored = Session.fromSnapshot({ ...snapshot, id: 'restored-evidence' });
    restored.setInputContent('draft triggers a notification');
    expect(restored.getCheckpoints()[0].changes?.length).toBe(originalCount);
    expect((await restored.previewRewind(checkpoint.id, { files: true, chat: false })).files?.restored).toEqual(['file.txt']);
    writeFileSync(path.join(project, 'file.txt'), 'user edit after preview');
    const result = await restored.rewind(checkpoint.id, { files: true, chat: true });
    expect(result.files?.conflicts).toEqual(['file.txt']);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user edit after preview');
    expect(result.fork?.inputContent).toBe('Change the file');
    expect(restored.getMessages()).toHaveLength(2);
    await restored.dispose();
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
    const result = await session.rewind(checkpoint.id, { files: false, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('new user edit');
    expect(session.getMessages()).toEqual(history);
    expect(result.fork?.messages).toEqual([]);
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

    const result = await session.rewind(checkpoints[1].id, { files: false, chat: true });
    expect(binding.runtimes[0].disposed).toBe(false);
    expect(session.getMessages()).toHaveLength(4);
    const fork = Session.fromSnapshot(result.fork!);
    await fork.sendMessage(prompt);
    expect(binding.runtimes[1].prompts[0].text).toBe([
      'Earlier conversation, for context:',
      'User: Change the file',
      '@sirus: Response 1',
      '',
      'Change the file',
    ].join('\n'));
    expect(fork.getContextUsage()).toEqual({ tokens: 330, window: 200_000 });
  });

  test.each(['fork', 'rewind'] as const)('%s starts a separate native session while the source remains resumable', async operation => {
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    let response = 0;
    const binding = bindScriptedRuntime(model, (_input, emit) => {
      emit({ type: 'text', text: `Response ${++response}` });
    }, true);
    let fork: Session | undefined;
    try {
      await session.sendMessage(prompt);
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'A later turn' }] });
      const originalNative = session.toSnapshot().participants[0].nativeSession!;
      const snapshot = operation === 'fork' ? session.fork()
        : (await session.rewind(session.getCheckpoints()[1].id, { files: false, chat: true })).fork!;
      expect(snapshot.participants.every(participant => participant.nativeSession === undefined)).toBe(true);
      expect(snapshot.defaultModel.nativeSession).toBeUndefined();
      expect(session.toSnapshot().participants[0].nativeSession).toEqual(originalNative);
      fork = Session.fromSnapshot(snapshot);
      await fork.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue separately' }] });
      expect(binding.starts[1].resume).toBeUndefined();
      expect(binding.runtimes[1].prompts[0].text).toContain('Earlier conversation, for context:');
      expect(binding.runtimes[1].prompts[0].text).toContain('Response 1');
      if (operation === 'rewind') {
        expect(binding.runtimes[1].prompts[0].text).not.toContain('Response 2');
        expect(binding.runtimes[1].prompts[0].text).not.toContain('A later turn');
      }
      expect(fork.toSnapshot().participants[0].nativeSession!.sessionId).not.toBe(originalNative.sessionId);

      binding.runtimes[0].dispose();
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue the original' }] });
      expect(binding.starts[2].resume).toEqual(originalNative);
      expect(binding.runtimes[2].prompts[0].text).toBe('Continue the original');
      expect(session.toSnapshot().participants[0].nativeSession!.sessionId).toBe(originalNative.sessionId);

      const forkNative = fork.toSnapshot().participants[0].nativeSession!;
      fork.clear();
      expect(fork.toSnapshot().participants[0].nativeSession).toBeUndefined();
      expect(fork.toSnapshot().defaultModel.nativeSession).toBeUndefined();
      await fork.sendMessage({ role: 'user', content: [{ type: 'text', text: 'After clear' }] });
      expect(binding.starts[3].resume).toBeUndefined();
      expect(binding.runtimes[3].prompts[0].text).toBe('After clear');
      expect(fork.toSnapshot().participants[0].nativeSession!.sessionId).not.toBe(forkNative.sessionId);
    } finally {
      await fork?.dispose();
      await session.dispose();
      if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    }
  });

  test('queued prompts that need new turns capture their own pre-turn files and history position', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let turnNumber = 0;
    bindScriptedRuntime(model, async (_input, emit, options, _signal, runtime) => {
      // A vendor that cannot accept the safe-point delivery leaves the
      // follow-up queued for a separate turn, with its own checkpoint.
      runtime.steer = async () => { throw new Error('Steering unavailable'); };
      const number = ++turnNumber;
      if (number === 1) await firstGate;
      const oldText = readFileSync(path.join(options.directory, 'file.txt'), 'utf8');
      writeFileSync(path.join(options.directory, 'file.txt'), `edit ${number}`);
      emit({ type: 'tool_call', call: {
        type: 'tool_call', id: `write-${number}`, title: 'file.txt', kind: 'edit', status: 'completed',
        locations: [{ path: path.join(options.directory, 'file.txt') }],
        content: [{ type: 'diff', path: 'file.txt', oldText, newText: `edit ${number}` }],
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
    expect(checkpoints.map(checkpoint => checkpoint.seq)).toEqual(
      session.getMessages().filter(message => message.role === 'user').map(message => message.seq),
    );
    expect(checkpoints.map(checkpoint => checkpoint.summary)).toEqual(['Change the file', 'Second queued change']);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('edit 2');
    expect(session.getQueuedMessageCount()).toBe(0);

    const secondFork = await session.rewind(checkpoints[1].id, { files: true, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('edit 1');
    expect(secondFork.fork?.messages).toHaveLength(2);
    expect(session.getMessages()).toHaveLength(4);

    const firstFork = await Session.fromSnapshot(secondFork.fork!).rewind(checkpoints[0].id, { files: true, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
    expect(firstFork.fork?.messages).toHaveLength(0);
    expect(session.getMessages()).toHaveLength(4);
  });

  test.each([new Error('runtime failed'), new TurnCancelledError()])(
    'settles a snapshot before a failed or cancelled turn can be cleared: %s', async error => {
      bindScriptedRuntime(model, () => { throw error; });
      await expect(session.sendMessage(prompt)).rejects.toThrow(error instanceof TurnCancelledError ? error.message : 'refused or could not complete');
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
    expect((await rewind).fork?.messages).toEqual([]);
    expect(session.getMessages()).toHaveLength(2);
    await session.sendMessage(prompt);
    expect(session.getMessages()).toHaveLength(4);
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
    expect((await session.rewind(invalidCheckpoint.id, { files: false, chat: true })).fork?.messages).toEqual([]);
    expect(session.getMessages()).toHaveLength(1);
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
    'blocks file rewind while an in-place worker from %s is still running', async ownerScope => {
      writeResponse();
      await session.sendMessage(prompt);
      const [checkpoint] = session.getCheckpoints();
      const owner = ownerScope === 'same session'
        ? session : new Session({ id: 'detached-other', name: 'Other session', directory: project, model });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let spawned = false;
      bindScriptedRuntime(model, async (_input, emit, options) => {
        if (isWorker(options)) await gate;
        else if (!spawned) {
          spawned = true;
          await owner.subagentHostFor('sirus')!.spawn('Keep working', { context: 'fresh' }, { callId: 'spawn' });
        }
        emit({ type: 'text', text: 'Done' });
      });
      const [worker] = await (async () => { await owner.sendMessage(prompt); return owner.getWorkers(); })();
      try {
        expect(owner.getStatus()).toBe('idle');
        expect(worker.status).toBe('working');
        // A project that is not a git repository has no worktree to give it,
        // so it works in the directory everything else is working in.
        expect(worker.branch).toBeNull();
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
        await subagentDone(worker);
        await until(() => owner.getStatus() !== 'working', 'the report turn to finish');
      }
      const result = await session.rewind(checkpoint.id, { files: true, chat: true });
      expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
      expect(result.fork?.messages).toEqual([]);
      expect(session.getMessages().length).toBeGreaterThan(0);
    },
  );

  test('allows rewind while another session has a worker in a different directory', async () => {
    writeResponse();
    await session.sendMessage(prompt);
    const [checkpoint] = session.getCheckpoints();
    const otherProject = path.join(root, 'other-project');
    mkdirSync(otherProject);
    const other = new Session({ id: 'detached-unrelated', name: 'Other project', directory: otherProject, model });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let spawned = false;
    bindScriptedRuntime(model, async (_input, emit, options) => {
      if (isWorker(options)) await gate;
      else if (!spawned) {
        spawned = true;
        await other.subagentHostFor('sirus')!.spawn('Keep working', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Done' });
    });
    try {
      await other.sendMessage(prompt);
      const [worker] = other.getWorkers();
      expect(other.getStatus()).toBe('idle');
      const result = await session.rewind(checkpoint.id, { files: true, chat: true });
      expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
      expect(result.fork?.messages).toEqual([]);
      expect(session.getMessages().length).toBeGreaterThan(0);
      expect(worker.status).toBe('working');
    } finally {
      release();
      await other.dispose();
    }
  });

  test('explicit worktree isolation starts at HEAD and removes unchanged work on completion', async () => {
    const repository = path.join(root, 'repository');
    mkdirSync(repository);
    git(repository, ['init', '--quiet', '-b', 'main']);
    git(repository, ['config', 'user.email', 'worker@example.com']);
    git(repository, ['config', 'user.name', 'Worker Test']);
    writeFileSync(path.join(repository, 'file.txt'), 'committed');
    git(repository, ['add', 'file.txt']);
    git(repository, ['commit', '--quiet', '-m', 'first']);

    const owner = new Session({ id: 'worktree-session', name: 'Worktree', directory: repository, model });
    owner.setPermissionMode('bypass');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let spawned = false;
    bindScriptedRuntime(model, async (_input, emit, options) => {
      if (isWorker(options)) {
        await gate;
        return;
      }
      if (!spawned) {
        spawned = true;
        await owner.subagentHostFor('sirus')!.spawn('Work on your own branch', { context: 'fresh', isolation: 'worktree' }, { callId: 'spawn' });
      }
      writeFileSync(path.join(options.directory, 'file.txt'), 'agent edit');
      emit({ type: 'tool_call', call: { type: 'tool_call', id: 'edit', title: 'Edit file', kind: 'edit', status: 'completed', locations: [],
        content: [{ type: 'diff', path: 'file.txt', oldText: 'committed', newText: 'agent edit' }],
      } });
      emit({ type: 'text', text: 'Done' });
    });
    let worktree = '';
    let branch = '';
    try {
      await owner.sendMessage(prompt);
      const [worker] = owner.getWorkers();
      worktree = worker.directory;
      branch = worker.branch!;
      expect(branch).toBe(`sirus/${worker.id}`);
      expect(worktree).toBe(path.join(root, 'state', 'worktrees', 'worktree-session', worker.id));
      expect(readFileSync(path.join(worktree, 'file.txt'), 'utf8')).toBe('committed');
      expect(git(repository, ['branch', '--list', branch])).toContain(branch);

      // Its work is not in the project, so nothing it does blocks a rewind
      // of the files there.
      const [checkpoint] = owner.getCheckpoints();
      expect(readFileSync(path.join(repository, 'file.txt'), 'utf8')).toBe('agent edit');
      await owner.rewind(checkpoint.id, { files: true, chat: false });
      expect(readFileSync(path.join(repository, 'file.txt'), 'utf8')).toBe('committed');
      expect(worker.status).toBe('working');
    } finally {
      release();
      await owner.dispose();
    }
    // The worktree goes with the session; the branch is left to be merged.
    expect(existsSync(worktree)).toBe(false);
    expect(git(repository, ['branch', '--list', branch]).trim()).toBe('');
    expect(git(repository, ['worktree', 'list'])).not.toContain(worktree);
  });
});

test('changed worktrees survive completion and disposal, including committed changes', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sirus-kept-worktrees-'));
  const previous = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = path.join(scratch, 'data');
  const repository = path.join(scratch, 'repository');
  mkdirSync(repository);
  git(repository, ['init', '--quiet', '-b', 'main']);
  git(repository, ['config', 'user.email', 'worker@example.com']);
  git(repository, ['config', 'user.name', 'Worker Test']);
  writeFileSync(path.join(repository, 'file.txt'), 'original');
  git(repository, ['add', 'file.txt']);
  git(repository, ['commit', '--quiet', '-m', 'first']);
  const session = new Session({ id: 'kept-worktrees', name: 'Kept', directory: repository, model });
  bindScriptedRuntime(model, (input, emit, options) => {
    writeFileSync(path.join(options.directory, 'file.txt'), input.text);
    if (input.text === 'commit') {
      git(options.directory, ['add', 'file.txt']);
      git(options.directory, ['commit', '--quiet', '-m', 'worker change']);
    }
    emit({ type: 'text', text: 'Changed file.txt' });
  });
  try {
    for (const prompt of ['dirty', 'commit']) {
      const report = await session.subagentHostFor('sirus')!.spawn(prompt, { isolation: 'worktree', runInBackground: false }, { callId: prompt });
      expect(report).toMatchObject({ status: 'done', branch: expect.stringContaining('sirus/'), worktree: expect.any(String) });
      expect(report.changes).toContain('Changed file.txt');
    }
    await session.dispose();
    for (const run of session.getWorkers()) {
      expect(existsSync(run.directory)).toBe(true);
      expect(readFileSync(path.join(run.directory, 'file.txt'), 'utf8')).toBe(run.prompt);
    }
    expect(readFileSync(path.join(repository, 'file.txt'), 'utf8')).toBe('original');
  } finally {
    await session.dispose();
    unbindRuntime(model);
    if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
});
