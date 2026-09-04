import type { RefObject } from 'react';
import { measureElement, type DOMElement } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { theme } from '../styles/theme';
import { copyToClipboard } from '../terminal/clipboard';
import {
  frameLines, lineText, lineWidth, lineToRow, onFrame, sliceColumns, writeOverlay,
} from '../terminal/screen';

// Screen-level text selection, the way Claude Code's fullscreen renderer does
// it: the selection is painted straight onto the terminal after each Ink frame
// and copied on release. Ink never sees it.
//
// Cells are stored relative to the element the selection follows (the chat's
// scrolling content box, say), so scrolling moves the highlight with the text
// instead of leaving it stranded on the same screen rows.

export interface Cell {
  /** frame line index, or a line offset when relative to a followed element */
  line: number;
  /** 0-based display column, likewise */
  col: number;
}

export interface Rect {
  /** first column, inclusive */
  left: number;
  /** first line, inclusive */
  top: number;
  /** one past the last column */
  right: number;
  /** one past the last line */
  bottom: number;
}

export interface SelectionSnapshot {
  anchor: Cell | null;
  focus: Cell | null;
  dragging: boolean;
  /** timestamp of the last copy, so the UI can acknowledge it */
  copiedAt: number | null;
}

type ElementRef = RefObject<DOMElement | null>;

export interface RegionOptions {
  /** element whose movement the selection should track; defaults to the region itself */
  follows?: ElementRef;
  /**
   * The followed element's complete content as rendered lines (ANSI allowed),
   * including whatever is scrolled out of view. With this, copying covers the
   * whole selection rather than only the part currently on screen.
   */
  text?: () => string[];
}

interface Region {
  ref: ElementRef;
  follows: ElementRef;
  text?: () => string[];
}

// Containers that scope a selection. Measured live, because scrolling moves a
// child without changing its own parent-relative metrics.
const regions = new Map<ElementRef, Region>();

export function registerSelectionRegion(ref: ElementRef, options: RegionOptions = {}): () => void {
  regions.set(ref, { ref, follows: options.follows ?? ref, text: options.text });
  return () => {
    regions.delete(ref);
  };
}

let state: SelectionSnapshot = { anchor: null, focus: null, dragging: false, copiedAt: null };
// Containers under the cell where the drag started. The selection is clipped
// to all of them, so a drag in the chat never bleeds into the sidebar.
let containers: Region[] = [];
// The region whose followed element the stored cells are relative to; null
// means screen coordinates.
let followedRegion: Region | null = null;
let paintedLines: number[] = [];
const listeners = new Set<() => void>();

function setState(next: Partial<SelectionSnapshot>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribeSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSelectionSnapshot(): SelectionSnapshot {
  return state;
}

export function hasSelection(): boolean {
  return state.anchor !== null && state.focus !== null
    && (state.anchor.line !== state.focus.line || state.anchor.col !== state.focus.col);
}

function measure(ref: ElementRef): Rect | null {
  if (!ref.current) return null;
  const { x, y, width, height } = measureElement(ref.current);
  return { left: x, top: y, right: x + width, bottom: y + height };
}

function contains(rect: Rect, cell: Cell): boolean {
  return cell.col >= rect.left && cell.col < rect.right && cell.line >= rect.top && cell.line < rect.bottom;
}

function area(rect: Rect): number {
  return (rect.right - rect.left) * (rect.bottom - rect.top);
}

/** Frame origin of the followed element right now; zero when following nothing. */
function origin(): Cell {
  const rect = followedRegion ? measure(followedRegion.follows) : null;
  return rect ? { line: rect.top, col: rect.left } : { line: 0, col: 0 };
}

function toRelative(cell: Cell): Cell {
  const o = origin();
  return { line: cell.line - o.line, col: cell.col - o.col };
}

function toScreen(cell: Cell): Cell {
  const o = origin();
  return { line: cell.line + o.line, col: cell.col + o.col };
}

/**
 * Intersection of the containers the drag started in, measured now. The app is
 * a single full-screen frame with no static output, so Ink's layout coordinates
 * are frame coordinates.
 */
function currentBounds(): Rect | null {
  let result: Rect | null = null;
  for (const { ref } of containers) {
    const rect = measure(ref);
    if (!rect) continue;
    result = result === null ? rect : {
      left: Math.max(result.left, rect.left),
      top: Math.max(result.top, rect.top),
      right: Math.min(result.right, rect.right),
      bottom: Math.min(result.bottom, rect.bottom),
    };
  }
  return result;
}

export function beginSelection(cell: Cell) {
  containers = [];
  let innermost: { region: Region; size: number } | null = null;
  for (const region of regions.values()) {
    const rect = measure(region.ref);
    if (!rect || !contains(rect, cell)) continue;
    containers.push(region);
    const size = area(rect);
    if (!innermost || size < innermost.size) innermost = { region, size };
  }
  followedRegion = innermost?.region ?? null;

  const relative = toRelative(cell);
  setState({ anchor: relative, focus: relative, dragging: true });
  paint();
}

export function extendSelection(cell: Cell) {
  if (!state.dragging) return;
  const relative = toRelative(cell);
  if (state.focus && state.focus.line === relative.line && state.focus.col === relative.col) return;
  setState({ focus: relative });
  paint();
}

export function endSelection(cell: Cell) {
  if (!state.dragging) return;
  setState({ focus: toRelative(cell), dragging: false });
  if (!hasSelection()) {
    clearSelection();
    return;
  }
  paint();
  const text = getSelectedText();
  if (text.trim()) {
    copyToClipboard(text);
    setState({ copiedAt: Date.now() });
  }
}

export function clearSelection() {
  if (state.anchor === null && state.focus === null) return;
  containers = [];
  followedRegion = null;
  setState({ anchor: null, focus: null, dragging: false });
  paint();
}

interface Span { line: number; from: number; to: number }

/** Anchor and focus in reading order, as stored (relative to the followed element). */
function ordered(): { start: Cell; end: Cell } {
  const a = state.anchor!;
  const f = state.focus!;
  const forward = a.line < f.line || (a.line === f.line && a.col <= f.col);
  return { start: forward ? a : f, end: forward ? f : a };
}

function spans(): Span[] {
  if (!hasSelection()) return [];
  const relative = ordered();
  const start = toScreen(relative.start);
  const end = toScreen(relative.end);
  const bounds = currentBounds();

  const lineCount = frameLines().length;
  const firstLine = Math.max(0, start.line, bounds?.top ?? 0);
  const lastLine = Math.min(end.line, lineCount - 1, (bounds?.bottom ?? Infinity) - 1);
  const result: Span[] = [];
  for (let line = firstLine; line <= lastLine; line++) {
    const width = lineWidth(line);
    const from = Math.max(bounds?.left ?? 0, line === start.line ? start.col : 0);
    // terminal convention: the cell under the cursor is part of the selection
    const to = Math.min(width, bounds?.right ?? Infinity, line === end.line ? end.col + 1 : width);
    if (from < to) result.push({ line, from, to });
  }
  return result;
}

/**
 * The selected text. When the region supplies its full content, this covers
 * the whole selection, including lines scrolled out of the viewport; otherwise
 * it falls back to what is on screen.
 */
export function getSelectedText(): string {
  if (followedRegion?.text && hasSelection()) {
    const lines = followedRegion.text().map(line => stripAnsi(line));
    const { start, end } = ordered();
    const result: string[] = [];
    for (let line = Math.max(0, start.line); line <= Math.min(end.line, lines.length - 1); line++) {
      const width = stringWidth(lines[line]);
      const from = line === start.line ? Math.max(0, start.col) : 0;
      const to = Math.min(width, line === end.line ? end.col + 1 : width);
      result.push(from < to ? sliceColumns(lines[line], from, to).trimEnd() : '');
    }
    return result.join('\n');
  }
  return visibleSelectedText();
}

function visibleSelectedText(): string {
  return spans()
    .map(({ line, from, to }) => sliceColumns(lineText(line), from, to).trimEnd())
    .join('\n');
}

function sgrColor(hex: string, layer: 38 | 48): string {
  const value = parseInt(hex.replace('#', ''), 16);
  return `\x1b[${layer};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

const SELECTION_SGR = sgrColor(theme.selectionBg, 48) + sgrColor(theme.selectionFg, 38);

/**
 * Repaint the highlight over the current frame. Cursor position is saved and
 * restored around the writes: Ink's redraw relies on the cursor sitting where
 * it left it.
 */
function paint() {
  const lines = frameLines();
  let out = '';
  // Put back the lines that carried a highlight last time. After an Ink frame
  // this is redundant, but after a drag step it is what un-highlights cells.
  for (const line of paintedLines) {
    const row = lineToRow(line);
    if (row < 1 || line >= lines.length) continue;
    out += `\x1b[${row};1H\x1b[0m${lines[line]}\x1b[0m`;
  }
  paintedLines = [];

  for (const { line, from, to } of spans()) {
    const row = lineToRow(line);
    if (row < 1) continue;
    out += `\x1b[${row};${from + 1}H${SELECTION_SGR}${sliceColumns(lineText(line), from, to)}\x1b[0m`;
    paintedLines.push(line);
  }

  if (out) writeOverlay(`\x1b7${out}\x1b8`);
}

onFrame(() => {
  // The frame just repainted everything, so nothing is highlighted any more.
  paintedLines = [];
  if (!hasSelection()) return;
  if (followedRegion && !followedRegion.follows.current) {
    // the content the selection lived in is gone (session switched, say)
    containers = [];
    followedRegion = null;
    setState({ anchor: null, focus: null, dragging: false });
    return;
  }
  paint();
});
