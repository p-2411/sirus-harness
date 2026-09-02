import { Box, Text } from 'ink';
import { modelStrategies } from '../../agent/chat';
import type { Participant } from '../../runtime/session';
import { theme } from '../theme';
import { MentionText, participantColorMap } from '../MentionText';

export interface ParticipantMenuItem {
  key: string;
  label: string;
  description: string;
}

// Only the unfinished @token at the cursor drives the menu. This supports a
// second mention in the same message without mistaking emails or @scope/pkg
// package names for participant input.
function activeMention(input: string): string | null {
  const match = /(?<![\w@])@([A-Za-z][A-Za-z0-9_-]*|)$/.exec(input);
  return match?.[1] ?? null;
}

export function participantMenuItems(
  input: string,
  participants: readonly Participant[],
  models: readonly string[] = Object.keys(modelStrategies),
): ParticipantMenuItem[] {
  const fragment = activeMention(input);
  if (fragment === null) return [];

  const normalized = fragment.toLocaleLowerCase();
  const matchingParticipants = participants.filter(participant =>
    participant.name.toLocaleLowerCase().startsWith(normalized),
  );
  const exactParticipant = matchingParticipants.some(participant =>
    participant.name.toLocaleLowerCase() === normalized,
  );
  const items = matchingParticipants.map(participant => ({
    key: `participant:${participant.name.toLocaleLowerCase()}`,
    label: `@${participant.name}`,
    description: `message participant`,
  }));

  if (!exactParticipant) {
    const name = fragment || 'name';
    items.push({
      key: 'create-participant',
      label: `@${name} <model> <prompt>`,
      description: `create participant`,
    });
  }
  return items;
}

export function ParticipantMenu({
  input,
  participants,
}: {
  input: string;
  participants: readonly Participant[];
}) {
  const items = participantMenuItems(input, participants);
  if (items.length === 0) return null;
  const colors = participantColorMap(participants);

  const column = Math.max(...items.map(item => item.label.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {items.map(item => (
        <Box key={item.key}>
          <Box width={column} flexShrink={0}>
            <Text color={theme.accent}><MentionText colors={colors}>{item.label}</MentionText></Text>
          </Box>
          <Text color={theme.textMuted}>{item.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
