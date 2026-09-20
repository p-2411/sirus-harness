import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  attachImageFile, detectImageType, imageData, imageDataUrl, imagesDirectory,
  MAX_IMAGE_BYTES, removeStoredImage, validatedImagePath,
} from '../src/images';
import { Session } from '../src/agent_runtime/session';
import { loadSessionSnapshots, saveSessionSnapshots } from '../src/persistence';
import type { ImageBlock } from '../src/agent_runtime/types';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
let directory: string;
let previousDataDirectory: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-images-test-'));
  previousDataDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = path.join(directory, 'state');
});

afterEach(() => {
  if (previousDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = previousDataDirectory;
  rmSync(directory, { recursive: true, force: true });
});

function attach(): ImageBlock {
  writeFileSync(path.join(directory, 'screenshot.wrong-extension'), PNG);
  return attachImageFile('screenshot.wrong-extension', directory);
}

describe('image storage', () => {
  test('detects supported types from bytes and rejects unknown signatures', () => {
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectImageType(Buffer.from('GIF87a'))).toBe('image/gif');
    expect(detectImageType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(detectImageType(Buffer.from('RIFF1234WEBP'))).toBe('image/webp');
    expect(detectImageType(Buffer.from('not an image'))).toBeNull();
    expect(detectImageType(PNG.subarray(0, 7))).toBeNull();
  });

  test('copies attachment bytes privately so removing the original preserves history', () => {
    const image = attach();
    const other = attach();
    expect(image.path).not.toBe(other.path);
    expect(path.dirname(image.path)).toBe(imagesDirectory());
    expect(image.mediaType).toBe('image/png');
    expect(image.bytes).toBe(PNG.length);
    expect(statSync(image.path).mode & 0o777).toBe(0o600);
    unlinkSync(path.join(directory, 'screenshot.wrong-extension'));
    expect(imageData(image)).toBe(PNG.toString('base64'));
    expect(imageDataUrl(image)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  test('rejects missing files, directories, non-images, and oversized files', () => {
    expect(() => attachImageFile('missing', directory)).toThrow(/Could not read/);
    expect(() => attachImageFile(directory)).toThrow(/Could not read/);
    const invalid = path.join(directory, 'fake.png');
    writeFileSync(invalid, 'not an image');
    expect(() => attachImageFile(invalid)).toThrow(/not a PNG/);
    truncateSync(invalid, MAX_IMAGE_BYTES + 1);
    expect(() => attachImageFile(invalid)).toThrow(/limited to/);
    expect(existsSync(imagesDirectory())).toBe(false);
  });

  test('rejects modified attachment metadata and changed file contents', () => {
    const image = attach();
    expect(() => imageData({ ...image, bytes: image.bytes + 1 })).toThrow(/metadata/);
    expect(() => validatedImagePath({ ...image, mediaType: 'image/jpeg' })).toThrow(/metadata/);
    writeFileSync(image.path, Buffer.alloc(image.bytes));
    expect(() => imageData(image)).toThrow(/metadata/);
    expect(() => validatedImagePath(image)).toThrow(/metadata/);
  });

  test('cannot read or remove outside files through persisted paths or symlinks', () => {
    const image = attach();
    const original = path.join(directory, 'screenshot.wrong-extension');
    const linkedFile = path.join(imagesDirectory(), 'linked.png');
    symlinkSync(original, linkedFile);
    const linkedDirectory = path.join(imagesDirectory(), 'linked-directory');
    symlinkSync(directory, linkedDirectory);
    for (const unsafePath of [original, linkedFile, path.join(linkedDirectory, path.basename(original))]) {
      const unsafe = { ...image, path: unsafePath };
      expect(() => imageData(unsafe)).toThrow();
      expect(() => validatedImagePath(unsafe)).toThrow();
      removeStoredImage(unsafe);
      expect(existsSync(unsafePath)).toBe(true);
    }
    expect(readFileSync(original)).toEqual(PNG);
  });

  test('removes discarded drafts and tolerates repeated cleanup', () => {
    const image = attach();
    removeStoredImage(image);
    expect(existsSync(image.path)).toBe(false);
    expect(() => removeStoredImage(image)).not.toThrow();
  });

  test('persists image-only sessions using metadata and reloads usable attachments', () => {
    const image = attach();
    const session = new Session({ id: 'image-session', name: 'Screenshot', directory, model: 'gpt-5.6-sol' });
    session.append({ role: 'user', content: [image] });
    expect(saveSessionSnapshots([session].filter(s => !s.isEmpty()).map(s => s.toSnapshot()), session.getId())).toBe(true);
    const saved = readFileSync(path.join(process.env.SIRUS_DATA_DIR!, 'sessions.json'), 'utf8');
    expect(saved).not.toContain(PNG.toString('base64'));
    const restored = loadSessionSnapshots();
    expect(restored.selectedSessionId).toBe(session.getId());
    const content = restored.snapshots[0]!.messages[0]!.content;
    expect(content).toEqual([image]);
    expect(imageData(content[0] as ImageBlock)).toBe(PNG.toString('base64'));
  });
});
