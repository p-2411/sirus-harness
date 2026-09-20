// The input bar's text buffer: a string, a cursor, and the edits that move
// through them. Nothing here knows about React, Ink or the terminal.

export interface InputState {
  text: string;
  cursor: number;
}

export type InputEdit =
  | { type: 'insert'; text: string }
  | { type: 'left' | 'right' | 'up' | 'down' | 'backspace' | 'delete-word-backward' | 'clear' };

// Pasted text and typed text alike: one newline per line break.
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// readline's backward-kill-word: drop the last word and any whitespace after it
function deleteWordBackward(text: string): string {
  return text.replace(/\S*\s*$/, '');
}

function previousCharacter(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const previous = text.charCodeAt(cursor - 1);
  return previous >= 0xDC00 && previous <= 0xDFFF
    && cursor > 1
    && text.charCodeAt(cursor - 2) >= 0xD800
    && text.charCodeAt(cursor - 2) <= 0xDBFF
    ? cursor - 2
    : cursor - 1;
}

function nextCharacter(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  const current = text.charCodeAt(cursor);
  return current >= 0xD800 && current <= 0xDBFF
    && cursor + 1 < text.length
    && text.charCodeAt(cursor + 1) >= 0xDC00
    && text.charCodeAt(cursor + 1) <= 0xDFFF
    ? cursor + 2
    : cursor + 1;
}

// The cursor one line up or down, keeping its character column where the
// line allows. Count whole characters so movement cannot split a surrogate pair.
function lineMove(text: string, cursor: number, delta: -1 | 1): number {
  const lineStart = cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1;
  const column = [...text.slice(lineStart, cursor)].length;
  let targetStart: number;
  let targetEnd: number;
  if (delta < 0) {
    if (lineStart === 0) return cursor;
    targetStart = lineStart >= 2 ? text.lastIndexOf('\n', lineStart - 2) + 1 : 0;
    targetEnd = lineStart - 1;
  } else {
    const lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1) return cursor;
    targetStart = lineEnd + 1;
    const nextEnd = text.indexOf('\n', targetStart);
    targetEnd = nextEnd === -1 ? text.length : nextEnd;
  }
  let target = targetStart;
  for (let index = 0; index < column && target < targetEnd; index++) {
    target = nextCharacter(text, target);
  }
  return target;
}

export function onFirstLine(state: InputState): boolean {
  return !state.text.slice(0, state.cursor).includes('\n');
}

export function onLastLine(state: InputState): boolean {
  return !state.text.slice(state.cursor).includes('\n');
}

export function applyInputEdit(state: InputState, edit: InputEdit): InputState {
  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  const before = state.text.slice(0, cursor);
  const after = state.text.slice(cursor);
  switch (edit.type) {
    case 'insert':
      return { text: before + edit.text + after, cursor: cursor + edit.text.length };
    case 'left':
      return { ...state, cursor: previousCharacter(state.text, cursor) };
    case 'right':
      return { ...state, cursor: nextCharacter(state.text, cursor) };
    case 'up':
      return { ...state, cursor: lineMove(state.text, cursor, -1) };
    case 'down':
      return { ...state, cursor: lineMove(state.text, cursor, 1) };
    case 'backspace': {
      const start = previousCharacter(state.text, cursor);
      return { text: state.text.slice(0, start) + after, cursor: start };
    }
    case 'delete-word-backward': {
      const shortened = deleteWordBackward(before);
      return { text: shortened + after, cursor: shortened.length };
    }
    case 'clear':
      return { text: '', cursor: 0 };
  }
}
