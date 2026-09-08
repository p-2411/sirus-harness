import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boundTransports } from '../../src/agent_runtime/providers';
import { Session } from '../../src/agent_runtime/session';
import * as naming from '../../src/agent_runtime/session/naming';
import type { Message } from '../../src/agent_runtime/types';

const model = 'test-background-session-naming';
const prompt = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
let directory: string;
let previousDataDirectory: string | undefined;
let generate: ReturnType<typeof spyOn<typeof naming, 'generateSessionName'>>;
let finishNaming: (name: string | null) => void;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'sirus-session-naming-'));
  previousDataDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = path.join(directory, 'data');
  generate = spyOn(naming, 'generateSessionName').mockImplementation(() =>
    new Promise(resolve => { finishNaming = resolve; }));
  boundTransports[model] = {
    getResponse: async () => ({ content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' }),
  };
});

afterEach(() => {
  generate.mockRestore();
  delete boundTransports[model];
  if (previousDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = previousDataDirectory;
  rmSync(directory, { recursive: true, force: true });
});

function createSession(): Session {
  return new Session({ name: 'Session 9', directory, model, autoNamePending: true });
}

describe('background session naming', () => {
  test('keeps the default while pending without blocking chat, then notifies and persists the title', async () => {
    const session = createSession();
    const first = prompt('Please fix the login flow\nand add regression tests');
    const turn = session.sendMessage(first);
    expect(session.getName()).toBe('Session 9');
    expect(session.toSnapshot().autoNamePending).toBe(false);
    await turn;
    expect(session.getStatus()).toBe('idle');
    expect(session.getName()).toBe('Session 9');
    expect(generate).toHaveBeenCalledWith(first.content[0].type === 'text' ? first.content[0].text : '', directory, model, expect.any(AbortSignal));
    const history = structuredClone(session.getMessages());
    const activity = session.getLastActivity();
    const conversation = session.getConversationStartedAt();
    const assistantVersion = session.getAssistantVersion();
    let notifications = 0;
    session.subscribe(() => notifications++);

    finishNaming('Fix login flow');
    await flush();

    expect(session.getName()).toBe('Fix login flow');
    expect(notifications).toBe(1);
    expect(session.getMessages()).toEqual(history);
    expect(session.getLastActivity()).toBe(activity);
    expect(session.getConversationStartedAt()).toBe(conversation);
    expect(session.getAssistantVersion()).toBe(assistantVersion);
    expect(Session.fromSnapshot(session.toSnapshot()).getName()).toBe('Fix login flow');
    await session.sendMessage(prompt('Now fix logout'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('uses only the first accepted prompt, even when another arrives before the name', async () => {
    const session = createSession();
    await expect(session.sendMessage(prompt('@missing help'))).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    expect(session.toSnapshot().autoNamePending).toBe(true);
    await session.sendMessage(prompt('First accepted prompt'));
    await session.sendMessage(prompt('Second prompt'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toBe('First accepted prompt');
    finishNaming('First task');
    await flush();
    expect(session.getName()).toBe('First task');
  });

  test('does not send attachment snapshots or participant creation models to the naming model', async () => {
    writeFileSync(path.join(directory, 'notes.txt'), 'Attached file contents');
    const session = createSession();
    await session.sendMessage(prompt(`@reviewer ${model} Summarize @./notes.txt`));
    expect(generate.mock.calls[0]?.[0]).toBe('@reviewer Summarize @./notes.txt');
    finishNaming('Summarize notes');
    await flush();
  });

  test.each(['My custom title', 'Session 9'])('manual rename to %s wins over an in-flight result', async name => {
    const session = createSession();
    await session.sendMessage(prompt('Generate a name'));
    const signal = generate.mock.calls[0]?.[3];
    session.setName(name);
    expect(signal?.aborted).toBe(true);
    finishNaming('Late title');
    await flush();
    expect(session.getName()).toBe(name);
  });

  test('naming failures keep the default and do not fail or retry the chat', async () => {
    generate.mockRejectedValue(new Error('Unavailable'));
    const session = createSession();
    await session.sendMessage(prompt('First prompt'));
    await flush();
    expect(session.getName()).toBe('Session 9');
    expect(session.getStatus()).toBe('idle');
    await session.sendMessage(prompt('Second prompt'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('an empty naming result leaves the default unchanged', async () => {
    const session = createSession();
    await session.sendMessage(prompt('First prompt'));
    finishNaming(null);
    await flush();
    expect(session.getName()).toBe('Session 9');
  });

  test('clearing history discards and aborts an in-flight name', async () => {
    const session = createSession();
    await session.sendMessage(prompt('Old task'));
    session.clear();
    expect(generate.mock.calls[0]?.[3]?.aborted).toBe(true);
    await session.sendMessage(prompt('New task'));
    finishNaming('Old title');
    await flush();
    expect(session.getName()).toBe('Session 9');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('rewinding away the first prompt discards an in-flight name', async () => {
    const session = new Session({
      name: 'Session 9', directory, model, autoNamePending: true,
      checkpoints: [{ id: 'a'.repeat(40), messageIndex: 0, summary: 'Old task', createdAt: Date.now() }],
    });
    await session.sendMessage(prompt('Old task'));
    await session.rewind('a'.repeat(40), { files: false, chat: true });
    expect(generate.mock.calls[0]?.[3]?.aborted).toBe(true);
    finishNaming('Old title');
    await flush();
    expect(session.isEmpty()).toBe(true);
    expect(session.getName()).toBe('Session 9');
  });

  test('restoring history does not name it from a later prompt', async () => {
    const session = createSession();
    session.append(prompt('Existing history'));
    const restored = Session.fromSnapshot(session.toSnapshot());
    await restored.sendMessage(prompt('Later prompt'));
    expect(generate).not.toHaveBeenCalled();
    expect(restored.getName()).toBe('Session 9');
  });
});
