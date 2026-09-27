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
  const column = Math.max(0, ...choices.map(item => item.label.length + (item.current ? 2 : 0))) + 2;
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
        // What is in effect now carries a check after its label.
        const label = item.current ? `${item.label} ✓` : item.label;
        // One line per choice: the label keeps its column and a long
        // description is cut at the edge rather than wrapped under it.
        return (
          <Box key={item.key}>
            <Box width={2} flexShrink={0}>
              <Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text>
            </Box>
            <Box flexShrink={0} {...(item.description ? { width: column } : {})}>
              <Text color={active ? theme.accent : theme.text}>{label}</Text>
            </Box>
            {item.description && <Text color={theme.textMuted} wrap="truncate-end">{item.description}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
