import crypto from 'crypto';
import { execFile } from 'child_process';
import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { dataDirectory } from './persistence';

// A checkpoint is the state of a session's directory just before a turn
// started, kept in a shadow git repository under the application-state
// directory: the project's own repository (if any) is never touched. Every
// file the project would track is captured; ignored files are left alone,
// both when capturing and when restoring.

export interface Checkpoint {
  // The shadow commit holding the directory's files.
  id: string;
  // Index in the session history of the user message that started the turn;
  // rewinding the chat truncates the history to this point.
  messageIndex: number;
  // The first line of that message, for the picker.
  summary: string;
  createdAt: number;
}

export interface RestoredFiles {
  // Files put back to their checkpoint contents.
  restored: string[];
  // Files that did not exist at the checkpoint and were removed.
  removed: string[];
}

const GIT_TIMEOUT_MS = 120_000;
const SUMMARY_LENGTH = 60;

// Off until the app turns it on, so sessions driven from tests or scripts
// never run git against the working directory.
let enabled = false;
const failures = new Map<string, string>();
const locks = new Map<string, Promise<unknown>>();

export function enableCheckpoints(on: boolean = true): void {
  enabled = on;
}

export function checkpointsEnabled(): boolean {
  return enabled;
}

// Why the most recent capture for this directory could not be taken, if it
// could not. Failures from another project must not leak into this session.
export function checkpointFailure(directory: string): string | null {
  return failures.get(path.resolve(directory)) ?? null;
}

export function checkpointSummary(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
}

export function checkpointRepository(directory: string): string {
  const key = crypto.createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);
  return path.join(dataDirectory(), 'checkpoints', key);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  // A Sirus process launched from a Git hook may inherit paths into the
  // project's index/object store. Neither Git invocation may reuse them.
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  ]) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

function git(directory: string, args: readonly string[]): Promise<string> {
  const gitDirectory = checkpointRepository(directory);
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', gitDirectory, '--work-tree', directory, ...args], {
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnvironment(),
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(new Error(`git ${args[0]} failed: ${detail}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// One git operation at a time per shadow repository: two sessions in the
// same directory must not race for its index.
function withRepository<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const key = checkpointRepository(directory);
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(key, next.catch(() => void 0));
  return next;
}

// Repository settings that keep the shadow repository self-contained: no
// hooks, no signing, no automatic gc (older checkpoints stay reachable), and
// an identity so commits never depend on the user's git configuration.
const REPOSITORY_CONFIG: ReadonlyArray<[string, string]> = [
  ['gc.auto', '0'],
  ['core.hooksPath', '/dev/null'],
  ['commit.gpgsign', 'false'],
  ['user.name', 'Sirus'],
  ['user.email', 'sirus@localhost'],
];

async function ensureRepository(directory: string): Promise<void> {
  const gitDirectory = checkpointRepository(directory);
  if (existsSync(path.join(gitDirectory, 'HEAD'))) return;
  mkdirSync(gitDirectory, { recursive: true, mode: 0o700 });
  await git(directory, ['init', '-q']);
  for (const [key, value] of REPOSITORY_CONFIG) await git(directory, ['config', key, value]);
  writeFileSync(path.join(gitDirectory, 'directory'), `${path.resolve(directory)}\n`, 'utf8');
}

function sourceGit(directory: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', directory, ...args], {
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnvironment(),
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

// Use the owning repository's tracked/untracked view when there is one. This
// honors its index, .gitignore, .git/info/exclude, and global excludes while
// still including tracked files that now match an ignore rule. A non-git
// directory uses the shadow repository's equivalent view.
async function checkpointFiles(directory: string): Promise<string> {
  try {
    await sourceGit(directory, ['rev-parse', '--is-inside-work-tree']);
    return await sourceGit(directory, ['ls-files', '-co', '--exclude-standard', '-z', '--', '.']);
  } catch {
    return git(directory, ['ls-files', '-co', '--exclude-standard', '-z', '--', '.']);
  }
}

async function commitDirectory(directory: string, message: string): Promise<string> {
  await ensureRepository(directory);
  const gitDirectory = checkpointRepository(directory);
  const pathspecFile = path.join(gitDirectory, `pathspec-${process.pid}-${crypto.randomUUID()}`);
  try {
    // The source index also lists deleted files. Leave those out of the new
    // tree, but keep dangling symlinks, whose link targets need not exist.
    const files = (await checkpointFiles(directory)).split('\0').filter(file => {
      if (!file) return false;
      try {
        const stat = lstatSync(path.join(directory, file));
        // A previously tracked file may now be a directory. Passing that
        // directory to forced add would also capture its ignored children.
        return stat.isFile() || stat.isSymbolicLink();
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
      }
    }).map(file => `${file}\0`).join('');
    writeFileSync(pathspecFile, files, { encoding: 'utf8', mode: 0o600 });
    // Rebuild the shadow index from the owning repository's file set. `-f` is
    // required for tracked files that happen to match an ignore rule.
    await git(directory, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.']);
    if (files.length > 0) {
      await git(directory, ['add', '-f', `--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul']);
    }
    await git(directory, ['commit', '-q', '--allow-empty', '--no-verify', '-m', message]);
    return (await git(directory, ['rev-parse', 'HEAD'])).trim();
  } finally {
    try {
      unlinkSync(pathspecFile);
    } catch {
      // A stale pathspec file is harmless and remains private in the app data.
    }
  }
}

// Records the directory as it is now. Null when checkpoints are off or the
// capture failed; a failure never stops the turn, it is reported on demand.
export async function captureCheckpoint(
  directory: string,
  summary: string,
): Promise<{ id: string; createdAt: number } | null> {
  if (!enabled) return null;
  const key = path.resolve(directory);
  try {
    const id = await withRepository(directory, () => commitDirectory(directory, summary || 'checkpoint'));
    failures.delete(key);
    return { id, createdAt: Date.now() };
  } catch (error) {
    failures.set(key, error instanceof Error ? error.message : String(error));
    return null;
  }
}

// Status letters of `git diff --name-status -z` from the checkpoint to now.
function parseNameStatus(output: string): RestoredFiles {
  const restored: string[] = [];
  const removed: string[] = [];
  const fields = output.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (!status || !file) continue;
    // Added since the checkpoint means it goes away; anything else is put back.
    if (status.startsWith('A')) removed.push(file);
    else restored.push(file);
  }
  return { restored, removed };
}

export function isCheckpointId(id: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(id);
}

// Git may overwrite ignored files even during a merging read-tree. Check
// every file outside our freshly captured index, including ignored children
// of a directory that the target would replace with a regular file.
async function protectExcludedFiles(directory: string, id: string): Promise<void> {
  const excluded = (await git(directory, ['ls-files', '--others', '-z']))
    .split('\0').filter(Boolean).map(file => file.replace(/\/$/, ''));
  if (excluded.length === 0) return;
  const protectedFiles = new Set(excluded);
  const protectedParents = new Set<string>();
  for (const file of excluded) {
    let parent = path.posix.dirname(file);
    while (parent !== '.') {
      protectedParents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const targetFiles = (await git(directory, ['ls-tree', '-r', '--name-only', '-z', id]))
    .split('\0').filter(Boolean);
  for (const file of targetFiles) {
    let candidate = file;
    let conflict = protectedParents.has(file);
    while (!conflict && candidate !== '.') {
      conflict = protectedFiles.has(candidate);
      candidate = path.posix.dirname(candidate);
    }
    if (conflict) throw new Error(`Cannot restore ${file}: it would overwrite files excluded from checkpoints.`);
  }
}

// Puts the directory back to the checkpoint. The state being replaced is
// committed first, so a rewind can itself be recovered from the repository.
export function restoreCheckpoint(directory: string, id: string): Promise<RestoredFiles> {
  if (!isCheckpointId(id)) return Promise.reject(new Error('Invalid checkpoint identifier.'));
  return withRepository(directory, async () => {
    await ensureRepository(directory);
    await git(directory, ['rev-parse', '--verify', `${id}^{commit}`]);
    await commitDirectory(directory, `before rewinding to ${id.slice(0, 7)}`);
    await protectExcludedFiles(directory, id);
    const changes = parseNameStatus(await git(directory, ['diff', '--name-status', '-z', '--no-renames', id, 'HEAD']));
    // Merge from the freshly captured index so concurrent file edits are
    // rejected instead of being discarded by an unconditional reset.
    await git(directory, ['read-tree', '-m', '-u', 'HEAD', id]);
    return changes;
  });
}
