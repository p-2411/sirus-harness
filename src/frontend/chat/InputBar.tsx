import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../styles/theme';
import { CommandMenu, moveCommandMenuSelection } from './CommandMenu';
import { moveSelection, SelectMenu } from './SelectMenu';
import { captureArrowKeys } from '../interaction/focus';
import {
  matchCommands,
  type CommandMenuEntry,
  type CommandMenuItem,
} from '../../commands/registry';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';
import { getSelectionSnapshot, subscribeSelection } from '../interaction/selection';
import type { Feedback } from '../../commands/feedback';
import type { Participant } from '../../agent_runtime/session';
import type { ImageBlock } from '../../agent_runtime/types';
import { describeImage } from '../../images';
import { ParticipantMenu } from './ParticipantMenu';
import { MentionText, participantColorMap, type ParticipantColors } from '../MentionText';
import { activeSubagentCount, getSubagentsVersion, subscribeSubagents } from '../../agent_runtime/tools/subagents';
import {
  PERMISSION_MODE_NAMES,
  describeRequester,
  type ApprovalDecision,
  type ApprovalRequest,
  type PermissionMode,
} from '../../agent_runtime/permissions/permissions';

// readline's backward-kill-word: drop the last word and any whitespace after it
function deleteWordBackward(text: string): string {
  return text.replace(/\S*\s*$/, '');
}

export interface InputState {
  text: string;
  cursor: number;
}

export type InputEdit =
  | { type: 'insert'; text: string }
  | { type: 'left' | 'right' | 'backspace' | 'delete-word-backward' | 'clear' };

function previousCharacter(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const previous = text.charCodeAt(cursor - 1);
  return previous >= 0xDC00 && previous <= 0xDFFF
    && cursor > 1
    && text.charCodeAt(cursor - 2) >= 0xD800
    && text.charCodeAt(cursor - 2) <= 0xDBFF
    ? cursor - 2
    : cursor - 1;
}

function nextCharacter(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  const current = text.charCodeAt(cursor);
  return current >= 0xD800 && current <= 0xDBFF
    && cursor + 1 < text.length
    && text.charCodeAt(cursor + 1) >= 0xDC00
    && text.charCodeAt(cursor + 1) <= 0xDFFF
    ? cursor + 2
    : cursor + 1;
}

export function applyInputEdit(state: InputState, edit: InputEdit): InputState {
  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  const before = state.text.slice(0, cursor);
  const after = state.text.slice(cursor);
  switch (edit.type) {
    case 'insert':
      return { text: before + edit.text + after, cursor: cursor + edit.text.length };
    case 'left':
      return { ...state, cursor: previousCharacter(state.text, cursor) };
    case 'right':
      return { ...state, cursor: nextCharacter(state.text, cursor) };
    case 'backspace': {
      const start = previousCharacter(state.text, cursor);
      return { text: state.text.slice(0, start) + after, cursor: start };
    }
    case 'delete-word-backward': {
      const shortened = deleteWordBackward(before);
      return { text: shortened + after, cursor: shortened.length };
    }
    case 'clear':
      return { text: '', cursor: 0 };
  }
}

// What the input bar is collecting: a message, a choice from a list, a
// value that must never be shown (an API key), or a permission decision.
export type InputMode =
  | { type: 'text' }
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

interface InputBarProps {
  send: (input: string, attachments?: readonly ImageBlock[]) => void;
  disabled: boolean;
  feedback: Feedback | null;
  participants: readonly Participant[];
  mode?: InputMode;
  permissionMode?: PermissionMode;
  // shift+tab in text mode
  onCyclePermissionMode?: () => void;
  // images waiting to go with the next message, oldest first
  attachments?: readonly ImageBlock[];
  // ctrl+v in text mode
  onPasteImage?: () => void;
  // backspace on an empty line drops the newest attachment
  onRemoveAttachment?: () => void;
  // the session's current model, shown under the input bar
  model?: string;
  thinkingLevel?: string;
}

const FEEDBACK_ICONS = {
  info: '→',
  success: '✓',
  error: '!',
} as const;

export function InputFeedback({
  feedback,
  participantColors,
}: Pick<InputBarProps, 'feedback'> & { participantColors?: ParticipantColors }) {
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

// Secret entry echoes one dot per character so the user can see the paste
// landed without the value ever reaching the screen (or a copied selection).
export function SecretInput({ prompt, value }: { prompt: string; value: string }) {
  return (
    <Box>
      <Text color={theme.accentSoft}>›{' '}</Text>
      <Text color={theme.textMuted}>{prompt}:{' '}</Text>
      <Text color={theme.text}>{'•'.repeat(value.length)}</Text>
      <Text color={theme.accentSoft}>▌</Text>
    </Box>
  );
}

// The line under the input box: the session's permission mode, then how many
// spawned subagents are still at work; the session's model stays on the far
// right. It keeps its height when there is nothing to say so the layout stays
// put.
export function SubagentStatusRow({ permissionMode, model, thinkingLevel }: {
  permissionMode?: PermissionMode;
  model?: string;
  thinkingLevel?: string;
}) {
  useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
  const active = activeSubagentCount();
  return (
    <Box paddingX={3} height={1} flexShrink={0} justifyContent="space-between">
      <Box>
        {permissionMode && (
          <Text color={permissionMode === 'bypass' ? theme.pending : theme.textMuted}>
            {PERMISSION_MODE_NAMES[permissionMode]}
            <Text color={theme.textSubtle}> · shift+tab</Text>
          </Text>
        )}
        {active > 0 && (
          <Text color={theme.textMuted}>{permissionMode ? ' · ' : ''}{active} active subagent{active === 1 ? '' : 's'}</Text>
        )}
      </Box>
      {model && (
        <Text color={theme.textSubtle} dimColor>
          {model}{thinkingLevel ? ` · ${thinkingLevel}` : ''}
        </Text>
      )}
    </Box>
  );
}

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
        <Text key={index} color={theme.textMuted} wrap="truncate-end">  {line}</Text>
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

const TEXT_MODE: InputMode = { type: 'text' };
const NO_ATTACHMENTS: readonly ImageBlock[] = [];

// The images that will go with the next message, above the input box.
export function AttachmentRow({ attachments }: { attachments: readonly ImageBlock[] }) {
  if (attachments.length === 0) return null;
  return (
    <Box paddingX={3} flexShrink={0}>
      <Text color={theme.textMuted} wrap="truncate-end">
        {attachments.map(image => `▣ ${describeImage(image)}`).join('   ')}
      </Text>
      <Text color={theme.textSubtle}>   backspace removes</Text>
    </Box>
  );
}

export function InputBar({
  send,
  disabled,
  feedback,
  participants,
  mode = TEXT_MODE,
  permissionMode,
  onCyclePermissionMode,
  attachments = NO_ATTACHMENTS,
  onPasteImage,
  onRemoveAttachment,
  model,
  thinkingLevel,
}: InputBarProps) {
  const [editor, setEditor] = useState<InputState>({ text: '', cursor: 0 });
  const input = editor.text;
  const participantColors = participantColorMap(participants);
  // Menu and secret state live apart from the draft so leaving either mode
  // brings back whatever the user had typed.
  const [selected, setSelected] = useState(0);
  const [secret, setSecret] = useState('');
  const [commandNavigation, setCommandNavigation] = useState({
    input: '',
    selected: 0,
    offset: 0,
  });
  const commandMatches = mode.type === 'text' ? matchCommands(input) : [];
  const activeCommandNavigation = commandNavigation.input === input
    ? commandNavigation
    : { input, selected: 0, offset: 0 };
  useEffect(() => {
    setCommandNavigation({ input, selected: 0, offset: 0 });
  }, [input]);
  useEffect(() => {
    setSelected(0);
    setSecret('');
  }, [mode]);
  // While a menu or secret prompt is open the arrows belong to it, not to
  // the sidebar's session switching.
  useEffect(() => {
    captureArrowKeys(mode.type !== 'text' || commandMatches.length > 0);
    return () => captureArrowKeys(false);
  }, [mode.type, commandMatches.length]);

  // Drag-selecting text copies it automatically; acknowledge that briefly
  // where the "enter" hint normally sits.
  const copiedAt = useSyncExternalStore(subscribeSelection, () => getSelectionSnapshot().copiedAt);
  const [showCopied, setShowCopied] = useState(false);
  useEffect(() => {
    if (copiedAt === null) return;
    setShowCopied(true);
    const timer = setTimeout(() => setShowCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copiedAt]);

  useInput((enteredInput, key) => {
    // mouse and window-focus reports are not typing
    if (isMouseInput(enteredInput) || isFocusInput(enteredInput)) return;

    // Most terminals (macOS included) send DEL for the backspace key, which
    // Ink reports as key.delete rather than key.backspace.
    const isBackspace = key.backspace || key.delete;

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
    if (mode.type === 'secret') {
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
      return;
    }
    if (key.tab && key.shift) {
      onCyclePermissionMode?.();
      return;
    }
    // ctrl+v (not cmd+v, which the terminal keeps for text) attaches the
    // clipboard image
    if (key.ctrl && enteredInput === 'v') {
      onPasteImage?.();
      return;
    }
    if (commandMatches.length > 0 && (key.upArrow || key.downArrow)) {
      setCommandNavigation(current => {
        const navigation = current.input === input
          ? current
          : { input, selected: 0, offset: 0 };
        return {
          input,
          ...moveCommandMenuSelection(
            navigation,
            key.upArrow ? -1 : 1,
            commandMatches.length,
          ),
        };
      });
      return;
    }
    // cmd+backspace: reported with the super modifier under the kitty keyboard
    // protocol; other terminals map it to ctrl+u, readline's kill-line
    if ((isBackspace && key.super) || (key.ctrl && enteredInput === 'u')) {
      setEditor(state => applyInputEdit(state, { type: 'clear' }));
      return;
    }
    // option+backspace: ESC DEL when option acts as meta, ctrl+w otherwise
    if ((isBackspace && key.meta) || (key.ctrl && enteredInput === 'w')) {
      setEditor(state => applyInputEdit(state, { type: 'delete-word-backward' }));
      return;
    }
    if (isBackspace) {
      if (input.length === 0 && attachments.length > 0) onRemoveAttachment?.();
      else setEditor(state => applyInputEdit(state, { type: 'backspace' }));
      return;
    }

    if (key.leftArrow) {
      setEditor(state => applyInputEdit(state, { type: 'left' }));
      return;
    }
    if (key.rightArrow) {
      setEditor(state => applyInputEdit(state, { type: 'right' }));
      return;
    }

    if (key.return) {
      if (disabled) return; // keep what's typed while sirus is thinking
      const selectedCommand = commandMatches[activeCommandNavigation.selected];
      const trimmed = selectedCommand ? `/${selectedCommand.name}` : input.trim();
      if (!trimmed && attachments.length === 0) return; // nothing to send
      send(trimmed, attachments);
      setEditor({ text: '', cursor: 0 });
      return;
    }

    if (!key.ctrl && !key.meta && !key.escape && !key.tab
      && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow
      && !key.pageUp && !key.pageDown && !key.home && !key.end) {
      setEditor(state => applyInputEdit(state, { type: 'insert', text: enteredInput }));
    }
  });

  if (mode.type !== 'text') {
    return (
      <>
        {mode.type === 'menu' && <SelectMenu items={mode.items} selected={selected} />}
        {mode.type === 'approval' && (
          <ApprovalPrompt request={mode.request} waiting={mode.waiting} selected={selected} />
        )}
        <InputFeedback feedback={feedback} participantColors={participantColors} />
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
                    {mode.type === 'approval' ? '↑↓ choose · enter to select · y / a / n' : '↑↓ choose · enter to select'}
                  </Text>
                </Box>
              )}
            <Text color={theme.textSubtle}>{mode.type === 'approval' ? 'esc cancels the turn' : 'esc cancels'}</Text>
          </Box>
        </Box>
        <SubagentStatusRow permissionMode={permissionMode} model={model} thinkingLevel={thinkingLevel} />
      </>
    );
  }

  return (
    <>
      <CommandMenu
        input={input}
        selected={activeCommandNavigation.selected}
        offset={activeCommandNavigation.offset}
      />
      <ParticipantMenu input={input} participants={participants} />
      <InputFeedback feedback={feedback} participantColors={participantColors} />
      <AttachmentRow attachments={attachments} />
      <Box
        borderStyle="round"
        borderColor={disabled ? theme.border : theme.accent}
        paddingX={1}
        marginX={1}
        flexShrink={0}
        flexDirection="column"
      >
        <Box justifyContent="space-between">
          <Box>
            <Text color={disabled ? theme.textSubtle : theme.accentSoft}>
              ›{' '}
            </Text>
            {input ? (
              <Text color={theme.text} wrap="wrap">
                <MentionText colors={participantColors}>{input.slice(0, editor.cursor)}</MentionText>
                <Text color={theme.accentSoft}>▌</Text>
                <MentionText colors={participantColors}>{input.slice(editor.cursor)}</MentionText>
              </Text>
            ) : (
              <>
                <Text color={disabled ? theme.textSubtle : theme.accentSoft}>▌</Text>
                <Text color={theme.textSubtle}>
                  {disabled
                    ? ' agents are thinking…'
                    : <> message sirus or <MentionText colors={participantColors}>@mention</MentionText> an agent…</>}
                </Text>
              </>
            )}
          </Box>
          {showCopied
            ? <Text color={theme.success}>copied ✓</Text>
            : <Text color={theme.textSubtle}>enter ↵</Text>}
        </Box>
      </Box>
      <SubagentStatusRow permissionMode={permissionMode} model={model} thinkingLevel={thinkingLevel} />
    </>
  );
}
