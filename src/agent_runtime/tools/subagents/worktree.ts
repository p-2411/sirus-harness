import { execFile } from 'child_process';
import { rmSync } from 'fs';
import path from 'path';
import { checkpointsEnabled, gitEnvironment } from '../../../checkpoints';
import { dataDirectory } from '../../../dataDirectory';

// Where a worker works. In a git project it gets a worktree of its own, cut
// from the project's HEAD onto a branch named after the run: uncommitted
// changes and ignored directories are not carried over, so two workers and
// the user never edit the same files. Anything else — a directory that is not
// a repository, a repository with no commit yet — runs the worker in the
// project itself.
//
// The worktree outlives the run: the report names the branch so the owner or
// the user can merge or inspect it. It goes when the session does; the branch
// stays.

const GIT_TIMEOUT_MS = 60_000;

export interface Worktree {
  directory: string;
  branch: string;
}

function git(directory: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', directory, ...args], {
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: gitEnvironment(),
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

export function worktreePath(sessionId: string, runId: string): string {
  return path.join(dataDirectory(), 'worktrees', sessionId, runId);
}

// The worker's own checkout, or null when it must run in place. Off entirely
// until the app switches checkpoints on, so a session driven from a test or a
// script never creates a branch in the user's repository.
export async function createWorktree(
  project: string,
  sessionId: string,
  runId: string,
): Promise<Worktree | null> {
  if (!checkpointsEnabled()) return null;
  const directory = worktreePath(sessionId, runId);
  const branch = `sirus/${runId}`;
  try {
    // An unborn HEAD has no commit to branch from, and a directory outside a
    // repository fails the same way.
    await git(project, ['rev-parse', '--verify', 'HEAD']);
    await git(project, ['worktree', 'add', '--quiet', '-b', branch, directory, 'HEAD']);
    return { directory, branch };
  } catch {
    return null;
  }
}

// Removes the worktree and forgets it, leaving the branch behind. Git refuses
// to remove one with changes in it, hence the force; whatever it leaves is
// removed directly and pruned from the project's administrative files.
export async function removeWorktree(project: string, directory: string): Promise<void> {
  try {
    await git(project, ['worktree', 'remove', '--force', directory]);
  } catch {
    // The user may have removed it themselves, or git may refuse it.
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Leaving a directory behind must never fail a session teardown.
  }
  try {
    await git(project, ['worktree', 'prune']);
  } catch {
    // Same: a stale administrative entry is harmless.
  }
}
