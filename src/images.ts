import crypto from 'crypto';
import { execFile } from 'child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { dataDirectory } from './persistence';
import type { ImageBlock, ImageMediaType } from './agent_runtime/types';

// Images the user attaches to a message. Each one is copied into the
// application-state directory under a fresh name, so the history can refer
// to it by path long after the clipboard or the original file has changed.

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const CLIPBOARD_TIMEOUT_MS = 15_000;

export function imagesDirectory(): string {
  return path.join(dataDirectory(), 'images');
}

// The format is read off the bytes, not the file name, so a screenshot saved
// with the wrong extension still goes to the model as what it is.
export function detectImageType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeImage(image: ImageBlock): string {
  return `image · ${formatBytes(image.bytes)} · ${EXTENSIONS[image.mediaType]}`;
}

function storeImage(bytes: Buffer, source: string): ImageBlock {
  const mediaType = detectImageType(bytes);
  if (!mediaType) throw new Error(`${source} is not a PNG, JPEG, GIF, or WebP image.`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`${source} is ${formatBytes(bytes.length)}; images are limited to ${formatBytes(MAX_IMAGE_BYTES)}.`);
  }
  const directory = imagesDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${crypto.randomUUID()}.${EXTENSIONS[mediaType]}`);
  // Write the bytes that were validated rather than copying the source path,
  // which may have changed between reading and storage. Attachments are private.
  writeFileSync(target, bytes, { mode: 0o600 });
  return { type: 'image', path: target, mediaType, bytes: bytes.length };
}

// Attaches an image file from disk (a saved screenshot, a dragged-in path).
export function attachImageFile(file: string, directory: string = process.cwd()): ImageBlock {
  const expanded = file === '~' || file.startsWith('~/')
    ? path.join(os.homedir(), file.slice(1))
    : file;
  const resolved = path.resolve(directory, expanded);
  let size: number;
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    throw new Error(`Could not read ${resolved}.`);
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`${resolved} is ${formatBytes(size)}; images are limited to ${formatBytes(MAX_IMAGE_BYTES)}.`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch {
    throw new Error(`Could not read ${resolved}.`);
  }
  return storeImage(bytes, resolved);
}

function readStoredImage(image: ImageBlock): { resolved: string; bytes: Buffer } {
  const root = path.resolve(imagesDirectory());
  const resolved = path.resolve(image.path);
  // Stored attachments are direct children. Reject nested paths too, since
  // an intermediate directory could be a symlink outside the store.
  if (path.dirname(resolved) !== root) {
    throw new Error('Attached image path is outside the Sirus image store.');
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Attached image is not a regular stored file.');
  if (stat.size > MAX_IMAGE_BYTES || stat.size !== image.bytes) {
    throw new Error('Attached image no longer matches its stored metadata.');
  }
  const bytes = readFileSync(resolved);
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length !== image.bytes || detectImageType(bytes) !== image.mediaType) {
    throw new Error('Attached image no longer matches its stored metadata.');
  }
  return { resolved, bytes };
}

export function validatedImagePath(image: ImageBlock): string {
  return readStoredImage(image).resolved;
}

// The bytes of an attached image, base64-encoded for a provider request.
// Revalidate persisted metadata before reading so a modified sessions file
// cannot turn an image attachment into an arbitrary local-file read.
export function imageData(image: ImageBlock): string {
  return readStoredImage(image).bytes.toString('base64');
}

export function removeStoredImage(image: ImageBlock): void {
  try {
    unlinkSync(validatedImagePath(image));
  } catch {
    // Missing, invalid, or already-removed draft attachments need no cleanup.
  }
}

export function imageDataUrl(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${imageData(image)}`;
}

function run(command: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: CLIPBOARD_TIMEOUT_MS, maxBuffer: MAX_IMAGE_BYTES * 2, encoding: 'buffer' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// The system clipboard's image, written to a temporary PNG by the platform's
// own tooling: AppleScript on macOS, wl-paste or xclip on Linux.
async function clipboardImageFile(directory: string): Promise<string> {
  const target = path.join(directory, 'clipboard.png');
  if (process.platform === 'darwin') {
    try {
      await run('osascript', [
        '-e', 'set png to (the clipboard as «class PNGf»)',
        '-e', `set f to open for access POSIX file ${JSON.stringify(target)} with write permission`,
        '-e', 'set eof f to 0',
        '-e', 'write png to f',
        '-e', 'close access f',
      ]);
    } catch {
      try { unlinkSync(target); } catch { /* nothing was written */ }
      throw new Error('The clipboard does not contain an image.');
    }
    return target;
  }
  if (process.platform === 'linux') {
    const attempts: Array<[string, string[]]> = process.env.WAYLAND_DISPLAY
      ? [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]]
      : [['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']], ['wl-paste', ['--type', 'image/png']]];
    let missing = 0;
    for (const [command, args] of attempts) {
      try {
        const bytes = await run(command, args);
        if (bytes.length === 0) continue;
        writeFileSync(target, bytes, { mode: 0o600 });
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing++;
      }
    }
    throw new Error(missing === attempts.length
      ? 'Reading clipboard images needs wl-paste (Wayland) or xclip (X11) installed.'
      : 'The clipboard does not contain an image.');
  }
  throw new Error(`Clipboard images are not supported on ${process.platform}.`);
}

export async function attachClipboardImage(): Promise<ImageBlock> {
  // The native clipboard tool may use its default file permissions, so keep
  // its output inside a private temporary directory until it is stored.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-clipboard-'));
  try {
    const file = await clipboardImageFile(directory);
    return storeImage(readFileSync(file), 'The clipboard image');
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // the temporary file is gone already
    }
  }
}
