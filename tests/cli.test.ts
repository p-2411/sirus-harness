import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCliArguments, resolveResumeSelection, runPrint } from '../src/cli';
import packageManifest from '../package.json';
import { Session, type SessionSnapshot } from '../src/agent_runtime/session';
import { loadSessionSnapshots, saveSessionSnapshot } from '../src/persistence';
import { bindScriptedRuntime, unbindRuntime } from './support/runtime';
import { stopSirusMcpServer } from '../src/agent_runtime/tools/server';

describe('sirus CLI', () => {
  test('is installed as a package-level executable', () => {
    expect(packageManifest.bin).toEqual({ sirus: 'bin/sirus.js' });
    expect(readFileSync(join(import.meta.dir, '..', packageManifest.bin.sirus), 'utf8'))
      .toStartWith('#!/usr/bin/env node');
    expect(packageManifest.dependencies.bun).toBeDefined();
  });

  test('opens a fresh draft in the current directory by default', () => {
    expect(parseCliArguments([], process.cwd())).toEqual({
      directory: process.cwd(), help: false, version: false, continueSession: false,
      resume: null, prompt: null, print: false, model: null, permissionMode: null,
    });
  });

  test('preserves an existing directory argument, with an optional prompt', () => {
    const parent = mkdtempSync(join(tmpdir(), 'sirus-cli-'));
    const project = join(parent, 'project');
    mkdirSync(project);
    try {
      expect(parseCliArguments(['project'], parent)).toMatchObject({ directory: realpathSync(project), prompt: null });
      expect(parseCliArguments(['project', 'fix it', '--model=gpt-6-sol'], parent)).toMatchObject({
        directory: realpathSync(project), prompt: 'fix it', model: 'gpt-6-sol',
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('treats words and file paths as prompt text', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-cli-'));
    const file = join(directory, 'file.txt');
    writeFileSync(file, 'not a directory');
    try {
      expect(parseCliArguments(['fix', 'it'], directory).prompt).toBe('fix it');
      expect(parseCliArguments([file], directory).prompt).toBe(file);
      expect(parseCliArguments(['--', '--explain'], directory).prompt).toBe('--explain');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('supports resume, continue, print, version and permission mode', () => {
    expect(parseCliArguments(['--help'])).toMatchObject({ directory: null, help: true });
    expect(parseCliArguments(['--version'])).toMatchObject({ version: true });
    expect(parseCliArguments(['-c', '-p', 'fix it', '--permission-mode', 'ask'])).toMatchObject({
      continueSession: true, print: true, prompt: 'fix it', permissionMode: 'ask',
    });
    expect(parseCliArguments(['-r'])).toMatchObject({ resume: '' });
    expect(parseCliArguments(['--resume', 'a name'])).toMatchObject({ resume: 'a name' });
    expect(parseCliArguments(['--resume=abc', '-p', 'next'])).toMatchObject({ resume: 'abc', print: true, prompt: 'next' });
    expect(() => parseCliArguments(['--permission-mode', 'plan'])).toThrow('Unknown permission mode');
    expect(() => parseCliArguments(['--model'])).toThrow('requires a value');
    expect(() => parseCliArguments(['--unknown'])).toThrow('Unknown option');
    expect(() => parseCliArguments(['-c', '-r'])).toThrow('either');
    expect(() => parseCliArguments(['-p', '-r'])).toThrow('name or id');
  });

  test('continues the most recent project session and resolves unambiguous names or ids', () => {
    const snapshot = (id: string, name: string, directory: string, updatedAt: number): SessionSnapshot => ({
      id, name, directory, updatedAt, participants: [{ name: 'sirus', model: 'gpt-6-sol' }],
      defaultModel: { name: 'sirus', model: 'gpt-6-sol' }, messages: [],
    });
    const snapshots = [snapshot('abc-1', 'Fix build', '/one', 10), snapshot('def-2', 'Fix tests', '/two', 30),
      snapshot('ghi-3', 'New feature', '/one', 20), { ...snapshot('archived', 'Archive', '/one', 40), archived: true }];
    const options = { directory: '/one', continueSession: true, resume: null };
    expect(resolveResumeSelection(snapshots, options)?.id).toBe('ghi-3');
    expect(resolveResumeSelection(snapshots, { ...options, directory: '/empty' })).toBeNull();
    const resume = (query: string) => resolveResumeSelection(snapshots, { ...options, continueSession: false, resume: query });
    expect(resume('def-2')?.name).toBe('Fix tests');
    expect(resume('FIX BUILD')?.id).toBe('abc-1');
    expect(resume('ghi')?.name).toBe('New feature');
    expect(resume('') === null).toBe(true);
    expect(() => resume('Fix')).toThrow('Several sessions');
    expect(() => resume('unknown')).toThrow('No session matches');
  });

  test('print runs one prompt, declines interactive requests, saves only its session and disposes the runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-cli-print-'));
    const previous = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    const model = 'test-cli-print';
    const binding = bindScriptedRuntime(model, async (input, emit, options, signal) => {
      expect(input.text).toContain('say hello');
      const permission = await options.onPermission({
        sessionId: 'runtime-session', toolCall: { toolCallId: 'edit', title: 'Edit' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }],
      }, signal);
      expect(permission.outcome).toEqual({ outcome: 'selected', optionId: 'no' });
      const answer = await options.onElicitation!({
        sessionId: 'runtime-session', mode: 'form', message: 'Which?', requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
      }, signal);
      expect(answer.action).toBe('decline');
      emit({ type: 'text', text: 'Hello.' });
    });
    const existing = new Session({ directory, model, name: 'Earlier', messages: [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }] });
    saveSessionSnapshot(existing.toSnapshot());
    try {
      let output = '';
      await runPrint(parseCliArguments(['-p', '--model', model, 'say hello'], directory), 'say hello', text => { output += text; });
      expect(output).toBe('Hello.\n');
      expect(binding.runtimes).toHaveLength(1);
      expect(binding.runtimes[0].disposed).toBe(true);
      const saved = loadSessionSnapshots(undefined, directory);
      expect(saved.snapshots).toHaveLength(2);
      expect(saved.snapshots.find(item => item.id === existing.getId())?.messages).toHaveLength(1);
      expect(saved.snapshots.find(item => item.id !== existing.getId())?.messages).toHaveLength(2);
    } finally {
      await existing.dispose();
      unbindRuntime(model);
      stopSirusMcpServer();
      if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('print resumes without printing earlier replies and persists a failed turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-cli-resume-'));
    const previous = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    const model = 'test-cli-resume';
    const session = new Session({ directory, model, name: 'Named conversation', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Earlier question' }] },
      { role: 'assistant', participant: 'sirus', content: [{ type: 'text', text: 'Earlier reply' }] },
    ] });
    saveSessionSnapshot(session.toSnapshot());
    bindScriptedRuntime(model, (_input, emit) => { emit({ type: 'text', text: 'New reply' }); });
    try {
      const options = parseCliArguments(['-p', '--resume', session.getId(), 'next'], directory);
      let output = '';
      await runPrint(options, 'next', text => { output += text; });
      expect(output).toBe('New reply\n');
      expect(loadSessionSnapshots(undefined, directory).snapshots).toHaveLength(1);
      bindScriptedRuntime(model, () => { throw new Error('Turn failed'); });
      await expect(runPrint(options, 'another', () => {})).rejects.toThrow('OpenAI refused or could not complete this request');
      const saved = loadSessionSnapshots(undefined, directory).snapshots[0];
      expect(saved.messages.filter(message => message.role === 'user')).toHaveLength(3);
      const previousExitCode = process.exitCode;
      const previousHandlers = process.listenerCount('SIGINT');
      const cancelled = bindScriptedRuntime(model, () => { process.emit('SIGINT'); });
      try {
        await expect(runPrint(options, 'cancel this turn', () => {})).rejects.toThrow('Cancelled');
        expect(process.exitCode).toBe(130);
        expect(process.listenerCount('SIGINT')).toBe(previousHandlers);
        expect(cancelled.runtimes[0].disposed).toBe(true);
      } finally {
        process.exitCode = previousExitCode ?? 0;
      }
    } finally {
      await session.dispose();
      unbindRuntime(model);
      stopSirusMcpServer();
      if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
