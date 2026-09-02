import { Box, Text } from 'ink';
import type { CommandMenuItem } from '../../commands/command_register';
import { theme } from '../theme';

export function moveSelection(selected: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (selected + delta + length) % length;
}

// A list the user walks with the arrow keys, shown where the command hints
// normally sit. The caller owns the selected index and the key handling.
export function SelectMenu({
  items,
  selected,
}: {
  items: readonly CommandMenuItem[];
  selected: number;
}) {
  if (items.length === 0) return null;
  const column = Math.max(...items.map(item => item.label.length)) + 2;

  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {items.map((item, i) => (
        <Box key={item.key}>
          <Text color={i === selected ? theme.accent : theme.textSubtle}>{i === selected ? '› ' : '  '}</Text>
          <Text color={i === selected ? theme.accent : theme.text}>{item.label.padEnd(column)}</Text>
          <Text color={theme.textMuted}>{item.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
