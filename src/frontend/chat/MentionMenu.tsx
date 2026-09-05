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
