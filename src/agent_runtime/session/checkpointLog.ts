import path from 'path';
import {
  captureCheckpoint,
  checkpointSummary,
  restoreCheckpoint,
  type Checkpoint,
  type RestoredFiles,
} from '../../checkpoints';
import { activeSubagentCount } from '../tools/subagents';
import type { ChangeFeed } from './changeFeed';

export type { Checkpoint };

// What a rewind is asked to put back.
export interface RewindOptions {
  files: boolean;
  chat: boolean;
}

export interface RewindResult {
  checkpoint: Checkpoint;
  // Null when files were not restored.
  files: RestoredFiles | null;
  // How many messages the chat lost; zero when the chat was kept.
  droppedMessages: number;
}

// Sessions can share a working directory. A file rewind must not overlap
// another session's turn, even when the session being rewound is idle. This
// is the one place that answers "is anything happening in this directory".
export interface DirectoryActivity {
  beginTurn(directory: string): void;
  endTurn(directory: string): void;
  beginRestore(directory: string): void;
  endRestore(directory: string): void;
  // Files here are being put back, by this session or by another.
  isRestoring(directory: string): boolean;
  // A turn or a file restore is running here, by this session or by another.
  isBusy(directory: string): boolean;
  // Detached workers outlive their parent turn, so the turn count alone does
  // not tell us whether files in this directory are still in use.
  subagentCount(directory: string): number;
}

class ProcessDirectoryActivity implements DirectoryActivity {
  private readonly turns = new Map<string, number>();
  private readonly restoring = new Set<string>();

  beginTurn(directory: string): void {
    const key = keyFor(directory);
    this.turns.set(key, (this.turns.get(key) ?? 0) + 1);
  }

  endTurn(directory: string): void {
    const key = keyFor(directory);
    const remaining = (this.turns.get(key) ?? 1) - 1;
    if (remaining > 0) this.turns.set(key, remaining);
    else this.turns.delete(key);
  }

  beginRestore(directory: string): void {
    this.restoring.add(keyFor(directory));
  }

  endRestore(directory: string): void {
    this.restoring.delete(keyFor(directory));
  }

  isRestoring(directory: string): boolean {
    return this.restoring.has(keyFor(directory));
  }

  isBusy(directory: string): boolean {
    const key = keyFor(directory);
    return this.turns.has(key) || this.restoring.has(key);
  }

  subagentCount(directory: string): number {
    return activeSubagentCount(keyFor(directory));
  }
}

function keyFor(directory: string): string {
  return path.resolve(directory);
}

// One process-wide instance, so two sessions sharing a directory see each
// other's turns and restores.
export const defaultDirectoryActivity: DirectoryActivity = new ProcessDirectoryActivity();

// This session's pre-turn directory snapshots, and the interlock that keeps
// concurrent work in the same directory out of a file restore.
export class CheckpointLog {
  private checkpoints: Checkpoint[];

  constructor(
    private readonly directory: string,
    checkpoints: readonly Checkpoint[],
    private readonly changes: ChangeFeed,
    private readonly activity: DirectoryActivity = defaultDirectoryActivity,
  ) {
    this.checkpoints = [...checkpoints];
  }

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  // Checkpoints go with a cleared history: they point into messages that
  // are gone.
  clear(): void {
    this.checkpoints = [];
  }

  // Captures the directory as it stood before a turn. The caller starts the
  // provider in parallel and makes every mutating tool wait on this promise,
  // so agent writes cannot race ahead of the snapshot.
  async capture(messageIndex: number, text: string): Promise<void> {
    const summary = checkpointSummary(text);
    const captured = await captureCheckpoint(this.directory, summary);
    if (!captured) return;
    this.checkpoints.push({ ...captured, messageIndex, summary });
    this.changes.notify();
  }

  find(checkpointId: string): { checkpoint: Checkpoint; index: number } | undefined {
    const index = this.checkpoints.findIndex(candidate => candidate.id === checkpointId);
    return index === -1 ? undefined : { checkpoint: this.checkpoints[index], index };
  }

  // Restoring the chat drops that checkpoint and every later one; restoring
  // only files keeps them all.
  dropFrom(index: number): void {
    this.checkpoints = this.checkpoints.slice(0, index);
  }

  restoreFiles(checkpointId: string): Promise<RestoredFiles> {
    return restoreCheckpoint(this.directory, checkpointId);
  }

  beginTurn(): void {
    this.activity.beginTurn(this.directory);
  }

  endTurn(): void {
    this.activity.endTurn(this.directory);
  }

  beginRestore(): void {
    this.activity.beginRestore(this.directory);
  }

  endRestore(): void {
    this.activity.endRestore(this.directory);
  }

  isRestoringDirectory(): boolean {
    return this.activity.isRestoring(this.directory);
  }

  isDirectoryBusy(): boolean {
    return this.activity.isBusy(this.directory);
  }

  // Whole-directory question: are subagents working here, whether they
  // belong to this session or another one sharing the directory. Distinct
  // from ParticipantRoster.hasWorkingSubagents, which asks only about this
  // session's own agents.
  directoryHasWorkingSubagents(): boolean {
    return this.activity.subagentCount(this.directory) > 0;
  }
}
