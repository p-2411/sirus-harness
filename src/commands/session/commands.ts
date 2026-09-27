import {
  PERMISSION_MODE_NAMES,
  PERMISSION_MODES,
  parsePermissionMode,
  type PermissionMode,
} from '../../agent_runtime/permissions/policy';
import { DEFAULT_PARTICIPANT } from '../../agent_runtime/types';
import type { Feedback } from '../feedback';
import type { CommandMenuItem, CommandSession, CommandSpec } from '../types';

function clearSession(session: CommandSession): Feedback {
  session.clear();
  return { kind: 'success', text: 'History cleared.' };
}

export const clearCommand: CommandSpec = {
  name: 'clear',
  description: 'clear the history',
  run: (_args, context) => clearSession(context.session),
};

// /compact asks the default participant's runtime to fold its conversation
// now. Each runtime also compacts on its own when its window fills; that is
// the vendor's and has no switch.
async function compactCommand(session: CommandSession, signal?: AbortSignal): Promise<Feedback> {
  await session.compact(signal);
  return { kind: 'success', text: `Compacted @${DEFAULT_PARTICIPANT}'s context.` };
}

export const compactCommandSpec: CommandSpec = {
  name: 'compact',
  description: 'ask the agent to compact its context now',
  run: (_args, context) => compactCommand(context.session, context.signal),
};

function renameSession(name: string, session: CommandSession): Feedback {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Usage: /rename <name>');
  session.setName(trimmed);
  return { kind: 'success', text: `Renamed to ${session.getName()}.` };
}

export const renameCommand: CommandSpec = {
  name: 'rename',
  args: '<name>',
  description: 'rename this session',
  run: (args, context) => renameSession(args.join(' '), context.session),
};

export const exitCommand: CommandSpec = {
  name: 'exit',
  description: 'quit sirus',
  // Only a caller that owns the app can quit it.
  run: (_args, context) => {
    if (!context.exit) throw new Error('/exit is not available here.');
    context.exit();
  },
};

const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: 'the agent asks before every action that is not a read',
  auto: 'the agent\'s own reviewer decides and asks only about what it judges unsafe',
  bypass: 'nothing is asked',
};

function permissionsMenuItems(): CommandMenuItem[] {
  return PERMISSION_MODES.map(mode => ({
    type: 'item',
    key: mode,
    label: PERMISSION_MODE_NAMES[mode],
    description: PERMISSION_MODE_DESCRIPTIONS[mode],
    command: `/permissions ${mode}`,
  }));
}

function permissionsCommand(mode: string | undefined, session: CommandSession): Feedback {
  if (mode === undefined) {
    return {
      kind: 'info',
      text: `Permission mode is ${PERMISSION_MODE_NAMES[session.getPermissionMode()]}.`,
    };
  }
  const parsed = parsePermissionMode(mode);
  if (!parsed) throw new Error('Usage: /permissions [ask|auto|bypass]');
  session.setPermissionMode(parsed);
  return {
    kind: 'success',
    text: `Permission mode set to ${PERMISSION_MODE_NAMES[parsed]}.`,
  };
}

export const permissionsCommandSpec: CommandSpec = {
  name: 'permissions',
  args: '[ask|auto|bypass]',
  description: 'show or set how tool calls are approved',
  run: (args, context) => permissionsCommand(args[0], context.session),
  menu: args => args.length === 0 ? permissionsMenuItems() : null,
};
