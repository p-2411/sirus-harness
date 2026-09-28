import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { matchCommands, type CommandMatch } from '../../commands/registry';
import { commandUsage } from '../../commands/types';
import type { NativeCommand } from '../../agent_runtime/runtime/commands';
import { theme } from '../styles/theme';
import { moveInWindow } from './SelectMenu';

const COMMAND_MENU_VISIBLE_ITEMS = 6;
const LABEL_COLUMN_MAX = 36;

// The commands the `/…` at the cursor matches, and where the menu sits in
// them. The selection belongs to the input that produced it: typing anything
// moves it back to the first match.
export function useCommandMenu(input: string, active: boolean, nativeCommands: readonly NativeCommand[] = [], cursor: number = input.length) {
  const [navigation, setNavigation] = useState({ input: '', selected: 0, offset: 0 });
  const matches = active ? matchCommands(input, nativeCommands, cursor) : [];
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
        ...moveInWindow(
          previous.input === input ? previous : { selected: 0, offset: 0 },
          delta,
          matches.length,
          COMMAND_MENU_VISIBLE_ITEMS,
        ),
      }));
    },
  };
}

// The matches useCommandMenu found, a window of them at a time.
export function CommandMenu({
  matches,
  selected = 0,
  offset = 0,
}: {
  matches: readonly CommandMatch[];
  selected?: number;
  offset?: number;
}) {
  if (matches.length === 0) return null;

  const labels = matches.map(commandUsage);
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
