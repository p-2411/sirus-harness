import {
  agentsCommand,
  agentsMenuItems,
  changeModel,
  modelMenuItems,
  subagentModelCommand,
  thinkingCommand,
  thinkingMenuItems,
} from './behavior';
import type { CommandSpec } from '../types';

export const modelCommand: CommandSpec = {
  name: 'model',
  args: '[agent|subagent] <model>',
  description: 'set an agent\'s model, or the one subagents run on',
  run: (args, context) => {
    if (args[0] === 'subagent') {
      return subagentModelCommand(args.slice(1), context.session);
    }
    if (args.length === 1) {
      return changeModel('sirus', args[0], context.session);
    }
    if (args.length === 2) {
      return changeModel(args[0], args[1], context.session);
    }
    throw new Error('Usage: /model [name|subagent] <model>');
  },
  menu: modelMenuItems,
};

export const agentsCommandSpec: CommandSpec = {
  name: 'agents',
  args: '[show|message|cancel|dismiss] [id]',
  description: 'watch, steer, stop or clear the session\'s background workers',
  run: (args, context) => agentsCommand(args, context.session),
  menu: agentsMenuItems,
};

export const thinkingCommandSpec: CommandSpec = {
  name: 'thinking',
  args: '[agent] [low|medium|high|xhigh|max]',
  description: 'show or set an agent\'s reasoning depth',
  run: (args, context) => thinkingCommand(args, context.session),
  menu: thinkingMenuItems,
};
