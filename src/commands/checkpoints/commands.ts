import { parseRewindScope, rewindCommand, rewindMenuItems, undoCommand, undoMenuItems } from './behavior';
import { commandUsage, type CommandSpec } from '../types';

export const undoCommandSpec: CommandSpec = {
  name: 'undo',
  args: '[all|files|chat]',
  description: 'restore files and chat to before the last turn',
  run: (args, context) => {
    const scope = parseRewindScope(args[0] ?? 'all');
    if (args.length > 1 || !scope) throw new Error(`Usage: ${commandUsage(undoCommandSpec)}`);
    return undoCommand(scope, context.session);
  },
  menu: undoMenuItems,
};

export const rewindCommandSpec: CommandSpec = {
  name: 'rewind',
  args: '[n] [all|files|chat]',
  description: 'restore files and chat to before an earlier turn',
  run: (args, context) => rewindCommand(args, context.session),
  menu: rewindMenuItems,
};
