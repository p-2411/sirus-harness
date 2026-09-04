import type { Session } from '../../agent_runtime/session';
import {
  PERMISSION_MODE_NAMES,
  PERMISSION_MODES,
  parsePermissionMode,
  type PermissionMode,
} from '../../agent_runtime/permissions/permissions';
import type { Feedback } from '../feedback';
import type { CommandMenuItem } from '../types';

export function clearSession(session: Session): Feedback {
  session.clear();
  return { kind: 'success', text: 'Session history cleared.' };
}

export function renameSession(name: string, session: Session): Feedback {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Usage: /rename <name>');
  session.setName(trimmed);
  return { kind: 'success', text: `Session renamed to ${session.getName()}.` };
}

const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: 'prompt before every write, shell command, and spawned agent',
  auto: 'run ordinary work; prompt only for sensitive operations',
  bypass: 'run everything without prompting',
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

export function permissionsCommand(mode: string | undefined, session: Session): Feedback {
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
