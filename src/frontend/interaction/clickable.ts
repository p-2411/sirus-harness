import { useEffect, useRef, useState, type RefObject } from 'react';
import { measureElement, type DOMElement } from 'ink';
import type { Cell } from './selection';

// Mouse targets: Boxes that react to hover and clicks. Like selection
// containers they are measured live, so nothing has to be kept in sync with
// layout changes.

type ElementRef = RefObject<DOMElement | null>;

interface Target {
  onClick: () => void;
  setHovered: (hovered: boolean) => void;
  hovered: boolean;
}

const targets = new Map<ElementRef, Target>();
// where the current left-button press landed, so the click fires only if the
// release lands on the same target
let pressed: ElementRef | null = null;

/** Area of the target under the cell, or null when it is not under it. */
function hitArea(ref: ElementRef, cell: Cell): number | null {
  if (!ref.current) return null;
  const { x, y, width, height } = measureElement(ref.current);
  let left = x, right = x + width, top = y, bottom = y + height;
  // A scrolled-out option must not answer clicks on the card around it.
  for (let parent = ref.current.parentNode; parent; parent = parent.parentNode) {
    if (parent.style.display === 'none') return null;
    const clipsX = parent.style.overflowX === 'hidden';
    const clipsY = parent.style.overflowY === 'hidden';
    if (!clipsX && !clipsY) continue;
    const bounds = measureElement(parent);
    if (clipsX) { left = Math.max(left, bounds.x); right = Math.min(right, bounds.x + bounds.width); }
    if (clipsY) { top = Math.max(top, bounds.y); bottom = Math.min(bottom, bounds.y + bounds.height); }
  }
  const inside = cell.col >= left && cell.col < right && cell.line >= top && cell.line < bottom;
  return inside ? (right - left) * (bottom - top) : null;
}

function hit(ref: ElementRef, cell: Cell): boolean {
  return hitArea(ref, cell) !== null;
}

/** Targets may nest (a button inside a row); the innermost one takes the click. */
function targetAt(cell: Cell): ElementRef | null {
  let best: { ref: ElementRef; area: number } | null = null;
  for (const ref of targets.keys()) {
    const area = hitArea(ref, cell);
    if (area !== null && (!best || area < best.area)) best = { ref, area };
  }
  return best?.ref ?? null;
}

/** Pointer moved with no button held: update hover state where it changed. */
export function moveAt(cell: Cell) {
  for (const [ref, target] of targets) {
    const hovered = hit(ref, cell);
    if (hovered !== target.hovered) {
      target.hovered = hovered;
      target.setHovered(hovered);
    }
  }
}

/** Returns true when the press landed on a target and should not start a selection. */
export function pressAt(cell: Cell): boolean {
  pressed = targetAt(cell);
  return pressed !== null;
}

/** Returns true when a press on a target is in progress, so drags are ignored. */
export function isPressingTarget(): boolean {
  return pressed !== null;
}

/** Returns true when the release completed a click on a target. */
export function releaseAt(cell: Cell): boolean {
  const ref = pressed;
  pressed = null;
  if (!ref) return false;
  if (hit(ref, cell)) targets.get(ref)?.onClick();
  return true;
}

/**
 * Make a Box a mouse target. Returns whether the pointer is over it, so the
 * component can restyle itself on hover.
 */
export function useClickable(ref: ElementRef, onClick: () => void): boolean {
  const [hovered, setHovered] = useState(false);
  // survives re-registration when onClick changes identity between renders
  const hoveredRef = useRef(false);
  useEffect(() => {
    targets.set(ref, {
      onClick,
      hovered: hoveredRef.current,
      setHovered: value => {
        hoveredRef.current = value;
        setHovered(value);
      },
    });
    return () => {
      targets.delete(ref);
      if (pressed === ref) pressed = null;
    };
  }, [ref, onClick]);
  return hovered;
}
