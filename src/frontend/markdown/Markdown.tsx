import { useMemo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import { theme } from '../styles/theme';
import { MentionText, type ParticipantColors } from '../MentionText';

interface MarkdownProps {
  children: string;
  /** Use compact spacing for a live preview inside another control. */
  compact?: boolean;
  participantColors?: ParticipantColors;
}

export function Markdown({ children, compact = false, participantColors }: MarkdownProps) {
  const tokens = useMemo(() => lexMarkdown(children), [children]);

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => renderBlock(token, `block-${index}`, compact, participantColors))}
    </Box>
  );
}

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

function renderBlock(
  token: Token,
  key: string,
  compact: boolean,
  participantColors?: ParticipantColors,
): ReactNode {
  switch (token.type) {
    case 'paragraph':
      return (
        <Text key={key} color={theme.text} wrap="wrap">
          {renderInline(token.tokens, key, participantColors)}
        </Text>
      );

    case 'heading':
      return (
        <Text key={key} color={theme.highlight} bold underline={token.depth === 1} wrap="wrap">
          {renderInline(token.tokens, key, participantColors)}
        </Text>
      );

    case 'code':
      return (
        <Box
          key={key}
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
          marginY={compact ? 0 : 1}
        >
          {token.lang && <Text color={theme.textSubtle}>{token.lang}</Text>}
          <Text color={theme.accentSoft}>{token.text}</Text>
        </Box>
      );

    case 'blockquote': {
      const blockquote = token as Tokens.Blockquote;
      return (
        <Box
          key={key}
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.border}
          paddingLeft={1}
        >
          {blockquote.tokens.map((child, index) =>
            renderBlock(child, `${key}-quote-${index}`, true, participantColors))}
        </Box>
      );
    }

    case 'list': {
      const list = token as Tokens.List;
      return (
        <Box key={key} flexDirection="column">
          {list.items.map((item, index) => {
            const ordinal = typeof list.start === 'number' ? list.start + index : index + 1;
            const marker = item.task
              ? item.checked ? '[x]' : '[ ]'
              : list.ordered ? `${ordinal}.` : '•';

            return (
              <Box key={`${key}-item-${index}`} alignItems="flex-start">
                <Text color={theme.textMuted}>{marker} </Text>
                <Box flexDirection="column" flexGrow={1}>
                  {item.tokens.map((child, childIndex) =>
                    renderListItemBlock(child, `${key}-item-${index}-${childIndex}`, participantColors),
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }

    case 'table':
      return renderTable(token as Tokens.Table, key, participantColors);

    case 'hr':
      return <Text key={key} color={theme.border}>{'─'.repeat(24)}</Text>;

    case 'html':
      // A terminal cannot render HTML. Showing it literally is safer and keeps
      // the original message available for copying.
      return <Text key={key} color={theme.textSubtle}>{token.text}</Text>;

    case 'text':
      return (
        <Text key={key} color={theme.text} wrap="wrap">
          {token.tokens
            ? renderInline(token.tokens, key, participantColors)
            : <MentionText colors={participantColors}>{token.text}</MentionText>}
        </Text>
      );

    case 'space':
      return compact ? null : <Text key={key}> </Text>;

    case 'def':
      return null;

    default:
      return <Text key={key} color={theme.text}>{token.raw}</Text>;
  }
}

function renderListItemBlock(
  token: Token,
  key: string,
  participantColors?: ParticipantColors,
): ReactNode {
  if (token.type === 'text') {
    return (
      <Text key={key} color={theme.text} wrap="wrap">
        {token.tokens
          ? renderInline(token.tokens, key, participantColors)
          : <MentionText colors={participantColors}>{token.text}</MentionText>}
      </Text>
    );
  }

  return renderBlock(token, key, true, participantColors);
}

function renderInline(
  tokens: Token[] = [],
  keyPrefix = 'inline',
  participantColors?: ParticipantColors,
): ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (token.type) {
      case 'text':
        return (
          <Text key={key}>
            {token.tokens
              ? renderInline(token.tokens, key, participantColors)
              : <MentionText colors={participantColors}>{token.text}</MentionText>}
          </Text>
        );

      case 'escape':
        return <Text key={key}><MentionText colors={participantColors}>{token.text}</MentionText></Text>;

      case 'strong':
        return <Text key={key} bold>{renderInline(token.tokens, key, participantColors)}</Text>;

      case 'em':
        return <Text key={key} italic>{renderInline(token.tokens, key, participantColors)}</Text>;

      case 'del':
        return <Text key={key} strikethrough>{renderInline(token.tokens, key, participantColors)}</Text>;

      case 'codespan':
        return <Text key={key} color={theme.accentSoft} inverse>{` ${token.text} `}</Text>;

      case 'link':
        return (
          <Text key={key} color={theme.highlight} underline>
            {renderInline(token.tokens, key, participantColors)}
            {token.href !== token.text && <Text color={theme.textSubtle}> ({token.href})</Text>}
          </Text>
        );

      case 'image':
        return <Text key={key} color={theme.textMuted}>[image: {token.text || token.href}]</Text>;

      case 'br':
        return <Text key={key}>{'\n'}</Text>;

      case 'html':
        return <Text key={key} color={theme.textSubtle}>{token.text}</Text>;

      default:
        return <Text key={key}>{token.raw}</Text>;
    }
  });
}

function renderTable(token: Tokens.Table, key: string, participantColors?: ParticipantColors): ReactNode {
  const rows = [token.header, ...token.rows];
  const textRows = rows.map(row => row.map(cell => inlineText(cell.tokens)));
  const widths = token.header.map((_, column) => Math.max(
    1,
    ...textRows.map(row => stringWidth(row[column] ?? '')),
  ));

  const formatRow = (row: string[]) => row
    .map((cell, column) => `${cell}${' '.repeat(widths[column] - stringWidth(cell))}`)
    .join(' │ ');

  return (
    <Box key={key} flexDirection="column" marginY={1}>
      <Text bold color={theme.highlight}>
        <MentionText colors={participantColors}>{formatRow(textRows[0])}</MentionText>
      </Text>
      <Text color={theme.border}>{widths.map(width => '─'.repeat(width)).join('─┼─')}</Text>
      {textRows.slice(1).map((row, index) => (
        <Text key={`${key}-row-${index}`} color={theme.text}>
          <MentionText colors={participantColors}>{formatRow(row)}</MentionText>
        </Text>
      ))}
    </Box>
  );
}

function inlineText(tokens: Token[] = []): string {
  return tokens.map(token => {
    switch (token.type) {
      case 'text':
      case 'escape':
      case 'codespan':
        return token.text;
      case 'strong':
      case 'em':
      case 'del':
        return inlineText(token.tokens);
      case 'link': {
        const label = inlineText(token.tokens);
        return token.href === label ? label : `${label} (${token.href})`;
      }
      case 'image':
        return token.text || token.href;
      case 'br':
        return ' ';
      default:
        return token.raw;
    }
  }).join('');
}
