import { Box, Text } from 'ink';
import type { PermissionOptionKind } from '@agentclientprotocol/sdk';
import { theme } from '../styles/theme';
import type { ToolCallBlock } from '../../agent_runtime/types';
import { describeRequester, type ApprovalDecision, type ApprovalRequest } from '../../agent_runtime/permissions/approvals';
import { argumentLines, editPreview, planText, toolLine, type DiffLine } from './toolCalls';
import type { InputState } from './editor';
import { FramedCard, type TitlePart } from './FramedCard';
import { terminalText, truncate } from '../terminal/text';

interface ApprovalChoice {
  kind: PermissionOptionKind;
  decision: ApprovalDecision;
  key: string;
  label: string;
  feedback?: boolean;
}

// The key each kind of option answers to, when the vendor offers one of each.
const KIND_KEYS: Record<PermissionOptionKind, string> = {
  allow_once: 'y',
  allow_always: 'a',
  reject_once: 'n',
  reject_always: 'd',
};

// One choice per option the vendor offered, in its order and in its words:
// both vendors say exactly what an option does ("don't ask again for these
// files", "clear context and use auto mode"), and often offer two of a kind.
// Keys follow the kind when no kind repeats, and count up otherwise.
export function approvalChoices(request: ApprovalRequest): ApprovalChoice[] {
  const kinds = request.options.map(option => option.kind);
  const byKind = new Set(kinds).size === kinds.length;
  const choices: ApprovalChoice[] = request.options.map((option, index) => ({
    kind: option.kind,
    decision: { optionId: option.optionId },
    key: byKind ? KIND_KEYS[option.kind] : String(index + 1),
    label: option.name,
  }));
  choices.push({
    kind: 'reject_once', decision: 'deny', key: 'tab',
    label: 'No, and tell it what to do instead', feedback: true,
  });
  return choices;
}

// A plan or a call's arguments up for approval are read in full, up to about
// a screen of them; a change, the way a row previews one.
const DETAIL_LINES = 30;
const DIFF_LINES = 16;

function cut(lines: readonly string[]): string[] {
  return lines.length > DETAIL_LINES
    ? [...lines.slice(0, DETAIL_LINES), `… ${lines.length - DETAIL_LINES} more lines, in the transcript`]
    : [...lines];
}

// What the user is approving, one item per line: where the call lands, then
// the change it makes, the command it runs, the plan it would carry out, or
// failing all of those its arguments, one to a line.
export function approvalDetail(call: ToolCallBlock): string[] {
  const lines = call.locations.map(location => terminalText(location.path));
  const diff = editPreview(call, DIFF_LINES);
  if (diff.length > 0) return [...lines, ...diff.map(markLine)];
  const input = call.input;
  const command = call.kind === 'execute' && input !== null && typeof input === 'object'
    && 'command' in input && typeof input.command === 'string' ? input.command : null;
  if (command !== null) return [...lines, ...command.split('\n').map(line => `$ ${line}`)];
  const plan = planText(call);
  if (plan) return [...lines, ...cut(plan.split('\n'))];
  return [...lines, ...cut(argumentLines(call))];
}

// The card numbers nothing: an edit up for approval has not landed anywhere.
function markLine(line: DiffLine): string {
  const text = terminalText(line.text);
  return line.sign === ' ' ? text : `${line.sign} ${text}`;
}

// "wants to read src/app.ts": the line's verb loses its capital mid-sentence.
function sentenceCase(line: string): string {
  return line.charAt(0).toLowerCase() + line.slice(1);
}

// What the card says the agent wants to do: the call's line, mid-sentence,
// or for a plan, to go ahead with it, as Claude Code asks "Would you like to
// proceed?".
export function approvalAction(call: ToolCallBlock): string {
  return planText(call) ? 'proceed with this plan' : sentenceCase(toolLine(call));
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

// A pending permission prompt as a framed card: who is asking and what for
// in its top edge, what the call would do, and the choices with their keys.
// The prompt bar holds the selection and reads the keys.
export function ApprovalPrompt({ request, waiting, selected, requesterName, feedback }: {
  request: ApprovalRequest;
  waiting: number;
  selected: number;
  requesterName?: string;
  feedback?: InputState;
}) {
  const choices = approvalChoices(request);
  const detail = approvalDetail(request.toolCall);
  // A plan is prose: it wraps, and its bullets are not a diff's marks.
  const plan = request.toolCall.kind === 'switch_mode';
  return (
    <FramedCard
      tone={theme.pending}
      title={[
        { text: '⚠ ', color: theme.pending },
        { text: requesterName ?? describeRequester(request.requester), color: theme.accent, bold: true },
        { text: ' wants to ' },
        { text: approvalAction(request.toolCall), color: theme.highlight, bold: true },
      ]}
      {...(waiting > 0 ? { right: `${waiting} more` } : {})}
      footer={feedback ? 'enter decline and send · esc decline' : '↑↓ move · enter select · tab add feedback · esc decline'}
    >
      {detail.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {detail.map((line, index) => (
            <Box key={index} paddingLeft={2}>
              <Text color={plan ? theme.text : detailColor(line)} wrap={plan ? 'wrap' : 'truncate-end'}>{terminalText(line)}</Text>
            </Box>
          ))}
        </Box>
      )}
      {feedback ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text color={theme.textMuted}>What should it do instead?</Text>
          <Text wrap="wrap">
            <Text color={theme.text}>{feedback.text.slice(0, feedback.cursor)}</Text>
            <Text color={theme.accent}>▌</Text>
            <Text color={theme.text}>{feedback.text.slice(feedback.cursor)}</Text>
          </Text>
        </Box>
      ) : choices.map((choice, index) => {
        const active = index === selected;
        return (
          <Box key={index} justifyContent="space-between">
            <Text color={active ? theme.accent : theme.text} wrap="truncate-end">
              {active ? '› ' : '  '}{terminalText(choice.label)}
            </Text>
            <Text color={active ? theme.accent : theme.textSubtle}>{choice.key}</Text>
          </Box>
        );
      })}
    </FramedCard>
  );
}
