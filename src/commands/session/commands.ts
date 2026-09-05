import { clearSession, permissionsCommand, permissionsMenuItems, renameSession } from './behavior';
import type { CommandSpec } from '../types';

export const clearCommand: CommandSpec = {
  name: 'clear',
  description: 'clear the history',
  run: (_args, execution) => clearSession(execution.session),
};

export const renameCommand: CommandSpec = {
  name: 'rename',
  args: '<name>',
  description: 'rename this session',
  run: (args, execution) => renameSession(args.join(' '), execution.session),
};

export const exitCommand: CommandSpec = {
  name: 'exit',
  description: 'quit sirus',
  run: (args, execution) => {
    if (args.length > 0) throw new Error('Usage: /exit');
    execution.exit();
  },
};

export const permissionsCommandSpec: CommandSpec = {
  name: 'permissions',
  args: '[ask|auto|bypass]',
  description: 'show or set how tool calls are approved',
  run: (args, execution) => permissionsCommand(args[0], execution.session),
  menu: args => args.length === 0 ? permissionsMenuItems() : null,
};
