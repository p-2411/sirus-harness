import { useMemo } from 'react';
import { Box } from 'ink';
import type { ParticipantColors } from '../MentionText';
import { renderBlock } from './blockRenderers';
import { lexMarkdown } from './parser';
import { terminalText } from '../terminal/text';

interface MarkdownProps {
  children: string;
  /** Use compact spacing for a live preview inside another control. */
  compact?: boolean;
  participantColors?: ParticipantColors;
}

export function Markdown({ children, compact = false, participantColors }: MarkdownProps) {
  // Every leaf of the tree prints part of this text, so it is made safe for
  // the terminal once, before it is read as markdown.
  const tokens = useMemo(() => lexMarkdown(terminalText(children)), [children]);
  const context = { compact, participantColors };

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => renderBlock(token, `block-${index}`, context))}
    </Box>
  );
}
