import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import {
  loadApiKeys,
  loadSessionSnapshots,
  loadMemoryAccessPreference,
  loadSirusModelPreference,
  loadSubscriptionPreferences,
  saveApiKeys,
  saveMemoryAccessPreference,
  saveSirusModelPreference,
  saveSessionSnapshots,
  saveSubscriptionPreferences,
  loadNotificationPreference,
  saveNotificationPreference,
} from '../../src/persistence';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-persistence-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('session persistence', () => {
  test('round-trips image attachments, checkpoints, usage, and session naming metadata together', () => {
    const image = { type: 'image' as const, path: path.join(directory, 'images', 'screenshot.png'), mediaType: 'image/png' as const, bytes: 123 };
    const checkpoint = { id: 'b'.repeat(40), messageIndex: 0, summary: '[image]', createdAt: Date.now() };
    const session = new Session({
      id: 'image-session',
      name: 'With image',
      directory: '/projects/image',
      model: 'gpt-5.6-luna',
      messages: [
        { role: 'user', content: [image, { type: 'text', text: 'Explain this screenshot' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Explanation' }],
          usage: { inputTokens: 120, outputTokens: 8, contextTokens: 128, contextWindow: 200_000 } },
      ],
      checkpoints: [checkpoint],
      permissionMode: 'ask',
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
      content: [
        { type: 'tool_call', id: 'call-1', name: 'ReadFile', arguments: { path: 'README.md' } },
        { type: 'tool_result', callId: 'call-1', result: '# Sirus', isError: false },
        { type: 'text', text: 'Done.' },
      ],
      usage: { inputTokens: 120, outputTokens: 8, contextTokens: 128, contextWindow: 200_000 },
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
    // stays pinned: no participants, no clocks and no draft on disk become a
    // single `sirus` participant, an epoch-zero history and an empty draft.
    // Round-tripped through `Session` itself, since a session with no
    // checkpoints omits that key from `toSnapshot()`.
    expect(Session.fromSnapshot(restored.snapshots[0]!).toSnapshot()).toEqual({
      id: 'legacy-id',
      name: 'Legacy',
      directory: '/projects/current-launch',
      participants: [{ name: 'sirus', model: 'gpt-5.6-luna' }],
      defaultModel: { name: 'sirus', model: 'gpt-5.6-luna' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Legacy history' }] }],
      inputContent: '',
      permissionMode: 'auto',
      updatedAt: 0,
      conversationStartedAt: 0,
      lastResponseFinishedAt: 0,
      autoNamePending: false,
    });
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
    saveSubscriptionPreferences({ claude: true, gpt: false }, directory);
    saveMemoryAccessPreference(false, directory);
    saveApiKeys({ gpt: 'test-key' }, directory);
    saveSirusModelPreference('gpt-5.6-sol', directory);
    expect(loadNotificationPreference(directory)).toBe('always');
    expect(saveNotificationPreference('off', directory)).toBe(true);
    expect(loadApiKeys(directory)).toEqual({ gpt: 'test-key' });
    expect(loadMemoryAccessPreference(directory)).toBe(false);
    expect(loadSubscriptionPreferences(directory)).toEqual({ claude: true, gpt: false });
    expect(loadSirusModelPreference(directory)).toBe('gpt-5.6-sol');
    expect(loadNotificationPreference(directory)).toBe('off');
  });

  test('defaults to API keys and restores enabled providers', () => {
    expect(loadSubscriptionPreferences(directory)).toEqual({ claude: false, gpt: false });
    expect(saveSubscriptionPreferences({ claude: true, gpt: false }, directory)).toBe(true);
    expect(loadSubscriptionPreferences(directory)).toEqual({ claude: true, gpt: false });
  });

  test('preserves memory access while saving subscription preferences', () => {
    expect(saveMemoryAccessPreference(false, directory)).toBe(true);
    expect(saveSubscriptionPreferences({ claude: true, gpt: false }, directory)).toBe(true);

    expect(loadMemoryAccessPreference(directory)).toBe(false);
    expect(loadSubscriptionPreferences(directory)).toEqual({ claude: true, gpt: false });
  });

  test('falls back safely when settings are invalid', () => {
    writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
      version: 1,
      subscriptions: { claude: 'yes', gpt: false },
    }));
    expect(loadSubscriptionPreferences(directory)).toEqual({ claude: false, gpt: false });
  });
});

describe('memory access preference persistence', () => {
  test('defaults on and preserves subscriptions when toggled', () => {
    expect(loadMemoryAccessPreference(directory)).toBe(true);
    expect(saveSubscriptionPreferences({ claude: false, gpt: true }, directory)).toBe(true);
    expect(saveMemoryAccessPreference(false, directory)).toBe(true);

    expect(loadMemoryAccessPreference(directory)).toBe(false);
    expect(loadSubscriptionPreferences(directory)).toEqual({ claude: false, gpt: true });
  });
});

describe('Sirus model preference persistence', () => {
  test('defaults unset and survives writes to other settings', () => {
    expect(loadSirusModelPreference(directory)).toBeNull();
    expect(saveSirusModelPreference('claude-sonnet-5', directory)).toBe(true);
    expect(saveSubscriptionPreferences({ claude: true, gpt: false }, directory)).toBe(true);
    expect(saveMemoryAccessPreference(false, directory)).toBe(true);

    expect(loadSirusModelPreference(directory)).toBe('claude-sonnet-5');
  });
});

describe('API key persistence', () => {
  test('defaults to no stored keys and restores saved ones', () => {
    expect(loadApiKeys(directory)).toEqual({});
    expect(saveApiKeys({ claude: 'sk-ant-test' }, directory)).toBe(true);
    expect(loadApiKeys(directory)).toEqual({ claude: 'sk-ant-test' });
  });

  test('keeps stored keys and other settings across each other\'s saves', () => {
    expect(saveApiKeys({ gpt: 'sk-openai-test' }, directory)).toBe(true);
    expect(saveSubscriptionPreferences({ claude: true, gpt: false }, directory)).toBe(true);
    expect(saveMemoryAccessPreference(false, directory)).toBe(true);

    expect(loadApiKeys(directory)).toEqual({ gpt: 'sk-openai-test' });
    expect(loadSubscriptionPreferences(directory)).toEqual({ claude: true, gpt: false });
    expect(loadMemoryAccessPreference(directory)).toBe(false);
  });

  test('writes the settings file readable only by the owner', () => {
    expect(saveApiKeys({ claude: 'sk-ant-test' }, directory)).toBe(true);
    const mode = statSync(path.join(directory, 'settings.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
