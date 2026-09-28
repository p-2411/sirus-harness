import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import { terminalText } from '../terminal/text';

// A run of the title in one style.
export interface TitlePart {
  text: string;
  color?: string;
  bold?: boolean;
}

// A title as plain text, for where it is said rather than drawn: the
// desktop notification says what the card's top edge does.
export function titleText(parts: readonly TitlePart[]): string {
  return parts.map(part => part.text).join('');
}

// The line that fills the rest of an edge: as wide as the room left, and no
// wider, however long the run of rule it is given.
function Rule({ color }: { color: string }) {
  return (
    <Box flexGrow={1} flexShrink={1} flexBasis={0} minWidth={1} height={1} overflow="hidden">
      <Text color={color}>{'─'.repeat(400)}</Text>
    </Box>
  );
}

// The frame the permission and question cards share, standing where the
// input box stands: a rounded border in the card's tone with who is asking
// set into its top edge, anything that counts (more waiting, progress) at the
// top right, and the keys along its bottom edge.
export function FramedCard({ tone, title, right, footer, children }: {
  tone: string;
  title: readonly TitlePart[];
  right?: string;
  footer: string;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column" marginX={1} flexShrink={0}>
      <Box height={1}>
        <Text color={tone}>╭─ </Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {title.map((part, index) => (
              <Text key={index} color={part.color ?? theme.text} bold={part.bold}>{terminalText(part.text)}</Text>
            ))}
          </Text>
        </Box>
        <Text> </Text>
        <Rule color={tone} />
        {right && <Text color={theme.textSubtle}> {terminalText(right)}</Text>}
        <Text color={tone}> ─╮</Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderBottom={false}
        borderColor={tone}
        paddingX={1}
        paddingY={1}
      >
        {children}
      </Box>
      <Box height={1}>
        <Text color={tone}>╰─ </Text>
        <Box flexShrink={1}>
          <Text color={theme.textSubtle} wrap="truncate-end">{terminalText(footer)}</Text>
        </Box>
        <Text> </Text>
        <Rule color={tone} />
        <Text color={tone}>╯</Text>
      </Box>
    </Box>
  );
}
