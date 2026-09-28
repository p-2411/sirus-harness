import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'fs';
import path from 'path';
import { errorMessage } from './abort';
import { listDirectoryEntries } from './fileSearch';
import { FILE_PATH_CHARACTER, rootTextRanges } from './mentions';
import type { Message, TextBlock } from './agent_runtime/types';

export interface FileMention {
  start: number;
  end: number;
  path: string;
}

export const MAX_MENTION_FILES = 10;
export const MAX_MENTION_FILE_BYTES = 256 * 1024;
export const MAX_MENTION_TOTAL_BYTES = 512 * 1024;
export const MAX_MENTION_DIRECTORY_ENTRIES = 100;

const BARE_PATH = new RegExp(`^${FILE_PATH_CHARACTER.source}+$`);

/** A mention for a file, or for a directory when the path ends in '/'. */
export function formatFileMention(filePath: string): string {
  const withoutPrefix = filePath.startsWith('./') ? filePath.slice(2) : filePath;
  // Quote extensionless names so they remain unambiguous file references (a
  // directory's trailing slash already is one), and a path with an @ in it,
  // so no part of it reads as a participant's name.
  return (withoutPrefix.endsWith('/') || path.basename(withoutPrefix).includes('.'))
    && !withoutPrefix.includes('@') && BARE_PATH.test(withoutPrefix)
    ? `@${withoutPrefix}`
    : `@${JSON.stringify(withoutPrefix)}`;
}

export function parseFileMentions(text: string, directory?: string): FileMention[] {
  const candidates: FileMention[] = [];
  const pattern = new RegExp(
    String.raw`(?<![\w@\\])@(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|${FILE_PATH_CHARACTER.source}+)`,
    'g',
  );
  for (const match of text.matchAll(pattern)) {
    let filePath = match[0].slice(1);
    const quoted = filePath.startsWith('"');
    if (quoted) {
      try { filePath = JSON.parse(filePath); } catch { continue; }
    }
    const explicit = quoted || filePath.startsWith('./') || filePath.startsWith('../') || path.isAbsolute(filePath);
    // Plain @agent names retain their routing meaning. Unprefixed filenames
    // and paths are references only when a local match exists; this preserves
    // package names such as @scope/package in ordinary prompt text.
    if (!explicit && !(directory && /[./]/.test(filePath) && existsSync(path.resolve(directory, filePath)))) continue;
    candidates.push({ start: match.index!, end: match.index! + match[0].length, path: filePath });
  }
  // Quoted paths are valid mention syntax, while ordinary quoted examples are
  // not. Mask candidates before asking the shared prose parser about scope.
  let masked = text;
  for (const mention of [...candidates].reverse()) {
    masked = masked.slice(0, mention.start) + 'x'.repeat(mention.end - mention.start) + masked.slice(mention.end);
  }
  const ranges = rootTextRanges(masked);
  return candidates.filter(mention => ranges.some(range => mention.start >= range.start && mention.end <= range.end));
}

function readTextFile(filePath: string): { text: string; bytes: number } {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Only regular text files can be mentioned.');
    if (stat.size > MAX_MENTION_FILE_BYTES) throw new Error('File mentions are limited to 256 KiB per file.');
    // Read at most one byte beyond the limit even if the file grows after stat.
    const buffer = Buffer.alloc(MAX_MENTION_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    if (bytes > MAX_MENTION_FILE_BYTES) throw new Error('File mentions are limited to 256 KiB per file.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)); }
    catch { throw new Error('File mentions require UTF-8 text.'); }
    if (/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) throw new Error('Binary files cannot be mentioned; attach images with /image.');
    return { text, bytes };
  } finally {
    closeSync(descriptor);
  }
}

// Fences a snapshot so neither its heading nor its body can close it early.
function snapshotBlock(filePath: string, heading: string, body: string): TextBlock {
  let longestBackticks = 2;
  for (const match of (heading + body).matchAll(/`+/g)) longestBackticks = Math.max(longestBackticks, match[0].length);
  const fence = '`'.repeat(longestBackticks + 1);
  return { type: 'text', filePath, text: `\n\n${fence}\n${heading}\n${body}\n${fence}` };
}

// What a directory holds, one level deep; the agent reads on from there.
function directoryListing(directory: string): string {
  const entries = listDirectoryEntries(directory);
  if (entries.length === 0) return '(empty)';
  const shown = entries.slice(0, MAX_MENTION_DIRECTORY_ENTRIES);
  if (entries.length > shown.length) shown.push(`… ${entries.length - shown.length} more`);
  return shown.join('\n');
}

// An attachment as the chat names it, read back from the block
// `snapshotBlock` wrote (a blank line, the fence, the heading, the body, the
// fence), the way Claude Code notes one: "Read notes.txt (12 lines)", or for a
// directory "Listed src/ (8 entries)". A final newline ends a file's last line.
export function describeAttachment(block: TextBlock): string {
  const lines = block.text.split('\n').slice(4, -1);
  if (block.filePath?.endsWith('/')) {
    const more = /^… (\d+) more$/.exec(lines.at(-1) ?? '');
    const entries = lines[0] === '(empty)' ? 0 : lines.length + (more ? Number(more[1]) - 1 : 0);
    return `Listed ${block.filePath} (${entries} entr${entries === 1 ? 'y' : 'ies'})`;
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return `Read ${block.filePath} (${lines.length} line${lines.length === 1 ? '' : 's'})`;
}

export function resolveFileMentions<T extends Pick<Message, 'content'>>(message: T, directory: string): T {
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const mentions = parseFileMentions(text, directory);
  if (mentions.length === 0) return message;
  const lexicalRoot = path.resolve(directory);
  const seen = new Set<string>();
  const attachments: TextBlock[] = [];
  let total = 0;
  for (const mention of mentions) {
    try {
      const lexicalPath = path.resolve(lexicalRoot, mention.path);
      const resolved = realpathSync(lexicalPath);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (seen.size > MAX_MENTION_FILES) throw new Error('Mention at most 10 files or directories per message.');
      const filePath = path.normalize(mention.path);
      if (statSync(resolved).isDirectory()) {
        const directoryPath = path.join(filePath, '/');
        const listing = directoryListing(resolved);
        total += Buffer.byteLength(listing);
        if (total > MAX_MENTION_TOTAL_BYTES) throw new Error('File mentions are limited to 512 KiB combined per message.');
        attachments.push(snapshotBlock(directoryPath, `Directory: ${JSON.stringify(directoryPath)}`, listing));
        continue;
      }
      const file = readTextFile(resolved);
      total += file.bytes;
      if (total > MAX_MENTION_TOTAL_BYTES) throw new Error('File mentions are limited to 512 KiB combined per message.');
      attachments.push(snapshotBlock(filePath, `File: ${JSON.stringify(filePath)}`, file.text));
    } catch (error) {
      throw new Error(`Could not attach ${formatFileMention(mention.path)}: ${errorMessage(error)}`);
    }
  }
  return { ...message, content: [...message.content, ...attachments] };
}
