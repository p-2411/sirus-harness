// The text the input bar and the prompts collect: a string, a cursor, the
// edits that move through them, and which keys are typing at all. Nothing
// here draws.
import type { Key } from 'ink';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';

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

// A character is what the user sees as one: an emoji with its skin tone, a
// flag, a family joined by ZWJs, each several code points. The cursor steps
// over it and backspace takes it whole.
const graphemes = new Intl.Segmenter();

// How many characters the text shows, which is how many dots a secret gets.
export function characterCount(text: string): number {
  return [...graphemes.segment(text)].length;
}

function previousCharacter(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  return graphemes.segment(text).containing(cursor - 1)!.index;
}

function nextCharacter(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  const { index, segment } = graphemes.segment(text).containing(cursor)!;
  return index + segment.length;
}

// The cursor one line up or down, keeping its character column where the
// line allows.
function lineMove(text: string, cursor: number, delta: -1 | 1): number {
  const lineStart = cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1;
  const column = characterCount(text.slice(lineStart, cursor));
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

// Backspace for the prompts that take one value and keep no cursor of
// their own: the last character goes, whole.
export function backspaceAtEnd(text: string): string {
  return applyInputEdit({ text, cursor: text.length }, { type: 'backspace' }).text;
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

// Input no prompt acts on: a mouse or window-focus report, which is not
// typing, and option+↑/↓, which switches session from the sidebar in every
// input mode.
export function isForeignInput(input: string, key: Key): boolean {
  return isMouseInput(input) || isFocusInput(input) || (key.meta && (key.upArrow || key.downArrow));
}

// A key that types its text rather than editing, moving or answering.
export function isTypedText(key: Key): boolean {
  return !key.ctrl && !key.meta && !key.escape && !key.tab && !key.return
    && !key.backspace && !key.delete
    && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow
    && !key.pageUp && !key.pageDown && !key.home && !key.end;
}
