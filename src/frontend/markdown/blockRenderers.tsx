import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { Token, Tokens } from 'marked';
import stringWidth from 'string-width';
import { MentionText, type ParticipantColors } from '../MentionText';
import { theme } from '../styles/theme';
import { inlineText, renderInline } from './inlineRenderers';

export interface BlockContext {
  compact: boolean;
  participantColors: ParticipantColors | undefined;
}

type BlockRenderer = (token: Token, key: string, context: BlockContext) => ReactNode;

function renderer<T extends Token>(render: (token: T, key: string, context: BlockContext) => ReactNode): BlockRenderer {
  return (token, key, context) => render(token as T, key, context);
}

const textBlock = renderer<Tokens.Text>((token, key, context) => (
  <Text key={key} color={theme.text} wrap="wrap">
    {token.tokens
      ? renderInline(token.tokens, key, context.participantColors)
      : <MentionText colors={context.participantColors}>{token.text}</MentionText>}
  </Text>
));

const blockRenderers: Record<string, BlockRenderer> = {
  paragraph: renderer<Tokens.Paragraph>((token, key, context) => (
    <Text key={key} color={theme.text} wrap="wrap">
      {renderInline(token.tokens, key, context.participantColors)}
    </Text>
  )),
  heading: renderer<Tokens.Heading>((token, key, context) => (
    <Text key={key} color={theme.highlight} bold underline={token.depth === 1} wrap="wrap">
      {renderInline(token.tokens, key, context.participantColors)}
    </Text>
  )),
  code: renderer<Tokens.Code>((token, key, context) => (
    <Box
      key={key}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginY={context.compact ? 0 : 1}
    >
      {token.lang && <Text color={theme.textSubtle}>{token.lang}</Text>}
      <Text color={theme.accentSoft}>{token.text}</Text>
    </Box>
  )),
  blockquote: renderer<Tokens.Blockquote>((token, key, context) => (
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
      {token.tokens.map((child, index) => renderBlock(
        child,
        `${key}-quote-${index}`,
        { ...context, compact: true },
      ))}
    </Box>
  )),
  list: renderer<Tokens.List>((token, key, context) => (
    <Box key={key} flexDirection="column">
      {token.items.map((item, index) => {
        const ordinal = typeof token.start === 'number' ? token.start + index : index + 1;
        const marker = item.task
          ? item.checked ? '[x]' : '[ ]'
          : token.ordered ? `${ordinal}.` : '•';

        return (
          <Box key={`${key}-item-${index}`} alignItems="flex-start">
            <Text color={theme.textMuted}>{marker} </Text>
            <Box flexDirection="column" flexGrow={1}>
              {item.tokens.map((child, childIndex) => renderListItemBlock(
                child,
                `${key}-item-${index}-${childIndex}`,
                context,
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  )),
  table: renderer<Tokens.Table>((token, key, context) => renderTable(token, key, context)),
  hr: renderer<Tokens.Hr>((_token, key) => (
    <Text key={key} color={theme.border}>{'─'.repeat(24)}</Text>
  )),
  html: renderer<Tokens.HTML | Tokens.Tag>((token, key) => (
    // A terminal cannot render HTML. Showing it literally is safer and keeps
    // the original message available for copying.
    <Text key={key} color={theme.textSubtle}>{token.text}</Text>
  )),
  text: textBlock,
  space: renderer<Tokens.Space>((_token, key, context) => (
    context.compact ? null : <Text key={key}> </Text>
  )),
  def: () => null,
};

export function renderBlock(token: Token, key: string, context: BlockContext): ReactNode {
  const render = blockRenderers[token.type];
  return render
    ? render(token, key, context)
    : <Text key={key} color={theme.text}>{token.raw}</Text>;
}

function renderListItemBlock(token: Token, key: string, context: BlockContext): ReactNode {
  return token.type === 'text'
    ? textBlock(token, key, context)
    : renderBlock(token, key, { ...context, compact: true });
}

function renderTable(token: Tokens.Table, key: string, context: BlockContext): ReactNode {
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
        <MentionText colors={context.participantColors}>{formatRow(textRows[0])}</MentionText>
      </Text>
      <Text color={theme.border}>{widths.map(width => '─'.repeat(width)).join('─┼─')}</Text>
      {textRows.slice(1).map((row, index) => (
        <Text key={`${key}-row-${index}`} color={theme.text}>
          <MentionText colors={context.participantColors}>{formatRow(row)}</MentionText>
        </Text>
      ))}
    </Box>
  );
}
