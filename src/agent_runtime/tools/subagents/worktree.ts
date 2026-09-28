import { rmSync } from 'fs';
import path from 'path';
import { errorMessage } from '../../../abort';
import { projectGit } from '../../../checkpoints';
import { dataDirectory } from '../../../dataDirectory';

// Explicit worktree isolation: a branch from HEAD, retained only when changed.
// Only a directory outside a repository runs the worker in place. A
// repository without a commit, or one Git cannot inspect, fails the spawn.

const GIT_TIMEOUT_MS = 60_000;

export interface Worktree {
  directory: string;
  branch: string;
  startHead: string;
}

function git(directory: string, args: readonly string[]): Promise<string> {
  return projectGit(directory, args, GIT_TIMEOUT_MS);
}

export function worktreePath(sessionId: string, runId: string): string {
  return path.join(dataDirectory(), 'worktrees', sessionId, runId);
}

export async function createWorktree(
  project: string,
  sessionId: string,
  runId: string,
): Promise<Worktree | null> {
  const directory = worktreePath(sessionId, runId);
  const branch = `sirus/${runId}`;
  let inside: string;
  try {
    inside = (await git(project, ['rev-parse', '--is-inside-work-tree'])).trim();
  } catch (error) {
    if (/not a git repository(?:\s|\()/i.test(errorMessage(error))) return null;
    throw new Error(`Could not inspect the repository for the worker: ${errorMessage(error)}`);
  }
  if (inside !== 'true') throw new Error('Could not create a worktree for the worker: the directory is not a Git working tree.');
  let startHead: string;
  try {
    startHead = (await git(project, ['rev-parse', '--verify', 'HEAD'])).trim();
  } catch (error) {
    throw new Error(`Could not create a worktree for the worker: ${errorMessage(error)}`);
  }
  try {
    await git(project, ['worktree', 'add', '--quiet', '-b', branch, directory, 'HEAD']);
  } catch (error) {
    // A repository that cannot make one fails the spawn: running the worker
    // in the user's own checkout instead is not a fallback. Git may have
    // made the branch, or part of the checkout, before it failed. Delete
    // its ref only if nobody has moved it beyond the starting commit.
    await discardWorktree(project, directory);
    await git(project, ['update-ref', '-d', `refs/heads/${branch}`, startHead]).catch(() => {});
    throw new Error(`Could not create a worktree for the worker: ${errorMessage(error)}`);
  }
  return { directory, branch, startHead };
}

// Removes what a failed `worktree add` left of the checkout and forgets it.
// Whatever git will not remove is removed directly and pruned from the
// project's administrative files.
async function discardWorktree(project: string, directory: string): Promise<void> {
  await git(project, ['worktree', 'remove', '--force', directory]).catch(() => {});
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Leaving a directory behind must never hide git's own error.
  }
  await git(project, ['worktree', 'prune']).catch(() => {});
}

// Both checks matter: a committed edit has a clean tree but still belongs
// to the worker. Failure to inspect it must leave its work in place.
export async function removeUnchangedWorktree(project: string, worktree: Worktree): Promise<boolean> {
  try {
    const head = (await git(worktree.directory, ['rev-parse', 'HEAD'])).trim();
    const status = await git(worktree.directory, ['status', '--porcelain', '--untracked-files=all']);
    if (head !== worktree.startHead || status.trim()) return false;
    await git(project, ['worktree', 'remove', worktree.directory]);
  } catch {
    return false;
  }
  // Once removed, a failed branch cleanup must not report a retained path.
  await git(project, ['update-ref', '-d', `refs/heads/${worktree.branch}`, worktree.startHead]).catch(() => undefined);
  return true;
}

export async function worktreeChanges(worktree: Worktree): Promise<string[]> {
  try {
    const changed = await git(worktree.directory, ['diff', '--name-only', '-z', worktree.startHead]);
    const untracked = await git(worktree.directory, ['ls-files', '--others', '--exclude-standard', '-z']);
    return [...new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean))];
  } catch {
    return [];
  }
}
