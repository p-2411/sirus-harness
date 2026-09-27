// The single lines that sit around the input box: the last command's feedback,
// the messages waiting to go out, and the prompt for a value a command needs.
import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import { MentionText, type ParticipantColors } from '../MentionText';
import { Markdown } from '../markdown/Markdown';
import type { Feedback } from '../../commands/feedback';

// An information line reads as plain text; the others are marked.
const FEEDBACK_ICONS: Partial<Record<Feedback['kind'], string>> = {
  success: '✓',
  warning: '!',
  error: '!',
};

export function InputFeedback({ feedback, participantColors }: {
  feedback: Feedback | null;
  participantColors?: ParticipantColors;
}) {
  if (!feedback) return null;
  const iconColor = feedback.kind === 'success'
    ? theme.success
    : feedback.kind === 'error' ? theme.danger
      : feedback.kind === 'warning' ? theme.pending : theme.accentSoft;
  const icon = feedback.showIcon === false ? undefined : FEEDBACK_ICONS[feedback.kind];
  // A vendor's report, such as Claude's /context table, reads as it would in
  // the chat.
  if (feedback.markdown) {
    return (
      <Box paddingX={3} flexShrink={0} flexDirection="column">
        <Markdown participantColors={participantColors}>{feedback.text}</Markdown>
      </Box>
    );
  }
  return (
    <Box paddingX={3} flexShrink={0}>
      {icon && <Text color={iconColor}>{icon}</Text>}
      <Text color={feedback.kind === 'error' ? theme.danger : feedback.kind === 'warning' ? theme.pending : theme.textMuted}>
        {icon ? ' ' : ''}<MentionText colors={participantColors}>{feedback.text}</MentionText>
      </Text>
    </Box>
  );
}

// Waiting messages, oldest first, one line each.
export function QueuedRow({ messages, participantColors }: {
  messages: readonly string[];
  participantColors?: ParticipantColors;
}) {
  if (messages.length === 0) return null;
  return (
    <Box paddingX={3} flexDirection="column" flexShrink={0}>
      {messages.map((message, index) => (
        <Box key={index} justifyContent="space-between">
          <Text color={theme.textMuted} wrap="truncate-end">
            <Text color={theme.textSubtle}>⋮ </Text>
            <MentionText colors={participantColors}>{message.replace(/\s+/g, ' ').trim()}</MentionText>
          </Text>
        </Box>
      ))}
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
