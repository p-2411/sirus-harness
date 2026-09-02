import { readFileSync } from 'fs';
import { join } from 'path';

// Real-pixel rendering of the horse via terminal graphics protocols.
// Ink can only lay out text cells, so components render an empty placeholder
// box and register its cell region here; after every frame flush the actual
// PNG is overlaid onto those cells. Terminals without a graphics protocol
// keep the glyph-art fallback.

export type ImageProtocol = 'iterm' | 'kitty' | null;

function detect(): ImageProtocol {
  const env = process.env;
  if (env.TMUX) return null; // would need passthrough wrapping
  const term = env.TERM ?? '';
  if (env.KITTY_WINDOW_ID || term.includes('kitty') || term.includes('ghostty') || env.GHOSTTY_RESOURCES_DIR) return 'kitty';
  const tp = env.TERM_PROGRAM ?? '';
  if (tp === 'iTerm.app' || tp === 'WezTerm' || tp === 'vscode' || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  return null;
}

export const protocol: ImageProtocol = detect();

export interface Region { col: number; row: number; cols: number; rows: number }

const regions = new Map<string, Region>();

let horseB64: string | null = null;
function horse(): string {
  horseB64 ??= readFileSync(join(import.meta.dir, 'assets', 'horse-crisp.png')).toString('base64');
  return horseB64;
}

export function setRegion(name: string, region: Region | null) {
  if (region) regions.set(name, region);
  else regions.delete(name);
  scheduleDraw();
}

const ESC = '\x1b';
const KITTY_IMAGE_ID = 77;
let kittyTransmitted = false;

function drawEscapes(): string {
  const b64 = horse();
  let out = `${ESC}7`; // save cursor
  if (protocol === 'kitty') {
    if (!kittyTransmitted) {
      // transmit the PNG once, in 4KB chunks; placements reference it by id
      for (let i = 0; i < b64.length; i += 4096) {
        const last = i + 4096 >= b64.length;
        const ctl = i === 0 ? `a=t,f=100,i=${KITTY_IMAGE_ID},q=2,m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
        out += `${ESC}_G${ctl};${b64.slice(i, i + 4096)}${ESC}\\`;
      }
      kittyTransmitted = true;
    }
    // kitty images float above text and survive erases, so clear old
    // placements before placing at the current regions
    out += `${ESC}_Ga=d,d=i,i=${KITTY_IMAGE_ID},q=2${ESC}\\`;
    for (const r of regions.values()) {
      out += `${ESC}[${r.row};${r.col}H${ESC}_Ga=p,i=${KITTY_IMAGE_ID},c=${r.cols},r=${r.rows},q=2${ESC}\\`;
    }
  } else if (protocol === 'iterm') {
    for (const r of regions.values()) {
      out += `${ESC}[${r.row};${r.col}H${ESC}]1337;File=inline=1;width=${r.cols};height=${r.rows};preserveAspectRatio=1:${b64}\x07`;
    }
  }
  out += `${ESC}8`; // restore cursor
  return out;
}

let emitting = false;
let scheduled = false;

export function scheduleDraw() {
  if (!protocol || scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    if (regions.size === 0) return;
    emitting = true;
    process.stdout.write(drawEscapes());
    emitting = false;
  });
}

export function installOverlay() {
  if (!protocol) return;
  const original = process.stdout.write.bind(process.stdout);
  // Ink repaints the whole frame on any update, wiping the images, and the
  // repaint can be triggered by components this module never hears about —
  // so redraw after every foreign stdout write.
  (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (...args: unknown[]) => {
    const result = (original as (...a: unknown[]) => boolean)(...args);
    if (!emitting) scheduleDraw();
    return result;
  };
}
