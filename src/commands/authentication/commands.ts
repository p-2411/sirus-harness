import {
  loginCommand,
  loginMenuItems,
  logoutCommand,
  logoutMenuItems,
  usageCommand,
} from './behavior';
import type { CommandSpec } from '../types';

export const loginCommandSpec: CommandSpec = {
  name: 'login',
  args: '[claude|gpt] [subscription|api <key>]',
  description: 'add a subscription or API key',
  run: (args, execution) => loginCommand(args, execution.notify, execution.signal),
  menu: loginMenuItems,
};

export const logoutCommandSpec: CommandSpec = {
  name: 'logout',
  args: '[claude|gpt] [source]',
  description: 'remove a subscription or API key',
  run: args => logoutCommand(args[0], args[1]),
  menu: logoutMenuItems,
};

export const usageCommandSpec: CommandSpec = {
  name: 'usage',
  description: 'remaining subscription allowance and session tokens',
  run: (args, execution) => {
    if (args.length > 0) throw new Error('Usage: /usage');
    return usageCommand(execution.signal, execution.session);
  },
};
