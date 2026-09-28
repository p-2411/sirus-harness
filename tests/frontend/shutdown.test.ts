import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import stripAnsi from 'strip-ansi';

async function until(check: () => boolean, events: EventEmitter, description: string, poll = false): Promise<void> {
  if (check()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (poller) clearInterval(poller);
      events.off('change', onChange);
      reject(new Error(`Timed out waiting for ${description}`));
    }, 8_000);
    const poller = poll ? setInterval(() => events.emit('change'), 25) : undefined;
    const onChange = () => {
      if (!check()) return;
      clearTimeout(timeout);
      if (poller) clearInterval(poller);
      events.off('change', onChange);
      resolve();
    };
    events.on('change', onChange);
    onChange();
  });
}

test.skipIf(process.platform === 'win32').each(['idle', 'adapter startup', 'heartbeat'])(
  'Ctrl+C restores the terminal and exits the process during %s', async scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-exit-test-'));
    const root = resolve(import.meta.dir, '../..');
    const pidFile = join(directory, 'adapter.pid');
    const events = new EventEmitter();
    let heartbeatReceived = false;
    const server = scenario === 'heartbeat' ? Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => { heartbeatReceived = true; events.emit('change'); return new Promise<Response>(() => {}); },
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
    let sendSecondOnHint = false;
    let secondSent = false;
    let exitedAtHint = false;
    let exited = false;
    const child = Bun.spawn([process.execPath, entry], {
      cwd: directory,
      env: { ...process.env, CI: undefined, TERM: 'xterm-256color', SIRUS_DATA_DIR: directory,
        ANTHROPIC_API: scenario === 'adapter startup' ? 'test-key' : '', OPENAI_SECRET: '',
        SIRUS_HEARTBEAT_URL: server ? `http://127.0.0.1:${server.port}/heartbeat` : '',
      },
      terminal: { cols: 100, rows: 30, data: (_terminal, data) => {
        output += Buffer.from(data).toString();
        if (sendSecondOnHint && !secondSent && output.includes('ctrl+c again to exit')) {
          exitedAtHint = exited;
          secondSent = true;
          _terminal.write('\x03');
        }
        events.emit('change');
      } },
    });
    void child.exited.then(() => { exited = true; events.emit('change'); });
    try {
      await until(() => output.includes('message sirus') && output.includes('\x1b[?2004h'), events, 'input to render');
      if (scenario === 'adapter startup') await until(() => existsSync(pidFile), events, 'adapter to start', true);
      if (scenario === 'heartbeat') await until(() => heartbeatReceived, events, 'heartbeat request');
      child.terminal!.write('draft');
      await until(() => stripAnsi(output).includes('› draft'), events, 'input handler to accept typing');
      sendSecondOnHint = true;
      child.terminal!.write('\x03');
      await until(() => secondSent, events, 'exit hint and second Ctrl+C');
      expect(exitedAtHint).toBe(false);
      await until(() => output.includes('\x1b[?1049l'), events, 'terminal restoration');
      await until(() => exited, events, 'CLI process to exit');
      expect(await child.exited).toBe(0);
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        await until(() => {
          try { process.kill(pid, 0); return false; }
          catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        }, events, 'adapter process to exit', true);
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
  }, 40_000,
);
