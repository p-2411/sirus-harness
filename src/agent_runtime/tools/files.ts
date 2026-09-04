import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { requiredString } from './arguments';

export function readFile(args: Record<string, unknown>, directory: string): string {
  const filePath = path.resolve(directory, requiredString(args, 'path', 'ReadFile'));
  return readFileSync(filePath, 'utf8');
}

export function writeFile(args: Record<string, unknown>, directory: string): Record<string, unknown> {
  const filePath = path.resolve(directory, requiredString(args, 'path', 'WriteFile'));
  const content = requiredString(args, 'content', 'WriteFile', true);
  const created = !existsSync(filePath);

  writeFileSync(filePath, content, 'utf8');
  return {
    path: filePath,
    created,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
  };
}

export function editFile(args: Record<string, unknown>, directory: string): Record<string, unknown> {
  const filePath = path.resolve(directory, requiredString(args, 'path', 'EditFile'));
  const oldText = requiredString(args, 'old_text', 'EditFile');
  const newText = requiredString(args, 'new_text', 'EditFile', true);
  const content = readFileSync(filePath, 'utf8');
  const firstMatch = content.indexOf(oldText);

  if (firstMatch === -1) {
    throw new Error(`EditFile could not find old_text in ${filePath}`);
  }
  if (content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
    throw new Error(`EditFile found multiple old_text matches in ${filePath}; include more surrounding context`);
  }

  const updated = content.slice(0, firstMatch) + newText + content.slice(firstMatch + oldText.length);
  writeFileSync(filePath, updated, 'utf8');
  return {
    path: filePath,
    replacements: 1,
    bytesWritten: Buffer.byteLength(updated, 'utf8'),
  };
}
