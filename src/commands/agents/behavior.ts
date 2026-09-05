import { modelStrategies } from '../../agent_runtime/chat';
import { saveSirusModelPreference } from '../../persistence';
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

function modelFamily(model: string): string {
  return model
    .toLocaleLowerCase()
    .split('-')
    .filter(part => !/^\d+(?:\.\d+)*$/.test(part))
    .join('-');
}

function modelVersion(model: string): number[] {
  return model
    .split('-')
    .filter(part => /^\d+(?:\.\d+)*$/.test(part))
    .flatMap(part => part.split('.').map(Number));
}

function compareModelVersions(left: string, right: string): number {
  const leftVersion = modelVersion(left);
  const rightVersion = modelVersion(right);
  const length = Math.max(leftVersion.length, rightVersion.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftVersion[index] ?? 0) - (rightVersion[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

export function resolveModelReference(
  reference: string,
  availableModels: readonly string[] = Object.keys(modelStrategies),
): string {
  const normalized = reference.toLocaleLowerCase();
  const exact = availableModels.find(model => model.toLocaleLowerCase() === normalized);
  if (exact) return exact;

  const matches = availableModels.filter(model =>
    model.toLocaleLowerCase().includes(normalized),
  );
  if (matches.length === 0) {
    throw new Error(`Unknown model "${reference}". Try: ${availableModels.join(', ')}`);
  }
  if (matches.length === 1) return matches[0];

  const families = new Set(matches.map(modelFamily));
  if (families.size === 1) {
    return matches.reduce((latest, model) =>
      compareModelVersions(model, latest) > 0 ? model : latest,
    );
  }

  throw new Error(`Ambiguous model "${reference}". Matches: ${matches.join(', ')}`);
}

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
): Feedback {
  const resolvedModel = resolveModelReference(model);
  const normalizedParticipantName = participantName.replace(/^@/, '');
  session.changeParticipantModel(participantName, resolvedModel);
  // Choosing Sirus before a conversation starts also chooses the default for
  // future sessions. Existing sessions retain their own participant models.
  if (session.isEmpty() && normalizedParticipantName.toLocaleLowerCase() === 'sirus'
    && !saveSirusModelPreference(resolvedModel)) {
    return {
      kind: 'error',
      text: `@${normalizedParticipantName} model set to ${resolvedModel}, but the default could not be saved.`,
    };
  }
  return {
    kind: 'success',
    text: `@${normalizedParticipantName} model set to ${resolvedModel}.`,
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
    text: `@${normalizedParticipantName} thinking set to ${level}.`,
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
    return { kind: 'info', text: `@sirus thinking is ${session.getThinkingLevel()}.` };
  }
  if (args.length === 1) {
    const level = parseThinkingLevel(args[0]);
    if (level) return changeThinkingLevel('sirus', level, session);
    if (!args[0].startsWith('@')) {
      throw new Error(`Unknown thinking level. Try: ${THINKING_LEVELS.join(', ')}`);
    }
    return {
      kind: 'info',
      text: `@${args[0].replace(/^@/, '')} thinking is ${session.getThinkingLevel(args[0])}.`,
    };
  }
  if (args.length === 2) return changeThinkingLevel(args[0], args[1], session);
  throw new Error('Usage: /thinking [participant] [low|medium|high|xhigh|max]');
}
