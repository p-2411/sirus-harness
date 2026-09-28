import {
  agentsCommand,
  agentsMenuItems,
  changeModel,
  changeThinkingLevel,
  isThinkingArgument,
  modelArgumentCount,
  modelMenuItems,
  subagentModelCommand,
  thinkingArgumentCount,
  thinkingCommand,
  thinkingMenuItems,
} from './behavior';
import { commandUsage, type CommandSpec } from '../types';
import { DEFAULT_PARTICIPANT } from '../../agent_runtime/types';

export const modelCommand: CommandSpec = {
  name: 'model',
  args: '[agent|subagent] <model> [thinking]',
  description: 'set an agent\'s model and thinking, or the model subagents run on',
  run: (args, context) => {
    if (args[0] === 'subagent') {
      return subagentModelCommand(args.slice(1), context.session);
    }
    // Two words are an agent and its model unless the second is a level.
    const named = args.length === 3 || (args.length === 2 && !isThinkingArgument(args[1]));
    const [participant, model, level] = named ? args : [DEFAULT_PARTICIPANT, ...args];
    if (!model || args.length > 3 || (level !== undefined && !isThinkingArgument(level))) {
      throw new Error(`Usage: ${commandUsage(modelCommand)}`);
    }
    const changed = changeModel(participant, model, context.session, context.notify);
    if (level === undefined) return changed;
    const thinking = changeThinkingLevel(participant, level, context.session);
    return { kind: changed.kind === 'success' ? thinking.kind : changed.kind, text: `${changed.text} ${thinking.text}` };
  },
  menu: modelMenuItems,
  takes: modelArgumentCount,
};

export const agentsCommandSpec: CommandSpec = {
  name: 'agents',
  args: '[show|message|cancel|dismiss] [name]',
  description: 'watch, steer, stop or clear the session\'s background workers',
  run: (args, context) => agentsCommand(args, context.session),
  menu: agentsMenuItems,
};

export const thinkingCommandSpec: CommandSpec = {
  name: 'thinking',
  args: '[agent] [default|low|medium|high|xhigh|max]',
  description: 'show or set an agent\'s reasoning depth',
  run: (args, context) => {
    if (args.length > 2) throw new Error(`Usage: ${commandUsage(thinkingCommandSpec)}`);
    return thinkingCommand(args, context.session);
  },
  menu: thinkingMenuItems,
  takes: thinkingArgumentCount,
};
