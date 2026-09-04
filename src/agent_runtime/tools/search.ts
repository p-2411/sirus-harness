import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { throwIfAborted } from '../../abort';
import { errorMessage, requiredString } from './arguments';
import type { ToolCallContext } from './types';

const SKIPPED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', 'coverage', '.cache', '.next',
]);
// Environment files hold secrets; a broad pattern must not echo them into
// the transcript.
const isEnvironmentFile = (name: string) => name === '.env' || name.startsWith('.env.');
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const LINE_PREVIEW_CHARS = 200;

// Content search that yields between files, so Escape can stop a walk of a
// large tree the same way it stops a shell command.
export async function searchFiles(
  args: Record<string, unknown>,
  directory: string,
  call?: ToolCallContext,
): Promise<string> {
  const source = requiredString(args, 'pattern', 'SearchFiles');
  let pattern: RegExp;
  try {
    pattern = new RegExp(source);
  } catch (error) {
    throw new Error(`SearchFiles pattern is not a valid regular expression: ${errorMessage(error)}`);
  }
  const root = path.resolve(directory, requiredString(args, 'path', 'SearchFiles'));
  const signal = call?.signal;
  const displayPath = (file: string) => {
    const relative = path.relative(directory, file);
    return relative === '' ? '.' : relative.startsWith('..') ? file : relative;
  };

  const matches: string[] = [];
  let searchedFiles = 0;
  let matchedFiles = 0;
  let truncated = false;

  const searchFile = async (file: string) => {
    throwIfAborted(signal);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
    const buffer = await readFile(file);
    if (buffer.subarray(0, 8192).includes(0)) return;
    searchedFiles++;
    const lines = buffer.toString('utf8').split('\n');
    let matchedHere = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/\r$/, '');
      if (!pattern.test(line)) continue;
      if (!matchedHere) {
        matchedHere = true;
        matchedFiles++;
      }
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        return;
      }
      const preview = line.length > LINE_PREVIEW_CHARS
        ? `${line.slice(0, LINE_PREVIEW_CHARS)}…`
        : line;
      matches.push(`${displayPath(file)}:${index + 1}: ${preview}`);
    }
  };
  const walk = async (current: string) => {
    throwIfAborted(signal);
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(full);
      } else if (entry.isFile() && !isEnvironmentFile(entry.name)) {
        await searchFile(full);
      }
    }
  };

  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    throw new Error(`SearchFiles could not find ${root}`);
  }
  if (rootInfo.isDirectory()) await walk(root);
  else await searchFile(root);

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (matches.length === 0) {
    return `No matches for /${source}/ under ${displayPath(root)} (${plural(searchedFiles, 'file')} searched).`;
  }
  const summary = `${matches.length}${truncated ? '+' : ''} ${matches.length === 1 && !truncated ? 'match' : 'matches'} in ${
    plural(matchedFiles, 'file')} (${plural(searchedFiles, 'file')} searched)${
    truncated ? `; showing the first ${MAX_MATCHES}` : ''}`;
  return [summary, ...matches].join('\n');
}
