import { Box, Text } from 'ink';
import type { CommandMenuEntry } from '../../commands/types';
import { theme } from '../styles/theme';

// The selection after an arrow key, wrapping around at either end.
export function moveSelection(selected: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (selected + delta + length) % length;
}

// The same move in a list that shows `visible` rows at a time from `offset`:
// the window follows the selection no further than it must to keep it on
// screen, and never past the end of the list.
export function moveInWindow(
  position: { selected: number; offset: number },
  delta: number,
  length: number,
  visible: number,
): { selected: number; offset: number } {
  const selected = moveSelection(position.selected, delta, length);
  const offset = selected < position.offset ? selected
    : selected >= position.offset + visible ? selected - visible + 1
    : position.offset;
  return { selected, offset: Math.min(offset, Math.max(0, length - visible)) };
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
            <Text color={active ? theme.accent : theme.text}>{item.description ? item.label.padEnd(column) : item.label}</Text>
            {item.description && <Text color={theme.textMuted}>{item.description}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
