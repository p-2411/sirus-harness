import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session, type Draft } from '../../src/agent_runtime/session';
import { loadSessionSnapshots, saveSessionSnapshots } from '../../src/persistence';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

const prompt: Draft = { role: 'user', content: [{ type: 'text', text: 'Continue' }] };
const response: Draft = { role: 'assistant', participant: 'sirus', content: [{ type: 'text', text: 'Done' }] };

describe('session conversation recency', () => {
  test('keeps replies through exactly five minutes in place and persists a later conversation start', () => {
    let now = 1_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-recency-'));
    try {
      let session = new Session();
      now = 2_000;
      session.append(prompt);
      expect(session.getConversationStartedAt()).toBe(2_000);
      now = 600_000;
      session.append(response);
      expect(session.getConversationStartedAt()).toBe(2_000);
      now += 5 * 60_000;
      session.append(prompt);
      expect(session.getConversationStartedAt()).toBe(2_000);
      expect(session.getLastActivity()).toBe(now);
      session.append(response);
      expect(saveSessionSnapshots([session].filter(s => !s.isEmpty()).map(s => s.toSnapshot()), session.getId(), directory)).toBe(true);
      session = Session.fromSnapshot(loadSessionSnapshots(directory).snapshots[0]!);
      expect(session.getConversationStartedAt()).toBe(2_000);
      now += 5 * 60_000 + 1;
      session.append(prompt);
      expect(session.getConversationStartedAt()).toBe(now);
      expect(saveSessionSnapshots([session].filter(s => !s.isEmpty()).map(s => s.toSnapshot()), session.getId(), directory)).toBe(true);
      expect(Session.fromSnapshot(loadSessionSnapshots(directory).snapshots[0]!).toSnapshot()).toEqual(session.toSnapshot());
    } finally {
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('measures from model completion even for long turns and ignores rejected prompts', async () => {
    let now = 1_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-recency-'));
    const model = 'test-conversation-recency';
    bindScriptedRuntime(model, (_input, emit) => {
      now += 10 * 60_000;
      emit({ type: 'text', text: 'Done' });
    });
    try {
      const session = new Session({ id: 'recency', name: 'Test', directory, model });
      await session.sendMessage(prompt);
      expect(session.getConversationStartedAt()).toBe(1_000);
      expect(session.toSnapshot().lastResponseFinishedAt).toBe(now);
      now += 4 * 60_000;
      await session.sendMessage(prompt);
      expect(session.getConversationStartedAt()).toBe(1_000);
      now += 5 * 60_000 + 1;
      const finished = session.toSnapshot().lastResponseFinishedAt;
      await expect(session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@missing' }] })).rejects.toThrow();
      expect(session.getConversationStartedAt()).toBe(1_000);
      expect(session.toSnapshot().lastResponseFinishedAt).toBe(finished);
      const started = now;
      await session.sendMessage(prompt);
      expect(session.getConversationStartedAt()).toBe(started);
    } finally {
      clock.mockRestore();
      unbindRuntime(model);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('older snapshots fall back to their activity time', () => {
    const { conversationStartedAt, lastResponseFinishedAt, ...snapshot } = new Session().toSnapshot();
    const restored = Session.fromSnapshot({
      ...snapshot,
      messages: [{ ...prompt, seq: 0 }, { ...response, seq: 1 }],
      updatedAt: 123_000,
    });
    expect(restored.getConversationStartedAt()).toBe(123_000);
    expect(restored.toSnapshot().lastResponseFinishedAt).toBe(123_000);
  });
});
