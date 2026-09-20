import { isAutoCompactEnabled, setAutoCompactEnabled } from '../../agent_runtime/compaction';
import {
  PERMISSION_MODE_NAMES,
  PERMISSION_MODES,
  parsePermissionMode,
  type PermissionMode,
} from '../../agent_runtime/permissions/policy';
import { formatTokens } from '../../agent_runtime/usage';
import type { Feedback } from '../feedback';
import type { CommandMenuItem, CommandSession } from '../types';

export function clearSession(session: CommandSession): Feedback {
  session.clear();
  return { kind: 'success', text: 'History cleared.' };
}

// /compact folds the history into a summary now; /compact on|off says
// whether sessions do that by themselves when the window fills.
export async function compactCommand(
  mode: string | undefined,
  session: CommandSession,
  signal?: AbortSignal,
): Promise<Feedback> {
  if (mode === 'on' || mode === 'off') {
    setAutoCompactEnabled(mode === 'on');
    return { kind: 'success', text: `Automatic compaction set to ${mode}.` };
  }
  if (mode !== undefined) throw new Error('Usage: /compact [on|off]');
  const result = await session.compact(signal);
  const size = result.tokensBefore > 0
    ? ` (ctx ${formatTokens(result.tokensBefore)} → ~${formatTokens(result.tokensAfter)})`
    : '';
  return {
    kind: 'success',
    text: `Compacted ${result.messages} message${result.messages === 1 ? '' : 's'} into a summary${size}. `
      + `Automatic compaction is ${isAutoCompactEnabled() ? 'on' : 'off'}.`,
  };
}

export function renameSession(name: string, session: CommandSession): Feedback {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Usage: /rename <name>');
  session.setName(trimmed);
  return { kind: 'success', text: `Renamed to ${session.getName()}.` };
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
