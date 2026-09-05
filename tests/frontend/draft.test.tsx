import { describe, expect, test } from 'bun:test';
import { render as renderInk } from 'ink';
import { PassThrough } from 'node:stream';
import { useState } from 'react';
import stripAnsi from 'strip-ansi';
import { InputBar } from '../../src/frontend/chat/InputBar';
import type { ImageBlock, MessageBlock } from '../../src/agent_runtime/types';

interface SentDraft {
  input: string;
  images: readonly ImageBlock[] | undefined;
  content?: readonly MessageBlock[];
}

function image(index: number): ImageBlock {
  return {
    type: 'image',
    path: `/dummy-image-${index}.png`,
    mediaType: 'image/png',
    bytes: index,
  };
}

function renderDraft() {
  const images = [image(1), image(2)];
  const sent: SentDraft[] = [];
  let input = '';
  let attachments: ImageBlock[] = [];
  let output = '';
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });

  function Harness() {
    const [draft, setDraft] = useState('');
    const [attached, setAttached] = useState<ImageBlock[]>([]);
    input = draft;
    attachments = attached;
    return <InputBar
      send={(text, sentImages, content?: readonly MessageBlock[]) => {
        sent.push({ input: text, images: sentImages, content });
      }}
      inputContent={draft}
      setInputContent={setDraft}
      disabled={false}
      feedback={null}
      participants={[]}
      attachments={attached}
      onPasteImage={() => {
        setAttached(current => [...current, images[current.length]]);
      }}
      onRemoveAttachment={removed => {
        setAttached(current => current.filter(candidate => candidate.path !== removed.path));
      }}
    />;
  }

  const app = renderInk(<Harness />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  const press = async (keys: string) => {
    stdin.write(keys);
    await flush();
  };
  // Adding an attachment updates state first, then InputBar's effect puts its
  // placeholder at the current cursor position.
  const pasteImage = async () => {
    await press('\u0016');
    await flush();
  };
  const unmount = () => {
    app.unmount();
    stdin.destroy();
    stdout.destroy();
  };

  return {
    sent,
    get input() { return input; },
    get attachments() { return attachments; },
    get output() { return output; },
    flush,
    press,
    pasteImage,
    unmount,
  };
}

describe('positional image drafts', () => {
  test('sends text around an image in the order it was placed', async () => {
    const draft = renderDraft();
    try {
      await draft.flush();
      await draft.press('here: tail');
      for (let index = 0; index < 'tail'.length; index++) await draft.press('\u001b[D');
      await draft.pasteImage();
      await draft.press('image ');
      expect(draft.input).toBe('here: \uE000image tail');
      await draft.press('\r');

      expect(draft.sent).toHaveLength(1);
      expect(draft.sent[0].images).toEqual([image(1)]);
      expect(draft.sent[0].content).toEqual([
        { type: 'text', text: 'here: ' },
        image(1),
        { type: 'text', text: 'image tail' },
      ]);
    } finally {
      draft.unmount();
    }
  });

  test('keeps positional order when later attachments are inserted earlier and removes one atomically', async () => {
    const draft = renderDraft();
    try {
      await draft.flush();
      await draft.press('left right');
      for (let index = 0; index < 'right'.length; index++) await draft.press('\u001b[D');
      await draft.pasteImage();
      // Move from after the first image to the start, then attach a second
      // image before it. Attachment creation order is now the reverse of
      // draft position order.
      for (let index = 0; index < 'left '.length + 1; index++) await draft.press('\u001b[D');
      await draft.pasteImage();

      expect(draft.input).toBe('\uE001left \uE000right');
      expect(draft.output.indexOf('image · 2 B · png')).toBeLessThan(draft.output.indexOf('image · 1 B · png'));

      // The cursor is immediately after the second image, so one backspace
      // drops that whole attachment without deleting either surrounding text.
      await draft.press('\u007f');
      expect(draft.input).toBe('left \uE000right');
      expect(draft.attachments).toEqual([image(1)]);

      await draft.press('\r');
      expect(draft.sent[0].content).toEqual([
        { type: 'text', text: 'left ' },
        image(1),
        { type: 'text', text: 'right' },
      ]);
    } finally {
      draft.unmount();
    }
  });

  test('keeps a slash command as a command when an image is attached', async () => {
    const draft = renderDraft();
    try {
      await draft.flush();
      await draft.press('/help');
      await draft.pasteImage();
      await draft.press('\r');

      expect(draft.sent).toHaveLength(1);
      expect(draft.sent[0].input).toBe('/help');
      expect(draft.sent[0].images).toEqual([image(1)]);
    } finally {
      draft.unmount();
    }
  });
});
