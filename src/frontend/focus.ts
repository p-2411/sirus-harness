// Ink calls every useInput handler for each key, so a component that wants
// the arrow keys to itself (the input bar's menu or secret prompt) raises this
// flag and the sidebar's session switching stands down while it is up.
let captured = false;

export function captureArrowKeys(on: boolean): void {
  captured = on;
}

export function arrowKeysCaptured(): boolean {
  return captured;
}
