import type { ReactNode } from 'react';
import { Text } from 'ink';
import type { Token, Tokens } from 'marked';
import { MentionText, type ParticipantColors } from '../MentionText';
import { theme } from '../styles/theme';

interface InlineContext {
  participantColors: ParticipantColors | undefined;
}

type InlineRenderer = (token: Token, key: string, context: InlineContext) => ReactNode;

function renderer<T extends Token>(render: (token: T, key: string, context: InlineContext) => ReactNode): InlineRenderer {
  return (token, key, context) => render(token as T, key, context);
}

const inlineRenderers: Record<string, InlineRenderer> = {
  text: renderer<Tokens.Text>((token, key, context) => (
    <Text key={key}>
      {token.tokens
        ? renderInline(token.tokens, key, context.participantColors)
        : <MentionText colors={context.participantColors}>{token.text}</MentionText>}
    </Text>
  )),
  escape: renderer<Tokens.Escape>((token, key, context) => (
    <Text key={key}><MentionText colors={context.participantColors}>{token.text}</MentionText></Text>
  )),
  strong: renderer<Tokens.Strong>((token, key, context) => (
    <Text key={key} bold>{renderInline(token.tokens, key, context.participantColors)}</Text>
  )),
  em: renderer<Tokens.Em>((token, key, context) => (
    <Text key={key} italic>{renderInline(token.tokens, key, context.participantColors)}</Text>
  )),
  del: renderer<Tokens.Del>((token, key, context) => (
    <Text key={key} strikethrough>{renderInline(token.tokens, key, context.participantColors)}</Text>
  )),
  codespan: renderer<Tokens.Codespan>((token, key) => (
    <Text key={key} color={theme.accentSoft}>{` ${token.text} `}</Text>
  )),
  link: renderer<Tokens.Link>((token, key, context) => (
    <Text key={key} color={theme.highlight} underline>
      {renderInline(token.tokens, key, context.participantColors)}
      {token.href !== token.text && <Text color={theme.textSubtle}> ({token.href})</Text>}
    </Text>
  )),
  image: renderer<Tokens.Image>((token, key) => (
    <Text key={key} color={theme.textMuted}>[image: {token.text || token.href}]</Text>
  )),
  br: renderer<Tokens.Br>((_token, key) => <Text key={key}>{'\n'}</Text>),
  html: renderer<Tokens.HTML | Tokens.Tag>((token, key) => (
    <Text key={key} color={theme.textSubtle}>{token.text}</Text>
  )),
};

export function renderInline(
  tokens: Token[] = [],
  keyPrefix = 'inline',
  participantColors?: ParticipantColors,
): ReactNode {
  const context: InlineContext = { participantColors };
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    const render = inlineRenderers[token.type];
    return render
      ? render(token, key, context)
      : <Text key={key}>{token.raw}</Text>;
  });
}

type TextRenderer = (token: Token) => string;

function textRenderer<T extends Token>(render: (token: T) => string): TextRenderer {
  return token => render(token as T);
}

const inlineTextRenderers: Record<string, TextRenderer> = {
  text: textRenderer<Tokens.Text>(token => token.text),
  escape: textRenderer<Tokens.Escape>(token => token.text),
  codespan: textRenderer<Tokens.Codespan>(token => token.text),
  strong: textRenderer<Tokens.Strong>(token => inlineText(token.tokens)),
  em: textRenderer<Tokens.Em>(token => inlineText(token.tokens)),
  del: textRenderer<Tokens.Del>(token => inlineText(token.tokens)),
  link: textRenderer<Tokens.Link>(token => {
    const label = inlineText(token.tokens);
    return token.href === label ? label : `${label} (${token.href})`;
  }),
  image: textRenderer<Tokens.Image>(token => token.text || token.href),
  br: () => ' ',
};

export function inlineText(tokens: Token[] = []): string {
  return tokens.map(token => (inlineTextRenderers[token.type] ?? (value => value.raw))(token)).join('');
}
