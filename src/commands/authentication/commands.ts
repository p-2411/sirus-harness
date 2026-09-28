import {
  loginCommand,
  loginMenuItems,
  logoutCommand,
  logoutMenuItems,
  usageCommand,
  usageMenuItems,
} from './behavior';
import type { CommandSpec } from '../types';

export const loginCommandSpec: CommandSpec = {
  name: 'login',
  args: '[claude|codex] [subscription|api <key>]',
  description: 'add a subscription or API key',
  run: (args, context) => loginCommand(args, context.notify, context.signal),
  menu: loginMenuItems,
};

export const logoutCommandSpec: CommandSpec = {
  name: 'logout',
  args: '[claude|codex] [source]',
  description: 'remove a subscription or API key',
  run: args => logoutCommand(args[0], args[1]),
  menu: logoutMenuItems,
};

export const usageCommandSpec: CommandSpec = {
  name: 'usage',
  description: 'remaining subscription allowance and each participant\'s context',
  run: (_args, context) => usageCommand(context.signal, context.session),
  menu: usageMenuItems,
};
