import { useEffect, useRef, useState } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../styles/theme';
import { useClickable } from '../interaction/clickable';
import type { Participant } from '../../agent_runtime/agent';
import type { ParticipantColors } from '../MentionText';

export type AgentActivity = 'working' | 'unread' | 'attention' | 'idle';

// A column of dots, all four rows of them, moves across the pill with its
// colour showing between the dots.
const BAR_COLUMN = '⣿';

function ThinkingName({ name, width, color }: {
  name: string;
  width: number;
  color: string;
}) {
  // Participant names are ASCII. Keep the resting name's truncation, then
  // sweep across both padding cells as well as the visible label.
  const labelWidth = width - 2;
  const label = name.length > labelWidth ? `${name.slice(0, labelWidth - 1)}…` : name;
  const pill = ` ${label.padEnd(labelWidth)} `;
  const cycle = width;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(value => (value + 1) % cycle), 270);
    return () => clearInterval(timer);
  }, [cycle]);

  return (
    <Text color={color} wrap="truncate-end" aria-label={name}>
      {Array.from(pill, (character, index) => index === frame ? BAR_COLUMN : character).join('')}
    </Text>
  );
}

// Preserve roster order and scroll the names only when selection leaves the
// available width. Background activity never changes the layout.
function visibleAgentTabs(participants: readonly Participant[], selected: string, width: number) {
  const current = Math.max(0, participants.findIndex(agent => agent.name === selected));
  const tabWidth = (index: number) => Math.min(24, stringWidth(participants[index].name) + 2);
  let start = current, end = current + 1, used = tabWidth(current);
  const budget = Math.max(1, width - 2);
  while (start > 0 && used + tabWidth(start - 1) + 1 <= budget) used += tabWidth(--start) + 1;
  while (end < participants.length && used + tabWidth(end) + 1 <= budget) used += tabWidth(end++) + 1;
  return { start, end };
}

function AgentName({ participant, selected, activity, width, color, onSelect }: {
  participant: Participant;
  selected: boolean;
  activity: AgentActivity;
  width: number;
  color: string;
  onSelect?: (name: string) => void;
}) {
  const ref = useRef<DOMElement>(null);
  useClickable(ref, () => onSelect?.(participant.name));
  const working = activity === 'working';
  const marker = activity === 'attention' ? '!' : activity === 'unread' ? '.' : ' ';
  return (
    <Box ref={onSelect ? ref : undefined} width={width} height={1} flexShrink={0} paddingLeft={working ? 0 : 1}
      backgroundColor={selected ? color : undefined}>
      {working
        ? <ThinkingName name={participant.name} width={width} color={selected ? '#151515' : color} />
        : <>
            <Box flexGrow={1} minWidth={0}>
              <Text color={selected ? '#151515' : color} wrap="truncate-end">{participant.name}</Text>
            </Box>
            <Text color={selected ? '#151515' : activity === 'attention' ? theme.pending : color}>{marker}</Text>
          </>}
    </Box>
  );
}

export function AgentTabs({ participants, selected, activity, colors, width, onSelect }: {
  participants: readonly Participant[];
  selected: string;
  activity: ReadonlyMap<string, AgentActivity>;
  colors: ParticipantColors;
  width: number;
  onSelect?: (name: string) => void;
}) {
  const { start, end } = visibleAgentTabs(participants, selected, width);
  return (
    <Box height={1} flexShrink={0} width={width} overflow="hidden" alignItems="center" justifyContent="flex-end">
      {start > 0 && <Text color={theme.textMuted}>‹</Text>}
      {participants.slice(start, end).map((participant, index) => (
        <Box key={participant.name} marginLeft={index > 0 ? 1 : 0} flexShrink={0}>
          <AgentName participant={participant} selected={participant.name === selected}
            activity={activity.get(participant.name) ?? 'idle'} color={colors.get(participant.name.toLocaleLowerCase()) ?? theme.textMuted}
            onSelect={onSelect} width={Math.min(Math.max(4, width - 2), 24, stringWidth(participant.name) + 2)} />
        </Box>
      ))}
      {end < participants.length && <Text color={theme.textMuted}>›</Text>}
    </Box>
  );
}
