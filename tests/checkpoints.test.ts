import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  captureCheckpoint,
  checkpointFailure,
  contentFingerprint,
  previewCheckpoint,
  type AgentFileChange,
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

afterEach(() => {
  enableCheckpoints(false);
  if (originalDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = originalDataDirectory;
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function change(file: string, before: string | null, after: string | null): AgentFileChange {
  return { path: file, before: before === null ? null : contentFingerprint(before), after: after === null ? null : contentFingerprint(after) };
}

function setup(name: string): string {
  const root = temporaryDirectory(name);
  const project = path.join(root, 'project');
  mkdirSync(project);
  process.env.SIRUS_DATA_DIR = path.join(root, 'state');
  enableCheckpoints();
  return project;
}

describe('worktree checkpoints', () => {
  test('previews and restores only proven agent changes, preserving user files and the source index', async () => {
    const project = setup('checkpoint');
    git(project, 'init', '-q');
    git(project, 'config', 'user.name', 'Test');
    git(project, 'config', 'user.email', 'test@example.com');
    writeFileSync(path.join(project, 'file.txt'), 'committed');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'initial');
    const originalIndex = readFileSync(path.join(project, '.git', 'index'));
    const originalHead = git(project, 'rev-parse', 'HEAD');
    writeFileSync(path.join(project, 'file.txt'), 'user draft');
    writeFileSync(path.join(project, 'user.txt'), 'user before');
    writeFileSync(path.join(project, 'deleted.txt'), 'delete me');
    const checkpoint = (await captureCheckpoint(project, 'before agent'))!;
    writeFileSync(path.join(project, 'file.txt'), 'agent');
    writeFileSync(path.join(project, 'user.txt'), 'user after');
    writeFileSync(path.join(project, 'added.txt'), 'created');
    rmSync(path.join(project, 'deleted.txt'));
    const changes = [change('file.txt', 'user draft', 'agent'), change('added.txt', null, 'created'), change('deleted.txt', 'delete me', null)];
    const preview = await previewCheckpoint(project, checkpoint.id, changes);
    expect(preview).toEqual({ restored: ['file.txt', 'deleted.txt'], removed: ['added.txt'], conflicts: [] });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('agent');
    expect(await restoreCheckpoint(project, checkpoint.id, changes)).toEqual(preview);
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user draft');
    expect(readFileSync(path.join(project, 'user.txt'), 'utf8')).toBe('user after');
    expect(readFileSync(path.join(project, 'deleted.txt'), 'utf8')).toBe('delete me');
    expect(() => readFileSync(path.join(project, 'added.txt'))).toThrow();
    expect(git(project, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(path.join(project, '.git', 'index'))).toEqual(originalIndex);
  });

  test('preserves user changes made after the preview and between agent edits', async () => {
    const project = setup('conflicts');
    writeFileSync(path.join(project, 'after.txt'), 'before');
    writeFileSync(path.join(project, 'between.txt'), 'before');
    const checkpoint = (await captureCheckpoint(project, 'before agent'))!;
    writeFileSync(path.join(project, 'after.txt'), 'agent');
    writeFileSync(path.join(project, 'between.txt'), 'agent two');
    const changes = [change('after.txt', 'before', 'agent'), change('between.txt', 'before', 'agent one'), change('between.txt', 'user interleaving', 'agent two')];
    expect((await previewCheckpoint(project, checkpoint.id, changes)).restored).toEqual(['after.txt']);
    writeFileSync(path.join(project, 'after.txt'), 'user after preview');
    const result = await restoreCheckpoint(project, checkpoint.id, changes);
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual(['after.txt', 'between.txt']);
    expect(readFileSync(path.join(project, 'after.txt'), 'utf8')).toBe('user after preview');
    expect(readFileSync(path.join(project, 'between.txt'), 'utf8')).toBe('agent two');
  });

  test('never restores unproven files from older checkpoints', async () => {
    const project = setup('legacy');
    writeFileSync(path.join(project, 'file.txt'), 'before');
    const checkpoint = (await captureCheckpoint(project, 'legacy checkpoint'))!;
    writeFileSync(path.join(project, 'file.txt'), 'user edit');
    expect(await restoreCheckpoint(project, checkpoint.id)).toEqual({ restored: [], removed: [], conflicts: [] });
    expect(readFileSync(path.join(project, 'file.txt'), 'utf8')).toBe('user edit');
  });

  test('refuses symlinks, directory replacements and paths outside the project', async () => {
    const project = setup('safe-paths');
    writeFileSync(path.join(project, 'target'), 'before');
    writeFileSync(path.join(project, 'link'), 'before');
    const checkpoint = (await captureCheckpoint(project, 'before'))!;
    rmSync(path.join(project, 'target'));
    mkdirSync(path.join(project, 'target'));
    writeFileSync(path.join(project, 'target', 'private'), 'user');
    rmSync(path.join(project, 'link'));
    const outside = path.join(project, '..', 'outside');
    writeFileSync(outside, 'private');
    symlinkSync(outside, path.join(project, 'link'));
    const result = await restoreCheckpoint(project, checkpoint.id, [change('target', 'before', 'agent'), change('link', 'before', 'private'), change('../outside', null, 'private')]);
    expect(result.conflicts).toEqual(['target', 'link']);
    expect(readFileSync(outside, 'utf8')).toBe('private');
    expect(readFileSync(path.join(project, 'target', 'private'), 'utf8')).toBe('user');
  });

  test('a user reset to an earlier agent result is a conflict', async () => {
    const project = setup('historical-state');
    writeFileSync(path.join(project, 'file'), 'A');
    const checkpoint = (await captureCheckpoint(project, 'before'))!;
    writeFileSync(path.join(project, 'file'), 'B');
    const result = await restoreCheckpoint(project, checkpoint.id, [change('file', 'A', 'B'), change('file', 'B', 'C')]);
    expect(result.conflicts).toEqual(['file']);
    expect(readFileSync(path.join(project, 'file'), 'utf8')).toBe('B');
  });

  test('restoring a hardlink replaces only the project path', async () => {
    const project = setup('hardlinks');
    const file = path.join(project, 'file');
    writeFileSync(file, 'A');
    const checkpoint = (await captureCheckpoint(project, 'before'))!;
    writeFileSync(file, 'B');
    const outside = path.join(project, '..', 'outside');
    linkSync(file, outside);
    expect((await restoreCheckpoint(project, checkpoint.id, [change('file', 'A', 'B')])).restored).toEqual(['file']);
    expect(readFileSync(file, 'utf8')).toBe('A');
    expect(readFileSync(outside, 'utf8')).toBe('B');
  });

  test('refuses a project root redirected through a symlink', async () => {
    const project = setup('root-symlink');
    writeFileSync(path.join(project, 'file'), 'A');
    const checkpoint = (await captureCheckpoint(project, 'before'))!;
    const outside = path.join(project, '..', 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'file'), 'B');
    renameSync(project, `${project}-original`);
    symlinkSync(outside, project);
    await expect(restoreCheckpoint(project, checkpoint.id, [change('file', 'A', 'B')])).rejects.toThrow('symlink');
    expect(readFileSync(path.join(outside, 'file'), 'utf8')).toBe('B');
  });

  test('ignores inherited Git index paths and preserves the source index', async () => {
    const project = setup('inherited-git');
    git(project, 'init', '-q');
    writeFileSync(path.join(project, 'tracked.txt'), 'staged');
    git(project, 'add', '.');
    const indexPath = path.join(project, '.git', 'index');
    const index = readFileSync(indexPath);
    writeFileSync(path.join(project, 'tracked.txt'), 'unstaged');
    const originalIndexPath = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_INDEX_FILE = indexPath;
      const checkpoint = (await captureCheckpoint(project, 'inherited index'))!;
      writeFileSync(path.join(project, 'tracked.txt'), 'agent');
      await restoreCheckpoint(project, checkpoint.id, [change('tracked.txt', 'unstaged', 'agent')]);
      expect(readFileSync(path.join(project, 'tracked.txt'), 'utf8')).toBe('unstaged');
      expect(readFileSync(indexPath)).toEqual(index);
    } finally {
      if (originalIndexPath === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = originalIndexPath;
    }
  });

  test('rejects malformed identifiers and scopes capture failures by directory', async () => {
    const project = setup('errors');
    await expect(restoreCheckpoint(project, '--help')).rejects.toThrow('Invalid checkpoint identifier');
    const missing = path.join(project, 'missing');
    expect(await captureCheckpoint(missing, 'fails')).toBeNull();
    expect(checkpointFailure(missing)).toContain('ENOENT');
    expect(checkpointFailure(project)).toBeNull();
  });
});
