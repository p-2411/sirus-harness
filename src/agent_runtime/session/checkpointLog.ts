import path from 'path';
import { realpathSync } from 'fs';
import {
  captureCheckpoint,
  checkpointSummary,
  checkpointPath,
  contentFingerprint,
  fileFingerprint,
  previewCheckpoint,
  type AgentFileChange,
  restoreCheckpoint,
  type Checkpoint,
  type RestoredFiles,
} from '../../checkpoints';
import { activeSubagentCount, type WorkerRecord } from '../tools/subagents';
import type { ChangeFeed } from './changeFeed';
import type { Message } from '../types';
import type { SessionSnapshot } from './index';

export type { Checkpoint };

// What a rewind is asked to put back.
export interface RewindOptions {
  files: boolean;
  chat: boolean;
  approvedFiles?: readonly string[];
}

export interface RewindPreview {
  checkpoint: Checkpoint;
  // Null when files were not restored.
  files: RestoredFiles | null;
  // Messages omitted from the fork; the original conversation is preserved.
  droppedMessages: number;
}

export interface RewindResult extends RewindPreview {
  fork: SessionSnapshot | null;
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
  private readonly observed = new Set<string>();

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

  // Captures the directory as it stood before a turn. The vendors run their
  // tools themselves and cannot wait on a barrier, so the caller awaits this
  // before any runtime is prompted.
  async capture(seq: number, text: string): Promise<void> {
    const summary = checkpointSummary(text);
    const captured = await captureCheckpoint(this.directory, summary);
    if (!captured) return;
    this.checkpoints.push({ ...captured, seq, summary });
    this.changes.notify();
  }

  find(checkpointId: string): { checkpoint: Checkpoint; index: number } | undefined {
    const index = this.checkpoints.findIndex(candidate => candidate.id === checkpointId);
    return index === -1 ? undefined : { checkpoint: this.checkpoints[index], index };
  }

  // Tool updates reach the same change feed as the transcript. Only an
  // explicit before/after diff proves ownership; locations without a diff
  // cannot separate an agent edit from user activity during the tool call.
  observe(messages: readonly Message[], restoring: boolean = false, worker?: WorkerRecord): void {
    if (worker) {
      try {
        if (realpathSync(worker.directory) !== realpathSync(this.directory)) return;
      } catch { return; }
    }
    const checkpoint = worker
      ? [...this.checkpoints].reverse().find(candidate => candidate.createdAt <= worker.startedAt)
      : this.checkpoints.at(-1);
    if (!checkpoint) return;
    for (const message of messages) {
      if ((!worker && message.seq < checkpoint.seq) || message.role !== 'assistant') continue;
      for (const call of message.content) {
        if (call.type !== 'tool_call') continue;
        const diffs = call.content.filter(content => content.type === 'diff');
        if (!diffs.length && !['edit', 'delete', 'move'].includes(call.kind)) continue;
        const paths = new Set([...call.locations.map(location => location.path), ...diffs.map(diff => diff.path)]);
        for (const toolPath of paths) {
          const file = checkpointPath(this.directory, toolPath);
          if (!file) continue;
          const key = `${worker?.id ?? 'session'}:${message.seq}:${call.id}:${file}`;
          if (this.observed.has(key)) continue;
          if (call.status === 'pending' || call.status === 'in_progress') continue;
          this.observed.add(key);
          if (restoring) continue;
          const changes: AgentFileChange[] = [];
          const fileDiffs = diffs.filter(diff => checkpointPath(this.directory, diff.path) === file);
          if (call.status === 'completed' && fileDiffs.length) {
            for (const diff of fileDiffs) changes.push({
              path: file,
              before: diff.oldText === null ? null : contentFingerprint(diff.oldText),
              after: call.kind === 'delete' ? null : contentFingerprint(diff.newText),
            });
          } else {
            let after: string | null = null;
            let conflict: string | undefined;
            try { after = fileFingerprint(this.directory, file); } catch { conflict = 'Unsafe file path'; }
            conflict ??= 'No explicit before/after diff';
            changes.push({ path: file, before: null, after, conflict });
          }
          checkpoint.changes ??= [];
          checkpoint.changes.push(...changes);
        }
      }
    }
  }

  private changesSince(checkpointId: string): AgentFileChange[] {
    const found = this.find(checkpointId);
    return found ? this.checkpoints.slice(found.index).flatMap(checkpoint => checkpoint.changes ?? []) : [];
  }

  previewFiles(checkpointId: string): Promise<RestoredFiles> {
    return previewCheckpoint(this.directory, checkpointId, this.changesSince(checkpointId));
  }

  restoreFiles(checkpointId: string, approvedFiles?: readonly string[]): Promise<RestoredFiles> {
    const changes = this.changesSince(checkpointId);
    return restoreCheckpoint(this.directory, checkpointId, approvedFiles
      ? changes.filter(change => approvedFiles.includes(change.path)) : changes);
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
