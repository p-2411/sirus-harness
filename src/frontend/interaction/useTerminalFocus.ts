import { useEffect } from 'react';
import { useInput, useStdout } from 'ink';
import {
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  parseFocusEvent,
  recordFocusEvent,
  resetFocusState,
} from '../terminal/window-focus';

// Asks the terminal to report window focus for as long as the app runs and
// keeps the answer where notifications can read it. Mount once, at the top.
export function useTerminalFocus() {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write(ENABLE_FOCUS_REPORTING);
    return () => {
      stdout.write(DISABLE_FOCUS_REPORTING);
      resetFocusState();
    };
  }, [stdout]);

  useInput(input => {
    const event = parseFocusEvent(input);
    if (event) recordFocusEvent(event);
  });
}
