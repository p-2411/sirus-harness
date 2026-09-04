import { changeModel, modelMenuItems, thinkingCommand, thinkingMenuItems } from './behavior';
import type { CommandSpec } from '../types';

export const modelCommand: CommandSpec = {
  name: 'model',
  args: '[agent] <model>',
  description: 'set Sirus globally or a named session agent model',
  run: (args, execution) => {
    if (args.length === 1) {
      return changeModel('sirus', args[0], execution.session, execution.setSirusModel);
    }
    if (args.length === 2) {
      return changeModel(args[0], args[1], execution.session, execution.setSirusModel);
    }
    throw new Error('Usage: /model [name] <model>');
  },
  menu: modelMenuItems,
};

export const thinkingCommandSpec: CommandSpec = {
  name: 'thinking',
  args: '[agent] [low|medium|high|xhigh|max]',
  description: 'show or set reasoning depth for a participant',
  run: (args, execution) => thinkingCommand(args, execution.session),
  menu: thinkingMenuItems,
};
