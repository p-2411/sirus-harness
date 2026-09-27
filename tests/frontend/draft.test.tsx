import { describe, expect, test } from 'bun:test';
import { render as renderInk } from 'ink';
import { PassThrough } from 'node:stream';
import { useState } from 'react';
import stripAnsi from 'strip-ansi';
import { InputBar } from '../../src/frontend/chat/InputBar';
import { applyInputEdit, createInputHistory, inputEditForKey } from '../../src/frontend/chat/editor';
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


describe('readline draft editing', () => {
  test('maps the readline keys without consuming chat scroll chords', () => {
    for (const [input, type] of Object.entries({
      a: 'home', e: 'end', d: 'delete', k: 'kill-line-end',
      u: 'kill-line-start', w: 'delete-word-backward', y: 'yank', _: 'undo',
    } as const)) expect(inputEditForKey(input, { ctrl: true })).toEqual({ type });
    for (const [input, type] of Object.entries({ b: 'word-left', f: 'word-right', d: 'delete-word-forward' } as const)) {
      expect(inputEditForKey(input, { meta: true })).toEqual({ type });
    }
    expect(inputEditForKey('', { home: true })).toEqual({ type: 'home' });
    expect(inputEditForKey('', { end: true })).toEqual({ type: 'end' });
    expect(inputEditForKey('', { leftArrow: true, meta: true })).toEqual({ type: 'word-left' });
    expect(inputEditForKey('', { rightArrow: true, meta: true })).toEqual({ type: 'word-right' });
    expect(inputEditForKey('', { home: true, ctrl: true })).toBeNull();
    expect(inputEditForKey('', { end: true, ctrl: true })).toBeNull();
    expect(inputEditForKey('\u001f', {})).toEqual({ type: 'undo' });
  });

  test('distinguishes raw DEL, meta DEL and forward Delete', () => {
    expect(inputEditForKey('', { delete: true }, '\u007f')).toEqual({ type: 'backspace' });
    expect(inputEditForKey('', { delete: true, meta: true }, '\u001b\u007f')).toEqual({ type: 'delete-word-backward' });
    expect(inputEditForKey('', { delete: true }, '\u001b[3~')).toEqual({ type: 'delete' });
    expect(inputEditForKey('', { backspace: true })).toEqual({ type: 'backspace' });
    expect(inputEditForKey('', { delete: true })).toEqual({ type: 'delete' });
    const state = { text: 'a🐎b', cursor: 1 };
    expect(applyInputEdit(state, { type: 'delete' })).toEqual({ text: 'ab', cursor: 1 });
    expect(applyInputEdit(state, { type: 'backspace' })).toEqual({ text: '🐎b', cursor: 0 });
  });

  test('moves to the current line edges and kills only that line', () => {
    const state = { text: 'first\nsecond\nlast', cursor: 9 };
    expect(applyInputEdit(state, { type: 'home' }).cursor).toBe(6);
    expect(applyInputEdit(state, { type: 'end' }).cursor).toBe(12);
    expect(applyInputEdit(state, { type: 'kill-line-start' })).toEqual({ text: 'first\nond\nlast', cursor: 6 });
    expect(applyInputEdit(state, { type: 'kill-line-end' })).toEqual({ text: 'first\nsec\nlast', cursor: 9 });
    expect(applyInputEdit({ ...state, cursor: 12 }, { type: 'kill-line-end' })).toEqual({ text: 'first\nsecondlast', cursor: 12 });
  });

  test('moves over punctuation and Unicode words without splitting characters', () => {
    let state = { text: '🐎 café.next tail', cursor: 0 };
    state = applyInputEdit(state, { type: 'word-right' });
    expect(state.cursor).toBe(7);
    state = applyInputEdit(state, { type: 'word-right' });
    expect(state.cursor).toBe(12);
    state = applyInputEdit(state, { type: 'word-left' });
    expect(state.cursor).toBe(8);
    expect(applyInputEdit(state, { type: 'delete-word-forward' })).toEqual({ text: '🐎 café. tail', cursor: 8 });
    expect(applyInputEdit({ text: 'one two  ', cursor: 9 }, { type: 'delete-word-backward' })).toEqual({ text: 'one ', cursor: 4 });
  });

  test('yanks consecutive kills in their original order and undoes text edits', () => {
    const history = createInputHistory();
    let state = { text: 'one two three', cursor: 13 };
    state = applyInputEdit(state, { type: 'delete-word-backward' }, history);
    state = applyInputEdit(state, { type: 'delete-word-backward' }, history);
    expect(state).toEqual({ text: 'one ', cursor: 4 });
    expect(history.killed).toBe('two three');
    state = applyInputEdit(state, { type: 'home' }, history);
    state = applyInputEdit(state, { type: 'yank' }, history);
    expect(state).toEqual({ text: 'two threeone ', cursor: 9 });
    state = applyInputEdit(state, { type: 'undo' }, history);
    expect(state).toEqual({ text: 'one ', cursor: 0 });
    state = applyInputEdit(state, { type: 'undo' }, history);
    expect(state).toEqual({ text: 'one two ', cursor: 8 });
    state = applyInputEdit(state, { type: 'undo' }, history);
    expect(state).toEqual({ text: 'one two three', cursor: 13 });
    expect(applyInputEdit(state, { type: 'undo' }, history)).toEqual(state);
  });

  test('filters control bytes, normalizes pasted lines and skips empty undo entries', () => {
    const history = createInputHistory();
    let state = { text: '', cursor: 0 };
    state = applyInputEdit(state, { type: 'insert', text: 'a\u0000\u0003\u001f\u007f\u0085b\r\nc\rd\t' }, history);
    expect(state).toEqual({ text: 'ab\nc\nd\t', cursor: 7 });
    state = applyInputEdit(state, { type: 'insert', text: '\u001f' }, history);
    expect(history.undo).toHaveLength(1);
    expect(applyInputEdit(state, { type: 'undo' }, history)).toEqual({ text: '', cursor: 0 });
  });
});


describe('readline keys through Ink', () => {
  test('edits at Home and End and distinguishes Delete from Backspace', async () => {
    const draft = renderDraft();
    try {
      await draft.flush();
      await draft.press('abc');
      await draft.press('\u001b[H');
      await draft.press('X');
      expect(draft.input).toBe('Xabc');
      await draft.press('\u001b[3~');
      expect(draft.input).toBe('Xbc');
      await draft.press('\u007f');
      expect(draft.input).toBe('bc');
      await draft.press('\u001b[F');
      await draft.press('!');
      expect(draft.input).toBe('bc!');
      await draft.press('\u0001');
      await draft.press('\u0004');
      expect(draft.input).toBe('c!');
      await draft.press('\u0005');
      await draft.press('?');
      expect(draft.input).toBe('c!?');
    } finally {
      draft.unmount();
    }
  });

  test('moves by word, kills and yanks text, and undoes without inserting a control byte', async () => {
    const draft = renderDraft();
    try {
      await draft.flush();
      await draft.press('one two three');
      await draft.press('\u001bb');
      await draft.press('\u000b');
      expect(draft.input).toBe('one two ');
      await draft.press('\u001f');
      expect(draft.input).toBe('one two three');
      await draft.press('\u001b[1;3D');
      await draft.press('\u001bd');
      expect(draft.input).toBe('one  three');
      await draft.press('\u001f');
      await draft.press('\u001b[1;3C');
      await draft.press('\u001bf');
      await draft.press('\u0017');
      expect(draft.input).toBe('one two ');
      await draft.press('\u0019');
      expect(draft.input).toBe('one two three');
      await draft.press('\u0015');
      expect(draft.input).toBe('');
      await draft.press('\u0019');
      expect(draft.input).toBe('one two three');
      await draft.press('\r');
      expect(draft.sent[0].input).toBe('one two three');
    } finally {
      draft.unmount();
    }
  });
});


test('ignores keyboard protocol reports while preserving keys and literal pasted text', async () => {
  const draft = renderDraft();
  try {
    await draft.flush();
    await draft.press('hello');
    await draft.press('\u001b[?0u');
    expect(draft.input).toBe('hello');
    await draft.press('\u001b[?');
    await draft.press('31u');
    expect(draft.input).toBe('hello');
    await draft.press('\u001b[97u');
    expect(draft.input).toBe('helloa');
    await draft.press('\u001b[200~[?0u\u001b[201~');
    expect(draft.input).toBe('helloa[?0u');
    await draft.press('\r');
    expect(draft.sent[0].input).toBe('helloa[?0u');
  } finally {
    draft.unmount();
  }
});
