import { memoryCommand } from './behavior';
import type { CommandSpec } from '../types';

export const memoryCommandSpec: CommandSpec = {
  name: 'memory',
  args: '[on|off]',
  description: 'show or toggle agent access to persistent memory',
  run: args => memoryCommand(args[0]),
};
