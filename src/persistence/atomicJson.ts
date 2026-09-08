import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

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
