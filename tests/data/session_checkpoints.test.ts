import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Session } from '../../src/agent_runtime/session';
import { modelStrategies } from '../../src/agent_runtime/chat';
import { runTool } from '../../src/agent_runtime/tools';
import { enableCheckpoints } from '../../src/checkpoints';
import { TurnCancelledError } from '../../src/abort';
import type { Message } from '../../src/agent_runtime/types';

const model = 'test-checkpoint-session';
const originalDataDirectory = process.env.SIRUS_DATA_DIR;
let root: string;
let project: string;
let session: Session;
const prompt: Message = { role: 'user', content: [{ type: 'text', text: 'Change the file' }] };

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'sirus-session-checkpoints-'));
  project = path.join(root, 'project');
  mkdirSync(project);
  writeFileSync(path.join(project, 'file.txt'), 'user draft');
  process.env.SIRUS_DATA_DIR = path.join(root, 'state');
  enableCheckpoints();
  session = new Session('Checkpoint test', 'checkpoint-session', model, [], project);
  session.setPermissionMode('bypass');
});

afterEach(() => {
  enableCheckpoints(false);
  delete modelStrategies[model];
  if (originalDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = originalDataDirectory;
  rmSync(root, { recursive: true, force: true });
});

function writeResponse() {
  modelStrategies[model] = {
    getResponse: async (_history, turn) => {
      const result = await runTool({
        type: 'tool_call', id: 'write', name: 'WriteFile',
        arguments: { path: 'file.txt', content: 'agent edit' },
      }, turn.directory, turn.signal, turn.permissions, turn.agent);
      expect(result.isError).toBe(false);
      return { content: [{ type: 'text', text: 'Edited.' }], stop_reason: 'end_turn' };
    },
  };
}

describe('session checkpoint integration', () => {
  test('a mutating tool waits for the pre-turn snapshot, and rewind restores files and history', async () => {
    writeResponse();
    let resets = 0;
    modelStrategies[model].resetRuntime = () => { resets++; };
    await session.sendMessage(prompt);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('agent edit');
    const [checkpoint] = session.getCheckpoints();
    expect(checkpoint.messageIndex).toBe(0);
    const result = await session.rewind(checkpoint.id, { files: true, chat: true });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
    expect(result.droppedMessages).toBe(2);
    expect(result.files?.restored).toEqual(['file.txt']);
    expect(session.getMessages()).toEqual([]);
    expect(session.getCheckpoints()).toEqual([]);
    expect(resets).toBe(1);
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

  test.each([new Error('provider failed'), new TurnCancelledError()])(
    'settles a snapshot before a failed or cancelled turn can be cleared: %s', async error => {
      modelStrategies[model] = { getResponse: async () => { throw error; } };
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
    const invalidCheckpoint = { id: 'a'.repeat(40), messageIndex: 0, summary: 'Unavailable', createdAt: Date.now() };
    session = new Session('Missing checkpoint', 'missing', model, [prompt], project, [], 'sirus', 'auto', [invalidCheckpoint]);
    await expect(session.rewind(invalidCheckpoint.id, { files: true, chat: true })).rejects.toThrow();
    expect(session.getMessages()).toEqual([prompt]);
    expect(session.getCheckpoints()).toEqual([invalidCheckpoint]);
    await session.rewind(invalidCheckpoint.id, { files: false, chat: true });
    expect(session.getMessages()).toEqual([]);
  });

  test('protects a shared directory while another session is working or restoring files', async () => {
    writeResponse();
    await session.sendMessage(prompt);
    const [checkpoint] = session.getCheckpoints();
    const other = new Session('Other session', 'other', model, [], project);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    modelStrategies[model] = {
      getResponse: async () => {
        await gate;
        return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
      },
    };
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
});
