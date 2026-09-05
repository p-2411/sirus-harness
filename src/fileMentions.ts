import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'fs';
import path from 'path';
import { rootTextRanges } from './mentions';
import type { Message, TextBlock } from './agent_runtime/types';

export interface FileMention {
  start: number;
  end: number;
  path: string;
}

export const MAX_MENTION_FILES = 10;
export const MAX_MENTION_FILE_BYTES = 256 * 1024;
export const MAX_MENTION_TOTAL_BYTES = 512 * 1024;

export function formatFileMention(filePath: string): string {
  const withoutPrefix = filePath.startsWith('./') ? filePath.slice(2) : filePath;
  // Quote extensionless names so they remain unambiguous file references.
  return path.basename(withoutPrefix).includes('.') && /^[^\s@"'`<>()[\]{},;]+$/.test(withoutPrefix)
    ? `@${withoutPrefix}`
    : `@${JSON.stringify(withoutPrefix)}`;
}

export function parseFileMentions(text: string, directory?: string): FileMention[] {
  const candidates: FileMention[] = [];
  const pattern = /(?<![\w@\\])@(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|[^\s"'`<>()[\]{},;]+)/g;
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

export function resolveFileMentions(message: Message, directory: string): Message {
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
      if (seen.size > MAX_MENTION_FILES) throw new Error('Mention at most 10 files per message.');
      const file = readTextFile(resolved);
      total += file.bytes;
      if (total > MAX_MENTION_TOTAL_BYTES) throw new Error('File mentions are limited to 512 KiB combined per message.');
      const filePath = path.normalize(mention.path);
      const label = JSON.stringify(filePath);
      let longestBackticks = 2;
      for (const match of (label + file.text).matchAll(/`+/g)) longestBackticks = Math.max(longestBackticks, match[0].length);
      const fence = '`'.repeat(longestBackticks + 1);
      attachments.push({ type: 'text', filePath, text: `\n\n${fence}\nFile: ${label}\n${file.text}\n${fence}` });
    } catch (error) {
      throw new Error(`Could not attach ${formatFileMention(mention.path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...message, content: [...message.content, ...attachments] };
}
