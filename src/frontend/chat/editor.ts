// The text the input bar and the prompts collect: a string, a cursor, the
// edits that move through them, and which keys are typing at all. Nothing
// here draws.
import type { Key } from 'ink';
import stringWidth from 'string-width';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';

export interface InputState {
  text: string;
  cursor: number;
}

export type InputEdit =
  | { type: 'insert'; text: string }
  | { type: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'word-left' | 'word-right'
    | 'backspace' | 'delete' | 'delete-word-backward' | 'delete-word-forward'
    | 'kill-line-start' | 'kill-line-end' | 'yank' | 'undo' | 'clear' };

export interface InputHistory {
  undo: InputState[];
  killed: string;
  killing: boolean;
}

export function createInputHistory(): InputHistory {
  return { undo: [], killed: '', killing: false };
}

// Ghostty and other Kitty-compatible terminals answer Ink's startup query
// with CSI ? flags u. Ink can also deliver that reply to useInput, with ESC
// stripped. It is terminal state, not text or a key; paste uses its own path.
export function isKeyboardProtocolReport(input: string): boolean {
  return /^(?:\x1b)?\[\?\d+u$/.test(input);
}

interface InputKey {
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
  home?: boolean;
  end?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

// Ink versions differ on DEL. Its raw byte means backspace; CSI 3~ means
// forward delete. Current Ink also distinguishes these in the key flags.
export function inputEditForKey(input: string, key: InputKey, raw?: string): InputEdit | null {
  if (input === '\u001f' || (key.ctrl && (input === '_' || input === '/'))) return { type: 'undo' };
  const backspace = key.backspace || (key.delete && (raw === '\u007f' || raw === '\u001b\u007f'));
  if (backspace) {
    if (key.super) return { type: 'kill-line-start' };
    if (key.meta || key.ctrl) return { type: 'delete-word-backward' };
    return { type: 'backspace' };
  }
  if (key.delete) return { type: key.meta ? 'delete-word-forward' : 'delete' };
  if (key.ctrl) {
    switch (input) {
      case 'a': return { type: 'home' };
      case 'e': return { type: 'end' };
      case 'd': return { type: 'delete' };
      case 'k': return { type: 'kill-line-end' };
      case 'u': return { type: 'kill-line-start' };
      case 'w': return { type: 'delete-word-backward' };
      case 'y': return { type: 'yank' };
    }
    return null;
  }
  if (key.home) return { type: 'home' };
  if (key.end) return { type: 'end' };
  if (key.leftArrow) return { type: key.meta ? 'word-left' : 'left' };
  if (key.rightArrow) return { type: key.meta ? 'word-right' : 'right' };
  if (key.meta) {
    switch (input.toLowerCase()) {
      case 'b': return { type: 'word-left' };
      case 'f': return { type: 'word-right' };
      case 'd': return { type: 'delete-word-forward' };
    }
  }
  return null;
}

// Pasted text and typed text alike: one newline per line break.
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Readline word movement skips punctuation; Ctrl+W uses whitespace instead.
function wordLeft(text: string, cursor: number): number {
  const before = text.slice(0, cursor);
  return before.replace(/[\p{L}\p{N}_]*[^\p{L}\p{N}_]*$/u, '').length;
}

function wordRight(text: string, cursor: number): number {
  const word = text.slice(cursor).match(/^[^\p{L}\p{N}_]*[\p{L}\p{N}_]*/u);
  return cursor + (word?.[0].length ?? 0);
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

export function applyInputEdit(state: InputState, edit: InputEdit, history?: InputHistory): InputState {
  if (edit.type === 'undo') {
    if (history) history.killing = false;
    return history?.undo.pop() ?? state;
  }
  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  const before = state.text.slice(0, cursor);
  const after = state.text.slice(cursor);
  const lineStart = before.lastIndexOf('\n') + 1;
  const newline = state.text.indexOf('\n', cursor);
  const lineEnd = newline < 0 ? state.text.length : newline;
  let next: InputState;
  let killed = '';
  let backwardKill = false;
  switch (edit.type) {
    case 'insert': {
      // Preserve pasted line breaks and tabs, but never send terminal control
      // bytes (including Ctrl+_) to the agent as part of the prompt.
      const text = normalizeNewlines(edit.text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
      next = { text: before + text + after, cursor: cursor + text.length };
      break;
    }
    case 'left':
      next = { ...state, cursor: previousCharacter(state.text, cursor) };
      break;
    case 'right':
      next = { ...state, cursor: nextCharacter(state.text, cursor) };
      break;
    case 'up':
      next = { ...state, cursor: lineMove(state.text, cursor, -1) };
      break;
    case 'down':
      next = { ...state, cursor: lineMove(state.text, cursor, 1) };
      break;
    case 'home':
      next = { ...state, cursor: lineStart };
      break;
    case 'end':
      next = { ...state, cursor: lineEnd };
      break;
    case 'word-left':
      next = { ...state, cursor: wordLeft(state.text, cursor) };
      break;
    case 'word-right':
      next = { ...state, cursor: wordRight(state.text, cursor) };
      break;
    case 'backspace': {
      const start = previousCharacter(state.text, cursor);
      next = { text: state.text.slice(0, start) + after, cursor: start };
      break;
    }
    case 'delete':
      next = { text: before + state.text.slice(nextCharacter(state.text, cursor)), cursor };
      break;
    case 'delete-word-backward':
    case 'kill-line-start': {
      const start = edit.type === 'kill-line-start' ? lineStart : before.replace(/\S*\s*$/, '').length;
      killed = state.text.slice(start, cursor);
      backwardKill = true;
      next = { text: state.text.slice(0, start) + after, cursor: start };
      break;
    }
    case 'delete-word-forward':
    case 'kill-line-end': {
      const end = edit.type === 'delete-word-forward' ? wordRight(state.text, cursor)
        : lineEnd === cursor ? Math.min(cursor + 1, state.text.length) : lineEnd;
      killed = state.text.slice(cursor, end);
      next = { text: before + state.text.slice(end), cursor };
      break;
    }
    case 'yank': {
      const text = history?.killed ?? '';
      next = { text: before + text + after, cursor: cursor + text.length };
      break;
    }
    case 'clear':
      next = { text: '', cursor: 0 };
      break;
  }
  if (history) {
    if (state.text !== next.text) {
      history.undo.push({ ...state });
      if (history.undo.length > 100) history.undo.shift();
    }
    if (killed) {
      history.killed = history.killing
        ? backwardKill ? killed + history.killed : history.killed + killed
        : killed;
    }
    history.killing = killed.length > 0;
  }
  return next;
}

export interface DraftCell {
  start: number;
  end: number;
  text: string;
  width: number;
  chip: boolean;
}

// Rendering and vertical movement share exactly the same terminal columns.
export function draftRows(text: string, width: number, label: (character: string) => string | undefined = () => undefined): DraftCell[][] {
  const rows: DraftCell[][] = [[]];
  const columns = Math.max(1, width);
  let used = 0;
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  for (const { segment, index } of segments) {
    const chip = label(segment);
    const display = segment === '\n' ? (used === columns ? '' : ' ') : segment === '\t' ? '    ' : chip ?? segment;
    const size = display === '' ? 0 : Math.min(columns, Math.max(1, stringWidth(display)));
    if (used + size > columns && rows.at(-1)!.length) { rows.push([]); used = 0; }
    rows.at(-1)!.push({ start: index, end: index + segment.length, text: display, width: size, chip: chip !== undefined });
    used += size;
    if (segment === '\n') { rows.push([]); used = 0; }
  }
  if (used >= columns) rows.push([]);
  rows.at(-1)!.push({ start: text.length, end: text.length, text: ' ', width: 1, chip: false });
  return rows;
}

export function draftCursorRow(rows: DraftCell[][], cursor: number): number {
  return Math.max(0, rows.findIndex(row => row.some(cell => cell.start === cursor || (cell.start < cursor && cursor < cell.end))));
}

export function moveDraftRow(state: InputState, rows: DraftCell[][], delta: -1 | 1): InputState {
  const current = draftCursorRow(rows, state.cursor);
  const target = rows[current + delta];
  if (!target) return state;
  let column = 0;
  for (const cell of rows[current]) { if (cell.start >= state.cursor) break; column += cell.width; }
  let used = 0;
  let cursor = target[0].start;
  for (const cell of target) {
    if (used > column) break;
    cursor = cell.start;
    used += cell.width;
  }
  return { ...state, cursor };
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
