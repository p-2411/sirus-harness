import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { Text, render, renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { activeFileMention, fileSearchDirectory, listMentionFiles, listProjectFiles, matchFileSuggestions } from '../../src/fileSearch';
import { FileMenu, useFileSuggestions } from '../../src/frontend/chat/FileMenu';

const runFile = promisify(execFile);

describe('file mention suggestions', () => {
  test('detects an unfinished token at the cursor, including quoted paths with spaces', () => {
    expect(activeFileMention('Review @', 8)).toEqual({ start: 7, end: 8, query: '' });
    expect(activeFileMention('Review @App', 11)).toEqual({ start: 7, end: 11, query: 'App' });
    expect(activeFileMention('Review @./src/App.ts next', 13)).toEqual({ start: 7, end: 20, query: './src' });
    const quoted = 'Review @"./docs/design not';
    expect(activeFileMention(quoted, quoted.length)).toEqual({ start: 7, end: quoted.length, query: './docs/design not' });
    expect(activeFileMention('Use @"./docs/file name.md" next', 15)?.end).toBe(26);
    expect(activeFileMention("Let's use @App", 14)?.query).toBe('App');
  });

  test('ignores emails, complete mentions, and quoted/code examples', () => {
    for (const input of [
      'user@example', '@./src/App.ts ', '@"./docs/file name.md" ',
      '"try @App', "'try @App", '`try @App', '```ts\nconst @App', '~~~ts\nconst @App', 'text \\@App',
    ]) expect(activeFileMention(input, input.length)).toBeNull();
    const input = '`example` now @App';
    expect(activeFileMention(input, input.length)?.query).toBe('App');
  });

  test('ranks path then basename prefixes then substrings deterministically and limits results', () => {
    expect(matchFileSuggestions(['src/wrapper.ts', 'z/app.ts', 'app/root.ts', 'a/App.ts', 'README.md'], 'app'))
      .toEqual(['app/root.ts', 'a/App.ts', 'z/app.ts', 'src/wrapper.ts']);
    expect(matchFileSuggestions(['src/App.ts', 'docs/src.md'], './src'))
      .toEqual(['src/App.ts', 'docs/src.md']);
    expect(activeFileMention('@src/frontend/', 14)?.query).toBe('src/frontend/');
    expect(matchFileSuggestions(['src/frontend/Chat.tsx', 'src/cli.ts'], 'src/frontend/'))
      .toEqual(['src/frontend/Chat.tsx']);
    expect(matchFileSuggestions(['src/frontend/Chat.tsx'], '/repo/src/frontend/', 50, '/repo'))
      .toEqual(['src/frontend/Chat.tsx']);
    expect(matchFileSuggestions(['src/frontend/Chat.tsx'], '/other/src/frontend/', 50, '/repo')).toEqual([]);
    expect(matchFileSuggestions(Array.from({ length: 70 }, (_, index) => `file${index}.ts`), 'file')).toHaveLength(50);
  });

  test('discovers tracked and untracked files while respecting gitignore and subdirectory scope', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sirus-file-menu-'));
    try {
      await runFile('git', ['init', '-q', directory]);
      await mkdir(path.join(directory, 'src'));
      await writeFile(path.join(directory, '.gitignore'), '*.ignored\n');
      await writeFile(path.join(directory, 'outside.ts'), 'outside');
      await writeFile(path.join(directory, 'src/tracked.ts'), 'tracked');
      await runFile('git', ['add', '--', 'src/tracked.ts'], { cwd: directory });
      await writeFile(path.join(directory, 'src/new file.ts'), 'untracked');
      await writeFile(path.join(directory, 'src/secret.ignored'), 'ignored');
      await writeFile(path.join(directory, 'src/.env'), 'secret');
      await writeFile(path.join(directory, 'src/.env.local'), 'secret');
      await writeFile(path.join(directory, 'src/.env.example'), 'example');
      expect(await listProjectFiles(path.join(directory, 'src')))
        .toEqual(['.env.example', 'new file.ts', 'tracked.ts']);
      expect(await listProjectFiles(directory)).toContain('outside.ts');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('falls back to a bounded file walk when tools are unavailable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sirus-file-fallback-'));
    try {
      await mkdir(path.join(directory, 'node_modules'));
      await mkdir(path.join(directory, 'docs'));
      await writeFile(path.join(directory, 'node_modules/hidden.ts'), 'hidden');
      await writeFile(path.join(directory, '.env'), 'secret');
      await writeFile(path.join(directory, '.env.example'), 'example');
      await writeFile(path.join(directory, 'docs/guide.md'), 'guide');
      const modulePath = path.resolve(import.meta.dir, '../../src/fileSearch.ts');
      const script = `import { listProjectFiles } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await listProjectFiles(process.argv[1])));`;
      const result = await runFile(process.execPath, ['--eval', script, directory], { env: { ...process.env, PATH: '' } });
      expect(JSON.parse(result.stdout)).toEqual(['.env.example', 'docs/guide.md']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('browses explicit sibling and absolute paths without broadening bare mention searches', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sirus-sibling-files-'));
    const project = path.join(directory, 'current');
    const sibling = path.join(directory, 'proj');
    try {
      await mkdir(project);
      await mkdir(sibling);
      await runFile('git', ['init', '-q', sibling]);
      await writeFile(path.join(project, 'local.ts'), 'local');
      await writeFile(path.join(sibling, '.gitignore'), '*.ignored\n');
      await writeFile(path.join(sibling, 'file.tsx'), 'sibling');
      await writeFile(path.join(sibling, 'file.ignored'), 'ignored');
      const query = '../proj/fi';
      expect(fileSearchDirectory(project, query)).toBe(sibling);
      expect(activeFileMention(`@${query}`, query.length + 1)?.query).toBe(query);
      const siblings = await listMentionFiles(project, fileSearchDirectory(project, query), false);
      expect(matchFileSuggestions(siblings, query, 50, project)).toEqual(['../proj/file.tsx']);
      const absoluteQuery = `${sibling}/fi`;
      const absoluteFiles = await listMentionFiles(project, fileSearchDirectory(project, absoluteQuery), true);
      expect(matchFileSuggestions(absoluteFiles, absoluteQuery, 50, project)).toEqual([path.join(sibling, 'file.tsx')]);
      expect(await listMentionFiles(project, fileSearchDirectory(project, ''), false)).toEqual(['local.ts']);
      expect(await listMentionFiles(project, path.join(sibling, 'missing/deeper'), false)).toContain('../proj/file.tsx');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('clips long paths to four rows and keeps the selection and navigation hint', () => {
    const files = Array.from({ length: 7 }, (_, index) => `${index}/very-long-directory/${'nested/'.repeat(10)}file.ts`);
    const output = stripAnsi(renderToString(<FileMenu files={files} selected={3} offset={2} />, { columns: 44 }));
    const lines = output.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('2/very-long-directory/');
    expect(lines[1]).toContain('› 3/very-long-directory/');
    expect(output).not.toContain('6/very-long');
    expect(output).toContain('↑↓ choose · tab attach · esc close');
    expect(lines.every(line => line.length <= 44)).toBe(true);
    expect(stripAnsi(renderToString(<FileMenu files={[]} selected={0} offset={0} error="secret stack trace" />)))
      .not.toContain('secret stack trace');
  });

  test('refreshes on reopening and isolates results when the directory changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sirus-file-hook-'));
    const second = await mkdtemp(path.join(os.tmpdir(), 'sirus-file-hook-'));
    const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    let result: ReturnType<typeof useFileSuggestions> | undefined;
    function Probe({ cwd, input }: { cwd: string; input: string }) {
      result = useFileSuggestions(cwd, input, input.length);
      return <Text>{JSON.stringify(result)}</Text>;
    }
    await writeFile(path.join(directory, 'first.ts'), 'first');
    await writeFile(path.join(second, 'other.ts'), 'second');
    const app = render(<Probe cwd={directory} input="plain text" />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const until = async (condition: () => boolean) => {
      for (let index = 0; index < 100; index++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        await app.waitUntilRenderFlush();
        if (condition()) return;
      }
      throw new Error('File suggestions did not settle');
    };
    try {
      await until(() => result !== undefined);
      expect(result?.mention).toBeNull();
      expect(result?.loading).toBe(false);
      expect(result?.files).toEqual([]);
      app.rerender(<Probe cwd={directory} input="@" />);
      await until(() => result?.files.includes('first.ts') === true);
      app.rerender(<Probe cwd={directory} input="closed " />);
      await until(() => result?.mention === null);
      await writeFile(path.join(directory, 'new.ts'), 'new');
      app.rerender(<Probe cwd={directory} input="@" />);
      await until(() => result?.files.includes('new.ts') === true);
      app.rerender(<Probe cwd={second} input="@" />);
      await until(() => result?.files.includes('other.ts') === true);
      expect(result?.files).toEqual(['other.ts']);
      const relativeOther = path.relative(directory, path.join(second, 'other.ts'));
      app.rerender(<Probe cwd={directory} input={`@${relativeOther.slice(0, -4)}`} />);
      await until(() => result?.files.includes(relativeOther) === true);
      expect(result?.files).toEqual([relativeOther]);
      app.rerender(<Probe cwd={directory} input={`@${path.join(second, 'oth')}`} />);
      await until(() => result?.files.includes(path.join(second, 'other.ts')) === true);
      expect(result?.files).toEqual([path.join(second, 'other.ts')]);
    } finally {
      app.unmount();
      stdin.destroy();
      stdout.destroy();
      await rm(directory, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });
});
