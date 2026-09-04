import type { Checkpoint, RewindResult, Session } from '../../agent_runtime/session';
import { activeSubagentCount } from '../../agent_runtime/tools/subagents';
import { checkpointFailure, checkpointsEnabled } from '../../checkpoints';
import type { Feedback } from '../feedback';
import type { CommandMenuEntry } from '../types';

// What a rewind puts back: the directory, the chat, or both.
export type RewindScope = 'all' | 'files' | 'chat';

export const REWIND_SCOPES: readonly RewindScope[] = ['all', 'files', 'chat'];

const SCOPE_LABELS: Record<RewindScope, string> = {
  all: 'Restore files and chat',
  files: 'Restore files only',
  chat: 'Restore chat only',
};

const SCOPE_DESCRIPTIONS: Record<RewindScope, string> = {
  all: 'put the directory back and drop the turn from the history',
  files: 'put the directory back and keep the conversation',
  chat: 'drop the turn from the history and keep the files',
};

const LISTED_FILES = 5;

export function parseRewindScope(value: unknown): RewindScope | null {
  return value === 'all' || value === 'files' || value === 'chat' ? value : null;
}

function noCheckpoints(session: Session): Error {
  const failure = checkpointFailure(session.getDirectory());
  if (failure) return new Error(`No checkpoints: the last capture failed. ${failure}`);
  if (!checkpointsEnabled()) return new Error('Checkpoints are not enabled in this process.');
  return new Error('No checkpoints yet: one is taken before each turn.');
}

function requireCheckpoints(session: Session): Checkpoint[] {
  const checkpoints = session.getCheckpoints();
  if (checkpoints.length === 0) throw noCheckpoints(session);
  return checkpoints;
}

// 1-based, oldest first: the number a user types after /rewind.
function checkpointNumber(session: Session, value: string | undefined): Checkpoint {
  const checkpoints = requireCheckpoints(session);
  const number = Number(value);
  if (!/^\d+$/.test(value ?? '') || number < 1 || number > checkpoints.length) {
    throw new Error(`Usage: /rewind <1-${checkpoints.length}> [all|files|chat]`);
  }
  return checkpoints[number - 1];
}

export function formatCheckpointAge(createdAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function scopeItems(heading: string, command: (scope: RewindScope) => string): CommandMenuEntry[] {
  return [
    { type: 'heading', key: 'target', label: heading },
    ...REWIND_SCOPES.map(scope => ({
      type: 'item' as const,
      key: scope,
      label: SCOPE_LABELS[scope],
      description: SCOPE_DESCRIPTIONS[scope],
      command: command(scope),
    })),
  ];
}

// /undo alone asks what to restore; with a scope it runs. Without a
// checkpoint there is no menu, and the command explains why.
export function undoMenuItems(args: readonly string[], session: Session): CommandMenuEntry[] | null {
  if (args.length > 0) return null;
  const checkpoints = session.getCheckpoints();
  const last = checkpoints[checkpoints.length - 1];
  if (!last) return null;
  return scopeItems(`Undo "${last.summary}"`, scope => `/undo ${scope}`);
}

// /rewind alone lists the checkpoints, newest first; /rewind <n> asks what
// to restore; /rewind <n> <scope> runs.
export function rewindMenuItems(args: readonly string[], session: Session): CommandMenuEntry[] | null {
  const checkpoints = session.getCheckpoints();
  if (checkpoints.length === 0 || args.length > 1) return null;
  if (args.length === 0) {
    return [
      { type: 'heading', key: 'checkpoints', label: 'Rewind to before…' },
      ...checkpoints.map((checkpoint, index) => ({
        type: 'item' as const,
        key: checkpoint.id,
        label: `${index + 1}. ${checkpoint.summary || '(no text)'}`,
        description: formatCheckpointAge(checkpoint.createdAt),
        command: `/rewind ${index + 1}`,
      })).reverse(),
    ];
  }
  const target = checkpointNumber(session, args[0]);
  return scopeItems(`Rewind to before "${target.summary}"`, scope => `/rewind ${args[0]} ${scope}`);
}

function listFiles(files: readonly string[]): string {
  const shown = files.slice(0, LISTED_FILES).join(', ');
  return files.length > LISTED_FILES ? `${shown} and ${files.length - LISTED_FILES} more` : shown;
}

export function describeRewind(result: RewindResult): Feedback {
  const parts: string[] = [];
  if (result.files) {
    const { restored, removed } = result.files;
    if (restored.length === 0 && removed.length === 0) parts.push('no files had changed');
    if (restored.length > 0) parts.push(`restored ${listFiles(restored)}`);
    if (removed.length > 0) parts.push(`removed ${listFiles(removed)}`);
  }
  if (result.droppedMessages > 0) {
    parts.push(`dropped ${result.droppedMessages} message${result.droppedMessages === 1 ? '' : 's'}`);
  }
  return {
    kind: 'success',
    text: `Rewound to before "${result.checkpoint.summary}": ${parts.join('; ')}.`,
  };
}

async function rewindTo(checkpoint: Checkpoint, scope: RewindScope, session: Session): Promise<Feedback> {
  const files = scope !== 'chat';
  if (files && activeSubagentCount(session.getDirectory()) > 0) {
    throw new Error('Subagents are still working in this directory. Wait for them or press escape to cancel them, then rewind.');
  }
  return describeRewind(await session.rewind(checkpoint.id, { files, chat: scope !== 'files' }));
}

export function undoCommand(scope: string | undefined, session: Session): Promise<Feedback> {
  const parsed = parseRewindScope(scope ?? 'all');
  if (!parsed) throw new Error('Usage: /undo [all|files|chat]');
  const checkpoints = requireCheckpoints(session);
  return rewindTo(checkpoints[checkpoints.length - 1], parsed, session);
}

export function rewindCommand(args: readonly string[], session: Session): Promise<Feedback> {
  const target = checkpointNumber(session, args[0]);
  const parsed = parseRewindScope(args[1] ?? 'all');
  if (!parsed || args.length > 2) throw new Error('Usage: /rewind <n> [all|files|chat]');
  return rewindTo(target, parsed, session);
}
