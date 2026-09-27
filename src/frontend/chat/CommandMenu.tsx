import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { matchCommands } from '../../commands/registry';
import type { NativeCommand } from '../../agent_runtime/runtime/commands';
import { theme } from '../styles/theme';

export const COMMAND_MENU_VISIBLE_ITEMS = 6;
const LABEL_COLUMN_MAX = 36;

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

// The commands `/…` currently matches, and where the menu sits in them. The
// selection belongs to the input that produced it: typing anything moves it
// back to the first match.
export function useCommandMenu(input: string, active: boolean, nativeCommands: readonly NativeCommand[] = []) {
  const [navigation, setNavigation] = useState({ input: '', selected: 0, offset: 0 });
  const matches = active ? matchCommands(input, nativeCommands) : [];
  const current = navigation.input === input ? navigation : { input, selected: 0, offset: 0 };
  useEffect(() => {
    setNavigation({ input, selected: 0, offset: 0 });
  }, [input]);
  return {
    matches,
    selected: current.selected,
    offset: current.offset,
    move(delta: number) {
      setNavigation(previous => ({
        input,
        ...moveCommandMenuSelection(
          previous.input === input ? previous : { selected: 0, offset: 0 },
          delta,
          matches.length,
        ),
      }));
    },
  };
}

export function CommandMenu({
  input,
  selected = 0,
  offset = 0,
  nativeCommands = [],
}: {
  input: string;
  selected?: number;
  offset?: number;
  nativeCommands?: readonly NativeCommand[];
}) {
  const matches = matchCommands(input, nativeCommands);
  if (matches.length === 0) return null;

  const labels = matches.map(spec => `/${spec.name}${spec.args ? ` ${spec.args}` : ''}`);
  // Capped: a vendor's argument hint can run to half a line and would push
  // every description out of view.
  const column = Math.min(Math.max(...labels.map(label => label.length)), LABEL_COLUMN_MAX) + 2;
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
            <Text color={theme.textMuted} wrap="truncate-end">
              {'vendor' in spec && spec.vendor && <Text color={theme.textSubtle}>({spec.vendor}) </Text>}
              {spec.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
