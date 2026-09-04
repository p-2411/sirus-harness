import { describe, expect, mock, test } from 'bun:test';
import type { Checkpoint, Session } from '../../src/agent_runtime/session';
import { rewindCommand, rewindMenuItems, undoCommand, undoMenuItems } from '../../src/commands/checkpoints/behavior';
import { undoCommandSpec } from '../../src/commands/checkpoints/commands';
import type { CommandExecution } from '../../src/commands/types';

function checkpointSession() {
  const checkpoints: Checkpoint[] = [
    { id: '1'.repeat(40), messageIndex: 0, summary: 'first turn', createdAt: Date.now() },
    { id: '2'.repeat(40), messageIndex: 2, summary: 'second turn', createdAt: Date.now() },
  ];
  const rewind = mock(async (id: string, options: { files: boolean; chat: boolean }) => ({
    checkpoint: checkpoints.find(checkpoint => checkpoint.id === id)!,
    files: options.files ? { restored: ['file.txt'], removed: [] } : null,
    droppedMessages: options.chat ? 2 : 0,
  }));
  const session = {
    getCheckpoints: () => checkpoints,
    getDirectory: () => '/checkpoint-command-test',
    rewind,
  } as unknown as Session;
  return { session, checkpoints, rewind };
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
    const { session, checkpoints, rewind } = checkpointSession();
    await undoCommand('files', session);
    expect(rewind).toHaveBeenLastCalledWith(checkpoints[1].id, { files: true, chat: false });
    await undoCommand('chat', session);
    expect(rewind).toHaveBeenLastCalledWith(checkpoints[1].id, { files: false, chat: true });
    await rewindCommand(['1'], session);
    expect(rewind).toHaveBeenLastCalledWith(checkpoints[0].id, { files: true, chat: true });
  });

  test('invalid arguments never trigger a restore', () => {
    const { session, rewind } = checkpointSession();
    for (const args of [['0'], ['3'], ['1.5'], ['1', 'invalid'], ['1', 'files', 'extra']]) {
      expect(() => rewindCommand(args, session)).toThrow('Usage: /rewind');
    }
    expect(() => undoCommand('invalid', session)).toThrow('Usage: /undo');
    expect(() => undoCommandSpec.run(['chat', 'extra'], { session } as CommandExecution)).toThrow('Usage: /undo');
    expect(rewind).not.toHaveBeenCalled();
  });
});
