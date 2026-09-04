import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Writable } from 'stream';
import { Box, render } from 'ink';
import stripAnsi from 'strip-ansi';
import Chat from '../../src/frontend/chat/Chat';
import { Session } from '../../src/agent_runtime/session';
import { modelStrategies } from '../../src/agent_runtime/chat';
import type { Message } from '../../src/agent_runtime/types';

const testModel = 'test-chat-attachment-model';
let directory: string;
let originalDataDirectory: string | undefined;
let imagePath: string;
let received: readonly Message[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sirus-chat-attachments-'));
  originalDataDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = join(directory, 'data');
  imagePath = join(directory, 'sample.png');
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKioAAAAASUVORK5CYII=', 'base64'));
  received = [];
  modelStrategies[testModel] = {
    getResponse: async messages => {
      received = [...messages];
      return { content: [{ type: 'text', text: 'I received the image.' }], stop_reason: 'end_turn' };
    },
  };
});

afterEach(() => {
  delete modelStrategies[testModel];
  if (originalDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = originalDataDirectory;
  rmSync(directory, { recursive: true, force: true });
});

function createChat(session: Session) {
  let output = '';
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
  }), { columns: 120, rows: 40, isTTY: true });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() { return this; },
    ref() { return this; },
    unref() { return this; },
  });
  const instance = render(
    <Box width={120} height={40}><Chat currSession={session} onSirusModelChange={() => {}} /></Box>,
    {
      stdout: stdout as NodeJS.WriteStream,
      stderr: stdout as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
      debug: true,
    },
  );
  const flush = async () => {
    // Effects attach Ink's stdin listener after the initial commit.
    await new Promise<void>(resolve => setImmediate(resolve));
    await instance.waitUntilRenderFlush();
  };
  return {
    flush,
    output: () => stripAnsi(output),
    async press(input: string) {
      await flush();
      stdin.write(input);
      await flush();
    },
    async submit(text: string) {
      await flush();
      stdin.write(text);
      await flush();
      stdin.write('\r');
      await flush();
    },
    async waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 3000;
      while (!predicate() && Date.now() < deadline) await flush();
      expect(predicate()).toBe(true);
    },
    async close() {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function storedImages(): string[] {
  const images = join(directory, 'data', 'images');
  return existsSync(images) ? readdirSync(images).map(file => join(images, file)) : [];
}

describe('chat attachment lifecycle', () => {
  test('retains an image after invalid routing, then transfers it to the accepted message', async () => {
    const session = Session.create('Image chat', directory, testModel);
    const chat = createChat(session);
    let sentPath: string | undefined;
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => chat.output().includes('Attached image'));
      expect(storedImages()).toHaveLength(1);
      sentPath = storedImages()[0];
      expect(session.getMessages()).toHaveLength(0);

      await chat.submit('@missing look at this');
      await chat.waitFor(() => session.getStatus() === 'error');
      expect(session.getMessages()).toHaveLength(0);
      expect(storedImages()).toEqual([sentPath]);

      await chat.submit('Describe the image');
      await chat.waitFor(() => session.getStatus() === 'idle' && received.length > 0);
      const attached = session.getMessages()[0].content.find(block => block.type === 'image');
      expect(attached).toMatchObject({ type: 'image', path: sentPath });
      expect(received.some(message => message.content.some(block => block.type === 'image' && block.path === sentPath))).toBe(true);
      expect(storedImages()).toEqual([sentPath]);
    } finally {
      await chat.close();
    }
    expect(sentPath && existsSync(sentPath)).toBe(true);
  });

  test('keeps a busy image draft intact while queued text runs, then sends the draft with its image', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    modelStrategies[testModel] = {
      getResponse: async messages => {
        calls++;
        received = [...messages];
        if (calls === 1) await gate;
        return { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' };
      },
    };
    const session = Session.create('Queued image draft', directory, testModel);
    const chat = createChat(session);
    let activeTurn: Promise<Message[]> | undefined;
    let sentPath: string | undefined;
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => chat.output().includes('Attached image'));
      sentPath = storedImages()[0];
      activeTurn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Running task' }] });
      await chat.waitFor(() => calls === 1);

      await chat.submit('Describe attached image');
      expect(session.getQueuedMessageCount()).toBe(0);
      expect(session.getMessages().filter(message => message.role === 'user')).toHaveLength(1);
      session.queueMessage('Queued text');
      release();
      await activeTurn;
      await chat.waitFor(() => session.getStatus() === 'idle' && calls === 2);
      expect(storedImages()).toEqual([sentPath!]);
      expect(session.getMessages().filter(message => message.role === 'user')[1].content)
        .toEqual([{ type: 'text', text: 'Queued text' }]);

      // The busy submit retained both the text draft and its attachment.
      await chat.press('\r');
      await chat.waitFor(() => session.getStatus() === 'idle' && calls === 3);
      expect(session.getMessages().filter(message => message.role === 'user')[2].content)
        .toEqual([
          expect.objectContaining({ type: 'image', path: sentPath }),
          { type: 'text', text: 'Describe attached image' },
        ]);
    } finally {
      release();
      await activeTurn;
      await chat.close();
    }
    expect(sentPath && existsSync(sentPath)).toBe(true);
  });

  test('combines image attachments with history recall, multiline paste and focus reports', async () => {
    const session = Session.create('Draft editing', directory, testModel);
    session.append({ role: 'user', content: [{ type: 'text', text: 'Earlier prompt' }] });
    session.append({ role: 'assistant', content: [{ type: 'text', text: 'Earlier reply' }] });
    const chat = createChat(session);
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => chat.output().includes('Attached image'));
      await chat.press('draft ');
      await chat.press('\x1b[A');
      await chat.press('\x1b[B');
      await chat.press('\x1b[O');
      await chat.press('\x1b[I');
      await chat.press('\x1b[200~first\r\nsecond\x1b[201~');
      await chat.press('\x1b[D');
      await chat.press('!');
      await chat.press('\r');
      await chat.waitFor(() => session.getStatus() === 'idle' && received.length > 0);
      expect(session.getMessages().filter(message => message.role === 'user')[1].content)
        .toEqual([
          expect.objectContaining({ type: 'image' }),
          { type: 'text', text: 'draft first\nsecon!d' },
        ]);
    } finally {
      await chat.close();
    }
  });

  test('sends an image without text when idle', async () => {
    const session = Session.create('Image only', directory, testModel);
    const chat = createChat(session);
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => chat.output().includes('Attached image'));
      await chat.press('\r');
      await chat.waitFor(() => session.getStatus() === 'idle' && received.length > 0);
      expect(session.getMessages()[0].content).toEqual([expect.objectContaining({ type: 'image' })]);
    } finally {
      await chat.close();
    }
  });

  test('removes an unsent stored attachment when leaving the chat', async () => {
    const chat = createChat(Session.create('Unsent image', directory, testModel));
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => chat.output().includes('Attached image'));
      expect(storedImages()).toHaveLength(1);
    } finally {
      await chat.close();
    }
    expect(storedImages()).toHaveLength(0);
    expect(existsSync(imagePath)).toBe(true);
  });
});
