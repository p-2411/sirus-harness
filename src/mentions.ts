import { marked } from 'marked';

export interface RootTextRange {
  start: number;
  end: number;
  text: string;
}

function closingQuote(markdown: string, start: number, closing: string): number {
  for (let index = start; index < markdown.length; index++) {
    if (markdown[index] !== closing || markdown[index - 1] === '\\') continue;
    if ((closing === "'" || closing === '’')
      && /[A-Za-z0-9]/.test(markdown[index - 1] ?? '')
      && /[A-Za-z0-9]/.test(markdown[index + 1] ?? '')) continue;
    return index;
  }
  return -1;
}

function directTextRanges(text: string, globalStart: number): RootTextRange[] {
  const ranges: RootTextRange[] = [];
  let segmentStart = 0;
  const pushSegment = (end: number) => {
    if (end <= segmentStart) return;
    ranges.push({
      start: globalStart + segmentStart,
      end: globalStart + end,
      text: text.slice(segmentStart, end),
    });
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    let close = -1;

    if (character === '`') {
      let runLength = 1;
      while (text[index + runLength] === '`') runLength++;
      close = text.indexOf('`'.repeat(runLength), index + runLength);
      if (close !== -1) close += runLength - 1;
    } else if (character === '"' || character === '“' || character === '‘' || character === "'") {
      // Apostrophes inside words are punctuation, not quoted examples.
      if (character === "'" && /[A-Za-z0-9]/.test(text[index - 1] ?? '')
        && /[A-Za-z0-9]/.test(text[index + 1] ?? '')) continue;
      const closing = character === '“' ? '”' : character === '‘' ? '’' : character;
      close = closingQuote(text, index + 1, closing);
    } else {
      continue;
    }

    pushSegment(index);
    // An unmatched quote/code delimiter protects the rest of the paragraph.
    index = close === -1 ? text.length : close;
    segmentStart = index + 1;
  }
  pushSegment(text.length);
  return ranges;
}

// Participant routing is intentionally limited to top-level prose. Markdown
// block examples (quotes/callouts, lists, tables, code, headings, HTML, etc.)
// are context, not instructions to invoke an agent.
export function rootTextRanges(markdown: string): RootTextRange[] {
  const ranges: RootTextRange[] = [];
  let cursor = 0;
  for (const token of marked.lexer(markdown, { gfm: true, breaks: true })) {
    const start = markdown.indexOf(token.raw, cursor);
    if (start === -1) continue;
    const end = start + token.raw.length;
    if (token.type === 'paragraph') ranges.push(...directTextRanges(token.raw, start));
    cursor = end;
  }
  return ranges;
}
