import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import type { WorkerRecord } from '../../src/agent_runtime/tools/subagents';
import { appendPromptHistory, readPromptHistory } from '../../src/persistence/promptHistory';
import {
  deleteSessionSnapshot,
  loadSessionRevision,
  loadSessionSnapshot,
  loadSessionSnapshots,
  saveSessionSnapshot,
  saveSessionSnapshots,
} from '../../src/persistence/sessions';
import { openSettings } from '../../src/persistence/settings';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-persistence-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('prompt history', () => {
  let previousDataDirectory: string | undefined;

  beforeEach(() => {
    previousDataDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
  });

  afterEach(() => {
    if (previousDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDataDirectory;
  });

  test('persists multiline prompts privately and separates project directories', () => {
    const project = path.join(directory, 'project');
    expect(readPromptHistory(project)).toEqual([]);
    appendPromptHistory(project, 'first\nsecond');
    appendPromptHistory(project, '  ');
    appendPromptHistory(`${project}/.`, 'next prompt');
    appendPromptHistory(path.join(directory, 'other'), 'other project');
    expect(readPromptHistory(project)).toEqual(['first\nsecond', 'next prompt']);
    expect(readPromptHistory(path.join(directory, 'other'))).toEqual(['other project']);
    const folder = path.join(directory, 'prompt-history');
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(folder)) {
      expect(file).toMatch(/^[a-f0-9]{64}\.jsonl$/);
      expect(statSync(path.join(folder, file)).mode & 0o777).toBe(0o600);
    }
  });

  test('keeps the latest thousand valid entries across damaged records', () => {
    const project = path.join(directory, 'project');
    for (let index = 0; index < 1_005; index++) appendPromptHistory(project, `prompt ${index}`);
    const folder = path.join(directory, 'prompt-history');
    const file = path.join(folder, readdirSync(folder)[0]!);
    writeFileSync(file, `${readFileSync(file, 'utf8')}invalid JSON\n42\n`);
    const history = readPromptHistory(project);
    expect(history).toHaveLength(1_000);
    expect(history[0]).toBe('prompt 5');
    expect(history.at(-1)).toBe('prompt 1004');
  });

  test('concurrent processes append without replacing another window’s prompts', async () => {
    const project = path.join(directory, 'project');
    const module = path.resolve(import.meta.dir, '../../src/persistence/promptHistory.ts');
    const children = Array.from({ length: 4 }, (_, worker) => Bun.spawn([
      process.execPath, '-e',
      `import { appendPromptHistory } from ${JSON.stringify(module)};
       for (let index = 0; index < 40; index++) {
         appendPromptHistory(${JSON.stringify(project)}, ${JSON.stringify(`worker ${worker}: `)} + index);
       }`,
    ], { env: process.env, stdout: 'pipe', stderr: 'pipe' }));
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0, 0]);
    const history = readPromptHistory(project);
    expect(history).toHaveLength(160);
    expect(new Set(history).size).toBe(160);
  });

  test('unwritable storage leaves input usable', () => {
    const file = path.join(directory, 'not-a-directory');
    writeFileSync(file, 'file');
    process.env.SIRUS_DATA_DIR = file;
    expect(() => appendPromptHistory(directory, 'prompt')).not.toThrow();
    expect(readPromptHistory(directory)).toEqual([]);
  });
});

describe('session persistence', () => {
  test('round-trips images, checkpoints, tools, notices, compaction and naming metadata together', () => {
    const image = { type: 'image' as const, path: path.join(directory, 'images', 'screenshot.png'), mediaType: 'image/png' as const, bytes: 123 };
    const checkpoint = {
      id: 'b'.repeat(40), seq: 0, summary: '[image]', createdAt: Date.now(),
      changes: [
        { path: 'edited.txt', before: 'original\n', after: 'agent edit\n' },
        { path: 'created.txt', before: null, after: 'created by agent\n' },
        { path: 'deleted.txt', before: 'removed by agent\n', after: null },
        { path: 'conflicted.txt', before: 'original\n', after: 'agent edit\n', conflict: 'User edited this file.' },
      ],
    };
    const session = new Session({
      id: 'image-session',
      name: 'With image',
      directory: '/projects/image',
      participants: [{ name: 'sirus', model: 'gpt-5.6-luna', nativeSession: {
        vendor: 'gpt', sessionId: 'codex-participant', directory: '/projects/image',
        sourceId: null, profileHome: '/profiles/codex', systemPromptHash: 'system-hash',
      } }],
      messages: [
        { role: 'user', to: ['sirus'], content: [image, { type: 'text', text: 'Explain this screenshot' }] },
        { role: 'assistant', participant: 'sirus', model: 'gpt-5.6-luna', content: [
          { type: 'thought', text: 'Looking at it.' },
          { type: 'notice', severity: 'warning', title: 'Model fallback', description: 'Using another model.' },
          { type: 'tool_call', id: 'call-1', title: 'ls', kind: 'execute', status: 'completed', locations: [], content: [{ type: 'text', text: 'a.png' }], input: { command: 'ls' }, output: 'a.png' },
          { type: 'text', text: 'Explanation' },
          { type: 'notice', severity: 'vendor-hint', title: 'Finished' },
          { type: 'compaction', summary: 'The screenshot was explained.' },
        ] },
      ],
      checkpoints: [checkpoint],
      permissionMode: 'ask',
      subagentModel: 'claude-sonnet-5',
      autoNamePending: true,
      timing: { updatedAt: 1_000 },
    });

    expect(saveSessionSnapshots([session].filter(s => !s.isEmpty()).map(s => s.toSnapshot()), session.getId(), directory)).toBe(true);
    const restored = loadSessionSnapshots(directory);
    expect(restored.selectedSessionId).toBe(session.getId());
    expect(restored.snapshots[0]).toEqual(session.toSnapshot());
    expect(restored.snapshots[0]!.participants[0]!.nativeSession).toEqual({
      vendor: 'gpt', sessionId: 'codex-participant', directory: '/projects/image',
      sourceId: null, profileHome: '/profiles/codex', systemPromptHash: 'system-hash',
    });
    expect(Session.fromSnapshot(restored.snapshots[0]).toSnapshot().checkpoints?.[0].changes).toEqual(checkpoint.changes);

    // Exercise migration on a scratch copy of a realistic old workspace,
    // including attachments, tools, notices and checkpoints, never real data.
    const original = JSON.stringify({ version: 1, selectedSessionId: session.getId(), sessions: [session.toSnapshot()] });
    const fixture = path.join(directory, 'legacy-fixture.json');
    const copiedDirectory = path.join(directory, 'migration-copy');
    writeFileSync(fixture, original);
    mkdirSync(copiedDirectory);
    copyFileSync(fixture, path.join(copiedDirectory, 'sessions.json'));
    const migrated = loadSessionSnapshots(copiedDirectory);
    expect(migrated.snapshots[0]).toEqual(session.toSnapshot());
    expect(Session.fromSnapshot(migrated.snapshots[0]).toSnapshot().checkpoints?.[0].changes).toEqual(checkpoint.changes);
    expect(migrated.selectedSessionId).toBe(session.getId());
    expect(readFileSync(path.join(copiedDirectory, 'sessions.json.migrated'), 'utf8')).toBe(original);
    expect(readFileSync(fixture, 'utf8')).toBe(original);
  });

  test('drops unknown block kinds without dropping messages or other sessions', () => {
    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({
      version: 1,
      selectedSessionId: 'future',
      sessions: [{
        id: 'future', name: 'Future blocks', model: 'gpt-5.6-luna', messages: [
          { role: 'user', content: [{ type: 'text', text: 'Keep this prompt' }] },
          { role: 'assistant', content: [
            { type: 'future-block', payload: { text: 'Ignore this' } },
            { type: 'text', text: 'Keep this answer' },
            { type: 'notice', severity: 'info', title: 'Keep this notice' },
            { type: 'tool_call', id: 'read', title: 'README', kind: 'read', status: 'completed', locations: [], content: [
              { type: 'future-tool-content', text: 'Ignore this too' },
              { type: 'text', text: 'Keep this result' },
            ] },
          ] },
        ],
      }, {
        id: 'ordinary', name: 'Ordinary', model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep this session' }] }],
      }],
    }));
    const restored = loadSessionSnapshots(directory);
    expect(restored.selectedSessionId).toBe('future');
    expect(restored.snapshots.map(snapshot => snapshot.id)).toEqual(['future', 'ordinary']);
    expect(restored.snapshots[0].messages).toHaveLength(2);
    expect(restored.snapshots[0].messages[1].content).toEqual([
      { type: 'text', text: 'Keep this answer' },
      { type: 'notice', severity: 'info', title: 'Keep this notice' },
      { type: 'tool_call', id: 'read', title: 'README', kind: 'read', status: 'completed', locations: [], content: [{ type: 'text', text: 'Keep this result' }] },
    ]);
  });

  test('restores sessions, selected session, models, and complete message history', () => {
    const first = new Session({ id: 'first-id', name: 'First', directory: '/projects/first', model: 'claude-fable-5-1' });
    first.append({ role: 'user', content: [{ type: 'text', text: 'Inspect this' }] });
    first.addParticipant('reviewer', 'gpt-5.6-terra');
    first.setThinkingLevel('medium');
    first.setThinkingLevel('xhigh', 'reviewer');
    first.append({
      role: 'assistant',
      participant: 'sirus',
      model: 'claude-fable-5-1',
      to: ['reviewer'],
      content: [
        { type: 'tool_call', id: 'call-1', title: 'README.md', kind: 'read', status: 'completed', locations: [{ path: 'README.md', line: 1 }], content: [] },
        { type: 'text', text: 'Done. @reviewer over to you.' },
      ],
    });
    const second = new Session({ id: 'second-id', name: 'Second', directory: '/projects/second', model: 'gpt-5.6-sol' });
    second.append({ role: 'user', content: [{ type: 'text', text: 'Keep this too' }] });
    first.setInputContent('Unfinished first message');
    second.setInputContent('  Unfinished second message\nwith whitespace  ');

    expect(saveSessionSnapshots(
      [first, second].filter(s => !s.isEmpty()).map(s => s.toSnapshot()),
      second.getId(),
      directory,
    )).toBe(true);
    const restored = loadSessionSnapshots(directory);

    expect(restored.selectedSessionId).toBe('second-id');
    const restoredSessions = restored.snapshots.map(Session.fromSnapshot);
    expect(restoredSessions.map(session => session.toSnapshot())).toEqual([
      first.toSnapshot(),
      second.toSnapshot(),
    ]);
    expect(restoredSessions[0].getThinkingLevel()).toBe('medium');
    expect(restoredSessions[0].getThinkingLevel('reviewer')).toBe('xhigh');
    expect(restoredSessions[0].getInputContent()).toBe('Unfinished first message');
    expect(restoredSessions[1].getInputContent()).toBe('  Unfinished second message\nwith whitespace  ');
  });

  test('round-trips the session’s workers, transcripts included', async () => {
    const worker: WorkerRecord = {
      nativeSession: {
        vendor: 'claude', sessionId: 'claude-worker',
        directory: path.join(directory, 'worktrees', 'worker-session', 'sub-1a2b3c4d'),
        sourceId: 'subscription-2', profileHome: '/profiles/claude-worker', systemPromptHash: 'worker-hash',
      },
      id: 'sub-1a2b3c4d',
      callId: 'call-spawn',
      owner: 'sirus',
      model: 'claude-sonnet-5',
      thinkingLevel: 'low',
      context: 'owner',
      prompt: 'Rewrite the parser',
      directory: path.join(directory, 'worktrees', 'worker-session', 'sub-1a2b3c4d'),
      branch: 'sirus/sub-1a2b3c4d',
      status: 'done',
      startedAt: 1_000,
      finishedAt: 2_000,
      updatedAt: 2_000,
      transcript: [
        { seq: 0, role: 'user', content: [{ type: 'text', text: 'Rewrite the parser' }] },
        { seq: 1, role: 'assistant', participant: 'sub-1a2b3c4d', model: 'claude-sonnet-5', content: [
          { type: 'notice', severity: 'info', title: 'Model rerouted' },
          { type: 'tool_call', id: 'edit-1', title: 'parser.ts', kind: 'edit', status: 'completed', locations: [{ path: 'parser.ts' }], content: [] },
          { type: 'text', text: 'Rewritten.' },
        ] },
      ],
      finalMessage: 'Rewritten.',
      changes: ['Edited parser.ts'],
      error: null,
      reported: true,
      dismissed: false,
    };
    const session = new Session({
      id: 'worker-session',
      name: 'With workers',
      directory,
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Delegate it' }] }],
      workers: [worker],
    });
    expect(session.toSnapshot().workers).toEqual([worker]);
    expect(saveSessionSnapshots([session.toSnapshot()], session.getId(), directory)).toBe(true);
    const file = path.join(directory, 'sessions', 'session-worker-session.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.workers[0].transcript[1].content.push({ type: 'future-worker-block' });
    writeFileSync(file, JSON.stringify(raw));
    await session.dispose();

    const [stored] = loadSessionSnapshots(directory).snapshots;
    expect(stored.workers).toEqual([worker]);
    const reopened = Session.fromSnapshot(stored);
    try {
      const [run] = reopened.getWorkers();
      expect(run).toMatchObject({ id: worker.id, sessionId: 'worker-session', worker: null, branch: worker.branch });
      // The response is the assistant entry's blocks, not a second copy.
      expect(run.content).toBe(run.transcript[1].content);
    } finally {
      await reopened.dispose();
    }
  });

  test('a session file written before workers existed loads without them', () => {
    const session = new Session({
      id: 'no-workers',
      name: 'No workers',
      directory,
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Nothing delegated' }] }],
    });
    expect(session.toSnapshot().workers).toBeUndefined();
    expect(saveSessionSnapshots([session.toSnapshot()], session.getId(), directory)).toBe(true);
    expect(loadSessionSnapshots(directory).snapshots[0].workers).toBeUndefined();
  });

  test('restores older participant snapshots with an empty draft', () => {
    const { inputContent, ...snapshot } = new Session().toSnapshot();
    expect(Session.fromSnapshot(snapshot).getInputContent()).toBe('');
  });

  test('draft edits notify subscribers and leave other sessions unchanged', () => {
    const first = new Session();
    const second = new Session();
    const drafts: string[] = [];
    const version = first.getVersion();
    const unsubscribe = first.subscribe(() => drafts.push(first.getInputContent()));
    first.setInputContent('Draft');
    first.setInputContent('Draft');
    first.setInputContent('');
    unsubscribe();

    expect(drafts).toEqual(['Draft', '']);
    expect(first.getVersion()).toBe(version + 2);
    expect(second.getInputContent()).toBe('');
  });

  test('falls back safely when the session file is corrupt or from an unknown version', () => {
    writeFileSync(path.join(directory, 'sessions.json'), '{broken');
    expect(loadSessionSnapshots(directory)).toMatchObject({ snapshots: [], selectedSessionId: null, notices: [expect.stringContaining('preserved')] });

    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({ version: 999, sessions: [] }));
    expect(loadSessionSnapshots(directory)).toMatchObject({ snapshots: [], selectedSessionId: null, notices: [expect.stringContaining('preserved')] });
  });

  test('assigns legacy sessions without a directory to the launch directory', () => {
    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({
      version: 1,
      selectedSessionId: 'legacy-id',
      sessions: [{
        id: 'legacy-id',
        name: 'Legacy',
        model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Legacy history' }] }],
      }],
    }));

    expect(loadSessionSnapshots(directory, '/projects/current-launch').snapshots[0]!.directory)
      .toBe('/projects/current-launch');
    expect(loadSessionSnapshots(directory, '/projects/current-launch').snapshots[0]!.participants)
      .toEqual([{ name: 'sirus', model: 'gpt-5.6-luna' }]);
  });

  test('normalises the single-model legacy file into a complete modern snapshot', () => {
    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({
      version: 1,
      selectedSessionId: 'legacy-id',
      sessions: [{
        id: 'legacy-id',
        name: 'Legacy',
        model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Legacy history' }] }],
      }],
    }));

    const restored = loadSessionSnapshots(directory, '/projects/current-launch');
    expect(restored.selectedSessionId).toBe('legacy-id');
    expect(restored.snapshots).toHaveLength(1);
    // Every field the modern shape carries, so the one remaining migration
    // stays pinned: no participants, no clocks, no draft and no seqs on disk
    // become a single `sirus` participant, an epoch-zero history, an empty
    // draft and seqs by position. Round-tripped through `Session` itself,
    // since a session with no checkpoints omits that key from `toSnapshot()`.
    expect(Session.fromSnapshot(restored.snapshots[0]!).toSnapshot()).toEqual({
      id: 'legacy-id',
      name: 'Legacy',
      archived: false,
      directory: '/projects/current-launch',
      participants: [{ name: 'sirus', model: 'gpt-5.6-luna' }],
      defaultModel: { name: 'sirus', model: 'gpt-5.6-luna' },
      messages: [{ seq: 0, role: 'user', content: [{ type: 'text', text: 'Legacy history' }] }],
      inputContent: '',
      permissionMode: 'auto',
      updatedAt: 0,
      conversationStartedAt: 0,
      lastResponseFinishedAt: 0,
      autoNamePending: false,
    });
  });

  test('migrates tool results, Sirus-written summaries and checkpoint indexes from files written before the runtimes ran the tools', () => {
    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({
      version: 1,
      selectedSessionId: 'old-id',
      sessions: [{
        id: 'old-id',
        name: 'Old',
        directory: '/projects/old',
        participants: [{ name: 'sirus', model: 'claude-sonnet-5' }],
        defaultModel: { name: 'sirus', model: 'claude-sonnet-5' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Read the readme' }] },
          { role: 'assistant', participant: 'sirus', model: 'claude-sonnet-5', content: [
            { type: 'tool_call', id: 'call-1', name: 'ReadFile', arguments: { path: 'README.md' } },
            { type: 'tool_result', callId: 'call-1', result: '# Sirus', isError: false },
            { type: 'tool_call', id: 'call-2', name: 'RunShell', arguments: { command: 'false' } },
            { type: 'tool_result', callId: 'call-2', result: 'exit 1', isError: true },
            { type: 'text', text: 'Done.' },
          ], usage: { inputTokens: 1, outputTokens: 1, contextTokens: 1, contextWindow: 200000 } },
          { role: 'user', content: [{ type: 'text', text: 'Earlier conversation compacted: the readme was read.' }],
            model: 'claude-sonnet-5', compaction: { messages: 2, tokensBefore: 128, trigger: 'auto' } },
        ],
        checkpoints: [{ id: 'c'.repeat(40), messageIndex: 0, summary: 'Read the readme', createdAt: 5 }],
        updatedAt: 7,
      }],
    }));

    const [snapshot] = loadSessionSnapshots(directory).snapshots;
    expect(snapshot.messages).toEqual([
      { seq: 0, role: 'user', content: [{ type: 'text', text: 'Read the readme' }] },
      { seq: 1, role: 'assistant', participant: 'sirus', model: 'claude-sonnet-5', content: [
        { type: 'tool_call', id: 'call-1', title: 'ReadFile', kind: 'other', status: 'completed', locations: [], content: [], input: { path: 'README.md' }, output: '# Sirus' },
        { type: 'tool_call', id: 'call-2', title: 'RunShell', kind: 'other', status: 'failed', locations: [], content: [], input: { command: 'false' }, output: 'exit 1' },
        { type: 'text', text: 'Done.' },
      ] },
      { seq: 2, role: 'assistant', participant: 'sirus', model: 'claude-sonnet-5', content: [
        { type: 'compaction', summary: 'Earlier conversation compacted: the readme was read.' },
      ] },
    ]);
    expect(snapshot.checkpoints).toEqual([{ id: 'c'.repeat(40), seq: 0, summary: 'Read the readme', createdAt: 5 }]);
    // Once saved again, the file carries only the current shape.
    expect(saveSessionSnapshots([snapshot], 'old-id', directory)).toBe(true);
    const raw = JSON.parse(readFileSync(path.join(directory, 'sessions', 'session-old-id.json'), 'utf8'));
    expect(JSON.stringify(raw)).not.toContain('tool_result');
    expect(JSON.stringify(raw)).not.toContain('messageIndex');
  });

  test('writes valid JSON without leaving temporary files behind', () => {
    expect(saveSessionSnapshots([new Session()].filter(s => !s.isEmpty()).map(s => s.toSnapshot()), null, directory)).toBe(true);
    expect(() => JSON.parse(readFileSync(path.join(directory, 'sessions', 'index.json'), 'utf8'))).not.toThrow();
    expect(readdirSync(directory)).toEqual(['sessions']);
    expect(readdirSync(path.join(directory, 'sessions'))).toEqual(['index.json']);
  });

  test('migrates each legacy session independently and keeps the exact original file', () => {
    const original = JSON.stringify({ version: 1, selectedSessionId: 'good', sessions: [
      { id: 'good', name: 'Readable', model: 'gpt-5.6-luna', messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep me' }] }] },
      { id: 'bad', name: 'Unexpected mode', model: 'gpt-5.6-luna', permissionMode: 'plan', messages: [] },
    ] }, null, 2);
    writeFileSync(path.join(directory, 'sessions.json'), original);
    const result = loadSessionSnapshots(directory, '/projects/legacy');
    expect(result.snapshots.map(snapshot => snapshot.id)).toEqual(['good']);
    expect(result.selectedSessionId).toBe('good');
    expect(result.notices).toEqual([expect.stringContaining('session bad')]);
    expect(readFileSync(path.join(directory, 'sessions.json.migrated'), 'utf8')).toBe(original);
    expect(existsSync(path.join(directory, 'sessions.json'))).toBe(false);
    const invalid = readdirSync(path.join(directory, 'invalid'));
    expect(invalid).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(directory, 'invalid', invalid[0]), 'utf8')).permissionMode).toBe('plan');
    expect(loadSessionSnapshots(directory).notices).toBeUndefined();
  });

  test('quarantines one damaged session and refuses stale writes to it', () => {
    const first = new Session({ id: 'first', model: 'gpt-5.6-luna', messages: [{ role: 'user', content: [{ type: 'text', text: 'First' }] }] }).toSnapshot();
    const second = { ...first, id: 'second' };
    saveSessionSnapshots([first, second], 'first', directory);
    const damagedFile = path.join(directory, 'sessions', 'session-first.json');
    writeFileSync(damagedFile, '{broken original');
    const result = loadSessionSnapshots(directory);
    expect(result.snapshots.map(snapshot => snapshot.id)).toEqual(['second']);
    expect(result.notices).toEqual([expect.stringContaining('session-first.json')]);
    expect(saveSessionSnapshot(first, directory)).toBe(false);
    expect(existsSync(damagedFile)).toBe(false);
    expect(readFileSync(path.join(directory, 'invalid', readdirSync(path.join(directory, 'invalid'))[0]), 'utf8')).toBe('{broken original');
  });

  test('independent windows change only their session and last writer wins for the same session', () => {
    const first = new Session({ id: 'first', model: 'gpt-5.6-luna', messages: [{ role: 'user', content: [{ type: 'text', text: 'First' }] }] }).toSnapshot();
    const second = { ...first, id: 'second', name: 'Second' };
    saveSessionSnapshots([first, second], 'first', directory);
    const secondRevision = loadSessionRevision('second', directory);
    const windowA = loadSessionSnapshot('first', directory)!;
    const windowB = loadSessionSnapshot('second', directory)!;
    expect(saveSessionSnapshot({ ...windowA, name: 'Edited in A' }, directory)).toBe(true);
    expect(loadSessionRevision('second', directory)).toBe(secondRevision);
    expect(saveSessionSnapshot({ ...windowB, name: 'Edited in B' }, directory)).toBe(true);
    expect(loadSessionSnapshot('first', directory)?.name).toBe('Edited in A');
    expect(loadSessionSnapshot('second', directory)?.name).toBe('Edited in B');
    expect(saveSessionSnapshot({ ...windowA, name: 'Final writer' }, directory)).toBe(true);
    expect(loadSessionSnapshot('first', directory)?.name).toBe('Final writer');
    expect(deleteSessionSnapshot('first', directory)).toBe(true);
    expect(loadSessionSnapshots(directory).snapshots.map(snapshot => snapshot.id)).toEqual(['second']);
  });

  test('migration never replaces a newer per-session file and reserves the metadata filename', () => {
    const snapshot = new Session({ id: 'index', model: 'gpt-5.6-luna', name: 'Newer edit', messages: [{ role: 'user', content: [{ type: 'text', text: 'Retained' }] }] }).toSnapshot();
    saveSessionSnapshot(snapshot, directory);
    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({ version: 1, selectedSessionId: 'index', sessions: [{ ...snapshot, name: 'Old name' }] }));
    const result = loadSessionSnapshots(directory);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].name).toBe('Newer edit');
    expect(result.selectedSessionId).toBe('index');
    expect(existsSync(path.join(directory, 'sessions.json.migrated'))).toBe(true);
  });

  test('does not save or restore empty sessions', () => {
    const used = new Session({ name: 'Used', directory: '/projects/used', autoNamePending: true });
    used.append({ role: 'user', content: [{ type: 'text', text: 'Persist me' }] });
    const empty = new Session({ name: 'Empty', directory: '/projects/empty', autoNamePending: true });

    // The empty-session filter is `app.tsx`'s save-side rule in production;
    // this test recreates it here so the drop-empty behaviour stays pinned.
    expect(saveSessionSnapshots(
      [used, empty].filter(session => !session.isEmpty()).map(session => session.toSnapshot()),
      empty.getId(),
      directory,
    )).toBe(true);
    const json = JSON.parse(readFileSync(path.join(directory, 'sessions', 'index.json'), 'utf8'));
    expect(json.sessionIds).toEqual([used.getId()]);
    expect(json.selectedSessionId).toBeNull();

    const restored = loadSessionSnapshots(directory);
    expect(restored.snapshots.map(snapshot => snapshot.id)).toEqual([used.getId()]);
    expect(restored.selectedSessionId).toBeNull();
  });
});

describe('subscription preference persistence', () => {
  test('notification preferences survive updates to the other settings', () => {
    expect(openSettings(directory).get('notifications')).toBe('background');
    expect(openSettings(directory).set({ notifications: 'always' })).toBe(true);
    openSettings(directory).set({ subscriptions: { claude: true, gpt: false } });
    openSettings(directory).set({ memoryEnabled: false });
    openSettings(directory).set({ apiKeys: { gpt: 'test-key' } });
    openSettings(directory).set({ sirusModel: 'gpt-5.6-sol' });
    expect(openSettings(directory).get('notifications')).toBe('always');
    expect(openSettings(directory).set({ notifications: 'off' })).toBe(true);
    expect(openSettings(directory).get('apiKeys')).toEqual({ gpt: 'test-key' });
    expect(openSettings(directory).get('memoryEnabled')).toBe(false);
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: true, gpt: false });
    expect(openSettings(directory).get('sirusModel')).toBe('gpt-5.6-sol');
    expect(openSettings(directory).get('notifications')).toBe('off');
  });

  test('defaults to API keys and restores enabled providers', () => {
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: false, gpt: false });
    expect(openSettings(directory).set({ subscriptions: { claude: true, gpt: false } })).toBe(true);
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: true, gpt: false });
  });

  test('preserves memory access while saving subscription preferences', () => {
    expect(openSettings(directory).set({ memoryEnabled: false })).toBe(true);
    expect(openSettings(directory).set({ subscriptions: { claude: true, gpt: false } })).toBe(true);

    expect(openSettings(directory).get('memoryEnabled')).toBe(false);
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: true, gpt: false });
  });

  test('falls back safely when settings are invalid', () => {
    writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
      version: 1,
      subscriptions: { claude: 'yes', gpt: false },
    }));
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: false, gpt: false });
  });

  test('a section this build cannot read falls back alone and survives saves to the others', () => {
    const file = path.join(directory, 'settings.json');
    const sources = { claude: [{ id: 'work', type: 'api' as const, key: 'sk-ant-work' }] };
    writeFileSync(file, JSON.stringify({
      version: 1,
      subscriptions: { claude: true, gpt: false },
      providerSources: sources,
      apiKeys: { gpt: 'sk-openai-test' },
      // A value a newer build added to the enum.
      notifications: 'mentions',
      futureSetting: { kept: true },
    }));
    expect(openSettings(directory).get('notifications')).toBe('background');
    expect(openSettings(directory).get('apiKeys')).toEqual({ gpt: 'sk-openai-test' });
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: true, gpt: false });
    expect(openSettings(directory).get('providerSources')).toEqual(sources);

    expect(openSettings(directory).set({ memoryEnabled: false })).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      subscriptions: { claude: true, gpt: false },
      providerSources: sources,
      apiKeys: { gpt: 'sk-openai-test' },
      notifications: 'mentions',
      futureSetting: { kept: true },
      memory: { enabled: false },
    });

    // Changing the setting itself replaces what this build could not read.
    expect(openSettings(directory).set({ notifications: 'always' })).toBe(true);
    expect(openSettings(directory).get('notifications')).toBe('always');
    expect(openSettings(directory).get('apiKeys')).toEqual({ gpt: 'sk-openai-test' });
  });

  test('sets a settings file it cannot read aside before writing over it', () => {
    for (const unreadable of [
      '{ "version": 1, "apiKeys": { "claude": "sk-ant-kept" }, }',
      JSON.stringify({ version: 2, apiKeys: { claude: 'sk-ant-kept' } }),
    ]) {
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory);
      writeFileSync(path.join(directory, 'settings.json'), unreadable);
      expect(openSettings(directory).get('apiKeys')).toEqual({});

      expect(openSettings(directory).set({ notifications: 'always' })).toBe(true);
      expect(openSettings(directory).get('notifications')).toBe('always');
      const aside = readdirSync(directory).filter(name => name.startsWith('settings.json.unreadable-'));
      expect(aside).toHaveLength(1);
      expect(readFileSync(path.join(directory, aside[0]!), 'utf8')).toBe(unreadable);
    }
  });
});

describe('memory access preference persistence', () => {
  test('defaults on and preserves subscriptions when toggled', () => {
    expect(openSettings(directory).get('memoryEnabled')).toBe(true);
    expect(openSettings(directory).set({ subscriptions: { claude: false, gpt: true } })).toBe(true);
    expect(openSettings(directory).set({ memoryEnabled: false })).toBe(true);

    expect(openSettings(directory).get('memoryEnabled')).toBe(false);
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: false, gpt: true });
  });
});

describe('Sirus model preference persistence', () => {
  test('defaults unset and survives writes to other settings', () => {
    expect(openSettings(directory).get('sirusModel')).toBeNull();
    expect(openSettings(directory).set({ sirusModel: 'claude-sonnet-5' })).toBe(true);
    expect(openSettings(directory).set({ subscriptions: { claude: true, gpt: false } })).toBe(true);
    expect(openSettings(directory).set({ memoryEnabled: false })).toBe(true);

    expect(openSettings(directory).get('sirusModel')).toBe('claude-sonnet-5');
  });
});

describe('API key persistence', () => {
  test('defaults to no stored keys and restores saved ones', () => {
    expect(openSettings(directory).get('apiKeys')).toEqual({});
    expect(openSettings(directory).set({ apiKeys: { claude: 'sk-ant-test' } })).toBe(true);
    expect(openSettings(directory).get('apiKeys')).toEqual({ claude: 'sk-ant-test' });
  });

  test('keeps stored keys and other settings across each other\'s saves', () => {
    expect(openSettings(directory).set({ apiKeys: { gpt: 'sk-openai-test' } })).toBe(true);
    expect(openSettings(directory).set({ subscriptions: { claude: true, gpt: false } })).toBe(true);
    expect(openSettings(directory).set({ memoryEnabled: false })).toBe(true);

    expect(openSettings(directory).get('apiKeys')).toEqual({ gpt: 'sk-openai-test' });
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: true, gpt: false });
    expect(openSettings(directory).get('memoryEnabled')).toBe(false);
  });

  test('writes the settings file readable only by the owner', () => {
    expect(openSettings(directory).set({ apiKeys: { claude: 'sk-ant-test' } })).toBe(true);
    const mode = statSync(path.join(directory, 'settings.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
