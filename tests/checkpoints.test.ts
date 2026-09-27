import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  captureCheckpoint,
  checkpointFailure,
  checkpointRepository,
  enableCheckpoints,
  restoreCheckpoint,
} from '../src/checkpoints';

const temporaryRoots: string[] = [];
const originalDataDirectory = process.env.SIRUS_DATA_DIR;

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), `sirus-${name}-`));
  temporaryRoots.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function checkpointTree(directory: string, id: string): string[] {
  return execFileSync('git', ['--git-dir', checkpointRepository(directory), 'ls-tree', '-r', '--name-only', '-z', id], {
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

afterEach(() => {
  enableCheckpoints(false);
  if (originalDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = originalDataDirectory;
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('worktree checkpoints', () => {
  test('restores the exact pre-turn tracked and non-ignored state without touching excluded files', async () => {
    const root = temporaryDirectory('checkpoint');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();

    git(project, 'init', '-q');
    git(project, 'config', 'user.name', 'Test');
    git(project, 'config', 'user.email', 'test@example.com');
    writeFileSync(path.join(project, '.gitignore'), '*.ignored\n');
    writeFileSync(path.join(project, 'tracked.txt'), 'committed\n');
    writeFileSync(path.join(project, 'tracked.ignored'), 'committed ignored\n');
    git(project, 'add', '-f', '.gitignore', 'tracked.txt', 'tracked.ignored');
    git(project, 'commit', '-q', '-m', 'initial');
    writeFileSync(path.join(project, '.git', 'info', 'exclude'), 'excluded.txt\n');

    // These are the user's pre-existing changes and must be the undo target.
    writeFileSync(path.join(project, 'tracked.txt'), 'user change\n');
    writeFileSync(path.join(project, 'tracked.ignored'), 'user ignored change\n');
    writeFileSync(path.join(project, 'untracked.txt'), 'user untracked\n');
    writeFileSync(path.join(project, 'excluded.txt'), 'private before\n');
    const originalHead = git(project, 'rev-parse', 'HEAD');
    const originalIndex = readFileSync(path.join(project, '.git', 'index'));
    const checkpoint = await captureCheckpoint(project, 'before agent');
    expect(checkpoint).not.toBeNull();

    writeFileSync(path.join(project, 'tracked.txt'), 'agent change\n');
    writeFileSync(path.join(project, 'tracked.ignored'), 'agent ignored change\n');
    writeFileSync(path.join(project, 'untracked.txt'), 'agent untracked change\n');
    writeFileSync(path.join(project, 'excluded.txt'), 'private after\n');
    writeFileSync(path.join(project, 'added.txt'), 'agent added\n');

    const restored = await restoreCheckpoint(project, checkpoint!.id);

    expect(readFileSync(path.join(project, 'tracked.txt'), 'utf8')).toBe('user change\n');
    expect(readFileSync(path.join(project, 'tracked.ignored'), 'utf8')).toBe('user ignored change\n');
    expect(readFileSync(path.join(project, 'untracked.txt'), 'utf8')).toBe('user untracked\n');
    expect(readFileSync(path.join(project, 'excluded.txt'), 'utf8')).toBe('private after\n');
    expect(() => readFileSync(path.join(project, 'added.txt'))).toThrow();
    expect(restored.removed).toContain('added.txt');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(path.join(project, '.git', 'index'))).toEqual(originalIndex);
  });

  test('captures pre-existing deletions and restores files deleted during a turn', async () => {
    const root = temporaryDirectory('deleted-checkpoint');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    git(project, 'init', '-q');
    for (const file of ['user-deleted.txt', 'agent-deleted.txt']) {
      writeFileSync(path.join(project, file), 'original\n');
    }
    git(project, 'add', '.');
    rmSync(path.join(project, 'user-deleted.txt'));
    symlinkSync('missing-target', path.join(project, 'dangling-link'));
    const checkpoint = await captureCheckpoint(project, 'deletions');
    expect(checkpoint).not.toBeNull();

    writeFileSync(path.join(project, 'user-deleted.txt'), 'recreated\n');
    rmSync(path.join(project, 'agent-deleted.txt'));
    rmSync(path.join(project, 'dangling-link'));
    const result = await restoreCheckpoint(project, checkpoint!.id);
    expect(result.restored).toEqual(['agent-deleted.txt', 'dangling-link']);
    expect(result.removed).toEqual(['user-deleted.txt']);
    expect(readFileSync(path.join(project, 'agent-deleted.txt'), 'utf8')).toBe('original\n');
    expect(() => readFileSync(path.join(project, 'user-deleted.txt'))).toThrow();
  });

  test('drops files that left the file set since the previous capture', async () => {
    const root = temporaryDirectory('shrinking-checkpoint');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    git(project, 'init', '-q');
    for (const file of ['kept.txt', 'removed.txt', 'ignored.txt']) {
      writeFileSync(path.join(project, file), `${file}\n`);
    }
    const first = await captureCheckpoint(project, 'first');
    expect(first).not.toBeNull();
    expect(checkpointTree(project, first!.id)).toEqual(['ignored.txt', 'kept.txt', 'removed.txt']);

    rmSync(path.join(project, 'removed.txt'));
    writeFileSync(path.join(project, '.gitignore'), 'ignored.txt\n');
    const second = await captureCheckpoint(project, 'second');
    expect(second).not.toBeNull();
    expect(checkpointTree(project, second!.id)).toEqual(['.gitignore', 'kept.txt']);
  });

  test('captures again after a rewind whose restored files were edited since', async () => {
    const root = temporaryDirectory('after-rewind');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    git(project, 'init', '-q');
    writeFileSync(path.join(project, 'edited.txt'), 'checkpoint\n');
    writeFileSync(path.join(project, 'ignored.txt'), 'checkpoint\n');
    const checkpoint = await captureCheckpoint(project, 'first');
    expect(checkpoint).not.toBeNull();
    writeFileSync(path.join(project, 'edited.txt'), 'agent\n');
    writeFileSync(path.join(project, 'ignored.txt'), 'agent\n');
    await restoreCheckpoint(project, checkpoint!.id);

    // The restore left the shadow index at the checkpoint and its HEAD at the
    // agent's state, so both files now differ from each.
    writeFileSync(path.join(project, 'edited.txt'), 'user\n');
    writeFileSync(path.join(project, '.gitignore'), 'ignored.txt\n');
    writeFileSync(path.join(project, 'ignored.txt'), 'private\n');
    const next = await captureCheckpoint(project, 'second');
    expect(checkpointFailure(project)).toBeNull();
    expect(next).not.toBeNull();
    expect(checkpointTree(project, next!.id)).toEqual(['.gitignore', 'edited.txt']);
  });

  test('restores the exact bytes whatever the project attributes say, in older shadow repositories too', async () => {
    const root = temporaryDirectory('exact-bytes');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    git(project, 'init', '-q');
    // A shadow repository made by a build that did not write its attributes.
    expect(await captureCheckpoint(project, 'empty')).not.toBeNull();
    rmSync(path.join(checkpointRepository(project), 'info', 'attributes'), { force: true });

    writeFileSync(path.join(project, '.gitattributes'), '* text eol=crlf\n');
    writeFileSync(path.join(project, 'lf.txt'), 'one\ntwo\n');
    writeFileSync(path.join(project, 'crlf.txt'), 'one\r\ntwo\r\n');
    const checkpoint = await captureCheckpoint(project, 'line endings');
    expect(checkpoint).not.toBeNull();
    writeFileSync(path.join(project, 'lf.txt'), 'agent\n');
    writeFileSync(path.join(project, 'crlf.txt'), 'agent\n');
    await restoreCheckpoint(project, checkpoint!.id);

    expect(readFileSync(path.join(project, 'lf.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(path.join(project, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
  });

  test('reads file names literally, so glob characters in one capture no ignored file', async () => {
    const root = temporaryDirectory('literal-names');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    git(project, 'init', '-q');
    writeFileSync(path.join(project, '.gitignore'), 'secret.txt\n');
    writeFileSync(path.join(project, 'secret.txt'), 'private before\n');
    writeFileSync(path.join(project, '*.txt'), 'star\n');
    const checkpoint = await captureCheckpoint(project, 'glob characters');
    expect(checkpoint).not.toBeNull();
    expect(checkpointTree(project, checkpoint!.id)).toEqual(['*.txt', '.gitignore']);

    writeFileSync(path.join(project, 'secret.txt'), 'private after\n');
    await restoreCheckpoint(project, checkpoint!.id);
    expect(readFileSync(path.join(project, 'secret.txt'), 'utf8')).toBe('private after\n');
  });

  test('refuses a restore that would overwrite a newly ignored file', async () => {
    const root = temporaryDirectory('ignored-conflict');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    git(project, 'init', '-q');
    writeFileSync(path.join(project, 'file.txt'), 'before\n');
    const checkpoint = await captureCheckpoint(project, 'before ignore');
    expect(checkpoint).not.toBeNull();
    writeFileSync(path.join(project, '.gitignore'), 'file.txt\n');
    writeFileSync(path.join(project, 'file.txt'), 'private content\n');

    await expect(restoreCheckpoint(project, checkpoint!.id)).rejects.toThrow();
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('private content\n');
  });

  test('protects ignored children when restoring a file over a directory', async () => {
    const root = temporaryDirectory('ignored-directory-conflict');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    writeFileSync(path.join(project, '.gitignore'), '*.private\n');
    writeFileSync(path.join(project, 'target'), 'before\n');
    const checkpoint = await captureCheckpoint(project, 'before directory');
    expect(checkpoint).not.toBeNull();
    rmSync(path.join(project, 'target'));
    mkdirSync(path.join(project, 'target'));
    writeFileSync(path.join(project, 'target', 'cache.private'), 'private content\n');

    await expect(restoreCheckpoint(project, checkpoint!.id)).rejects.toThrow('excluded from checkpoints');
    expect(readFileSync(path.join(project, 'target', 'cache.private'), 'utf8')).toBe('private content\n');
  });

  test('ignores inherited Git index paths and preserves the source index', async () => {
    const root = temporaryDirectory('inherited-git');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();
    git(project, 'init', '-q');
    writeFileSync(path.join(project, 'tracked.txt'), 'staged\n');
    git(project, 'add', '.');
    const indexPath = path.join(project, '.git', 'index');
    const index = readFileSync(indexPath);
    writeFileSync(path.join(project, 'tracked.txt'), 'unstaged\n');
    const originalIndexPath = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_INDEX_FILE = indexPath;
      const checkpoint = await captureCheckpoint(project, 'inherited index');
      expect(checkpoint).not.toBeNull();
      writeFileSync(path.join(project, 'tracked.txt'), 'agent\n');
      await restoreCheckpoint(project, checkpoint!.id);
      expect(readFileSync(path.join(project, 'tracked.txt'), 'utf8')).toBe('unstaged\n');
      expect(readFileSync(indexPath)).toEqual(index);
    } finally {
      if (originalIndexPath === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = originalIndexPath;
    }
  });

  test('works outside git while leaving ignored files alone', async () => {
    const root = temporaryDirectory('plain-checkpoint');
    const project = path.join(root, 'project');
    mkdirSync(path.join(project, 'ignored'), { recursive: true });
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();

    writeFileSync(path.join(project, '.gitignore'), 'ignored/\n');
    writeFileSync(path.join(project, 'file.txt'), 'before\n');
    writeFileSync(path.join(project, 'ignored', 'cache.txt'), 'cache before\n');
    const checkpoint = await captureCheckpoint(project, 'plain directory');
    expect(checkpoint).not.toBeNull();

    writeFileSync(path.join(project, 'file.txt'), 'after\n');
    writeFileSync(path.join(project, 'ignored', 'cache.txt'), 'cache after\n');
    writeFileSync(path.join(project, 'new.txt'), 'new\n');
    await restoreCheckpoint(project, checkpoint!.id);

    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('before\n');
    expect(readFileSync(path.join(project, 'ignored', 'cache.txt'), 'utf8')).toBe('cache after\n');
    expect(() => readFileSync(path.join(project, 'new.txt'))).toThrow();
  });

  test('rejects malformed identifiers before invoking git and scopes failures by directory', async () => {
    const root = temporaryDirectory('checkpoint-errors');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env.SIRUS_DATA_DIR = path.join(root, 'state');
    enableCheckpoints();

    await expect(restoreCheckpoint(project, '--help')).rejects.toThrow('Invalid checkpoint identifier');
    const missing = path.join(root, 'missing');
    expect(await captureCheckpoint(missing, 'fails')).toBeNull();
    expect(checkpointFailure(missing)).toContain('ENOENT');
    expect(checkpointFailure(project)).toBeNull();
  });
});
