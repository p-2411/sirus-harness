import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import type { WorkerRecord } from '../../src/agent_runtime/tools/subagents';
import { loadSessionSnapshots, saveSessionSnapshots } from '../../src/persistence/sessions';
import {
  loadNotificationPreference,
  loadSirusModelPreference,
  openSettings,
  saveJevApiKey,
  saveJevKeyRequested,
  saveNotificationPreference,
  saveSirusModelPreference,
} from '../../src/persistence/settings';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-persistence-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('session persistence', () => {
  test('round-trips image attachments, checkpoints, tool activity, compaction and naming metadata together', () => {
    const image = { type: 'image' as const, path: path.join(directory, 'images', 'screenshot.png'), mediaType: 'image/png' as const, bytes: 123 };
    const checkpoint = { id: 'b'.repeat(40), seq: 0, summary: '[image]', createdAt: Date.now() };
    const session = new Session({
      id: 'image-session',
      name: 'With image',
      directory: '/projects/image',
      model: 'gpt-5.6-luna',
      messages: [
        { role: 'user', to: ['sirus'], content: [image, { type: 'text', text: 'Explain this screenshot' }] },
        { role: 'assistant', participant: 'sirus', model: 'gpt-5.6-luna', content: [
          { type: 'thought', text: 'Looking at it.' },
          { type: 'tool_call', id: 'call-1', title: 'ls', kind: 'execute', status: 'completed', locations: [], content: [{ type: 'text', text: 'a.png' }], input: { command: 'ls' }, output: 'a.png' },
          { type: 'text', text: 'Explanation' },
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
    expect(loadSessionSnapshots(directory)).toEqual({ snapshots: [], selectedSessionId: null });

    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({ version: 999, sessions: [] }));
    expect(loadSessionSnapshots(directory)).toEqual({ snapshots: [], selectedSessionId: null });
  });

  test('a session this build cannot read costs that session alone and is written back unchanged', () => {
    const readable = new Session({
      id: 'readable',
      name: 'Readable',
      directory,
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Still here' }] }],
    });
    // A permission mode a newer build added.
    const newer = JSON.parse(JSON.stringify({ ...readable.toSnapshot(), id: 'newer', name: 'Newer', permissionMode: 'plan' }));
    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({
      version: 1,
      selectedSessionId: 'readable',
      sessions: [readable.toSnapshot(), newer],
    }));

    const restored = loadSessionSnapshots(directory);
    expect(restored.snapshots.map(snapshot => snapshot.id)).toEqual(['readable']);
    expect(restored.selectedSessionId).toBe('readable');

    // The app saves what it restored as soon as it mounts, and on every change.
    for (let save = 0; save < 2; save++) {
      expect(saveSessionSnapshots(restored.snapshots, restored.selectedSessionId, directory)).toBe(true);
      const saved = JSON.parse(readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
      expect(saved.sessions.map((session: { id: string }) => session.id)).toEqual(['readable', 'newer']);
      expect(saved.sessions[1]).toEqual(newer);
    }
  });

  test('sets a session file it cannot read aside before the first save', () => {
    const broken = '{"version":1,"selectedSessionId":null,"sessions":[{"id":"typo"},]}';
    writeFileSync(path.join(directory, 'sessions.json'), broken);
    expect(loadSessionSnapshots(directory)).toEqual({ snapshots: [], selectedSessionId: null });

    const session = new Session({
      id: 'fresh',
      name: 'Fresh',
      directory,
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'After the typo' }] }],
    });
    expect(saveSessionSnapshots([session.toSnapshot()], null, directory)).toBe(true);
    expect(saveSessionSnapshots([session.toSnapshot()], null, directory)).toBe(true);
    const aside = readdirSync(directory).filter(name => name.startsWith('sessions.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(path.join(directory, aside[0]!), 'utf8')).toBe(broken);
    expect(loadSessionSnapshots(directory).snapshots.map(snapshot => snapshot.id)).toEqual(['fresh']);
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
    const raw = JSON.parse(readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
    expect(JSON.stringify(raw)).not.toContain('tool_result');
    expect(JSON.stringify(raw)).not.toContain('messageIndex');
  });

  test('writes valid JSON without leaving temporary files behind', () => {
    expect(saveSessionSnapshots([new Session()].filter(s => !s.isEmpty()).map(s => s.toSnapshot()), null, directory)).toBe(true);
    expect(() => JSON.parse(readFileSync(path.join(directory, 'sessions.json'), 'utf8'))).not.toThrow();
    expect(readdirSync(directory)).toEqual(['sessions.json']);
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
    const json = JSON.parse(readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
    expect(json.sessions.map((session: { id: string }) => session.id)).toEqual([used.getId()]);
    expect(json.selectedSessionId).toBeNull();

    const restored = loadSessionSnapshots(directory);
    expect(restored.snapshots.map(snapshot => snapshot.id)).toEqual([used.getId()]);
    expect(restored.selectedSessionId).toBeNull();
  });
});

describe('subscription preference persistence', () => {
  test('notification preferences survive updates to the other settings', () => {
    expect(loadNotificationPreference(directory)).toBe('background');
    expect(saveNotificationPreference('always', directory)).toBe(true);
    openSettings(directory).set({ subscriptions: { claude: true, gpt: false } });
    openSettings(directory).set({ memoryEnabled: false });
    openSettings(directory).set({ apiKeys: { gpt: 'test-key' } });
    saveSirusModelPreference('gpt-5.6-sol', directory);
    expect(loadNotificationPreference(directory)).toBe('always');
    expect(saveNotificationPreference('off', directory)).toBe(true);
    expect(openSettings(directory).get('apiKeys')).toEqual({ gpt: 'test-key' });
    expect(openSettings(directory).get('memoryEnabled')).toBe(false);
    expect(openSettings(directory).get('subscriptions')).toEqual({ claude: true, gpt: false });
    expect(loadSirusModelPreference(directory)).toBe('gpt-5.6-sol');
    expect(loadNotificationPreference(directory)).toBe('off');
  });

  test('keeps the Jev key and the one-time request beside the other settings', () => {
    expect(openSettings(directory).get('jevApiKey')).toBeNull();
    expect(openSettings(directory).get('jevKeyRequested')).toBe(false);
    expect(saveJevKeyRequested(directory)).toBe(true);
    expect(openSettings(directory).get('jevKeyRequested')).toBe(true);
    expect(openSettings(directory).get('jevApiKey')).toBeNull();
    expect(saveJevApiKey('ts-live-key-1234', directory)).toBe(true);
    saveNotificationPreference('always', directory);
    expect(openSettings(directory).get('jevApiKey')).toBe('ts-live-key-1234');
    expect(openSettings(directory).get('jevKeyRequested')).toBe(true);
    expect(saveJevApiKey(null, directory)).toBe(true);
    expect(openSettings(directory).get('jevApiKey')).toBeNull();
    expect(openSettings(directory).get('jevKeyRequested')).toBe(true);
    expect(loadNotificationPreference(directory)).toBe('always');
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
    expect(loadNotificationPreference(directory)).toBe('background');
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
      jev: { keyRequested: false },
    });

    // Changing the setting itself replaces what this build could not read.
    expect(saveNotificationPreference('always', directory)).toBe(true);
    expect(loadNotificationPreference(directory)).toBe('always');
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

      expect(saveNotificationPreference('always', directory)).toBe(true);
      expect(loadNotificationPreference(directory)).toBe('always');
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
    expect(loadSirusModelPreference(directory)).toBeNull();
    expect(saveSirusModelPreference('claude-sonnet-5', directory)).toBe(true);
    expect(openSettings(directory).set({ subscriptions: { claude: true, gpt: false } })).toBe(true);
    expect(openSettings(directory).set({ memoryEnabled: false })).toBe(true);

    expect(loadSirusModelPreference(directory)).toBe('claude-sonnet-5');
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
