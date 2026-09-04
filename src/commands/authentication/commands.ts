import {
  infoCommand,
  loginCommand,
  loginMenuItems,
  logoutCommand,
} from './behavior';
import type { CommandSpec } from '../types';

export const loginCommandSpec: CommandSpec = {
  name: 'login',
  args: '[claude|gpt] [subscription|api <key>]',
  description: 'sign in with a subscription or an API key',
  run: (args, execution) => loginCommand(args, execution.notify, execution.signal),
  menu: loginMenuItems,
};

export const logoutCommandSpec: CommandSpec = {
  name: 'logout',
  args: '<claude|gpt>',
  description: 'sign out of the subscription or stored API key for a provider',
  run: args => logoutCommand(args[0]),
};

export const infoCommandSpec: CommandSpec = {
  name: 'info',
  description: 'show how each provider is signed in',
  run: (_args, execution) => infoCommand(execution.signal),
};
