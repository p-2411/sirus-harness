import path from 'path';
import type { SessionAgent } from '../../agent';
import type { PermissionContext } from '../../permissions/policy';
import type { MessageBlock } from '../../types';

// Subagents: one detached run of the agent loop per delegated task. This file
// is the process-wide index of runs and the change notification the UI
// subscribes to; the lifecycle is in `run.ts` and what a run says about itself
// is in `report.ts`, both imported directly (`run.ts` reads this index, so a
// re-export of it here would close the loop).
//
// Ownership lives on the SessionAgent that spawned a run; this index exists so
// the chat, the notifications and the rewind interlock can see runs they do
// not own.

export type SubagentStatus = 'working' | 'done' | 'failed' | 'cancelled';

export interface SubagentRun {
  id: string;
  // The SpawnAgent tool call that started the run, so the UI can decorate it.
  callId: string | null;
  // The session the owning agent belongs to, so the UI can tell two sessions
  // sharing a call id apart.
  sessionId: string | null;
  // The agent that spawned the run, and the agent that does its work.
  owner: SessionAgent;
  worker: SessionAgent;
  model: string;
  prompt: string;
  directory: string;
  status: SubagentStatus;
  streamFile: string | null;
  startedAt: number;
  finishedAt: number | null;
  content: MessageBlock[];
  finalMessage: string | null;
  changes: string[];
  error: string | null;
  // The owner's permission context: the run answers to the same mode and
  // prompts, as itself.
  permissions: PermissionContext | null;
}

const runs = new Map<string, SubagentRun>();
const listeners = new Set<() => void>();
let version = 0;

export function notifySubagents(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribeSubagents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Monotonic counter for useSyncExternalStore; runs are mutated in place.
export function getSubagentsVersion(): number {
  return version;
}

export function registerSubagent(run: SubagentRun): void {
  runs.set(run.id, run);
}

export function findSubagentByCall(callId: string, sessionId?: string): SubagentRun | undefined {
  for (const run of runs.values()) {
    if (run.callId === callId && (sessionId === undefined || run.sessionId === sessionId)) return run;
  }
  return undefined;
}

// Every run of the process, whoever owns it, for the UI.
export function listAllSubagents(): SubagentRun[] {
  return [...runs.values()];
}

export function activeSubagentCount(directory?: string): number {
  const target = directory ? path.resolve(directory) : null;
  let count = 0;
  for (const run of runs.values()) {
    if (run.status === 'working' && (!target || path.resolve(run.directory) === target)) count++;
  }
  return count;
}

export function allSubagents(): Iterable<SubagentRun> {
  return runs.values();
}

export type { SubagentSpawnOptions } from './run';
