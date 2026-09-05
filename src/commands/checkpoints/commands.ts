import { rewindCommand, rewindMenuItems, undoCommand, undoMenuItems } from './behavior';
import type { CommandSpec } from '../types';

export const undoCommandSpec: CommandSpec = {
  name: 'undo',
  args: '[all|files|chat]',
  description: 'restore files and chat to before the last turn',
  run: (args, execution) => {
    if (args.length > 1) throw new Error('Usage: /undo [all|files|chat]');
    return undoCommand(args[0], execution.session);
  },
  menu: undoMenuItems,
};

export const rewindCommandSpec: CommandSpec = {
  name: 'rewind',
  args: '[n] [all|files|chat]',
  description: 'restore files and chat to before an earlier turn',
  run: (args, execution) => rewindCommand(args, execution.session),
  menu: rewindMenuItems,
};
