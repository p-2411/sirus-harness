import crypto from 'crypto';
import { execFile } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { errorMessage } from './abort';
import { dataDirectory } from './dataDirectory';

// A checkpoint is the state of a session's directory just before a turn
// started, kept in a shadow git repository under the application-state
// directory: the project's own repository (if any) is never touched. Every
// file the project would track is captured; restoration is limited to files
// with explicit agent diffs and no conflicting user changes.

export interface Checkpoint {
  // The shadow commit holding the directory's files.
  id: string;
  // The sequence number of the user prompt that started the turn; rewinding
  // fork keeps every participant's entries before this seq.
  seq: number;
  // The first line of that message, for the picker.
  summary: string;
  createdAt: number;
  changes?: AgentFileChange[];
}

// Content fingerprints observed at an agent tool boundary. A missing file
// has a null fingerprint. Unproven changes are conflicts, never restore targets.
export interface AgentFileChange {
  path: string;
  before: string | null;
  after: string | null;
  conflict?: string;
}

export interface RestoredFiles {
  // Files put back to their checkpoint contents.
  restored: string[];
  // Files that did not exist at the checkpoint and were removed.
  removed: string[];
  conflicts: string[];
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

// A Sirus process launched from a Git hook may inherit paths into the
// project's index and object store. No git that Sirus runs may reuse them.
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  ]) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

// Pathspecs are taken literally: the files handed to a forced add are names,
// and a file called `*.txt` must not stand for every text file in the
// project, ignored ones included.
function git(directory: string, args: readonly string[]): Promise<string> {
  const gitDirectory = checkpointRepository(directory);
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', gitDirectory, '--work-tree', directory, '--literal-pathspecs', ...args], {
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
// hooks, no signing, and an identity so commits never depend on the user's
// git configuration. Automatic gc is off too. It would prune no checkpoint,
// since every one is an ancestor of HEAD; what turning it off does is keep
// every object loose, never packed.
const REPOSITORY_CONFIG: ReadonlyArray<[string, string]> = [
  ['gc.auto', '0'],
  ['core.hooksPath', '/dev/null'],
  ['commit.gpgsign', 'false'],
  ['user.name', 'Sirus'],
  ['user.email', 'sirus@localhost'],
];

// A checkpoint must give back the exact bytes it took, whatever the project's
// .gitattributes or the user's git configuration say: no line-ending
// conversion, no clean or smudge filter (Git LFS among them), no $Id$
// expansion and no re-encoding. The shadow repository's own info/attributes
// takes precedence over the project's files. The encoding is made unspecified
// rather than unset, since older git releases reject an unset one.
const EXACT_BYTES_ATTRIBUTES = '* -text -filter -ident !working-tree-encoding\n';

async function ensureRepository(directory: string): Promise<void> {
  const gitDirectory = checkpointRepository(directory);
  if (!existsSync(path.join(gitDirectory, 'HEAD'))) {
    mkdirSync(gitDirectory, { recursive: true, mode: 0o700 });
    await git(directory, ['init', '-q']);
    for (const [key, value] of REPOSITORY_CONFIG) await git(directory, ['config', key, value]);
    writeFileSync(path.join(gitDirectory, 'directory'), `${path.resolve(directory)}\n`, 'utf8');
  }
  // Each is written whenever it is missing, so that repositories made by
  // builds that did not write it get it too.
  const root = path.join(gitDirectory, 'root');
  if (!existsSync(root)) writeFileSync(root, realpathSync(directory), { mode: 0o600 });
  const attributes = path.join(gitDirectory, 'info', 'attributes');
  if (!existsSync(attributes)) {
    mkdirSync(path.dirname(attributes), { recursive: true });
    writeFileSync(attributes, EXACT_BYTES_ATTRIBUTES, 'utf8');
  }
}

// Git run against the project's own repository rather than the shadow one:
// here to list what a checkpoint captures, and by the worker worktrees to cut
// and remove their checkouts.
export function projectGit(
  directory: string,
  args: readonly string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', directory, ...args], {
      cwd: directory,
      timeout: timeoutMs,
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
    await projectGit(directory, ['rev-parse', '--is-inside-work-tree']);
    return await projectGit(directory, ['ls-files', '-co', '--exclude-standard', '-z', '--', '.']);
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
    });
    const writePathspecs = (paths: string[]) =>
      writeFileSync(pathspecFile, paths.join('\0'), { encoding: 'utf8', mode: 0o600 });
    // The shadow index is kept from one capture to the next, so git knows an
    // unchanged file by its stat data instead of rehashing every byte of the
    // project before each turn. Only the entries that left the file set are
    // dropped. `-f` because a restore leaves the index at the checkpoint and
    // HEAD at the state it replaced, and git would otherwise refuse to unstage
    // a restored file that was edited since.
    const listed = new Set(files);
    const stale = (await git(directory, ['ls-files', '-z'])).split('\0')
      .filter(file => file && !listed.has(file));
    if (stale.length > 0) {
      writePathspecs(stale);
      await git(directory, [
        'rm', '-q', '-f', '--cached', '--ignore-unmatch', `--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul',
      ]);
    }
    // `-f` is required for tracked files that happen to match an ignore rule.
    if (files.length > 0) {
      writePathspecs(files);
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
    failures.set(key, errorMessage(error));
    return null;
  }
}

export function isCheckpointId(id: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(id);
}

export function contentFingerprint(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Tool paths can come from a vendor or a worker. Never follow a symlink or
// accept a path outside this project, including its Git metadata.
export function checkpointPath(directory: string, file: string): string | null {
  const relative = path.relative(path.resolve(directory), path.resolve(directory, file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep).includes('.git')) return null;
  return relative;
}

export function fileFingerprint(directory: string, file: string): string | null {
  const root = path.join(checkpointRepository(directory), 'root');
  if (lstatSync(directory).isSymbolicLink() || !existsSync(root) || readFileSync(root, 'utf8') !== realpathSync(directory)) {
    throw new Error('Project directory moved or became a symlink.');
  }
  const relative = checkpointPath(directory, file);
  if (!relative) throw new Error('Path is outside the project.');
  let current = path.resolve(directory);
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Path is a symlink or directory.');
    }
  }
  return contentFingerprint(readFileSync(current));
}

interface RestoreTarget {
  file: string;
  expected: string | null;
  content: Buffer | null;
  mode: number;
}

function readBlob(directory: string, id: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', checkpointRepository(directory), 'cat-file', 'blob', id], {
      cwd: directory, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      env: gitEnvironment(), encoding: 'buffer',
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function restorationPlan(directory: string, id: string, changes: readonly AgentFileChange[]): Promise<{
  result: RestoredFiles; targets: RestoreTarget[];
}> {
  const root = path.join(checkpointRepository(directory), 'root');
  if (changes.length && (!existsSync(root) || readFileSync(root, 'utf8') !== realpathSync(directory) || lstatSync(directory).isSymbolicLink())) {
    throw new Error('The project directory moved or became a symlink; no files were restored.');
  }
  await git(directory, ['rev-parse', '--verify', `${id}^{commit}`]);
  const tree = new Map<string, { id: string; mode: string }>();
  for (const entry of (await git(directory, ['ls-tree', '-r', '-z', id])).split('\0')) {
    const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (match) tree.set(match[3], { id: match[2], mode: match[1] });
  }
  const byFile = new Map<string, AgentFileChange[]>();
  for (const change of changes) {
    const file = checkpointPath(directory, change.path);
    if (!file) continue;
    const history = byFile.get(file) ?? [];
    history.push(change);
    byFile.set(file, history);
  }
  const result: RestoredFiles = { restored: [], removed: [], conflicts: [] };
  const targets: RestoreTarget[] = [];
  // Files with no agent evidence are deliberately absent from this plan.
  for (const [file, history] of byFile) {
    const original = tree.get(file);
    const content = original ? await readBlob(directory, original.id) : null;
    const before = content === null ? null : contentFingerprint(content);
    let expected = before;
    let conflict = !!original && !['100644', '100755'].includes(original.mode);
    for (const change of history) {
      if (change.conflict || change.before !== expected) conflict = true;
      expected = change.after;
    }
    try {
      const current = fileFingerprint(directory, file);
      // Already restored files need no write, even on a repeated rewind.
      if (current === before) continue;
      if (current !== expected) conflict = true;
    } catch { conflict = true; }
    if (conflict) { result.conflicts.push(file); continue; }
    (content === null ? result.removed : result.restored).push(file);
    targets.push({ file, expected, content, mode: original?.mode === '100755' ? 0o755 : 0o644 });
  }
  return { result, targets };
}

export function previewCheckpoint(directory: string, id: string, changes: readonly AgentFileChange[] = []): Promise<RestoredFiles> {
  if (!isCheckpointId(id)) return Promise.reject(new Error('Invalid checkpoint identifier.'));
  return withRepository(directory, async () => (await restorationPlan(directory, id, changes)).result);
}

// Restore only proven agent changes. Recheck each path after all asynchronous
// Git reads so edits made while the preview was open remain untouched.
export function restoreCheckpoint(directory: string, id: string, changes: readonly AgentFileChange[] = []): Promise<RestoredFiles> {
  if (!isCheckpointId(id)) return Promise.reject(new Error('Invalid checkpoint identifier.'));
  return withRepository(directory, async () => {
    const { result, targets } = await restorationPlan(directory, id, changes);
    for (const target of targets) {
      try {
        if (fileFingerprint(directory, target.file) !== target.expected) throw new Error('File changed.');
        const filename = path.join(directory, target.file);
        if (target.content === null) unlinkSync(filename);
        else {
          mkdirSync(path.dirname(filename), { recursive: true });
          const temporary = path.join(path.dirname(filename), `.sirus-rewind-${crypto.randomUUID()}`);
          try {
            writeFileSync(temporary, target.content, { flag: 'wx', mode: target.mode });
            if (fileFingerprint(directory, target.file) !== target.expected) throw new Error('File changed.');
            renameSync(temporary, filename);
          } finally {
            try { unlinkSync(temporary); } catch { /* Rename already consumed it. */ }
          }
        }
      } catch {
        result.restored = result.restored.filter(file => file !== target.file);
        result.removed = result.removed.filter(file => file !== target.file);
        result.conflicts.push(target.file);
      }
    }
    return result;
  });
}
