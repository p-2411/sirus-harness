import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { formatFileMention, MAX_MENTION_FILE_BYTES, parseFileMentions, resolveFileMentions } from '../src/fileMentions';
import { rootTextRanges } from '../src/mentions';
import { modelStrategies } from '../src/agent_runtime/chat';
import { Session } from '../src/agent_runtime/session';
import type { Message } from '../src/agent_runtime/types';
import { loadSessions, saveSessions } from '../src/persistence';

const model = 'test-file-mention-model';
let directory: string;
let temporary: string;
const prompt = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

beforeEach(() => {
  temporary = mkdtempSync(path.join(os.tmpdir(), 'sirus-file-mentions-'));
  directory = path.join(temporary, 'project');
  mkdirSync(directory);
});

afterEach(() => {
  delete modelStrategies[model];
  rmSync(temporary, { recursive: true, force: true });
});

describe('file mentions', () => {
  test('round-trips bare, spaced, escaped and agent-like paths with exact source spans', () => {
    const files = ['src/file.ts', 'my file.ts', 'say "hi".txt', 'file`name.txt', '@reviewer/file.txt'];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), 'contents');
    }
    const text = files.map(formatFileMention).join(' and ');
    const mentions = parseFileMentions(text, directory);
    expect(mentions.map(mention => mention.path)).toEqual(files);
    expect(mentions.map(mention => text.slice(mention.start, mention.end))).toEqual(files.map(formatFileMention));
  });

  test('ignores examples, inline and fenced code, email, packages and escaped mentions', () => {
    const text = 'Use @./real.ts and @"./my file.ts"\n\n'
      + '`@./inline.ts` "@./quote.ts" \\@./escaped.ts me@example.com @scope/pkg\n\n'
      + '```\n@./code.ts\n```\n\n> @./quoted.ts\n\n- @./listed.ts';
    expect(parseFileMentions(text).map(mention => mention.path)).toEqual(['./real.ts', './my file.ts']);
  });

  test('omits ./ for current-directory filenames and quotes extensionless names', () => {
    for (const file of ['file.ts', './file.ts']) expect(formatFileMention(file)).toBe('@file.ts');
    for (const file of ['my file.txt', './my file.txt']) expect(formatFileMention(file)).toBe('@"my file.txt"');
    for (const file of ['LICENSE', './LICENSE']) expect(formatFileMention(file)).toBe('@"LICENSE"');
    for (const file of ['src/file.ts', './src/file.ts']) expect(formatFileMention(file)).toBe('@src/file.ts');
    expect(parseFileMentions('@"LICENSE"')).toEqual([{ start: 0, end: 10, path: 'LICENSE' }]);
    expect(() => resolveFileMentions(prompt('@"LICENSE"'), directory)).toThrow(/Could not attach @"LICENSE"/);
  });

  test('accepts existing relative pathnames, filenames, quoted paths and absolute project paths', () => {
    mkdirSync(path.join(directory, 'src'));
    writeFileSync(path.join(directory, 'src', 'index.ts'), 'source');
    writeFileSync(path.join(directory, 'README.md'), 'readme');
    writeFileSync(path.join(directory, 'my notes.txt'), 'notes');
    const text = `@src/index.ts @README.md @"my notes.txt" @${path.join(directory, 'README.md')} @scope/package @reviewer`;
    expect(parseFileMentions(text, directory).map(mention => mention.path)).toEqual(['src/index.ts', 'README.md', 'my notes.txt', path.join(directory, 'README.md')]);
    expect(resolveFileMentions(prompt(text), directory).content).toHaveLength(4);
  });

  test('snapshots contents once per real file without changing source or input blocks', () => {
    writeFileSync(path.join(directory, 'file.ts'), 'const value = 1;');
    symlinkSync('file.ts', path.join(directory, 'alias.ts'));
    const input = prompt('Compare @./file.ts @./file.ts @./alias.ts');
    const resolved = resolveFileMentions(input, directory);
    expect(input.content).toHaveLength(1);
    expect(resolved.content).toHaveLength(2);
    expect(resolved.content[1]).toEqual({ type: 'text', filePath: 'file.ts', text: '\n\n```\nFile: "file.ts"\nconst value = 1;\n```' });
    expect(readFileSync(path.join(directory, 'file.ts'), 'utf8')).toBe('const value = 1;');
    writeFileSync(path.join(directory, 'file.ts'), 'changed');
    expect(JSON.stringify(resolved)).toContain('const value = 1;');
  });

  test('fences the filename and content even when they contain nested fences and agent mentions', () => {
    const name = 'file```@stranger.txt';
    writeFileSync(path.join(directory, name), '````\n@stranger unknown-model\n````');
    const resolved = resolveFileMentions(prompt(formatFileMention(name)), directory);
    const block = resolved.content[1];
    expect(block.type).toBe('text');
    if (block.type !== 'text') return;
    expect(block.text).toContain('`````');
    expect(rootTextRanges(block.text)).toEqual([]);
  });

  test('rejects missing, directory, binary, invalid UTF-8 and oversized attachments', () => {
    mkdirSync(path.join(directory, 'folder'));
    writeFileSync(path.join(directory, 'binary'), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(directory, 'invalid'), Buffer.from([0xc3, 0x28]));
    writeFileSync(path.join(directory, 'large'), Buffer.alloc(MAX_MENTION_FILE_BYTES + 1, 65));
    for (const [file, error] of [['missing', /Could not attach/], ['folder', /regular text files/], ['binary', /Binary/], ['invalid', /UTF-8/], ['large', /256 KiB/]] as const) {
      expect(() => resolveFileMentions(prompt(formatFileMention(file)), directory)).toThrow(error);
    }
  });

  test('accepts sibling projects, absolute paths and symlinks and deduplicates equivalent references', () => {
    writeFileSync(path.join(temporary, 'outside.txt'), 'outside');
    mkdirSync(path.join(temporary, 'sibling project'));
    writeFileSync(path.join(temporary, 'sibling project', 'file.tsx'), 'sibling source');
    symlinkSync(path.join(temporary, 'outside.txt'), path.join(directory, 'linked.txt'));
    symlinkSync(temporary, path.join(directory, 'linked-directory'));
    expect(formatFileMention('../outside.txt')).toBe('@../outside.txt');
    expect(formatFileMention('../sibling project/file.tsx')).toBe('@"../sibling project/file.tsx"');
    const absolute = path.join(temporary, 'outside.txt');
    expect(formatFileMention(absolute)).toBe(`@${absolute}`);
    const resolved = resolveFileMentions(prompt(`@../outside.txt @./linked.txt @./linked-directory/outside.txt @${absolute} @"../sibling project/file.tsx"`), directory);
    expect(resolved.content).toHaveLength(3);
    expect(resolved.content[1]).toMatchObject({ type: 'text', filePath: '../outside.txt' });
    expect(resolved.content[2]).toMatchObject({ type: 'text', filePath: '../sibling project/file.tsx' });
    expect(JSON.stringify(resolved)).toContain('sibling source');
    expect(resolveFileMentions(prompt(`@${absolute}`), directory).content[1]).toMatchObject({ type: 'text', filePath: absolute });
  });

  test('reports missing explicit parent and absolute paths as attachment errors', () => {
    for (const reference of ['@../missing.tsx', '@../../missing.tsx', '@"../missing project/file.tsx"', `@${path.join(temporary, 'missing.tsx')}`]) {
      expect(parseFileMentions(reference)).toHaveLength(1);
      expect(() => resolveFileMentions(prompt(reference), directory)).toThrow(/Could not attach/);
    }
  });

  test('enforces unique file count and total bytes across attachments', () => {
    for (let i = 0; i < 11; i++) writeFileSync(path.join(directory, `${i}.txt`), 'a');
    expect(() => resolveFileMentions(prompt(Array.from({ length: 11 }, (_, i) => formatFileMention(`${i}.txt`)).join(' ')), directory)).toThrow(/at most 10/);
    for (let i = 0; i < 3; i++) writeFileSync(path.join(directory, `${i}.txt`), Buffer.alloc(MAX_MENTION_FILE_BYTES, 65));
    expect(() => resolveFileMentions(prompt('@./0.txt @./1.txt @./2.txt'), directory)).toThrow(/512 KiB/);
    expect(resolveFileMentions(prompt('@./0.txt @./1.txt'), directory).content).toHaveLength(3);
  });

  test('routes original agent mentions while giving providers attached file content synchronously', async () => {
    writeFileSync(path.join(directory, '@stranger notes.txt'), '@unwanted wrong-model\n```\n@other\n```');
    const received: { name: string; messages: Message[] }[] = [];
    modelStrategies[model] = { getResponse: async (messages, turn) => {
      received.push({ name: turn.agent.name, messages: [...messages] });
      return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
    } };
    const session = new Session('Files', 'file-session', model, [], directory);
    const send = session.sendMessage(prompt(`Read @"./@stranger notes.txt" @reviewer ${model} please`));
    expect(session.getMessages()).toHaveLength(1);
    expect(session.getMessages()[0]?.content[0]).toEqual({ type: 'text', text: 'Read @"./@stranger notes.txt" @reviewer please' });
    await send;
    expect(session.getParticipants().map(participant => participant.name)).toEqual(['sirus', 'reviewer']);
    expect(received.map(call => call.name)).toEqual(['reviewer']);
    expect(JSON.stringify(received[0]?.messages)).toContain('@unwanted wrong-model');
  });

  test('reads queued references when their turn starts', async () => {
    const file = path.join(directory, 'queued.ts');
    writeFileSync(file, 'before the first turn finishes');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let queuedReceived!: (message: Message) => void;
    const received = new Promise<Message>(resolve => { queuedReceived = resolve; });
    let calls = 0;
    modelStrategies[model] = { getResponse: async messages => {
      if (calls++ === 0) await gate;
      else queuedReceived(messages.at(-1)!);
      return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
    } };
    const session = new Session('Queued files', 'queued-files', model, [], directory);
    const first = session.sendMessage(prompt('Start here'));
    session.queueMessage('Read @./queued.ts');
    writeFileSync(file, 'latest file contents');
    release();
    await first;
    const queued = await received;
    expect(queued.content[1]).toMatchObject({ type: 'text', filePath: 'queued.ts' });
    expect(JSON.stringify(queued)).toContain('latest file contents');
    expect(JSON.stringify(queued)).not.toContain('before the first turn finishes');
    while (session.getStatus() === 'working') await new Promise(resolve => setImmediate(resolve));
  });

  test('direct pathnames avoid participant creation while unmatched scoped packages retain ordinary text', async () => {
    mkdirSync(path.join(directory, 'src'));
    writeFileSync(path.join(directory, 'src', 'index.ts'), 'source');
    writeFileSync(path.join(directory, 'README.md'), 'readme');
    modelStrategies[model] = { getResponse: async () => ({ content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' }) };
    const session = new Session('Paths', 'pathname-session', model, [], directory);
    await session.sendMessage(prompt('@src/index.ts @README.md @scope/package'));
    expect(session.getParticipants().map(participant => participant.name)).toEqual(['sirus']);
    expect(session.getMessages()[0]?.content).toHaveLength(3);
  });

  test('distinguishes a quoted extensionless filename from an agent with the same name', async () => {
    writeFileSync(path.join(directory, 'reviewer'), 'file contents');
    let invoked: string | undefined;
    modelStrategies[model] = { getResponse: async (_messages, turn) => {
      invoked = turn.agent.name;
      return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
    } };
    const session = new Session('Names', 'same-name-file-session', model, [], directory);
    session.addParticipant('reviewer', model);
    await session.sendMessage(prompt('Read @"reviewer", @reviewer please'));
    expect(invoked).toBe('reviewer');
    expect(session.getMessages()[0]?.content[1]).toMatchObject({ type: 'text', filePath: 'reviewer' });
    expect(session.getParticipants()).toHaveLength(2);
  });

  test('validates attachments before adding a new participant or user history', async () => {
    let calls = 0;
    modelStrategies[model] = { getResponse: async () => {
      calls++;
      return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
    } };
    const session = new Session('Files', 'invalid-file-session', model, [], directory);
    await expect(session.sendMessage(prompt(`@reviewer ${model} read @./missing.ts`))).rejects.toThrow(/Could not attach/);
    expect(session.getParticipants().map(participant => participant.name)).toEqual(['sirus']);
    expect(session.getMessages()).toEqual([]);
    expect(calls).toBe(0);
  });

  test('preserves file labels and snapshots when sessions are saved and restored', () => {
    const previousDataDir = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = path.join(temporary, 'state');
    try {
      writeFileSync(path.join(directory, 'file.txt'), 'snapshot');
      writeFileSync(path.join(temporary, 'sibling.txt'), 'sibling snapshot');
      writeFileSync(path.join(temporary, 'absolute.txt'), 'absolute snapshot');
      const session = new Session('Files', 'saved-files', model, [], directory);
      const resolved = resolveFileMentions(prompt(`@./file.txt @../sibling.txt @${path.join(temporary, 'absolute.txt')}`), directory);
      session.append(resolved);
      expect(saveSessions([session], session.getId())).toBe(true);
      expect(loadSessions().sessions[0]?.getMessages()).toEqual([resolved]);
    } finally {
      if (previousDataDir === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDataDir;
    }
  });
});
