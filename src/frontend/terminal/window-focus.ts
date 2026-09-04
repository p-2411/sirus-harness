// Focus reporting (DECSET 1004): the terminal sends CSI I when its window
// gains focus and CSI O when it loses it. Ink strips the leading ESC, so the
// sequences reach useInput as the bare "[I" and "[O".

export const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
export const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';

export type FocusEvent = 'in' | 'out';

// Null until the terminal has reported anything: a terminal without focus
// reporting never does, and the difference matters to notifications.
let focused: boolean | null = null;

export function parseFocusEvent(input: string): FocusEvent | null {
  const body = input.startsWith('\x1b') ? input.slice(1) : input;
  if (body === '[I') return 'in';
  if (body === '[O') return 'out';
  return null;
}

export function isFocusInput(input: string): boolean {
  return parseFocusEvent(input) !== null;
}

export function recordFocusEvent(event: FocusEvent): void {
  focused = event === 'in';
}

export function terminalFocused(): boolean | null {
  return focused;
}

export function resetFocusState(): void {
  focused = null;
}
