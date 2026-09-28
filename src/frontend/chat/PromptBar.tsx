// The input bar while it is asking something of the user rather than
// collecting a message. It answers with a decision, a menu choice or one
// typed value and then hands the bar back; the draft the user was typing
// waits untouched in the session, so nothing here knows about it.
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { moveSelection, SelectMenu } from './SelectMenu';
import { ApprovalPrompt, approvalChoices } from './ApprovalPrompt';
import { QuestionCard } from './QuestionCard';
import {
  applyInputEdit,
  backspaceAtEnd,
  inputEditForKey,
  isForeignInput,
  isKeyboardProtocolReport,
  isTypedText,
  type InputEdit,
  type InputState,
} from './editor';
import { EntryInput, InputFeedback, QueuedRow } from './InputRows';
import { StatusRow, type StatusRowProps } from './StatusRow';
import { WorkerStrip } from './WorkerStrip';
import type { ParticipantColors } from '../MentionText';
import type { Feedback } from '../../commands/feedback';
import type { CommandMenuEntry, CommandMenuItem } from '../../commands/types';
import type { ApprovalDecision, ApprovalRequest } from '../../agent_runtime/permissions/approvals';
import type { QuestionAnswer, QuestionRequest } from '../../agent_runtime/permissions/questions';
import type { SubagentRun } from '../../agent_runtime/tools/subagents';

export type PromptMode =
  | {
    type: 'approval';
    request: ApprovalRequest;
    // further prompts queued behind this one for the same session
    waiting: number;
    requesterName?: string;
    onDecide: (decision: ApprovalDecision, feedback?: string) => void;
  }
  | {
    type: 'question';
    request: QuestionRequest;
    // further questions queued behind this one for the same session
    waiting: number;
    onAnswer: (answer: QuestionAnswer) => void;
  }
  | {
    type: 'menu';
    items: readonly CommandMenuEntry[];
    onSelect: (item: CommandMenuItem) => void;
    onCancel: () => void;
  }
  | {
    type: 'entry';
    prompt: string;
    // A secret is echoed as dots; everything else is typed in the open.
    masked: boolean;
    onSubmit: (value: string) => void;
    onCancel: () => void;
  };

export function PromptBar({ mode, feedback, participantColors, queuedMessages, workers, status }: {
  mode: PromptMode;
  feedback: Feedback | null;
  participantColors?: ParticipantColors;
  queuedMessages: readonly string[];
  workers: readonly SubagentRun[];
  status: StatusRowProps;
}) {
  const [selected, setSelected] = useState(0);
  const [entry, setEntry] = useState('');
  const [approvalFeedback, setApprovalFeedback] = useState<InputState | null>(null);
  const decided = useRef(false);
  const promptIdentity = mode.type === 'approval' || mode.type === 'question' ? mode.request.id : mode;
  useEffect(() => {
    setSelected(0);
    setEntry('');
    setApprovalFeedback(null);
    decided.current = false;
  }, [promptIdentity]);

  const editFeedback = (edit: InputEdit) => setApprovalFeedback(current => current && applyInputEdit(current, edit));

  usePaste(text => {
    if (mode.type === 'entry') setEntry(current => current + text.trim());
    else if (mode.type === 'approval' && approvalFeedback) editFeedback({ type: 'insert', text: text.replace(/\r\n?|\n/g, ' ') });
  });

  useInput((enteredInput, key) => {
    if (isKeyboardProtocolReport(enteredInput)) return;
    if (key.eventType === 'release' || (key.ctrl && enteredInput === 'c')) return;
    if (isForeignInput(enteredInput, key)) return;
    // The question card takes its own keys.
    if (mode.type === 'question') return;

    if (mode.type === 'approval') {
      if (decided.current) return;
      const decide = (decision: ApprovalDecision, feedback?: string) => {
        decided.current = true;
        mode.onDecide(decision, feedback);
      };
      if (key.escape) { decide('deny'); return; }
      if (approvalFeedback) {
        if (key.return) decide('deny', approvalFeedback.text.trim() || undefined);
        else if (inputEditForKey(enteredInput, key)) editFeedback(inputEditForKey(enteredInput, key)!);
        else if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) {
          editFeedback({ type: 'insert', text: enteredInput.replace(/[\u0000-\u001f\u007f-\u009f]/g, '') });
        }
        return;
      }
      if (key.ctrl || key.meta) return;
      const choices = approvalChoices(mode.request);
      const choose = (choice: typeof choices[number]) => {
        if (choice.feedback) setApprovalFeedback({ text: '', cursor: 0 });
        else decide(choice.decision);
      };
      if (key.tab) setApprovalFeedback({ text: '', cursor: 0 });
      else if (key.upArrow) setSelected(current => moveSelection(current, -1, choices.length));
      else if (key.downArrow) setSelected(current => moveSelection(current, 1, choices.length));
      else if (key.return && choices[selected]) choose(choices[selected]);
      else {
        const choice = choices.find(candidate => candidate.key === enteredInput);
        if (choice) choose(choice);
      }
      return;
    }
    if (mode.type === 'menu') {
      const items = mode.items.filter((entry): entry is CommandMenuItem => entry.type === 'item');
      if (key.escape) mode.onCancel();
      else if (key.upArrow) setSelected(current => moveSelection(current, -1, items.length));
      else if (key.downArrow) setSelected(current => moveSelection(current, 1, items.length));
      else if (key.return && items[selected]) mode.onSelect(items[selected]);
      return;
    }
    // Most terminals (macOS included) send DEL for the backspace key, which
    // Ink reports as key.delete rather than key.backspace.
    const isBackspace = key.backspace || key.delete;
    if (key.escape) mode.onCancel();
    else if (key.return) {
      const value = entry.trim();
      if (value) mode.onSubmit(value);
    } else if (key.ctrl && enteredInput === 'u') setEntry('');
    else if (isBackspace) setEntry(backspaceAtEnd);
    else if (isTypedText(key)) setEntry(current => current + enteredInput);
  });

  // A permission or question card stands where the input box stands.
  if (mode.type === 'approval' || mode.type === 'question') {
    return (
      <>
        <InputFeedback feedback={feedback} participantColors={participantColors} />
        <QueuedRow messages={queuedMessages} participantColors={participantColors} />
        {mode.type === 'approval'
          ? <ApprovalPrompt request={mode.request} waiting={mode.waiting} selected={selected} requesterName={mode.requesterName} feedback={approvalFeedback ?? undefined} />
          : <QuestionCard key={mode.request.id} request={mode.request} waiting={mode.waiting} onAnswer={mode.onAnswer} />}
        <WorkerStrip workers={workers} />
        <StatusRow {...status} />
      </>
    );
  }

  return (
    <>
      {mode.type === 'menu' && <SelectMenu items={mode.items} selected={selected} />}
      <InputFeedback feedback={feedback} participantColors={participantColors} />
      <QueuedRow messages={queuedMessages} participantColors={participantColors} />
      <Box
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        marginX={1}
        flexShrink={0}
        flexDirection="column"
      >
        <Box justifyContent="space-between">
          {mode.type === 'entry'
            ? <EntryInput prompt={mode.prompt} value={entry} masked={mode.masked} />
            : (
              <Box>
                <Text color={theme.accentSoft}>›{' '}</Text>
                <Text color={theme.textSubtle}>↑↓ choose · enter to select</Text>
              </Box>
            )}
          <Text color={theme.textSubtle}>esc cancels</Text>
        </Box>
      </Box>
      <WorkerStrip workers={workers} />
      <StatusRow {...status} />
    </>
  );
}
