import { notifyCommand, notifyMenuItems } from './behavior';
import type { CommandSpec } from '../types';

export const notifyCommandSpec: CommandSpec = {
  name: 'notify',
  args: '[off|background|always]',
  description: 'show or set desktop notifications',
  run: args => {
    if (args.length > 1) throw new Error('Usage: /notify [off|background|always]');
    return notifyCommand(args[0]);
  },
  menu: args => args.length === 0 ? notifyMenuItems() : null,
};
