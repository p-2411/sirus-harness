import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
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
  // A chosen quoted directory stays open: what is typed after its closing
  // quote continues the path inside it.
  const match = /(?:^|[\s([{])@(?:"([^"\n]*)|"([^"\n]*\/)"([^\s@"'`<>]*)|([^\s@"'`<>]*))$/.exec(prefix);
  if (!match) return null;
  const start = match.index + (match[0]!.startsWith('@') ? 0 : 1);
  if (protectedText(input.slice(0, start))) return null;
  const quoted = match[1] !== undefined;
  const query = match[1] ?? (match[2] !== undefined ? match[2] + match[3] : match[4] ?? '');
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

// The folders holding the listed files, each ending in '/', so a directory
// can be mentioned too. Folders with nothing listable stay out, as ignored
// files do.
function withDirectories(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) {
      directories.add(file.slice(0, slash + 1));
    }
  }
  return [...files, ...[...directories].sort()];
}

/** Files and folders to suggest for an @ mention; folder references end in '/'. */
export async function listMentionFiles(
  directory: string,
  browseDirectory: string,
  absoluteReferences: boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  let root = browseDirectory;
  if (root === path.resolve(directory)) {
    const entries = withDirectories(await listProjectFiles(root, signal));
    return absoluteReferences ? entries.map(entry => path.join(root, entry)) : entries;
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
  // The browsed folder is a suggestion too, so a typed ../proj/ can be attached as is.
  const entries = ['', ...withDirectories(await listProjectFiles(root, signal))];
  return entries.flatMap(entry => {
    const target = path.join(root, entry);
    const reference = absoluteReferences ? target : path.relative(directory, target);
    if (!reference) return [];
    return entry === '' || entry.endsWith('/') ? [reference.endsWith('/') ? reference : `${reference}/`] : [reference];
  });
}

// Path prefix, then name prefix, then anywhere in the path.
function fileRank(file: string, query: string): number {
  const basename = file.slice(file.lastIndexOf('/') + 1);
  return file.startsWith(query) ? 0 : basename.startsWith(query) ? 1 : file.includes(query) ? 2 : 3;
}

// A folder matches on its own name, or as the next level under a typed path,
// so a matching parent does not bring every folder beneath it into the list.
function directoryRank(directory: string, query: string): number {
  if (directory.startsWith(query) && !directory.slice(query.length, -1).includes('/')) return 0;
  if (!query) return 3;
  const nameStart = directory.lastIndexOf('/', directory.length - 2) + 1;
  if (directory.startsWith(query, nameStart)) return 1;
  const at = directory.lastIndexOf(query);
  return at >= 0 && at + query.length > nameStart ? 2 : 3;
}

/** Ranked suggestions for a query; folders come before files of the same rank. */
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
      const folder = lower.endsWith('/');
      return { file, folder, rank: folder ? directoryRank(lower, normalized) : fileRank(lower, normalized) };
    })
    .filter(item => item.rank < 3)
    .sort((left, right) => left.rank - right.rank || Number(right.folder) - Number(left.folder)
      || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .slice(0, limit)
    .map(item => item.file);
}

// Git decides what .gitignore hides; outside a repository nothing is hidden.
// Names go bare: git tells folders apart itself, and rejects a slash after a
// linked folder.
function ignoredNames(directory: string, names: readonly string[]): Set<string> {
  if (names.length === 0) return new Set();
  try {
    const output = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: directory,
      input: names.join('\0'),
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(output.split('\0').filter(Boolean));
  } catch {
    // Exit status 1 means nothing is ignored; 128 means no repository.
    return new Set();
  }
}

/**
 * One level of a mentioned directory, folders first and ending in '/', hiding
 * what file search hides. A folder whose every entry is ignored is itself
 * ignored, and was named on purpose, so it is listed in full.
 */
export function listDirectoryEntries(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true }).filter(entry => visibleFile(entry.name));
  const ignored = ignoredNames(directory, entries.map(entry => entry.name));
  const visible = entries.filter(entry => !ignored.has(entry.name));
  return (visible.length > 0 ? visible : entries)
    .map(entry => {
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { folder = statSync(path.join(directory, entry.name)).isDirectory(); } catch { /* a dangling link lists by name */ }
      }
      return folder ? `${entry.name}/` : entry.name;
    })
    .sort((left, right) => Number(right.endsWith('/')) - Number(left.endsWith('/'))
      || (left < right ? -1 : left > right ? 1 : 0));
}
