import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { useState, type ReactNode } from 'react';
import { Box, render } from 'ink';
import stripAnsi from 'strip-ansi';
import { modelStrategies } from '../../src/agent_runtime/chat';
import { Session } from '../../src/agent_runtime/session';
import type { Message } from '../../src/agent_runtime/types';
import Chat, { promptHistory } from '../../src/frontend/chat/Chat';
import * as fileSearch from '../../src/fileSearch';
import { InputBar } from '../../src/frontend/chat/InputBar';

const model = 'test-file-mentions-integration';
const projects: string[] = [];

afterEach(() => {
  delete modelStrategies[model];
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-file-picker-'));
  projects.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), contents);
  }
  return directory;
}

function terminal(component: ReactNode) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 35 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(<Box width={120} height={35}>{component}</Box>, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  return {
    output: () => output,
    flush,
    async type(input: string) {
      stdin.write(input);
      if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
      await flush();
    },
    async until(predicate: () => boolean) {
      const deadline = Date.now() + 3_000;
      while (!predicate() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
        await flush();
      }
      expect(predicate()).toBe(true);
    },
    close() { app.unmount(); stdin.destroy(); stdout.destroy(); },
  };
}

describe('file mentions through the terminal', () => {
  test('matching agents stay selected at the bottom while files load, and exact names retain file choices', async () => {
    const directory = project({ 'reviewer.md': 'Review notes', 'reviewer.ts': 'export const review = true;' });
    const sent: string[] = [];
    let draft = '';
    let release!: () => void;
    const loaded = new Promise<void>(resolve => { release = resolve; });
    const originalList = fileSearch.listMentionFiles;
    let searches = 0;
    const listing = spyOn(fileSearch, 'listMentionFiles').mockImplementation(async (...args) => {
      if (++searches === 1) await loaded;
      return originalList(...args);
    });
    function Editor() {
      const [input, setInput] = useState('');
      draft = input;
      return <InputBar inputContent={input} setInputContent={setInput} send={value => sent.push(value)}
        directory={directory} disabled={false} feedback={null} participants={[{ name: 'Reviewer', model }]} />;
    }
    const ui = terminal(<Editor />);
    try {
      await ui.flush();
      await ui.type('@rev');
      expect(ui.output()).toContain('› @Reviewer');
      expect(ui.output()).not.toContain('@reviewer.md');
      release();
      await ui.until(() => ui.output().includes('@reviewer.md'));
      expect(ui.output()).toContain('› @Reviewer');
      expect(ui.output().indexOf('@Reviewer')).toBeGreaterThan(ui.output().indexOf('@reviewer.md'));
      await ui.type('\t');
      expect(draft).toBe('@Reviewer ');
      expect(sent).toEqual([]);

      await ui.type('@rev');
      await ui.until(() => ui.output().includes('@reviewer.md'));
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @rev <model>');
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @reviewer.md');
      await ui.type('\t');
      expect(draft).toBe('@Reviewer @reviewer.md ');
      await ui.type('\r');
      expect(sent).toEqual(['@Reviewer @reviewer.md']);

      await ui.type('@Reviewer');
      await ui.until(() => ui.output().includes('@reviewer.ts'));
      expect(ui.output()).toContain('› @Reviewer');
      await ui.type('\r');
      expect(draft).toBe('@Reviewer ');
      expect(sent).toHaveLength(1);
      await ui.type('\r');
      expect(sent).toEqual(['@Reviewer @reviewer.md', '@Reviewer']);

      writeFileSync(path.join(directory, 'Reviewer'), 'An extensionless file, not the agent.');
      await ui.type('@Reviewer');
      await ui.until(() => ui.output().includes('@"Reviewer"'));
      expect(ui.output()).toContain('› @Reviewer');
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @"Reviewer"');
      await ui.type('\t');
      expect(draft).toBe('@"Reviewer" ');
      expect(sent).toHaveLength(2);
    } finally { release(); listing.mockRestore(); ui.close(); }
  });

  test('searches project files, navigates choices, inserts at the cursor, and dismisses without submitting', async () => {
    const directory = project({ 'match-a.txt': 'first', 'match-b space.txt': 'second' });
    const sent: string[] = [];
    let draft = '';
    function Editor() {
      const [input, setInput] = useState('Compare  after');
      draft = input;
      return <InputBar inputContent={input} setInputContent={setInput} send={value => sent.push(value)}
        directory={directory} disabled={false} feedback={null} participants={[]} />;
    }
    const ui = terminal(<Editor />);
    try {
      await ui.flush();
      for (let count = 0; count < ' after'.length; count++) await ui.type('\u001b[D');
      await ui.type('@match');
      await ui.until(() => ui.output().includes('match-b space.txt'));
      expect(ui.output()).toContain('› @match <model>');
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @match-a.txt');
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @"match-b space.txt"');
      await ui.type('\t');
      expect(draft).toBe('Compare @"match-b space.txt"  after');
      expect(sent).toEqual([]);

      for (let count = 0; count < ' after'.length; count++) await ui.type('\u001b[C');
      await ui.type(' @match-a');
      await ui.until(() => ui.output().includes('@match-a.txt'));
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @match-a.txt');
      await ui.type('\r');
      expect(draft).toBe('Compare @"match-b space.txt"  after @match-a.txt ');
      expect(sent).toEqual([]);
      await ui.type('\r');
      expect(sent).toEqual(['Compare @"match-b space.txt"  after @match-a.txt']);

      await ui.type('@match');
      await ui.until(() => ui.output().includes('@match-a.txt'));
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @match-a.txt');
      await ui.type('\u001b');
      expect(ui.output()).not.toContain('tab / enter select');
      expect(draft).toBe('@match');
      expect(sent).toHaveLength(1);
    } finally { ui.close(); }
  });

  test('starts at the bottom, scrolls only past visible rows, and resets to the closest match when the query changes', async () => {
    const directory = project(Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`item${index}.txt`, `File ${index}`])));
    const sent: string[] = [];
    function Editor() {
      const [input, setInput] = useState('');
      return <InputBar inputContent={input} setInputContent={setInput} send={value => sent.push(value)}
        directory={directory} disabled={false} feedback={null} participants={[]} />;
    }
    const ui = terminal(<Editor />);
    const visibleFiles = () => ui.output().split('\n').filter(line => line.includes('attach file'))
      .map(line => /@item\d\.txt/.exec(line)?.[0]);
    try {
      await ui.flush();
      await ui.type('@./item');
      await ui.until(() => ui.output().includes('› @item0.txt'));
      expect(visibleFiles()).toEqual(['@item3.txt', '@item2.txt', '@item1.txt', '@item0.txt']);
      for (let index = 1; index <= 3; index++) {
        await ui.type('\u001b[A');
        expect(ui.output()).toContain(`› @item${index}.txt`);
        expect(visibleFiles()).toEqual(['@item3.txt', '@item2.txt', '@item1.txt', '@item0.txt']);
      }
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @item4.txt');
      expect(visibleFiles()).toEqual(['@item4.txt', '@item3.txt', '@item2.txt', '@item1.txt']);
      for (let index = 3; index >= 1; index--) {
        await ui.type('\u001b[B');
        expect(ui.output()).toContain(`› @item${index}.txt`);
        expect(visibleFiles()).toEqual(['@item4.txt', '@item3.txt', '@item2.txt', '@item1.txt']);
      }
      await ui.type('\u001b[B');
      expect(ui.output()).toContain('› @item0.txt');
      expect(visibleFiles()).toEqual(['@item3.txt', '@item2.txt', '@item1.txt', '@item0.txt']);
      await ui.type('7');
      await ui.until(() => ui.output().includes('› @item7.txt'));
      expect(visibleFiles()).toEqual(['@item7.txt']);
      await ui.type('\u007f');
      await ui.until(() => ui.output().includes('› @item0.txt'));
      expect(visibleFiles()).toEqual(['@item3.txt', '@item2.txt', '@item1.txt', '@item0.txt']);
      expect(sent).toEqual([]);
    } finally { ui.close(); }
  });

  test('both path fragments and basenames find the same nested project file', async () => {
    const directory = project({ 'docs/design.md': '# Design', 'other.txt': 'Unrelated' });
    const sent: string[] = [];
    let draft = '';
    function Editor() {
      const [input, setInput] = useState('');
      draft = input;
      return <InputBar inputContent={input} setInputContent={setInput} send={value => sent.push(value)}
        directory={directory} disabled={false} feedback={null} participants={[]} />;
    }
    const ui = terminal(<Editor />);
    try {
      await ui.flush();
      for (const query of ['@docs/de', '@design']) {
        await ui.type(query);
        await ui.until(() => ui.output().includes('@docs/design.md'));
        if (!query.includes('/')) await ui.type('\u001b[A');
        expect(ui.output()).toContain('› @docs/design.md');
        expect(ui.output()).not.toContain('other.txt');
        await ui.type('\t');
        expect(draft).toBe('@docs/design.md ');
        await ui.type('\r');
      }
      expect(sent).toEqual(['@docs/design.md', '@docs/design.md']);
    } finally { ui.close(); }
  });

  test('sends selected file contents only to the addressed agent and keeps history and rendering compact', async () => {
    const contents = 'Unique attachment contents. @intruder should never become a participant.';
    const directory = project({ 'notes.txt': contents });
    const calls: { participant: string; messages: readonly Message[] }[] = [];
    modelStrategies[model] = {
      getResponse: async (messages, turn) => {
        calls.push({ participant: turn.agent.name, messages: structuredClone(messages) });
        return { content: [{ type: 'text', text: 'Reviewed the attachment.' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('File mention integration', 'file-mention-integration', model, [], directory);
    session.addParticipant('reviewer', model);
    const ui = terminal(<Chat currSession={session} />);
    try {
      await ui.flush();
      await ui.type('@reviewer Read @note');
      await ui.until(() => ui.output().includes('@notes.txt'));
      await ui.type('\u001b[A');
      expect(ui.output()).toContain('› @notes.txt');
      await ui.type('\r');
      expect(session.getInputContent()).toBe('@reviewer Read @notes.txt ');
      expect(calls).toHaveLength(0);
      await ui.type('\r');
      await ui.until(() => ui.output().includes('Reviewed the attachment.'));
      expect(calls.map(call => call.participant)).toEqual(['reviewer']);
      expect(JSON.stringify(calls[0]!.messages)).toContain(contents);
      expect(session.getParticipants().map(participant => participant.name)).toEqual(['sirus', 'reviewer']);
      expect(promptHistory(session.getMessages())).toEqual(['@reviewer Read @notes.txt']);
      expect(ui.output()).toContain('@notes.txt');
      expect(ui.output()).not.toContain('attached:');
      expect(ui.output()).not.toContain('Unique attachment contents');
      const restored = Session.fromSnapshot(JSON.parse(JSON.stringify(session.toSnapshot())));
      expect(restored.getMessages()[0]!.content).toEqual(session.getMessages()[0]!.content);
      expect(restored.getMessages()[0]!.content.some(block => block.type === 'text' && block.filePath === 'notes.txt')).toBe(true);
      expect(promptHistory(restored.getMessages())).toEqual(['@reviewer Read @notes.txt']);
    } finally { ui.close(); }
  });

  test('a missing file restores the editable draft without starting a provider or recording a message', async () => {
    const directory = project({});
    let calls = 0;
    modelStrategies[model] = {
      getResponse: async () => {
        calls++;
        return { content: [{ type: 'text', text: 'Unexpected response' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Missing file', 'missing-file-integration', model, [], directory);
    const ui = terminal(<Chat currSession={session} />);
    try {
      await ui.flush();
      await ui.type('Read @./missing.txt please');
      await ui.type('\r');
      await ui.until(() => ui.output().includes('Could not attach @missing.txt'));
      expect(session.getInputContent()).toBe('Read @./missing.txt please');
      expect(session.getMessages()).toEqual([]);
      expect(calls).toBe(0);
      await ui.type('!');
      expect(session.getInputContent()).toBe('Read @./missing.txt please!');
    } finally { ui.close(); }
  });

  test('explicit parent paths attach a selected sibling-project file without expanding default search', async () => {
    const contents = 'export const siblingProjectValue = 42;';
    const root = project({ 'current/local.txt': 'Current project', 'proj/file.tsx': contents });
    const directory = path.join(root, 'current');
    const received: Message[][] = [];
    modelStrategies[model] = {
      getResponse: async messages => {
        received.push(structuredClone([...messages]));
        return { content: [{ type: 'text', text: 'Read the sibling file.' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Sibling file', 'sibling-file-integration', model, [], directory);
    const ui = terminal(<Chat currSession={session} />);
    try {
      await ui.flush();
      await ui.type('@');
      await ui.until(() => ui.output().includes('@local.txt'));
      expect(ui.output()).not.toContain('file.tsx');
      await ui.type('../proj/fi');
      await ui.until(() => ui.output().includes('../proj/file.tsx'));
      await ui.type('\t');
      expect(session.getInputContent()).toBe('@../proj/file.tsx ');
      expect(received).toHaveLength(0);
      await ui.type('\r');
      await ui.until(() => ui.output().includes('Read the sibling file.'));
      expect(received).toHaveLength(1);
      expect(JSON.stringify(received[0])).toContain(contents);
      expect(promptHistory(session.getMessages())).toEqual(['@../proj/file.tsx']);
      expect(ui.output()).toContain('@../proj/file.tsx');
      expect(ui.output()).not.toContain('attached:');
      expect(ui.output()).not.toContain('siblingProjectValue');
      const restored = Session.fromSnapshot(JSON.parse(JSON.stringify(session.toSnapshot())));
      expect(promptHistory(restored.getMessages())).toEqual(['@../proj/file.tsx']);
      expect(restored.getMessages()[0]!.content.some(block => block.type === 'text' && block.filePath === '../proj/file.tsx')).toBe(true);
    } finally { ui.close(); }
  });
});
