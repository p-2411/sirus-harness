import { changeModel, modelMenuItems, thinkingCommand, thinkingMenuItems } from './behavior';
import type { CommandSpec } from '../types';

export const modelCommand: CommandSpec = {
  name: 'model',
  args: '[agent] <model>',
  description: 'set an agent\'s model',
  run: (args, execution) => {
    if (args.length === 1) {
      return changeModel('sirus', args[0], execution.session);
    }
    if (args.length === 2) {
      return changeModel(args[0], args[1], execution.session);
    }
    throw new Error('Usage: /model [name] <model>');
  },
  menu: modelMenuItems,
};

export const thinkingCommandSpec: CommandSpec = {
  name: 'thinking',
  args: '[agent] [low|medium|high|xhigh|max]',
  description: 'show or set an agent\'s reasoning depth',
  run: (args, execution) => thinkingCommand(args, execution.session),
  menu: thinkingMenuItems,
};
