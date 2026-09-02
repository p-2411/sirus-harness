import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

// Ink repaints by writing the whole frame to stdout. Our layout is always a
// full-screen frame, one line per terminal row, so keeping the last frame
// gives a cell-accurate picture of the screen. That is what mouse coordinates
// get resolved against — Ink itself has no notion of which text is at (x, y).

let frame: string[] = [];
let plainCache: (string | undefined)[] = [];
const listeners = new Set<() => void>();
// Set while we write our own overlays, so those writes aren't taken for frames.
let writingOverlay = false;

// Cursor and erase sequences Ink wraps around a frame. SGR ('m') is
// deliberately excluded: colour codes belong to the frame's text.
const LEADING_CONTROL = /^(?:\x1b\[[0-9;?]*[A-HJKhl])+/;
const TRAILING_CONTROL = /(?:\x1b\[[0-9;?]*[A-HJKhl])+$/;

export function extractFrame(chunk: string): string[] | null {
  const body = chunk.replace(LEADING_CONTROL, '').replace(TRAILING_CONTROL, '');
  if (!body.includes('\n')) return null;
  return body.split('\n');
}

export function installFrameCapture() {
  const stdout = process.stdout;
  const original = stdout.write.bind(stdout) as (...args: unknown[]) => boolean;
  (stdout as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
    const result = original(...args);
    const chunk = args[0];
    if (!writingOverlay && typeof chunk === 'string') {
      const lines = extractFrame(chunk);
      if (lines) {
        frame = lines;
        plainCache = [];
        for (const listener of listeners) listener();
      }
    }
    return result;
  };
}

/** Called after every captured frame, once the frame is on the terminal. */
export function onFrame(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Write to the terminal without the chunk being mistaken for an Ink frame. */
export function writeOverlay(data: string) {
  writingOverlay = true;
  try {
    process.stdout.write(data);
  } finally {
    writingOverlay = false;
  }
}

export function frameLines(): readonly string[] {
  return frame;
}

function rowOffset(): number {
  // Frames are bottom-anchored: a frame shorter than the terminal sits at the
  // bottom, one taller than it has scrolled its first lines away.
  const rows = process.stdout.rows ?? frame.length;
  return frame.length - rows;
}

/** 1-based terminal row to frame line index. May fall outside the frame. */
export function rowToLine(row: number): number {
  return row - 1 + rowOffset();
}

/** Frame line index to 1-based terminal row. */
export function lineToRow(line: number): number {
  return line + 1 - rowOffset();
}

export function lineText(line: number): string {
  const cached = plainCache[line];
  if (cached !== undefined) return cached;
  const plain = stripAnsi(frame[line] ?? '');
  plainCache[line] = plain;
  return plain;
}

export function lineWidth(line: number): number {
  return stringWidth(lineText(line));
}

const segmenter = new Intl.Segmenter();

/**
 * Slice plain text by display columns [from, to). A grapheme is included when
 * it starts inside the range, so a wide character straddling the boundary is
 * kept whole rather than split.
 */
export function sliceColumns(plain: string, from: number, to: number): string {
  let column = 0;
  let out = '';
  for (const { segment } of segmenter.segment(plain)) {
    if (column >= to) break;
    if (column >= from) out += segment;
    column += stringWidth(segment);
  }
  return out;
}
