import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkSirusUpdate,
  isNewerVersion,
  parsePublishedVersion,
  updateSirus,
  type UpdateCommandRunner,
} from '../src/updater';

const temporaryDirectories: string[] = [];

function packageRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sirus-updater-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('parsePublishedVersion', () => {
  test('accepts npm JSON and plain semver output', () => {
    expect(parsePublishedVersion('"1.2.3"\n')).toBe('1.2.3');
    expect(parsePublishedVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
  });

  test('rejects output that cannot safely become an npm package specifier', () => {
    expect(() => parsePublishedVersion('latest')).toThrow(/invalid Sirus version/);
    expect(() => parsePublishedVersion('1.2.3; echo nope')).toThrow(/invalid Sirus version/);
  });
});

describe('update availability', () => {
  test('compares stable and prerelease versions', () => {
    expect(isNewerVersion('0.1.0', '0.0.3')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.0.0-beta.10', '1.0.0-beta.2')).toBe(true);
    expect(isNewerVersion('0.0.3', '0.0.3')).toBe(false);
    expect(isNewerVersion('0.0.3', '0.1.0')).toBe(false);
  });

  test('checks npm without installing anything', async () => {
    const calls: string[][] = [];
    const result = await checkSirusUpdate(undefined, {
      currentVersion: '0.0.3',
      run: async args => {
        calls.push([...args]);
        return { code: 0, stdout: '"0.1.0"', stderr: '' };
      },
    });
    expect(result).toEqual({
      updateAvailable: true,
      currentVersion: '0.0.3',
      latestVersion: '0.1.0',
    });
    expect(calls).toEqual([['view', 'sirus-harness', 'version', '--json']]);
  });
});

describe('updateSirus', () => {
  test('reports an installation that is already current without reinstalling', async () => {
    const calls: string[][] = [];
    const run: UpdateCommandRunner = async args => {
      calls.push([...args]);
      return { code: 0, stdout: '"0.0.3"\n', stderr: '' };
    };
    const notices: string[] = [];

    await expect(updateSirus(text => notices.push(text), undefined, {
      currentVersion: '0.0.3',
      packageRoot: packageRoot(),
      run,
    })).resolves.toEqual({
      updated: false,
      currentVersion: '0.0.3',
      latestVersion: '0.0.3',
    });
    expect(calls).toEqual([['view', 'sirus-harness', 'version', '--json']]);
    expect(notices).toEqual(['Checking npm for a newer Sirus release…']);
  });

  test('installs the exact published version globally', async () => {
    const calls: string[][] = [];
    const run: UpdateCommandRunner = async args => {
      calls.push([...args]);
      return calls.length === 1
        ? { code: 0, stdout: '"0.1.0"\n', stderr: '' }
        : { code: 0, stdout: 'updated 1 package', stderr: '' };
    };
    const notices: string[] = [];

    await expect(updateSirus(text => notices.push(text), undefined, {
      currentVersion: '0.0.3',
      packageRoot: packageRoot(),
      run,
    })).resolves.toEqual({
      updated: true,
      currentVersion: '0.0.3',
      latestVersion: '0.1.0',
    });
    expect(calls).toEqual([
      ['view', 'sirus-harness', 'version', '--json'],
      ['install', '--global', 'sirus-harness@0.1.0', '--no-fund', '--no-audit'],
    ]);
    expect(notices).toEqual([
      'Checking npm for a newer Sirus release…',
      'Updating Sirus 0.0.3 → 0.1.0…',
    ]);
  });

  test('does not mutate a source checkout', async () => {
    const root = packageRoot();
    mkdirSync(join(root, '.git'));
    let ran = false;

    await expect(updateSirus(undefined, undefined, {
      packageRoot: root,
      run: async () => {
        ran = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    })).rejects.toThrow(/source checkout.*git pull/i);
    expect(ran).toBe(false);
  });

  test('surfaces npm lookup and install errors', async () => {
    await expect(updateSirus(undefined, undefined, {
      packageRoot: packageRoot(),
      run: async () => ({ code: 1, stdout: '', stderr: 'registry unavailable' }),
    })).rejects.toThrow('Could not check for updates: registry unavailable');

    let call = 0;
    await expect(updateSirus(undefined, undefined, {
      currentVersion: '0.0.3',
      packageRoot: packageRoot(),
      run: async () => ++call === 1
        ? { code: 0, stdout: '"0.1.0"', stderr: '' }
        : { code: 1, stdout: '', stderr: 'permission denied' },
    })).rejects.toThrow('Sirus update failed: permission denied');
  });
});
