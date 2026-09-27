import { execFile } from 'child_process';
import path from 'path';
import { gitEnvironment } from '../../../checkpoints';
import { dataDirectory } from '../../../dataDirectory';

// Explicit worktree isolation: a branch from HEAD, retained only when changed.

const GIT_TIMEOUT_MS = 60_000;

export interface Worktree {
  directory: string;
  branch: string;
  startHead: string;
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

export async function createWorktree(
  project: string,
  sessionId: string,
  runId: string,
): Promise<Worktree | null> {
  const directory = worktreePath(sessionId, runId);
  const branch = `sirus/${runId}`;
  let startHead: string;
  try {
    startHead = (await git(project, ['rev-parse', '--verify', 'HEAD'])).trim();
  } catch {
    return null;
  }
  await git(project, ['worktree', 'add', '--quiet', '-b', branch, directory, 'HEAD']);
  return { directory, branch, startHead };
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
  await git(project, ['branch', '-D', worktree.branch]).catch(() => undefined);
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
