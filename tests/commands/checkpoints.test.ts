import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '../../src/agent_runtime/session';
import type { Checkpoint } from '../../src/checkpoints';
import { rewindCommand, rewindMenuItems, undoCommand, undoMenuItems } from '../../src/commands/checkpoints/behavior';
import { undoCommandSpec } from '../../src/commands/checkpoints/commands';
import type { CommandCapabilities, CommandContext } from '../../src/commands/types';

function checkpointSession() {
  const checkpoints: Checkpoint[] = [
    { id: '1'.repeat(40), seq: 0, summary: 'first turn', createdAt: Date.now() },
    { id: '2'.repeat(40), seq: 2, summary: 'second turn', createdAt: Date.now() },
  ];
  const rewind = mock(async (id: string, options: { files: boolean; chat: boolean }) => ({
    checkpoint: checkpoints.find(checkpoint => checkpoint.id === id)!,
    files: options.files ? { restored: ['file.txt'], removed: [], conflicts: [] } : null,
    droppedMessages: options.chat ? 2 : 0,
    fork: null,
  }));
  const session = {
    getCheckpoints: () => checkpoints,
    getDirectory: () => '/checkpoint-command-test',
    rewind,
    previewRewind: async (id: string, options: { files: boolean; chat: boolean }) => ({
      checkpoint: checkpoints.find(checkpoint => checkpoint.id === id)!,
      files: options.files ? { restored: ['file.txt'], removed: [], conflicts: ['user.txt'] } : null,
      droppedMessages: options.chat ? 2 : 0,
    }),
  } as unknown as Session;
  const confirm = mock(async () => true);
  const capabilities: CommandCapabilities = { confirm, openSession: mock(() => {}) };
  return { session, checkpoints, rewind, capabilities, confirm };
}

describe('checkpoint commands', () => {
  test('lists newest first while keeping checkpoint numbers stable through scope selection', () => {
    const { session } = checkpointSession();
    const targets = rewindMenuItems([], session)!;
    expect(targets.filter(item => item.type === 'item').map(item => item.command)).toEqual([
      '/rewind 2', '/rewind 1',
    ]);
    expect(rewindMenuItems(['1'], session)!.filter(item => item.type === 'item').map(item => item.command)).toEqual([
      '/rewind 1 all', '/rewind 1 files', '/rewind 1 chat',
    ]);
    expect(undoMenuItems([], session)![0]).toMatchObject({ label: 'Undo "second turn"' });
  });

  test('undo targets the last turn and supports independently restoring files or chat', async () => {
    const { session, checkpoints, rewind, capabilities, confirm } = checkpointSession();
    await undoCommand('files', session, capabilities);
    expect(rewind).toHaveBeenLastCalledWith(checkpoints[1].id, { files: true, chat: false, approvedFiles: ['file.txt'] });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Keep conflict: user.txt'));
    await undoCommand('chat', session, capabilities);
    expect(rewind).toHaveBeenLastCalledWith(checkpoints[1].id, { files: false, chat: true });
    await rewindCommand(['1'], session, capabilities);
    expect(rewind).toHaveBeenLastCalledWith(checkpoints[0].id, { files: true, chat: true, approvedFiles: ['file.txt'] });
  });

  test('cancelled previews do not restore files or fork the conversation', async () => {
    const { session, rewind } = checkpointSession();
    const openSession = mock(() => {});
    const result = await rewindCommand(['1', 'all'], session, { confirm: async () => false, openSession });
    expect(result.text).toBe('Rewind cancelled.');
    expect(rewind).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  test('invalid arguments never trigger a restore', () => {
    const { session, rewind } = checkpointSession();
    for (const args of [['0'], ['3'], ['1.5'], ['1', 'invalid'], ['1', 'files', 'extra']]) {
      expect(() => rewindCommand(args, session)).toThrow('Usage: /rewind');
    }
    const context: CommandContext = { session, signal: new AbortController().signal, notify: () => {} };
    expect(() => undoCommandSpec.run(['invalid'], context)).toThrow('Usage: /undo');
    expect(() => undoCommandSpec.run(['chat', 'extra'], context)).toThrow('Usage: /undo');
    expect(rewind).not.toHaveBeenCalled();
  });
});
