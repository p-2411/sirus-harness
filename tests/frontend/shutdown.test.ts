import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import stripAnsi from 'strip-ansi';

async function until(check: () => boolean, description: string, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  if (!check()) throw new Error(`Timed out waiting for ${description}`);
}

test.skipIf(process.platform === 'win32').each(['idle', 'adapter startup', 'heartbeat'])(
  'Ctrl+C restores the terminal and exits the process during %s', async scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-exit-test-'));
    const root = resolve(import.meta.dir, '../..');
    const pidFile = join(directory, 'adapter.pid');
    let heartbeatReceived = false;
    const server = scenario === 'heartbeat' ? Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => { heartbeatReceived = true; return new Promise<Response>(() => {}); },
    }) : undefined;
    const entry = join(directory, 'entry.ts');
    writeFileSync(entry, `
      import { spyOn } from 'bun:test';
      import * as updater from ${JSON.stringify(join(root, 'src/updater'))};
      import * as launch from ${JSON.stringify(join(root, 'src/agent_runtime/runtime/launch'))};
      import { openSettings } from ${JSON.stringify(join(root, 'src/persistence/settings'))};
      if (${scenario === 'adapter startup'}) openSettings().set({ providerSources: {
        claude: [{ id: 'first', type: 'api', key: 'test-key' }, { id: 'fallback', type: 'api', key: 'fallback-key' }],
      } });
      spyOn(updater, 'checkSirusUpdate').mockResolvedValue({ updateAvailable: false, currentVersion: '1', latestVersion: '1' });
      spyOn(launch, 'launchFor').mockImplementation(options => ({
        command: process.execPath,
        args: ['-e', ${JSON.stringify(`
          import { writeFileSync } from 'node:fs';
          process.stdin.on('data', () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); });
          setInterval(() => {}, 1000);
        `)}],
        env: options.env, mode: 'ask', session: () => ({ mcpServers: [] }), forkNeedsResume: false,
      }));
      const { runCli } = await import(${JSON.stringify(join(root, 'src/cli'))});
      await runCli([]);
    `);
    let output = '';
    const child = Bun.spawn([process.execPath, entry], {
      cwd: directory,
      env: { ...process.env, CI: undefined, TERM: 'xterm-256color', SIRUS_DATA_DIR: directory,
        ANTHROPIC_API: scenario === 'adapter startup' ? 'test-key' : '', OPENAI_SECRET: '',
        SIRUS_HEARTBEAT_URL: server ? `http://127.0.0.1:${server.port}/heartbeat` : '',
      },
      terminal: { cols: 100, rows: 30, data: (_terminal, data) => { output += Buffer.from(data).toString(); } },
    });
    let exited = false;
    void child.exited.then(() => { exited = true; });
    try {
      await until(() => output.includes('message sirus') && output.includes('\x1b[?2004h'), 'input to render');
      if (scenario === 'adapter startup') await until(() => existsSync(pidFile), 'adapter to start');
      if (scenario === 'heartbeat') await until(() => heartbeatReceived, 'heartbeat request');
      child.terminal!.write('draft');
      await until(() => stripAnsi(output).includes('› draft'), 'input handler to accept typing');
      child.terminal!.write('\x03');
      await until(() => output.includes('ctrl+c again to exit'), 'exit hint');
      expect(exited).toBe(false);
      child.terminal!.write('\x03');
      await until(() => output.includes('\x1b[?1049l'), 'terminal restoration');
      await until(() => exited, 'CLI process to exit');
      expect(await child.exited).toBe(0);
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        await until(() => {
          try { process.kill(pid, 0); return false; }
          catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        }, 'adapter process to exit');
      }
    } catch (error) {
      throw new Error(`${String(error)}\n${output.slice(-2_000)}`);
    } finally {
      child.kill();
      await child.exited;
      child.terminal?.close();
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already stopped. */ }
      }
      server?.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000,
);
