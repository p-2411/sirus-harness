import { Box, Text } from 'ink';
import { matchCommands } from '../../commands/registry';
import { theme } from '../styles/theme';

export const COMMAND_MENU_VISIBLE_ITEMS = 6;

export interface CommandMenuNavigation {
  selected: number;
  offset: number;
}

export function moveCommandMenuSelection(
  navigation: CommandMenuNavigation,
  delta: number,
  length: number,
): CommandMenuNavigation {
  if (length === 0) return { selected: 0, offset: 0 };

  const selected = (navigation.selected + delta + length) % length;
  let offset = navigation.offset;
  if (selected < offset) offset = selected;
  else if (selected >= offset + COMMAND_MENU_VISIBLE_ITEMS) {
    offset = selected - COMMAND_MENU_VISIBLE_ITEMS + 1;
  }

  return {
    selected,
    offset: Math.min(offset, Math.max(0, length - COMMAND_MENU_VISIBLE_ITEMS)),
  };
}

export function CommandMenu({
  input,
  selected = 0,
  offset = 0,
}: {
  input: string;
  selected?: number;
  offset?: number;
}) {
  const matches = matchCommands(input);
  if (matches.length === 0) return null;

  const labels = matches.map(spec => `/${spec.name}${spec.args ? ` ${spec.args}` : ''}`);
  const column = Math.max(...labels.map(label => label.length)) + 2;
  const visibleMatches = matches.slice(offset, offset + COMMAND_MENU_VISIBLE_ITEMS);

  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {visibleMatches.map((spec, visibleIndex) => {
        const index = offset + visibleIndex;
        const active = index === selected;
        return (
          <Box key={spec.name} height={1} minHeight={1} flexShrink={0} overflow="hidden">
            <Box width={2} flexShrink={0}>
              <Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text>
            </Box>
            <Box width={column} flexShrink={0}>
              <Text color={active ? theme.accent : theme.text} wrap="truncate-end">{labels[index]}</Text>
            </Box>
            <Text color={theme.textMuted} wrap="truncate-end">{spec.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
