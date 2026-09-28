import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import * as updater from '../../src/updater';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Session } from '../../src/agent_runtime/session';
import { DEFAULT_MODEL } from '../../src/agent_runtime/providers/catalog';
import * as naming from '../../src/agent_runtime/session/naming';
import { providerFor } from '../../src/agent_runtime/providers';
import { bindScriptedRuntime, textTurn, unbindRuntime } from '../support/runtime';
import { isAbortError } from '../../src/abort';
import App, { createWorkspace, nextSessionName, startSession } from '../../src/frontend/app';
import { changeModel } from '../../src/commands/agents/behavior';
import { rememberListedModels } from '../../src/agent_runtime/providers/catalog';
import * as sessionFile from '../../src/persistence/sessions';
import { deleteSessionSnapshot, loadSessionRevision, loadSessionSnapshot, loadSessionSnapshots, saveSessionSnapshot, saveSessionSnapshots } from '../../src/persistence/sessions';

describe('app workspace startup', () => {
  let settingsDirectory: string;
  let previousDirectory: string | undefined;
  beforeEach(() => {
    settingsDirectory = mkdtempSync(join(tmpdir(), 'sirus-workspace-'));
    previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = settingsDirectory;
    rememberListedModels('gpt', [{ id: 'gpt-6-sol', description: 'Sol' }]);
    rememberListedModels('claude', [{ id: 'claude-haiku-4-5', description: 'Haiku' }]);
  });
  afterEach(() => {
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
    rmSync(settingsDirectory, { recursive: true, force: true });
  });
  test.each([
    ['legacy', '\u0003'],
    ['Kitty', '\u001b[99;5u'],
    ['Kitty press', '\u001b[99;5:1u'],
    ['Kitty repeat', '\u001b[99;5:2u'],
  ])('%s Ctrl+C exits only on the second press', async (_name, sequence) => {
    const update = spyOn(updater, 'checkSirusUpdate').mockResolvedValue({
      updateAvailable: false, currentVersion: '1.0.0', latestVersion: '1.0.0',
    });
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode() {}, ref() {}, unref() {},
    });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    stdout.resume();
    const app = render(createElement(App, { launchDirectory: settingsDirectory }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    let exited = false;
    const exit = app.waitUntilExit().then(() => { exited = true; });
    const flush = async () => {
      await new Promise(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
    };
    try {
      await flush();
      // Plain typing, other shortcuts, and releasing Ctrl+C must not quit.
      for (const input of ['c', '\u001b[99u', '\u0015', '\u001b[99;5:3u']) {
        stdin.write(input);
        await flush();
        expect(exited).toBe(false);
      }
      stdin.write(sequence);
      await flush();
      expect(exited).toBe(false);
      stdin.write(sequence);
      await flush();
      expect(exited).toBe(true);
      await exit;
    } finally {
      app.unmount();
      stdin.destroy();
      stdout.destroy();
      update.mockRestore();
    }
  });

  test('new sessions keep the saved or default model through the first prompt', async () => {
    const name = spyOn(naming, 'generateSessionName').mockResolvedValue(null);
    const preferred = 'claude-fable-5-1';
    providerFor('gpt').sources.addApiKey('test-openai-key');
    providerFor('claude').sources.addApiKey('test-anthropic-key');
    const fallbackRuntime = bindScriptedRuntime(DEFAULT_MODEL, textTurn('Done'));
    const preferredRuntime = bindScriptedRuntime(preferred, textTurn('Done'));
    try {
      for (const preference of [null, preferred]) {
        const { draftSession } = createWorkspace({ sessions: [], selectedSessionId: null }, settingsDirectory, preference);
        const model = preference ?? DEFAULT_MODEL;
        expect(draftSession.getModel()).toBe(model);
        await draftSession.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Review this project' }] });
        expect(draftSession.getModel()).toBe(model);
        expect(draftSession.toSnapshot().defaultModel.model).toBe(model);
      }
      expect(fallbackRuntime.starts).toHaveLength(1);
      expect(preferredRuntime.starts).toHaveLength(1);
    } finally {
      name.mockRestore();
      unbindRuntime(DEFAULT_MODEL);
      unbindRuntime(preferred);
    }
  });

  test('menus keep pane widths fixed and Ctrl+B leaves the dots in place', async () => {
    const sessions = ['First', 'Second'].map(name => {
      const session = new Session({ name, directory: `/projects/${name}`, autoNamePending: true });
      session.append({ role: 'user', content: [{ type: 'text', text: 'Existing history' }] });
      return session;
    });
    saveSessionSnapshots(sessions.filter(s => !s.isEmpty()).map(s => s.toSnapshot()), null);
    const update = spyOn(updater, 'checkSirusUpdate').mockResolvedValue({
      updateAvailable: true, currentVersion: '1.0.0', latestVersion: '1.2.9',
    });
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode() {}, ref() {}, unref() {},
    });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 60 });
    let output = '';
    stdout.on('data', chunk => {
      const frame = stripAnsi(chunk.toString());
      if (frame.trim()) output = frame;
    });
    const app = render(createElement(App, { launchDirectory: '/projects/current' }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const flush = async () => {
      await new Promise(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
    };
    const type = async (input: string) => {
      stdin.write(input);
      if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
      await flush();
    };
    const dots = () => output.split('\n').flatMap((line, row) =>
      /^[ ]○/.test(line) ? [{ row, column: line.indexOf('○') }] : []);
    const expectPanes = (sidebarWidth: number) => {
      const lines = output.trimEnd().split('\n');
      expect(lines.length).toBe(60);
      for (const line of lines) {
        expect(['│', '├']).toContain(line[sidebarWidth - 1]!);
        expect(stringWidth(line)).toBeLessThanOrEqual(stdout.columns);
      }
      const rule = lines.find(line => line.includes('├'))!;
      expect(stringWidth(rule)).toBe(stdout.columns);
      const inputBorder = lines.find(line => line.includes('╭'))!;
      expect(stringWidth(inputBorder)).toBe(stdout.columns - 1);
    };
    try {
      await flush();
      expectPanes(26);
      expect(output).toContain('Sirus 1.2.9 available · /update');
      const originalDots = dots();
      expect(originalDots).toHaveLength(2);
      for (const command of ['/help', '/login', '/model']) {
        await type(command);
        expectPanes(26);
        await type('\r');
        expectPanes(26);
        expect(dots()).toEqual(originalDots);
        await type('\u001b');
      }
      await type('/model');
      await type('\r');
      await type('\u0002'); // Ctrl+B, including while a menu is open.
      expectPanes(4);
      expect(output).toContain('Sirus 1.2.9 available · /update');
      expect(dots()).toEqual(originalDots);
      for (const { row } of originalDots) {
        expect(output.split('\n')[row]!.slice(0, 4)).toBe(' ○ │');
      }
      expect(output).toContain('Anthropic');
      expect(output).not.toContain('First');
      expect(output).not.toContain('Second');
      expect(output).not.toContain('new session');
      await type('\u001b');
      await type('unfinished draft');
      await type('\u0002');
      expectPanes(26);
      expect(dots()).toEqual(originalDots);
      expect(output).toContain('unfinished draft');
      stdout.columns = 120;
      stdout.emit('resize');
      await flush();
      expectPanes(26);
      await type('\u0002');
      expectPanes(4);
      expect(dots()).toEqual(originalDots);
      await type('\u0006'); // Ctrl+F expands the sidebar and opens management.
      expect(output).toContain('search: ▌__');
      expect(output).toContain('Manage sessions in the sidebar');
      expect(output).not.toContain('manage session');
      await type('Second');
      expect(output).not.toContain('First');
      expect(output).toContain('Second');
      await type('\u001b');
      expectPanes(26);
      expect(output).toContain('unfinished draft');
      expect(output).toMatch(/manage session\s+ctrl\+f/);
      expect(output).not.toContain('search:');
      expect(dots()).toEqual(originalDots);
      await type('\u0002');
      expectPanes(4);
      // The sidebar remains interactive when collapsed.
      await type('\u001b[1;3B'); // Option+Down switches to a saved session.
      expect(output).toContain('Existing history');
      expectPanes(4);
      await type('\u000e'); // Ctrl+N focuses the existing draft.
      expect(dots()).toHaveLength(2);
      await type('\u000e');
      expect(dots()).toHaveLength(2);
      expectPanes(4);
    } finally {
      app.unmount();
      stdin.destroy();
      stdout.destroy();
      update.mockRestore();
    }
  });
  test('reloads inactive sessions, preserves other files, and never resurrects an external deletion', async () => {
    const first = new Session({ id: 'external-first', name: 'Original title', directory: settingsDirectory,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'First history' }] }] }).toSnapshot();
    const second = { ...first, id: 'external-second', name: 'Untouched title' };
    saveSessionSnapshots([first, second], null);
    const revision = loadSessionRevision(second.id);
    const update = spyOn(updater, 'checkSirusUpdate').mockResolvedValue({
      updateAvailable: false, currentVersion: '1.0.0', latestVersion: '1.0.0',
    });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 });
    let output = '';
    stdout.on('data', chunk => { const frame = stripAnsi(chunk.toString()); if (frame.trim()) output = frame; });
    const app = render(createElement(App, { launchDirectory: settingsDirectory }), {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await app.waitUntilRenderFlush(); };
    try {
      await flush();
      expect(loadSessionRevision(second.id)).toBe(revision);
      saveSessionSnapshot({ ...first, name: 'External title', inputContent: 'External draft' });
      await new Promise(resolve => setTimeout(resolve, 1650));
      await flush();
      expect(output).toContain('External title');
      expect(output).not.toContain('Original title');
      expect(loadSessionRevision(second.id)).toBe(revision);
      // Switch before another poll, which also exercises the direct disk read.
      saveSessionSnapshot({ ...first, name: 'Newest title', inputContent: 'Newest draft' });
      stdin.write('\u001b[1;3B');
      await flush();
      expect(output).toContain('Newest draft');
      expect(deleteSessionSnapshot(first.id)).toBe(true);
      stdin.write(' additional text');
      await flush();
      expect(loadSessionSnapshot(first.id)).toBeNull();
      stdin.write('\u000e');
      await flush();
      await new Promise(resolve => setTimeout(resolve, 1650));
      await flush();
      expect(loadSessionSnapshots().snapshots.map(snapshot => snapshot.id)).toEqual([second.id]);
      expect(loadSessionRevision(second.id)).toBe(revision);
    } finally {
      app.unmount(); stdin.destroy(); stdout.destroy(); update.mockRestore();
    }
    expect(loadSessionSnapshot(first.id)).toBeNull();
  });

  test.each(['exit', 'cleanup'])('%s saves a final stream chunk before its throttled notification', async finalSave => {
    const first = new Session({ id: 'streaming-final', name: 'Streaming', directory: settingsDirectory,
      model: DEFAULT_MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'Existing history' }] }] }).toSnapshot();
    const second = { ...first, id: 'untouched-final', name: 'Untouched' };
    saveSessionSnapshots([first, second], null);
    const untouchedRevision = loadSessionRevision(second.id);
    const originalRestore = Session.fromSnapshot;
    let restored!: Session;
    const restore = spyOn(Session, 'fromSnapshot').mockImplementation(snapshot => {
      const session = originalRestore(snapshot);
      if (snapshot.id === first.id) restored = session;
      return session;
    });
    const update = spyOn(updater, 'checkSirusUpdate').mockResolvedValue({
      updateAvailable: false, currentVersion: '1.0.0', latestVersion: '1.0.0',
    });
    providerFor('gpt').sources.addApiKey('test-openai-key');
    let emitChunk: ((text: string) => void) | undefined;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const binding = bindScriptedRuntime(DEFAULT_MODEL, async (_input, emit) => {
      emitChunk = text => emit({ type: 'text', text });
      await gate;
    });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    stdout.resume();
    const previousExitListeners = new Set(process.listeners('exit'));
    const app = render(createElement(App, { launchDirectory: settingsDirectory }), {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    let turn: ReturnType<Session['sendMessage']> | undefined;
    try {
      await new Promise(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      turn = restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Stream a reply' }] }).catch(error => {
        if (!isAbortError(error)) throw error;
        return restored.getMessages();
      });
      const deadline = Date.now() + 2000;
      while (!emitChunk && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(emitChunk).toBeDefined();
      emitChunk!('Saved chunk');
      await new Promise(resolve => setTimeout(resolve, 75));
      // Force a notification now, then append a chunk inside the 50 ms window.
      restored.setInputContent('draft');
      const version = restored.getVersion();
      emitChunk!(' and final chunk');
      expect(restored.getVersion()).toBe(version);
      const text = () => loadSessionSnapshot(first.id)!.messages.flatMap(message =>
        message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
      expect(text()).not.toContain('final chunk');
      if (finalSave === 'exit') {
        const listener = process.listeners('exit').find(candidate =>
          !previousExitListeners.has(candidate) && candidate.name === 'persistOnExit');
        expect(listener).toBeDefined();
        listener!(0);
      } else {
        app.unmount();
      }
      expect(text()).toContain('Saved chunk and final chunk');
      expect(loadSessionRevision(second.id)).toBe(untouchedRevision);
    } finally {
      app.unmount();
      release();
      await turn;
      expect(binding.runtimes.every(runtime => runtime.disposed)).toBe(true);
      await restored?.dispose();
      restore.mockRestore(); update.mockRestore(); unbindRuntime(DEFAULT_MODEL);
      stdin.destroy(); stdout.destroy();
    }
  });

  test('gathers a burst of session changes into one save, and saves what is left on unmount', async () => {
    const saved = new Session({ id: 'burst', name: 'Burst', directory: settingsDirectory,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Existing history' }] }] }).toSnapshot();
    saveSessionSnapshots([saved], null);
    const update = spyOn(updater, 'checkSirusUpdate').mockResolvedValue({
      updateAvailable: false, currentVersion: '1.0.0', latestVersion: '1.0.0',
    });
    const save = spyOn(sessionFile, 'saveSessionSnapshot');
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode() {}, ref() {}, unref() {},
    });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    stdout.resume();
    // Continue the saved session, so what is typed is a change to it.
    const startup = {
      directory: settingsDirectory, help: false, version: false, continueSession: true, resume: null,
      prompt: null, print: false, model: null, permissionMode: null,
    };
    const app = render(createElement(App, { launchDirectory: settingsDirectory, startup }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const flush = async () => {
      await new Promise(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
    };
    try {
      await flush();
      const mounted = save.mock.calls.length;
      // Every key changes the draft, and every change notifies.
      for (const key of 'draft') {
        stdin.write(key);
        await flush();
      }
      expect(save.mock.calls.length).toBe(mounted);
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(save.mock.calls.length).toBe(mounted + 1);
      expect(loadSessionSnapshot(saved.id)?.inputContent).toBe('draft');

      stdin.write('!');
      await flush();
      app.unmount();
      expect(save.mock.calls.length).toBe(mounted + 2);
      expect(loadSessionSnapshot(saved.id)?.inputContent).toBe('draft!');
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(save.mock.calls.length).toBe(mounted + 2);
    } finally {
      app.unmount();
      stdin.destroy();
      stdout.destroy();
      save.mockRestore();
      update.mockRestore();
    }
  });

  test('uses a collision-safe name for the startup draft', () => {
    const existing = new Session({ name: 'Session 2', directory: '/projects/previous', autoNamePending: true });

    expect(nextSessionName([existing])).toBe('Session 3');
    expect(createWorkspace({ sessions: [existing], selectedSessionId: existing.getId() }, '/projects/current')
      .draftSession.getName()).toBe('Session 3');
  });

  test('opens an unselected draft without adding it to saved sessions', () => {
    const previous = new Session({ name: 'Previous', directory: '/projects/previous', autoNamePending: true });
    previous.append({ role: 'user', content: [{ type: 'text', text: 'Existing history' }] });

    const workspace = createWorkspace({
      sessions: [previous],
      selectedSessionId: previous.getId(),
    }, '/projects/current');

    expect(workspace.sessions).toHaveLength(1);
    expect(workspace.sessions[0]).toBe(previous);
    expect(workspace.selectedSession).toBeNull();
    expect(workspace.draftSession.getDirectory()).toBe('/projects/current');
    expect(workspace.draftSession.isEmpty()).toBe(true);
  });

  test('promotes the draft to a selected session on its first message', () => {
    const workspace = createWorkspace({ sessions: [], selectedSessionId: null }, '/projects/current');
    workspace.draftSession.append({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });

    const started = startSession(workspace, workspace.draftSession, '/projects/current');

    expect(started.sessions).toEqual([workspace.draftSession]);
    expect(started.selectedSession).toBe(workspace.draftSession);
    expect(started.draftSession).not.toBe(workspace.draftSession);
    expect(started.draftSession.isEmpty()).toBe(true);
  });

  test('preserves saved session models and applies the preference only to the new draft', () => {
    const first = new Session({ id: 'first', name: 'First', model: 'gpt-5.6-luna' });
    const second = new Session({ id: 'second', name: 'Second', model: 'gpt-5.6-terra' });
    second.addParticipant('reviewer', 'claude-fable-5-1');
    const workspace = createWorkspace({
      sessions: [first, second],
      selectedSessionId: second.getId(),
    }, '/projects/current', 'claude-sonnet-5');

    expect(workspace.sessions.map(session => session.getModel()))
      .toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
    expect(workspace.draftSession.getModel()).toBe('claude-sonnet-5');
    expect(second.getParticipants()[1]).toEqual({ name: 'reviewer', model: 'claude-fable-5-1' });
  });

  test('an empty-session choice supplies future defaults while populated-session choices survive restart', () => {
    const workspace = createWorkspace({ sessions: [], selectedSessionId: null }, '/projects/current');
    changeModel('sirus', 'sol', workspace.draftSession);
    workspace.draftSession.append({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    changeModel('sirus', 'haiku', workspace.draftSession);
    const started = startSession(workspace, workspace.draftSession, '/projects/current');
    expect(started.selectedSession?.getModel()).toBe('claude-haiku-4-5');
    expect(started.draftSession.getModel()).toBe('gpt-6-sol');
    saveSessionSnapshots(
      started.sessions.filter(s => !s.isEmpty()).map(s => s.toSnapshot()),
      started.selectedSession!.getId(),
    );
    const saved = loadSessionSnapshots();
    const restored = createWorkspace({
      sessions: saved.snapshots.map(snapshot => Session.fromSnapshot(snapshot)),
      selectedSessionId: saved.selectedSessionId,
    }, '/projects/current');
    expect(restored.sessions[0].getModel()).toBe('claude-haiku-4-5');
    expect(restored.draftSession.getModel()).toBe('gpt-6-sol');
  });
});
