import {
  PERMISSION_MODE_NAMES,
  PERMISSION_MODES,
  parsePermissionMode,
  type PermissionMode,
} from '../../agent_runtime/permissions/policy';
import type { Feedback } from '../feedback';
import type { CommandMenuItem, CommandSession } from '../types';

export function clearSession(session: CommandSession): Feedback {
  session.clear();
  return { kind: 'success', text: 'History cleared.' };
}

// /compact asks the default participant's runtime to fold its conversation
// now. Each runtime also compacts on its own when its window fills; that is
// the vendor's and has no switch.
export async function compactCommand(session: CommandSession, signal?: AbortSignal): Promise<Feedback> {
  await session.compact(signal);
  const name = session.getParticipants()[0]?.name ?? 'sirus';
  return { kind: 'success', text: `Compacted @${name}'s context.` };
}

export function renameSession(name: string, session: CommandSession): Feedback {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Usage: /rename <name>');
  session.setName(trimmed);
  return { kind: 'success', text: `Renamed to ${session.getName()}.` };
}

const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: 'the agent asks before every action that is not a read',
  auto: 'the agent\'s own reviewer decides and asks only about what it judges unsafe',
  bypass: 'nothing is asked',
};

export function permissionsMenuItems(): CommandMenuItem[] {
  return PERMISSION_MODES.map(mode => ({
    type: 'item',
    key: mode,
    label: PERMISSION_MODE_NAMES[mode],
    description: PERMISSION_MODE_DESCRIPTIONS[mode],
    command: `/permissions ${mode}`,
  }));
}

export function permissionsCommand(mode: string | undefined, session: CommandSession): Feedback {
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
