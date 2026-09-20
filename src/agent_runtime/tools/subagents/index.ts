import path from 'path';
import type { SessionAgent } from '../../agent';
import type { Message, MessageBlock, ThinkingLevel } from '../../types';
import type { WorkerContext } from '../types';

// Subagents: one detached runtime per delegated task, a worker like a
// participant with a record of its own. This file is the process-wide index
// of runs and the change notification the UI subscribes to; the lifecycle is
// in `run.ts` and what a run says about itself is in `report.ts`, both
// imported directly (`run.ts` reads this index, so a re-export of it here
// would close the loop).
//
// Ownership lives on the SessionAgent that spawned a run; this index exists so
// the chat, the notifications and the rewind interlock can see runs they do
// not own.

// `interrupted` is a run that was still working when the process it lived in
// ended: its record survives in the session file, nothing restarts it.
export type SubagentStatus = 'working' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export type { WorkerContext };

// What the session file keeps of a worker: enough to show its record, tell
// where its branch is, and give its owner the report it never received.
export interface WorkerRecord {
  id: string;
  // The SpawnAgent tool call that started the run, so the UI can decorate it.
  callId: string | null;
  // The participant that spawned the run.
  owner: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  context: WorkerContext;
  prompt: string;
  // Where the worker runs: its own worktree in a git project, the project
  // itself otherwise.
  directory: string;
  // The branch its worktree is on, or null when it works in place.
  branch: string | null;
  status: SubagentStatus;
  startedAt: number;
  finishedAt: number | null;
  // The worker's own record: the task, the steering messages sent to it,
  // and the one assistant entry its turn fills in. Live while it works.
  transcript: Message[];
  finalMessage: string | null;
  changes: string[];
  error: string | null;
  // Its report has been delivered to the owner's transcript.
  reported: boolean;
  // The user cleared its line from the worker strip.
  dismissed: boolean;
}

export interface SubagentRun extends WorkerRecord {
  // The session the owning agent belongs to, so the UI can tell two sessions
  // sharing a call id apart.
  sessionId: string;
  // The agent that does the work; null for a run restored from a snapshot,
  // which is a record and nothing more.
  worker: SessionAgent | null;
  // The worker's response as it stands: the content of its assistant entry,
  // mutated in place while it works.
  content: MessageBlock[];
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

export function unregisterSubagent(id: string): void {
  runs.delete(id);
}

export function findSubagent(id: string): SubagentRun | undefined {
  return runs.get(id);
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
