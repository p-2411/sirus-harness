import { modelStrategies } from '../../agent_runtime/chat';
import {
  modelsFor,
  providerFor,
  VENDORS,
} from '../../agent_runtime/providers/providers';
import type { Session } from '../../agent_runtime/session';
import {
  THINKING_LEVEL_DESCRIPTIONS,
  THINKING_LEVELS,
  parseThinkingLevel,
  type ThinkingLevel,
} from '../../agent_runtime/types';
import type { Feedback } from '../feedback';
import type { CommandMenuEntry, CommandMenuItem } from '../types';

export function modelMenuItems(args: readonly string[] = []): CommandMenuEntry[] | null {
  if (args.length > 1 || (args.length === 1 && !args[0].startsWith('@'))) return null;
  const participant = args[0]?.replace(/^@/, '');

  return VENDORS.flatMap(vendor => [
    {
      type: 'heading' as const,
      key: `${vendor}-models`,
      label: providerFor(vendor).apiKeyOwner,
    },
    ...modelsFor(vendor).map(model => ({
      type: 'item' as const,
      key: model,
      label: model,
      command: participant ? `/model @${participant} ${model}` : `/model ${model}`,
    })),
  ]);
}

export function changeModel(
  participantName: string = 'sirus',
  model: string,
  session: Session,
  setSirusModel: (model: string) => void,
): Feedback {
  if (!modelStrategies[model]) {
    throw new Error(`Unknown model. Try: ${Object.keys(modelStrategies).join(', ')}`);
  }
  const normalizedParticipantName = participantName.replace(/^@/, '');
  if (normalizedParticipantName.toLocaleLowerCase() === 'sirus') {
    setSirusModel(model);
  } else {
    session.changeParticipantModel(participantName, model);
  }
  return {
    kind: 'success',
    text: `@${normalizedParticipantName} model changed to ${model}.`,
  };
}

export function changeThinkingLevel(
  participantName: string = 'sirus',
  value: string,
  session: Session,
): Feedback {
  const level = parseThinkingLevel(value);
  if (!level) throw new Error(`Unknown thinking level. Try: ${THINKING_LEVELS.join(', ')}`);
  const normalizedParticipantName = participantName.replace(/^@/, '');
  session.setThinkingLevel(level, normalizedParticipantName);
  return {
    kind: 'success',
    text: `@${normalizedParticipantName} thinking level changed to ${level}.`,
  };
}

export function thinkingMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 1 || (args.length === 1 && (parseThinkingLevel(args[0]) || !args[0].startsWith('@')))) {
    return null;
  }
  const participant = args[0]?.replace(/^@/, '');
  return THINKING_LEVELS.map((level: ThinkingLevel) => ({
    type: 'item',
    key: level,
    label: level,
    description: THINKING_LEVEL_DESCRIPTIONS[level],
    command: participant ? `/thinking @${participant} ${level}` : `/thinking ${level}`,
  }));
}

export function thinkingCommand(args: readonly string[], session: Session): Feedback {
  if (args.length === 0) {
    return { kind: 'info', text: `@sirus thinking level is ${session.getThinkingLevel()}.` };
  }
  if (args.length === 1) {
    const level = parseThinkingLevel(args[0]);
    if (level) return changeThinkingLevel('sirus', level, session);
    if (!args[0].startsWith('@')) {
      throw new Error(`Unknown thinking level. Try: ${THINKING_LEVELS.join(', ')}`);
    }
    return {
      kind: 'info',
      text: `@${args[0].replace(/^@/, '')} thinking level is ${session.getThinkingLevel(args[0])}.`,
    };
  }
  if (args.length === 2) return changeThinkingLevel(args[0], args[1], session);
  throw new Error('Usage: /thinking [participant] [low|medium|high|xhigh|max]');
}
