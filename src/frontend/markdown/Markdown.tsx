import { useMemo } from 'react';
import { Box } from 'ink';
import type { ParticipantColors } from '../MentionText';
import { renderBlock } from './blockRenderers';
import { lexMarkdown } from './parser';

interface MarkdownProps {
  children: string;
  /** Use compact spacing for a live preview inside another control. */
  compact?: boolean;
  participantColors?: ParticipantColors;
}

export function Markdown({ children, compact = false, participantColors }: MarkdownProps) {
  const tokens = useMemo(() => lexMarkdown(children), [children]);
  const context = { compact, participantColors };

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => renderBlock(token, `block-${index}`, context))}
    </Box>
  );
}

export { lexMarkdown, segmentMarkdown } from './parser';
