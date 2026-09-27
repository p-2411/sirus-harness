import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as naming from '../../src/agent_runtime/session/naming';
import * as images from '../../src/images';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Writable } from 'stream';
import { Box, render } from 'ink';
import stripAnsi from 'strip-ansi';
import Chat from '../../src/frontend/chat/Chat';
import { Session } from '../../src/agent_runtime/session';
import type { PromptInput } from '../../src/agent_runtime/runtime/runtime';
import type { ImageBlock, Message } from '../../src/agent_runtime/types';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

const testModel = 'test-chat-attachment-model';
let directory: string;
let originalDataDirectory: string | undefined;
let imagePath: string;
let received: PromptInput[];
let generateName: ReturnType<typeof spyOn<typeof naming, 'generateSessionName'>>;

beforeEach(() => {
  generateName = spyOn(naming, 'generateSessionName').mockResolvedValue(null);
  directory = mkdtempSync(join(tmpdir(), 'sirus-chat-attachments-'));
  originalDataDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = join(directory, 'data');
  imagePath = join(directory, 'sample.png');
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKioAAAAASUVORK5CYII=', 'base64'));
  received = [];
  bindScriptedRuntime(testModel, (input, emit) => {
    received.push(input);
    emit({ type: 'text', text: 'I received the image.' });
  });
});

afterEach(() => {
  generateName.mockRestore();
  unbindRuntime(testModel);
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
    <Box width={120} height={40}><Chat currSession={session} /></Box>,
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
  test.each(['', 'Keep this text'])('Ctrl+C clears pasted images alongside draft text: %s', async text => {
    const clipboard = spyOn(images, 'readClipboard').mockImplementation(async () => images.attachImageFile(imagePath));
    const session = new Session({ name: 'Clear image draft', directory, model: testModel });
    const chat = createChat(session);
    try {
      if (text) await chat.press(text);
      await chat.press('\x1b[118;9u');
      await chat.press('\x1b[118;9u');
      await chat.waitFor(() => storedImages().length === 2 && session.getInputContent().length === text.length + 2);
      const beforeClear = chat.output().length;
      await chat.press('\u0003');
      expect(session.getInputContent()).toBe('');
      expect(storedImages()).toEqual([]);
      expect(chat.output().slice(beforeClear)).not.toContain('image ·');
      expect(chat.output().slice(beforeClear)).toContain('ctrl+c again to exit');
      expect(received).toHaveLength(0);
      if (text) {
        await chat.press('\x1b[A');
        expect(session.getInputContent()).toBe(text);
      } else await chat.press('Next prompt');
      await chat.press('\r');
      await chat.waitFor(() => session.getStatus() === 'idle' && received.length > 0);
      expect(received[0]!.images).toEqual([]);
    } finally {
      clipboard.mockRestore();
      await chat.close();
      await session.dispose();
    }
  });

  test('pasting an image stays quiet while the clipboard is read, then sends the attachment', async () => {
    let finishPaste!: (content: ImageBlock | string) => void;
    const clipboard = spyOn(images, 'readClipboard').mockImplementation(() => new Promise(resolve => { finishPaste = resolve; }));
    const session = new Session({ name: 'Clipboard image', directory, model: testModel });
    const chat = createChat(session);
    try {
      await chat.press('\x1b[118;9u'); // Cmd+V forwarded by the terminal.
      expect(clipboard).toHaveBeenCalledTimes(1);
      expect(chat.output()).not.toContain('thinking');
      expect(session.getStatus()).toBe('idle');
      expect(received).toHaveLength(0);

      const image = images.attachImageFile(imagePath);
      finishPaste(image);
      await chat.waitFor(() => chat.output().includes('image ·'));
      expect(chat.output()).not.toContain('thinking');
      expect(chat.output()).not.toContain('Attached image');
      await chat.press('\r');
      await chat.waitFor(() => session.getStatus() === 'idle' && received.length > 0);
      expect(received[0]!.images).toEqual([image]);
    } finally {
      finishPaste?.('');
      clipboard.mockRestore();
      await chat.close();
      await session.dispose();
    }
  });

  test('retains an image after invalid routing, then transfers it to the accepted message', async () => {
    const session = new Session({ name: 'Image chat', directory, model: testModel, autoNamePending: true });
    const chat = createChat(session);
    let sentPath: string | undefined;
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => storedImages().length > 0);
      expect(chat.output()).not.toContain('Attached image');
      expect(storedImages()).toHaveLength(1);
      sentPath = storedImages()[0];
      expect(session.getMessages()).toHaveLength(0);

      // Keep a separator after the image chip so word deletion can correct the
      // rejected route without deleting the attachment placeholder.
      await chat.submit(` @subagent ${testModel} look this`);
      await chat.waitFor(() => session.getStatus() === 'error');
      expect(session.getMessages()).toHaveLength(0);
      expect(storedImages()).toEqual([sentPath]);

      // Rejected sends restore their draft. Remove the invalid route while
      // retaining the image, then submit the corrected message.
      await chat.press('\x17');
      await chat.press('\x17');
      await chat.press('\x17');
      await chat.press('\x17');
      await chat.press('\x7f');
      await chat.submit('Describe the image');
      await chat.waitFor(() => session.getStatus() === 'idle' && received.length > 0);
      const attached = session.getMessages()[0].content.find(block => block.type === 'image');
      expect(attached).toMatchObject({ type: 'image', path: sentPath });
      expect(received.some(input => input.images.some(image => image.path === sentPath))).toBe(true);
      expect(storedImages()).toEqual([sentPath]);
    } finally {
      await chat.close();
    }
    expect(sentPath && existsSync(sentPath)).toBe(true);
  });

  test('queues a busy image draft with its text and transfers ownership to the queue', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    bindScriptedRuntime(testModel, async (input, emit) => {
      calls++;
      received.push(input);
      if (calls === 1) await gate;
      emit({ type: 'text', text: 'Done.' });
    });
    const session = new Session({ name: 'Queued image draft', directory, model: testModel, autoNamePending: true });
    const chat = createChat(session);
    let activeTurn: Promise<Message[]> | undefined;
    let sentPath: string | undefined;
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => storedImages().length > 0);
      expect(chat.output()).not.toContain('Attached image');
      sentPath = storedImages()[0];
      activeTurn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Running task' }] });
      await chat.waitFor(() => calls === 1);

      await chat.submit('Describe attached image');
      expect(session.getQueuedMessageCount()).toBe(1);
      expect(session.getInputContent()).toBe('');
      expect(session.getQueuedMessages()[0].text).toBe('Describe attached image');
      expect(session.getQueuedMessages()[0].images).toEqual([expect.objectContaining({ path: sentPath })]);
      expect(session.getMessages().filter(message => message.role === 'user')).toHaveLength(1);
      session.queueMessage('Queued text');
      release();
      await activeTurn;
      await chat.waitFor(() => session.getStatus() === 'idle' && calls === 3);
      expect(storedImages()).toEqual([sentPath!]);
      expect(session.getMessages().filter(message => message.role === 'user')[1].content)
        .toEqual([
          expect.objectContaining({ type: 'image', path: sentPath }),
          { type: 'text', text: 'Describe attached image' },
        ]);
      expect(session.getMessages().filter(message => message.role === 'user')[2].content)
        .toEqual([{ type: 'text', text: 'Queued text' }]);
    } finally {
      release();
      await activeTurn;
      await chat.close();
    }
    expect(sentPath && existsSync(sentPath)).toBe(true);
  });

  test('combines image attachments with history recall, multiline paste and focus reports', async () => {
    const session = new Session({ name: 'Draft editing', directory, model: testModel, autoNamePending: true });
    session.append({ role: 'user', content: [{ type: 'text', text: 'Earlier prompt' }] });
    session.append({ role: 'assistant', content: [{ type: 'text', text: 'Earlier reply' }] });
    const chat = createChat(session);
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => storedImages().length > 0);
      expect(chat.output()).not.toContain('Attached image');
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
    const session = new Session({ name: 'Image only', directory, model: testModel, autoNamePending: true });
    const chat = createChat(session);
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => storedImages().length > 0);
      expect(chat.output()).not.toContain('Attached image');
      await chat.press('\r');
      await chat.waitFor(() => session.getStatus() === 'idle' && received.length > 0);
      expect(session.getMessages()[0].content).toEqual([expect.objectContaining({ type: 'image' })]);
    } finally {
      await chat.close();
    }
  });

  test('removes an unsent stored attachment when leaving the chat', async () => {
    const chat = createChat(new Session({ name: 'Unsent image', directory, model: testModel, autoNamePending: true }));
    try {
      await chat.submit(`/image ${imagePath}`);
      await chat.waitFor(() => storedImages().length > 0);
      expect(chat.output()).not.toContain('Attached image');
      expect(storedImages()).toHaveLength(1);
    } finally {
      await chat.close();
    }
    expect(storedImages()).toHaveLength(0);
    expect(existsSync(imagePath)).toBe(true);
  });
});
