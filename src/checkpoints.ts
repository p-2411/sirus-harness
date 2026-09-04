import crypto from 'crypto';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
let lastFailure: string | null = null;
const locks = new Map<string, Promise<unknown>>();

export function enableCheckpoints(on: boolean = true): void {
  enabled = on;
}

export function checkpointsEnabled(): boolean {
  return enabled;
}

// Why the most recent capture could not be taken, if it could not.
export function checkpointFailure(): string | null {
  return lastFailure;
}

export function checkpointSummary(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
}

export function checkpointRepository(directory: string): string {
  const key = crypto.createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);
  return path.join(dataDirectory(), 'checkpoints', key);
}

function git(directory: string, args: readonly string[]): Promise<string> {
  const gitDirectory = checkpointRepository(directory);
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', gitDirectory, '--work-tree', directory, ...args], {
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
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

async function commitDirectory(directory: string, message: string): Promise<string> {
  await ensureRepository(directory);
  await git(directory, ['add', '-A', '--', '.']);
  await git(directory, ['commit', '-q', '--allow-empty', '--no-verify', '-m', message]);
  return (await git(directory, ['rev-parse', 'HEAD'])).trim();
}

// Records the directory as it is now. Null when checkpoints are off or the
// capture failed; a failure never stops the turn, it is reported on demand.
export async function captureCheckpoint(
  directory: string,
  summary: string,
): Promise<{ id: string; createdAt: number } | null> {
  if (!enabled) return null;
  try {
    const id = await withRepository(directory, () => commitDirectory(directory, summary || 'checkpoint'));
    lastFailure = null;
    return { id, createdAt: Date.now() };
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
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

// Puts the directory back to the checkpoint. The state being replaced is
// committed first, so a rewind can itself be recovered from the repository.
export function restoreCheckpoint(directory: string, id: string): Promise<RestoredFiles> {
  return withRepository(directory, async () => {
    await commitDirectory(directory, `before rewinding to ${id.slice(0, 7)}`);
    const changes = parseNameStatus(await git(directory, ['diff', '--name-status', '-z', '--no-renames', id, 'HEAD']));
    await git(directory, ['read-tree', '--reset', '-u', id]);
    return changes;
  });
}
