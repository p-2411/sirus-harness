import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import {
  loadApiKeys,
  loadSessions,
  loadMemoryAccessPreference,
  loadSirusModelPreference,
  loadSubscriptionPreferences,
  saveApiKeys,
  saveMemoryAccessPreference,
  saveSirusModelPreference,
  saveSessions,
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
    const session = new Session('With image', 'image-session', 'gpt-5.6-luna', [
      { role: 'user', content: [image, { type: 'text', text: 'Explain this screenshot' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Explanation' }],
        usage: { inputTokens: 120, outputTokens: 8, contextTokens: 128, contextWindow: 200_000 } },
    ], '/projects/image', [], 'sirus', 'ask', [checkpoint], 1_000, true);

    expect(saveSessions([session], session.getId(), directory)).toBe(true);
    const restored = loadSessions(directory);
    expect(restored.selectedSessionId).toBe(session.getId());
    expect(restored.sessions[0].toSnapshot()).toEqual(session.toSnapshot());
  });

  test('restores sessions, selected session, models, and complete message history', () => {
    const first = new Session('First', 'first-id', 'claude-fable-5-1', [], '/projects/first');
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
    const second = new Session('Second', 'second-id', 'gpt-5.6-sol', [], '/projects/second');
    second.append({ role: 'user', content: [{ type: 'text', text: 'Keep this too' }] });

    expect(saveSessions([first, second], second.getId(), directory)).toBe(true);
    const restored = loadSessions(directory);

    expect(restored.selectedSessionId).toBe('second-id');
    expect(restored.sessions.map(session => session.toSnapshot())).toEqual([
      first.toSnapshot(),
      second.toSnapshot(),
    ]);
    expect(restored.sessions[0].getThinkingLevel()).toBe('medium');
    expect(restored.sessions[0].getThinkingLevel('reviewer')).toBe('xhigh');
  });

  test('falls back safely when the session file is corrupt or from an unknown version', () => {
    writeFileSync(path.join(directory, 'sessions.json'), '{broken');
    expect(loadSessions(directory)).toEqual({ sessions: [], selectedSessionId: null });

    writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({ version: 999, sessions: [] }));
    expect(loadSessions(directory)).toEqual({ sessions: [], selectedSessionId: null });
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

    expect(loadSessions(directory, '/projects/current-launch').sessions[0].getDirectory())
      .toBe('/projects/current-launch');
    expect(loadSessions(directory, '/projects/current-launch').sessions[0].getParticipants())
      .toEqual([{ name: 'sirus', model: 'gpt-5.6-luna' }]);
  });

  test('writes valid JSON without leaving temporary files behind', () => {
    expect(saveSessions([new Session()], null, directory)).toBe(true);
    expect(() => JSON.parse(readFileSync(path.join(directory, 'sessions.json'), 'utf8'))).not.toThrow();
    expect(readdirSync(directory)).toEqual(['sessions.json']);
  });

  test('does not save or restore empty sessions', () => {
    const used = Session.create('Used', '/projects/used');
    used.append({ role: 'user', content: [{ type: 'text', text: 'Persist me' }] });
    const empty = Session.create('Empty', '/projects/empty');

    expect(saveSessions([used, empty], empty.getId(), directory)).toBe(true);
    const json = JSON.parse(readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
    expect(json.sessions.map((session: { id: string }) => session.id)).toEqual([used.getId()]);
    expect(json.selectedSessionId).toBeNull();

    const restored = loadSessions(directory);
    expect(restored.sessions.map(session => session.getId())).toEqual([used.getId()]);
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
