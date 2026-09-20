// The input bar while it is asking something of the user rather than
// collecting a message. It answers with a decision, a menu choice or a secret
// and then hands the bar back; the draft the user was typing waits untouched
// in the session, so nothing here knows about it.
import { useEffect, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { moveSelection, SelectMenu } from './SelectMenu';
import { ApprovalPrompt, approvalChoices } from './ApprovalPrompt';
import { InputFeedback, QueuedRow, SecretInput } from './InputRows';
import { SubagentStatusRow, type StatusRowProps } from './StatusRow';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';
import type { ParticipantColors } from '../MentionText';
import type { Feedback } from '../../commands/feedback';
import type { CommandMenuEntry, CommandMenuItem } from '../../commands/registry';
import type { ApprovalDecision, ApprovalRequest } from '../../agent_runtime/permissions/approvals';

export type PromptMode =
  | {
    type: 'approval';
    request: ApprovalRequest;
    // further prompts queued behind this one for the same session
    waiting: number;
    onDecide: (decision: ApprovalDecision) => void;
  }
  | {
    type: 'menu';
    items: readonly CommandMenuEntry[];
    onSelect: (item: CommandMenuItem) => void;
    onCancel: () => void;
  }
  | {
    type: 'secret';
    prompt: string;
    onSubmit: (value: string) => void;
    onCancel: () => void;
  };

export function PromptBar({ mode, feedback, participantColors, queuedMessages, status }: {
  mode: PromptMode;
  feedback: Feedback | null;
  participantColors?: ParticipantColors;
  queuedMessages: readonly string[];
  status: StatusRowProps;
}) {
  const [selected, setSelected] = useState(0);
  const [secret, setSecret] = useState('');
  useEffect(() => {
    setSelected(0);
    setSecret('');
  }, [mode]);

  usePaste(text => {
    if (mode.type === 'secret') setSecret(current => current + text.trim());
  });

  useInput((enteredInput, key) => {
    // Mouse and window-focus reports are not typing.
    if (isMouseInput(enteredInput) || isFocusInput(enteredInput)) return;
    // Session switching belongs to the sidebar in every input mode.
    if (key.meta && (key.upArrow || key.downArrow)) return;

    if (mode.type === 'approval') {
      // escape is the turn's cancel, handled by the chat; it withdraws the prompt
      const choices = approvalChoices(mode.request);
      if (key.upArrow) setSelected(current => moveSelection(current, -1, choices.length));
      else if (key.downArrow) setSelected(current => moveSelection(current, 1, choices.length));
      else if (key.return && choices[selected]) mode.onDecide(choices[selected].decision);
      else {
        const choice = choices.find(candidate => candidate.key === enteredInput);
        if (choice) mode.onDecide(choice.decision);
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
      const value = secret.trim();
      if (value) mode.onSubmit(value);
    } else if (key.ctrl && enteredInput === 'u') setSecret('');
    else if (isBackspace) setSecret(current => current.slice(0, -1));
    else if (!key.ctrl && !key.meta && !key.tab
      && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow
      && !key.pageUp && !key.pageDown && !key.home && !key.end) {
      setSecret(current => current + enteredInput);
    }
  });

  return (
    <>
      {mode.type === 'menu' && <SelectMenu items={mode.items} selected={selected} />}
      {mode.type === 'approval' && (
        <ApprovalPrompt request={mode.request} waiting={mode.waiting} selected={selected} />
      )}
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
          {mode.type === 'secret'
            ? <SecretInput prompt={mode.prompt} value={secret} />
            : (
              <Box>
                <Text color={theme.accentSoft}>›{' '}</Text>
                <Text color={theme.textSubtle}>
                  ↑↓ choose · enter to select
                  {mode.type === 'approval' && ` · ${approvalChoices(mode.request).map(choice => choice.key).join(' / ')}`}
                </Text>
              </Box>
            )}
          <Text color={theme.textSubtle}>{mode.type === 'approval' ? 'esc cancels the turn' : 'esc cancels'}</Text>
        </Box>
      </Box>
      <SubagentStatusRow {...status} />
    </>
  );
}
