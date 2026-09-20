import { Box, Text } from 'ink';
import type { PermissionOptionKind } from '@agentclientprotocol/sdk';
import { theme } from '../styles/theme';
import type { ToolCallBlock } from '../../agent_runtime/types';
import { describeRequester, type ApprovalDecision, type ApprovalRequest } from '../../agent_runtime/permissions/approvals';
import { editPreview, toolLine, type DiffLine } from './ChatMessage';

interface ApprovalChoice {
  kind: PermissionOptionKind;
  decision: ApprovalDecision;
  key: string;
  label: string;
}

// One choice per option the vendor offered, in its order. Both rejections
// decide `deny`; the handler picks the reject option from the kind.
const CHOICES: Record<PermissionOptionKind, Omit<ApprovalChoice, 'kind'>> = {
  allow_once: { decision: 'allow', key: 'y', label: 'Allow once' },
  allow_always: { decision: 'allow-session', key: 'a', label: 'Allow for this session' },
  reject_once: { decision: 'deny', key: 'n', label: 'Deny' },
  reject_always: { decision: 'deny', key: 'd', label: 'Deny for this session' },
};

export function approvalChoices(request: ApprovalRequest): ApprovalChoice[] {
  return request.options.map(option => ({ kind: option.kind, ...CHOICES[option.kind] }));
}

const INPUT_LENGTH = 200;

// What the user is approving, one item per line: where the call lands, then
// the change it makes, the command it runs, or failing both its input.
export function approvalDetail(call: ToolCallBlock): string[] {
  const lines = call.locations.map(location => location.path);
  const diff = editPreview(call);
  if (diff.length > 0) return [...lines, ...diff.map(markLine)];
  const input = call.input;
  const command = call.kind === 'execute' && input !== null && typeof input === 'object'
    && 'command' in input && typeof input.command === 'string' ? input.command : null;
  if (command !== null) return [...lines, ...command.split('\n').map(line => `$ ${line}`)];
  if (input === undefined) return lines;
  const text = JSON.stringify(input) ?? String(input);
  return [...lines, text.length > INPUT_LENGTH ? `${text.slice(0, INPUT_LENGTH)}…` : text];
}

function markLine(line: DiffLine): string {
  return line.sign === ' ' ? line.text : `${line.sign} ${line.text}`;
}

// "wants to read src/app.ts": the line's verb loses its capital mid-sentence.
export function sentenceCase(line: string): string {
  return line.charAt(0).toLowerCase() + line.slice(1);
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
        <Text color={theme.text}> wants to </Text>
        <Text color={theme.highlight} bold>{sentenceCase(toolLine(request.toolCall))}</Text>
        {waiting > 0 && <Text color={theme.textSubtle}> · {waiting} more waiting</Text>}
      </Text>
      {approvalDetail(request.toolCall).map((line, index) => (
        <Text key={index} color={detailColor(line)} wrap="truncate-end">  {line}</Text>
      ))}
      <Box height={1} />
      {choices.map((choice, index) => (
        <Box key={choice.kind}>
          <Text color={index === selected ? theme.accent : theme.textSubtle}>{index === selected ? '› ' : '  '}</Text>
          <Text color={index === selected ? theme.accent : theme.text}>{choice.label.padEnd(column)}</Text>
          <Text color={theme.textSubtle}>{choice.key}</Text>
        </Box>
      ))}
    </Box>
  );
}
