import { useState } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { Participant } from '../../agent_runtime/session';
import { formatFileMention } from '../../fileMentions';
import { MentionText, participantColorMap } from '../MentionText';
import { theme } from '../styles/theme';
import { participantMenuItems } from './ParticipantMenu';

export const MENTION_MENU_VISIBLE_ITEMS = 4;

export interface MentionMenuItem {
  key: string;
  label: string;
  description: string;
  replacement: string;
  kind: 'participant' | 'file' | 'create';
}

export function mentionMenuItems(
  input: string,
  participants: readonly Participant[],
  files: readonly string[],
): MentionMenuItem[] {
  const participantItems = participantMenuItems(input, participants);
  const agents: MentionMenuItem[] = [];
  const creation: MentionMenuItem[] = [];
  for (const item of participantItems) {
    if (item.key === 'create-participant') {
      creation.push({ ...item, kind: 'create', replacement: `${item.label.split(' ')[0]} ` });
    } else {
      agents.push({ ...item, kind: 'participant', replacement: `${item.label} ` });
    }
  }
  agents.sort((left, right) => left.label.length - right.label.length
    || left.label.localeCompare(right.label));
  return [
    ...[...files].reverse().map(file => {
      const label = formatFileMention(file);
      return { key: `file:${file}`, label, description: 'attach file', replacement: `${label} `, kind: 'file' as const };
    }),
    ...creation,
    ...agents.reverse(),
  ];
}

// Which item the menu has selected and which slice of it is on screen. The
// closest match sits at the bottom, so the window is tracked from its bottom
// edge: file results arriving above the agents leave the selection where it is.
export function useMentionMenu({ active, input, cursor, participants, files }: {
  active: boolean;
  input: string;
  cursor: number;
  participants: readonly Participant[];
  files: readonly string[];
}) {
  const [navigation, setNavigation] = useState({ key: '', selected: '', bottomGap: 0 });
  const items = active ? mentionMenuItems(input.slice(0, cursor), participants, files) : [];
  const key = `${input}\0${cursor}`;
  const saved = navigation.key === key ? items.findIndex(item => item.key === navigation.selected) : -1;
  const selected = saved >= 0 ? saved : Math.max(0, items.length - 1);
  const offset = Math.max(0, items.length - MENTION_MENU_VISIBLE_ITEMS
    - (saved >= 0 ? navigation.bottomGap : 0));
  return {
    items,
    selected,
    offset,
    move(delta: -1 | 1) {
      if (items.length === 0) return;
      const next = (selected + delta + items.length) % items.length;
      const nextOffset = next < offset ? next
        : next >= offset + MENTION_MENU_VISIBLE_ITEMS ? next - MENTION_MENU_VISIBLE_ITEMS + 1
        : offset;
      setNavigation({
        key,
        selected: items[next].key,
        bottomGap: Math.max(0, items.length - MENTION_MENU_VISIBLE_ITEMS - nextOffset),
      });
    },
  };
}

export function MentionMenu({ items, participants, selected, offset, loading = false, error = null }: {
  items: readonly MentionMenuItem[];
  participants: readonly Participant[];
  selected: number;
  offset: number;
  loading?: boolean;
  error?: string | null;
}) {
  const colors = participantColorMap(participants);
  const labelWidth = Math.min(38, Math.max(0, ...items.map(item => stringWidth(item.label))) + 2);
  const descriptionWidth = Math.max(0, ...items.map(item => stringWidth(item.description)));
  const visible = items.slice(offset, offset + MENTION_MENU_VISIBLE_ITEMS);
  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {visible.map((item, index) => {
        const active = offset + index === selected;
        return (
          <Box key={item.key} height={1} minHeight={1} flexShrink={0} overflow="hidden">
            <Box width={2} flexShrink={0}>
              <Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text>
            </Box>
            <Box width={labelWidth} flexShrink={1} minWidth={0} paddingRight={2}>
              <Text color={active ? theme.accent : theme.text} wrap="truncate-end">
                <MentionText colors={colors}>{item.label}</MentionText>
              </Text>
            </Box>
            <Box width={descriptionWidth} flexShrink={1} minWidth={0}>
              <Text color={theme.textMuted} wrap="truncate-end">{item.description}</Text>
            </Box>
          </Box>
        );
      })}
      {visible.length === 0 ? (
        <Text color={theme.textMuted} wrap="truncate-end">{loading ? 'Finding files…' : error ? 'Unable to list files in this directory.' : 'No matching files'}</Text>
      ) : null}
    </Box>
  );
}
