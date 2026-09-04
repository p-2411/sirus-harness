import { clearSession, permissionsCommand, permissionsMenuItems, renameSession } from './behavior';
import type { CommandSpec } from '../types';

export const clearCommand: CommandSpec = {
  name: 'clear',
  description: 'clear this session history',
  run: (_args, execution) => clearSession(execution.session),
};

export const renameCommand: CommandSpec = {
  name: 'rename',
  args: '<name>',
  description: 'rename this session',
  run: (args, execution) => renameSession(args.join(' '), execution.session),
};

export const permissionsCommandSpec: CommandSpec = {
  name: 'permissions',
  args: '[ask|auto|bypass]',
  description: 'show or set how this session approves tool calls',
  run: (args, execution) => permissionsCommand(args[0], execution.session),
  menu: args => args.length === 0 ? permissionsMenuItems() : null,
};
