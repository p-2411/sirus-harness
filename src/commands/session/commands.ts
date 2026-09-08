import { clearSession, permissionsCommand, permissionsMenuItems, renameSession } from './behavior';
import type { CommandSpec } from '../types';

export const clearCommand: CommandSpec = {
  name: 'clear',
  description: 'clear the history',
  run: (_args, context) => clearSession(context.session),
};

export const renameCommand: CommandSpec = {
  name: 'rename',
  args: '<name>',
  description: 'rename this session',
  run: (args, context) => renameSession(args.join(' '), context.session),
};

export const exitCommand: CommandSpec = {
  name: 'exit',
  description: 'quit sirus',
  // Only a caller that owns the app can quit it.
  run: (args, context) => {
    if (args.length > 0) throw new Error('Usage: /exit');
    if (!context.exit) throw new Error('/exit is not available here.');
    context.exit();
  },
};

export const permissionsCommandSpec: CommandSpec = {
  name: 'permissions',
  args: '[ask|auto|bypass]',
  description: 'show or set how tool calls are approved',
  run: (args, context) => permissionsCommand(args[0], context.session),
  menu: args => args.length === 0 ? permissionsMenuItems() : null,
};
