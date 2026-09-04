import { useEffect, type RefObject } from 'react';
import { useInput, useStdout, type DOMElement } from 'ink';
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, parseMouseEvent } from './mouse';
import { rowToLine } from '../terminal/screen';
import { isPressingTarget, moveAt, pressAt, releaseAt } from './clickable';
import {
  beginSelection, clearSelection, endSelection, extendSelection, registerSelectionRegion,
  type RegionOptions,
} from './selection';

/**
 * Mark a Box as a selection container: a drag that starts inside it stays
 * inside it. Containers may nest; a drag is clipped to all of the ones under
 * its starting cell. Pass `follows` when the text inside moves independently
 * of the container (a scrolling content box): the selection then tracks that
 * element, so scrolling carries the highlight along with the text. Pass `text`
 * to make copying cover content scrolled out of view.
 */
export function useSelectionRegion(ref: RefObject<DOMElement | null>, options?: RegionOptions) {
  const follows = options?.follows;
  const text = options?.text;
  useEffect(() => registerSelectionRegion(ref, { follows, text }), [ref, follows, text]);
}

/**
 * Owns mouse tracking for the app: hover and clicks go to registered targets,
 * left-button drags elsewhere become a text selection. Mount once, at the top
 * of the tree.
 */
export function useTextSelection() {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write(ENABLE_MOUSE_TRACKING);
    return () => {
      stdout.write(DISABLE_MOUSE_TRACKING);
    };
  }, [stdout]);

  useInput((input, key) => {
    if (key.escape) {
      clearSelection();
      return;
    }
    const event = parseMouseEvent(input);
    if (!event) return;
    // wheel scrolling is Chat's business; the selection follows the content
    if (event.kind === 'wheel') return;
    const cell = { line: rowToLine(event.row), col: event.column - 1 };
    if (event.kind === 'move') {
      moveAt(cell);
      return;
    }
    // modified clicks are the terminal's own selection path; leave them alone
    if (event.button !== 'left' || event.shift) return;

    if (event.kind === 'press') {
      if (!pressAt(cell)) beginSelection(cell);
    } else if (event.kind === 'drag') {
      if (!isPressingTarget()) extendSelection(cell);
    } else if (!releaseAt(cell)) {
      endSelection(cell);
    }
  });
}
