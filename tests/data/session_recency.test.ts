import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/agent_runtime/session';
import { modelStrategies } from '../../src/agent_runtime/chat';
import type { Message } from '../../src/agent_runtime/types';
import { loadSessions, saveSessions } from '../../src/persistence';

const prompt: Message = { role: 'user', content: [{ type: 'text', text: 'Continue' }] };
const response: Message = { role: 'assistant', content: [{ type: 'text', text: 'Done' }] };

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
      expect(saveSessions([session], session.getId(), directory)).toBe(true);
      session = loadSessions(directory).sessions[0];
      expect(session.getConversationStartedAt()).toBe(2_000);
      now += 5 * 60_000 + 1;
      session.append(prompt);
      expect(session.getConversationStartedAt()).toBe(now);
      expect(saveSessions([session], session.getId(), directory)).toBe(true);
      expect(loadSessions(directory).sessions[0].toSnapshot()).toEqual(session.toSnapshot());
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
    modelStrategies[model] = {
      getResponse: async () => {
        now += 10 * 60_000;
        return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
      },
    };
    try {
      const session = new Session('Test', 'recency', model, [], directory);
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
      delete modelStrategies[model];
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('older snapshots fall back to their activity time', () => {
    const { conversationStartedAt, lastResponseFinishedAt, ...snapshot } = new Session().toSnapshot();
    const restored = Session.fromSnapshot({ ...snapshot, messages: [prompt, response], updatedAt: 123_000 });
    expect(restored.getConversationStartedAt()).toBe(123_000);
    expect(restored.toSnapshot().lastResponseFinishedAt).toBe(123_000);
  });
});
