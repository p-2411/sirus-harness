import { notifyCommand, notifyMenuItems } from './behavior';
import type { CommandSpec } from '../types';

export const notifyCommandSpec: CommandSpec = {
  name: 'notify',
  args: '[off|background|always]',
  description: 'show or set desktop notifications for finished turns and approvals',
  run: args => notifyCommand(args[0]),
  menu: args => args.length === 0 ? notifyMenuItems() : null,
};
