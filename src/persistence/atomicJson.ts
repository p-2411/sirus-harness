import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { dataDirectory } from '../dataDirectory';

// Every file Sirus owns is read and written through here: a missing or
// unreadable file is `null` rather than a throw, and a write lands whole or
// not at all. Failure is a `false`, never an exception, so a full disk or a
// read-only home never takes the app down.

export function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function writeJson(filePath: string, value: unknown): boolean {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, filePath);
    return true;
  } catch {
    return false;
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A failed cleanup should not turn persistence into an app failure.
      }
    }
  }
}

// A file under the data directory that is read once and kept in memory after,
// for the caches the UI consults on every render. It is read again when the
// data directory changes, as it does between tests.
export interface CachedJsonFile<T> {
  read(): T;
  write(value: T): void;
}

export function cachedJsonFile<T>(
  name: string,
  parse: (stored: unknown) => T,
  serialize: (value: T) => unknown = value => value,
): CachedJsonFile<T> {
  let cached: { file: string; value: T } | null = null;
  return {
    read() {
      const file = path.join(dataDirectory(), name);
      if (cached?.file !== file) cached = { file, value: parse(readJson(file)) };
      return cached.value;
    },
    write(value) {
      cached = { file: path.join(dataDirectory(), name), value };
      writeJson(cached.file, serialize(value));
    },
  };
}

// A file that is there but that this build cannot read, a hand edit that broke
// the JSON or a version it does not know, is renamed beside itself before
// anything is written over it, so what it held can still be recovered. True
// once nothing is left at the path; a caller that gets `false` must not write.
export function setAside(filePath: string): boolean {
  try {
    renameSync(filePath, `${filePath}.unreadable-${Date.now()}`);
    return true;
  } catch {
    return !existsSync(filePath);
  }
}
