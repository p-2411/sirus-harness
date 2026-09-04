import { Box, Text } from 'ink';
import type { CommandMenuEntry } from '../../commands/registry';
import { theme } from '../styles/theme';

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
  items: readonly CommandMenuEntry[];
  selected: number;
}) {
  if (items.length === 0) return null;
  const choices = items.filter(item => item.type === 'item');
  const column = Math.max(0, ...choices.map(item => item.label.length)) + 2;
  let choiceIndex = -1;

  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {items.map(item => {
        if (item.type === 'heading') {
          return (
            <Box key={item.key} marginTop={choiceIndex >= 0 ? 1 : 0}>
              <Text color={theme.textMuted} bold>{item.label}</Text>
            </Box>
          );
        }
        choiceIndex++;
        const active = choiceIndex === selected;
        return (
          <Box key={item.key}>
            <Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text>
            <Text color={active ? theme.accent : theme.text}>{item.label.padEnd(column)}</Text>
            {item.description && <Text color={theme.textMuted}>{item.description}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
