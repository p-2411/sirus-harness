import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import type { ApprovalDecision, ApprovalRequest } from '../../agent_runtime/permissions/approvals';
import { describeRequester } from '../../agent_runtime/permissions/describe';

interface ApprovalChoice {
  decision: ApprovalDecision;
  key: string;
  label: string;
}

// "Allow for this session" is offered only when an allowance can cover the
// call; sensitive operations never get one.
export function approvalChoices(request: ApprovalRequest): ApprovalChoice[] {
  return [
    { decision: 'allow', key: 'y', label: 'Allow once' },
    ...(request.allowanceKey
      ? [{ decision: 'allow-session' as const, key: 'a', label: 'Allow for this session' }]
      : []),
    { decision: 'deny', key: 'n', label: 'Deny' },
  ];
}

// Detail lines carry their own marks: removed and added lines of an edit,
// the shell prompt of a command. Colour follows the mark.
function detailColor(line: string): string {
  const content = line.trimStart();
  if (content.startsWith('+ ')) return theme.success;
  if (content.startsWith('- ')) return theme.danger;
  if (content.startsWith('$ ')) return theme.text;
  return theme.textMuted;
}

// A pending permission prompt: who is asking, what for, and the choices.
export function ApprovalPrompt({ request, waiting, selected }: {
  request: ApprovalRequest;
  waiting: number;
  selected: number;
}) {
  const choices = approvalChoices(request);
  const column = Math.max(...choices.map(choice => choice.label.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      <Text wrap="truncate-end">
        <Text color={theme.pending}>⚠ </Text>
        <Text color={theme.accent} bold>{describeRequester(request.requester)}</Text>
        <Text color={theme.text}> wants to run </Text>
        <Text color={theme.highlight} bold>{request.call.name}</Text>
        {waiting > 0 && <Text color={theme.textSubtle}> · {waiting} more waiting</Text>}
      </Text>
      {request.detail.map((line, index) => (
        <Text key={index} color={detailColor(line)} wrap="truncate-end">  {line}</Text>
      ))}
      <Box height={1} />
      {choices.map((choice, index) => (
        <Box key={choice.decision}>
          <Text color={index === selected ? theme.accent : theme.textSubtle}>{index === selected ? '› ' : '  '}</Text>
          <Text color={index === selected ? theme.accent : theme.text}>{choice.label.padEnd(column)}</Text>
          <Text color={theme.textSubtle}>{choice.key}</Text>
        </Box>
      ))}
    </Box>
  );
}
