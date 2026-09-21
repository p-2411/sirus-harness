// The single lines that sit around the input box: the last command's feedback,
// the messages waiting to go out, and the prompt for a value a command needs.
import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import { MentionText, type ParticipantColors } from '../MentionText';
import type { Feedback } from '../../commands/feedback';

const FEEDBACK_ICONS = {
  info: '→',
  success: '✓',
  error: '!',
} as const;

export function InputFeedback({ feedback, participantColors }: {
  feedback: Feedback | null;
  participantColors?: ParticipantColors;
}) {
  if (!feedback) return null;
  const iconColor = feedback.kind === 'success'
    ? theme.success
    : feedback.kind === 'error' ? theme.danger : theme.accentSoft;
  const showIcon = feedback.showIcon !== false;
  return (
    <Box paddingX={3} flexShrink={0}>
      {showIcon && <Text color={iconColor}>{FEEDBACK_ICONS[feedback.kind]}</Text>}
      <Text color={feedback.kind === 'error' ? theme.danger : theme.textMuted}>
        {showIcon ? ' ' : ''}<MentionText colors={participantColors}>{feedback.text}</MentionText>
      </Text>
    </Box>
  );
}

// Waiting messages, with the one being edited highlighted.
export function QueuedRow({ messages, selected = null, participantColors }: {
  messages: readonly string[];
  selected?: number | null;
  participantColors?: ParticipantColors;
}) {
  if (messages.length === 0) return null;
  return (
    <Box paddingX={3} flexDirection="column" flexShrink={0}>
      {messages.map((message, index) => {
        const active = index === selected;
        return (
          <Box key={index} justifyContent="space-between">
            <Text color={active ? theme.text : theme.textMuted} wrap="truncate-end">
              <Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '⋮ '}</Text>
              <MentionText colors={participantColors}>{message.replace(/\s+/g, ' ').trim()}</MentionText>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// One value a command asked for. A secret echoes one dot per character, so
// the user can see the paste landed without the value ever reaching the
// screen (or a copied selection); ordinary text is shown as it is typed.
export function EntryInput({ prompt, value, masked }: {
  prompt: string;
  value: string;
  masked: boolean;
}) {
  return (
    <Box>
      <Text color={theme.accentSoft}>›{' '}</Text>
      <Text color={theme.textMuted}>{prompt}:{' '}</Text>
      <Text color={theme.text}>{masked ? '•'.repeat(value.length) : value}</Text>
      <Text color={theme.accentSoft}>▌</Text>
    </Box>
  );
}
