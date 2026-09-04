import { rewindCommand, rewindMenuItems, undoCommand, undoMenuItems } from './behavior';
import type { CommandSpec } from '../types';

export const undoCommandSpec: CommandSpec = {
  name: 'undo',
  args: '[all|files|chat]',
  description: 'put the directory and chat back to before the last turn',
  run: (args, execution) => undoCommand(args[0], execution.session),
  menu: undoMenuItems,
};

export const rewindCommandSpec: CommandSpec = {
  name: 'rewind',
  args: '[n] [all|files|chat]',
  description: 'pick an earlier turn and put the directory and chat back to before it',
  run: (args, execution) => rewindCommand(args, execution.session),
  menu: rewindMenuItems,
};
