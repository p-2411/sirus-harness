import { rewindCommand, rewindMenuItems, undoCommand, undoMenuItems } from './behavior';
import type { CommandSpec } from '../types';

export const undoCommandSpec: CommandSpec = {
  name: 'undo',
  args: '[all|files|chat]',
  description: 'preview agent file changes and fork before the last turn',
  run: (args, context) => {
    if (args.length > 1) throw new Error('Usage: /undo [all|files|chat]');
    return undoCommand(args[0], context.session, context);
  },
  menu: undoMenuItems,
};

export const rewindCommandSpec: CommandSpec = {
  name: 'rewind',
  args: '[n] [all|files|chat]',
  description: 'preview agent file changes and fork before an earlier turn',
  run: (args, context) => rewindCommand(args, context.session, context),
  menu: rewindMenuItems,
};
