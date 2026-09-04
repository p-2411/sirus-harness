import { marked, type Token } from 'marked';

// marked's lexer is superlinear in document length, and a streaming message is
// re-rendered on every chunk, so lexing the whole text each time freezes the
// UI once a response grows long. The text is lexed as independent segments
// instead: blocks never span a blank line except inside a fence, a list, or an
// indented continuation, so a split anywhere else yields the same tokens. Every
// segment but the still-growing tail is cached by its text.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?\n|$)/;
const BLANK = /^[ \t]*\r?\n?$/;

export function segmentMarkdown(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  const segments: string[] = [];
  let start = 0;
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // a backtick fence's info string may not itself contain a backtick
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    if (!BLANK.test(line)) continue;
    let next = index + 1;
    while (next < lines.length && BLANK.test(lines[next])) next++;
    // trailing blank lines stay with the tail; a following list item or
    // indented line may continue the block before the blank
    if (next >= lines.length || /^[ \t]/.test(lines[next]) || LIST_ITEM.test(lines[next])) {
      index = next - 1;
      continue;
    }
    segments.push(lines.slice(start, next).join(''));
    start = next;
    index = next - 1;
  }
  if (start < lines.length) segments.push(lines.slice(start).join(''));
  return segments;
}

const SEGMENT_CACHE_LIMIT = 2000;
const segmentTokens = new Map<string, Token[]>();

function lexSegment(segment: string, cache: boolean): Token[] {
  const cached = segmentTokens.get(segment);
  if (cached) return cached;
  const tokens = marked.lexer(segment, { gfm: true, breaks: true });
  if (cache) {
    segmentTokens.set(segment, tokens);
    if (segmentTokens.size > SEGMENT_CACHE_LIMIT) {
      segmentTokens.delete(segmentTokens.keys().next().value as string);
    }
  }
  return tokens;
}

export function lexMarkdown(text: string): Token[] {
  const segments = segmentMarkdown(text);
  return segments.flatMap((segment, index) => lexSegment(segment, index < segments.length - 1));
}
