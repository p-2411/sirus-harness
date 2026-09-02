export type MouseButton = 'left' | 'middle' | 'right' | 'none';

export interface MouseEvent {
  kind: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  button: MouseButton;
  /** Only set for wheel events. */
  direction?: 'up' | 'down';
  /** 1-based terminal column. */
  column: number;
  /** 1-based terminal row. */
  row: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface MouseWheelEvent {
  direction: 'up' | 'down';
  column: number;
  row: number;
}

// SGR (1006) encoding: ESC [ < code ; column ; row M|m — 'M' is a press or
// motion, 'm' a release. Ink strips the leading ESC before handing the
// sequence to useInput, so both shapes are accepted.
const SGR_MOUSE_PATTERN = /^\[<(\d+);(\d+);(\d+)([Mm])$/;
const BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right', 'none'];

function normalizedInput(input: string): string {
  return input.startsWith('\x1b') ? input.slice(1) : input;
}

export function isMouseInput(input: string): boolean {
  return SGR_MOUSE_PATTERN.test(normalizedInput(input));
}

export function parseMouseEvent(input: string): MouseEvent | null {
  const match = SGR_MOUSE_PATTERN.exec(normalizedInput(input));
  if (!match) return null;

  const code = Number(match[1]);
  const isRelease = match[4] === 'm';
  const base = {
    column: Number(match[2]),
    row: Number(match[3]),
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };

  if ((code & 64) !== 0) {
    const direction = code & 3;
    // 2 and 3 are horizontal wheel; releases are never reported for wheels
    if (direction > 1 || isRelease) return null;
    return { kind: 'wheel', button: 'none', direction: direction === 0 ? 'up' : 'down', ...base };
  }

  const button = BUTTONS[code & 3];
  if ((code & 32) !== 0) {
    // motion is a drag while a button is held, otherwise a plain move (1003)
    return { kind: button === 'none' ? 'move' : 'drag', button, ...base };
  }
  return { kind: isRelease ? 'release' : 'press', button, ...base };
}

export function parseMouseWheel(input: string): MouseWheelEvent | null {
  const event = parseMouseEvent(input);
  if (!event || event.kind !== 'wheel' || !event.direction) return null;
  return { direction: event.direction, column: event.column, row: event.row };
}

// 1000: report presses and releases. 1002: also report motion while a button
// is held, which is what drag-selection needs. 1003: report all motion, for
// hover. 1006: SGR coordinates, so columns past 223 and modifier bits survive.
export const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
export const DISABLE_MOUSE_TRACKING = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
