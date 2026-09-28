import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { Box, render } from 'ink';
import stripAnsi from 'strip-ansi';
import Chat from '../../src/frontend/chat/Chat';
import { Session } from '../../src/agent_runtime/session';
import { usageCommandSpec } from '../../src/commands/authentication/commands';
import type { CommandMenuEntry } from '../../src/commands/types';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

let directory: string;
let previousDirectory: string | undefined;
const model = 'test-usage-menu';

beforeEach(() => {
  previousDirectory = process.env.SIRUS_DATA_DIR;
  directory = mkdtempSync(join(tmpdir(), 'sirus-usage-menu-'));
  process.env.SIRUS_DATA_DIR = directory;
});

afterEach(() => {
  mock.restore();
  unbindRuntime(model);
  if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

function screen(session: Session) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let frame = '';
  stdout.on('data', chunk => { frame = stripAnsi(chunk.toString()); });
  const app = render(<Box width={120} height={40}><Chat currSession={session} /></Box>, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  return {
    frame: () => frame,
    flush,
    async press(key: string) {
      await flush(); stdin.write(key);
      // Ink waits briefly to distinguish Escape from a longer key sequence.
      if (key === '\x1b') await new Promise(resolve => setTimeout(resolve, 60));
      await flush();
    },
    async close() {
      app.unmount();
      await app.waitUntilExit();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

const usageRows: CommandMenuEntry[] = [
  { type: 'heading', key: 'usage', label: 'Usage' },
  { type: 'info', key: 'codex', label: 'Codex · 5h 70% left · 7d 90% left' },
  { type: 'item', key: 'refresh', label: 'Refresh', command: '/usage' },
];

test('/usage loads a menu, refreshes it, and never invokes the run handler', async () => {
  let finish!: (items: CommandMenuEntry[]) => void;
  const menu = spyOn(usageCommandSpec, 'menu').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const run = spyOn(usageCommandSpec, 'run').mockReturnValue(undefined);
  const session = new Session({ directory, model });
  const chat = screen(session);
  try {
    await chat.press('/usage'); await chat.press('\r');
    expect(chat.frame()).toContain('Loading…');
    expect(chat.frame()).toContain('esc closes');
    expect(chat.frame()).not.toContain('enter to select');
    finish(usageRows); await chat.flush();
    expect(chat.frame()).toContain('Codex · 5h 70% left · 7d 90% left');
    expect(chat.frame()).toContain('› Refresh');
    await chat.press('\r');
    expect(menu).toHaveBeenCalledTimes(2);
    expect(chat.frame()).toContain('Loading…');
    finish(usageRows); await chat.flush();
    await chat.press('\x1b');
    expect(chat.frame()).not.toContain('› Refresh');
    expect(run).not.toHaveBeenCalled();
    expect(session.getMessages()).toHaveLength(0);
  } finally { await chat.close(); await session.dispose(); }
});

test('Escape cancels a pending usage menu without interrupting a running turn or showing late results', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  bindScriptedRuntime(model, async (_input, emit) => { emit({ type: 'text', text: 'Working' }); await gate; });
  let signal!: AbortSignal;
  let finish!: (items: CommandMenuEntry[]) => void;
  spyOn(usageCommandSpec, 'menu').mockImplementation((_args, _session, requestSignal) => {
    signal = requestSignal!;
    return new Promise(resolve => { finish = resolve; });
  });
  const session = new Session({ directory, model });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Keep working' }] });
  const cancel = spyOn(session, 'cancel');
  const chat = screen(session);
  try {
    await chat.press('/usage'); await chat.press('\r');
    expect(chat.frame()).toContain('Loading…');
    expect(session.getStatus()).toBe('working');
    await chat.press('\x1b');
    expect(signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe('working');
    finish(usageRows); await chat.flush();
    expect(chat.frame()).not.toContain('› Refresh');
    expect(chat.frame()).not.toContain('5h 70% left');
  } finally { release(); await turn; await chat.close(); await session.dispose(); }
});

test('a failed menu stays dismissible and unmounting cancels its next request', async () => {
  let signal!: AbortSignal;
  const menu = spyOn(usageCommandSpec, 'menu').mockImplementation(() => Promise.reject(new Error('Usage could not be loaded')));
  const session = new Session({ directory, model });
  const chat = screen(session);
  let closed = false;
  try {
    await chat.press('/usage'); await chat.press('\r');
    expect(chat.frame()).toContain('Usage could not be loaded');
    await chat.press('\x1b');
    menu.mockImplementation((_args, _session, requestSignal) => {
      signal = requestSignal!;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    await chat.press('/usage'); await chat.press('\r');
    await chat.close(); closed = true;
    expect(signal.aborted).toBe(true);
  } finally { if (!closed) await chat.close(); await session.dispose(); }
});
