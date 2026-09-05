import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);
const MAX_FILES = 20_000;

export interface FileMention {
  start: number;
  end: number;
  query: string;
}

function protectedText(text: string): boolean {
  let quote: string | null = null;
  let code = 0;
  let codeCharacter = '`';
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '\\') {
      index++;
      continue;
    }
    if (code) {
      if (character !== codeCharacter) continue;
      let length = 1;
      while (text[index + length] === codeCharacter) length++;
      if (length === code) code = 0;
      index += length - 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '`') {
      codeCharacter = '`';
      code = 1;
      while (text[index + code] === '`') code++;
      index += code - 1;
    } else if (character === '~' && text.slice(index, index + 3) === '~~~'
      && /^ {0,3}$/.test(text.slice(text.lastIndexOf('\n', index - 1) + 1, index))) {
      codeCharacter = '~';
      code = 3;
      while (text[index + code] === '~') code++;
      index += code - 1;
    } else if ('"“‘\''.includes(character)) {
      if (character === "'" && /\w/.test(text[index - 1] ?? '') && /\w/.test(text[index + 1] ?? '')) continue;
      quote = character === '“' ? '”' : character === '‘' ? '’' : character;
    }
  }
  return quote !== null || code > 0;
}

/** The unfinished file token being edited, without treating email addresses as mentions. */
export function activeFileMention(input: string, cursor: number): FileMention | null {
  const position = Math.max(0, Math.min(input.length, cursor));
  const prefix = input.slice(0, position);
  const match = /(?:^|[\s([{])@(?:"([^"\n]*)|([^\s@"'`<>]*))$/.exec(prefix);
  if (!match) return null;
  const start = match.index + (match[0]!.startsWith('@') ? 0 : 1);
  if (protectedText(input.slice(0, start))) return null;
  const quoted = match[1] !== undefined;
  const query = match[1] ?? match[2] ?? '';
  let end = position;
  if (quoted) {
    while (end < input.length && input[end] !== '"' && input[end] !== '\n') end++;
    if (input[end] === '"') end++;
  } else {
    while (end < input.length && !/[\s@"'`<>]/.test(input[end]!)) end++;
  }
  return { start, end, query };
}

function visibleFile(file: string): boolean {
  if (!file || path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) return false;
  const segments = file.split('/');
  if (segments.some(segment => segment === '..' || excludedDirectories.has(segment))) return false;
  const name = segments.at(-1)!;
  return name !== '.env' && (!name.startsWith('.env.') || name === '.env.example');
}

function normalizeFiles(output: string): string[] {
  return [...new Set(output.split('\0').filter(visibleFile))].sort().slice(0, MAX_FILES);
}

async function walkFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const directories = [{ relative: '', depth: 0 }];
  let visited = 0;
  while (directories.length && visited < MAX_FILES && files.length < MAX_FILES) {
    signal?.throwIfAborted();
    const current = directories.pop()!;
    let entries;
    try {
      entries = await readdir(path.join(directory, current.relative), { withFileTypes: true });
    } catch (error) {
      if (!current.relative) throw error;
      continue;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (++visited > MAX_FILES) break;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (!visibleFile(relative)) continue;
      if (entry.isFile()) files.push(relative);
      else if (entry.isDirectory() && current.depth < 20) {
        directories.push({ relative, depth: current.depth + 1 });
      }
    }
  }
  return files.sort();
}

/** List only the working directory's files, using ignore-aware tools when available. */
export async function listProjectFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
  const options = { cwd: directory, signal, encoding: 'utf8' as const, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 };
  try {
    const result = await runFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], options);
    return normalizeFiles(result.stdout);
  } catch {
    signal?.throwIfAborted();
  }
  try {
    const result = await runFile('rg', ['--files', '-0', '--hidden', '-g', '!.git'], options);
    return normalizeFiles(result.stdout);
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as { code?: string | number }).code === 1) return [];
  }
  return walkFiles(directory, signal);
}

/** Parent/absolute browsing is activated only by an explicit pathname query. */
export function fileSearchDirectory(directory: string, query: string): string {
  if (!query.startsWith('../') && !path.isAbsolute(query)) return path.resolve(directory);
  return path.resolve(directory, query.endsWith('/') ? query : path.dirname(query));
}

export async function listMentionFiles(
  directory: string,
  browseDirectory: string,
  absoluteReferences: boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  let root = browseDirectory;
  if (root === path.resolve(directory)) {
    const files = await listProjectFiles(root, signal);
    return absoluteReferences ? files.map(file => path.join(root, file)) : files;
  }
  while (true) {
    signal?.throwIfAborted();
    try {
      if ((await stat(root)).isDirectory()) break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(root);
    if (parent === root) return [];
    root = parent;
  }
  const files = await listProjectFiles(root, signal);
  return files.map(file => absoluteReferences
    ? path.join(root, file)
    : path.relative(directory, path.join(root, file)));
}

export function matchFileSuggestions(files: readonly string[], query: string, limit = 50, directory?: string): string[] {
  let relativeQuery = query.startsWith('../') || path.isAbsolute(query) ? path.normalize(query) : query;
  // Raw project listings use relative paths, while explicit absolute browsing
  // already returns absolute references for insertion into the editor.
  if (path.isAbsolute(query) && !files.some(file => path.isAbsolute(file))) {
    if (!directory) return [];
    relativeQuery = path.relative(path.resolve(directory), query);
  }
  const normalized = relativeQuery.replace(/^\.\//, '').toLocaleLowerCase();
  return files
    .map(file => {
      const lower = file.toLocaleLowerCase();
      const basename = lower.slice(lower.lastIndexOf('/') + 1);
      const rank = lower.startsWith(normalized) ? 0 : basename.startsWith(normalized) ? 1 : lower.includes(normalized) ? 2 : 3;
      return { file, rank };
    })
    .filter(item => item.rank < 3)
    .sort((left, right) => left.rank - right.rank || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .slice(0, limit)
    .map(item => item.file);
}
