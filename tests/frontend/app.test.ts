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
import App, { createWorkspace, nextSessionName, startSession } from '../../src/frontend/app';
import { changeModel } from '../../src/commands/agents/behavior';
import { loadSessions, saveSessions } from '../../src/persistence';

describe('app workspace startup', () => {
  let settingsDirectory: string;
  let previousDirectory: string | undefined;
  beforeEach(() => {
    settingsDirectory = mkdtempSync(join(tmpdir(), 'sirus-workspace-'));
    previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = settingsDirectory;
  });
  afterEach(() => {
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
    rmSync(settingsDirectory, { recursive: true, force: true });
  });
  test('menus keep pane widths fixed and Ctrl+K leaves the dots in place', async () => {
    const sessions = ['First', 'Second'].map(name => {
      const session = Session.create(name, `/projects/${name}`);
      session.append({ role: 'user', content: [{ type: 'text', text: 'Existing history' }] });
      return session;
    });
    saveSessions(sessions, null);
    const update = spyOn(updater, 'checkSirusUpdate').mockResolvedValue({
      updateAvailable: false, currentVersion: '1.0.0', latestVersion: '1.0.0',
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
      await type('\u000b'); // Ctrl+K, including while a menu is open.
      expectPanes(4);
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
      await type('\u000b');
      expectPanes(26);
      expect(dots()).toEqual(originalDots);
      expect(output).toContain('unfinished draft');
      stdout.columns = 120;
      stdout.emit('resize');
      await flush();
      expectPanes(26);
      await type('\u000b');
      expectPanes(4);
      expect(dots()).toEqual(originalDots);
      // The sidebar remains interactive when collapsed.
      await type('\u001b[1;3B'); // Option+Down switches to a saved session.
      expect(output).toContain('Existing history');
      expectPanes(4);
      await type('\u000e'); // Ctrl+N still creates a session.
      expect(dots()).toHaveLength(3);
      expectPanes(4);
    } finally {
      app.unmount();
      stdin.destroy();
      stdout.destroy();
      update.mockRestore();
    }
  });
  test('uses a collision-safe name for the startup draft', () => {
    const existing = Session.create('Session 2', '/projects/previous');

    expect(nextSessionName([existing])).toBe('Session 3');
    expect(createWorkspace({ sessions: [existing], selectedSessionId: existing.getId() }, '/projects/current')
      .draftSession.getName()).toBe('Session 3');
  });

  test('opens an unselected draft without adding it to saved sessions', () => {
    const previous = Session.create('Previous', '/projects/previous');
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
    const first = new Session('First', 'first', 'gpt-5.6-luna');
    const second = new Session('Second', 'second', 'gpt-5.6-terra');
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
    expect(started.selectedSession?.getModel()).toBe('claude-haiku-4.5');
    expect(started.draftSession.getModel()).toBe('gpt-5.6-sol');
    saveSessions(started.sessions, started.selectedSession!.getId());
    const restored = createWorkspace(loadSessions(), '/projects/current');
    expect(restored.sessions[0].getModel()).toBe('claude-haiku-4.5');
    expect(restored.draftSession.getModel()).toBe('gpt-5.6-sol');
  });
});
