import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { CommandMenu, moveCommandMenuSelection } from './CommandMenu';
import { moveSelection, SelectMenu } from './SelectMenu';
import {
  matchCommands,
  type CommandMenuEntry,
  type CommandMenuItem,
} from '../../commands/registry';
import { isMouseInput } from '../interaction/mouse';
import { getSelectionSnapshot, subscribeSelection } from '../interaction/selection';
import type { Feedback } from '../../commands/feedback';
import type { Participant } from '../../agent_runtime/session';
import { ParticipantMenu } from './ParticipantMenu';
import { MentionText, participantColorMap, type ParticipantColors } from '../MentionText';
import { activeSubagentCount, getSubagentsVersion, subscribeSubagents } from '../../agent_runtime/tools/subagents';
import { contextPercent, formatTokens, type ContextUsage } from '../../agent_runtime/usage';
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
  | { type: 'left' | 'right' | 'up' | 'down' | 'backspace' | 'delete-word-backward' | 'clear' };

// Pasted text and typed text alike: one newline per line break.
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

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

// The cursor one line up or down, keeping its character column where the
// line allows. Count whole characters so movement cannot split a surrogate pair.
function lineMove(text: string, cursor: number, delta: -1 | 1): number {
  const lineStart = cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1;
  const column = [...text.slice(lineStart, cursor)].length;
  let targetStart: number;
  let targetEnd: number;
  if (delta < 0) {
    if (lineStart === 0) return cursor;
    targetStart = lineStart >= 2 ? text.lastIndexOf('\n', lineStart - 2) + 1 : 0;
    targetEnd = lineStart - 1;
  } else {
    const lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1) return cursor;
    targetStart = lineEnd + 1;
    const nextEnd = text.indexOf('\n', targetStart);
    targetEnd = nextEnd === -1 ? text.length : nextEnd;
  }
  let target = targetStart;
  for (let index = 0; index < column && target < targetEnd; index++) {
    target = nextCharacter(text, target);
  }
  return target;
}

export function onFirstLine(state: InputState): boolean {
  return !state.text.slice(0, state.cursor).includes('\n');
}

export function onLastLine(state: InputState): boolean {
  return !state.text.slice(state.cursor).includes('\n');
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
    case 'up':
      return { ...state, cursor: lineMove(state.text, cursor, -1) };
    case 'down':
      return { ...state, cursor: lineMove(state.text, cursor, 1) };
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
  send: (input: string) => void;
  inputContent: string;
  setInputContent: (inputContent: string) => void;
  disabled: boolean;
  feedback: Feedback | null;
  participants: readonly Participant[];
  mode?: InputMode;
  permissionMode?: PermissionMode;
  // shift+tab in text mode
  onCyclePermissionMode?: () => void;
  // the session's current model, shown under the input bar
  model?: string;
  thinkingLevel?: string;
  // the session's earlier prompts, oldest first, for ↑/↓ recall
  history?: readonly string[];
  // messages waiting to go out once the agents are free
  queued?: number;
  // where a message sent while the agents are working goes; without it the
  // draft simply stays put
  onQueue?: (text: string) => void;
  contextUsage?: ContextUsage | null;
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

// The context gauge: how much of the model's window the last response used.
// Muted until it matters, amber when it is getting full, red when nearly so.
export function ContextGauge({ usage }: { usage: ContextUsage }) {
  const percent = contextPercent(usage);
  const color = percent === null ? theme.textSubtle
    : percent >= 90 ? theme.danger
      : percent >= 70 ? theme.pending : theme.textSubtle;
  return (
    <Text color={color} dimColor={percent === null || percent < 70}>
      ctx {formatTokens(usage.tokens)}{percent !== null ? ` · ${percent}%` : ''}
    </Text>
  );
}

// The line under the input box: the session's permission mode, messages
// waiting to be sent, then how many spawned subagents are still at work; the
// context gauge and the session's model stay on the far right. It keeps its
// height when there is nothing to say so the layout stays put.
export function SubagentStatusRow({ permissionMode, model, thinkingLevel, queued = 0, contextUsage }: {
  permissionMode?: PermissionMode;
  model?: string;
  thinkingLevel?: string;
  queued?: number;
  contextUsage?: ContextUsage | null;
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
        {queued > 0 && (
          <Text color={theme.textMuted}>
            {permissionMode ? ' · ' : ''}{queued} queued
            <Text color={theme.textSubtle}> · esc discards</Text>
          </Text>
        )}
        {active > 0 && (
          <Text color={theme.textMuted}>{permissionMode || queued > 0 ? ' · ' : ''}{active} active subagent{active === 1 ? '' : 's'}</Text>
        )}
      </Box>
      <Box>
        {contextUsage && <ContextGauge usage={contextUsage} />}
        {contextUsage && model && <Text color={theme.textSubtle} dimColor> · </Text>}
        {model && (
          <Text color={theme.textSubtle} dimColor>
            {model}{thinkingLevel ? ` · ${thinkingLevel}` : ''}
          </Text>
        )}
      </Box>
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

// Detail lines carry their own marks: removed and added lines of an edit,
// the shell prompt of a command. Colour follows the mark.
export function detailColor(line: string): string {
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

const TEXT_MODE: InputMode = { type: 'text' };
const NO_HISTORY: readonly string[] = [];

export function InputBar({
  send,
  inputContent,
  setInputContent,
  disabled,
  feedback,
  participants,
  mode = TEXT_MODE,
  permissionMode,
  onCyclePermissionMode,
  model,
  thinkingLevel,
  history = NO_HISTORY,
  queued = 0,
  onQueue,
  contextUsage,
}: InputBarProps) {
  const [cursor, setCursor] = useState(inputContent.length);
  const input = inputContent;
  const editor: InputState = { text: inputContent, cursor };
  function setEditor(next: InputState): void {
    setCursor(next.cursor);
    setInputContent(next.text);
  }
  const participantColors = participantColorMap(participants);
  // Menu and secret state live apart from the draft so leaving either mode
  // brings back whatever the user had typed.
  const [selected, setSelected] = useState(0);
  const [secret, setSecret] = useState('');
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [commandNavigation, setCommandNavigation] = useState({
    input: '',
    selected: 0,
    offset: 0,
  });
  // Which earlier prompt ↑ has brought back, and the draft it replaced so ↓
  // past the newest one restores it. Editing leaves the recall.
  const [recall, setRecall] = useState<{ index: number; draft: InputState } | null>(null);
  const commandMatches = mode.type === 'text' && !commandMenuDismissed ? matchCommands(input) : [];
  const activeCommandNavigation = commandNavigation.input === input
    ? commandNavigation
    : { input, selected: 0, offset: 0 };
  useEffect(() => {
    setCommandNavigation({ input, selected: 0, offset: 0 });
    setCommandMenuDismissed(false);
  }, [input]);
  useEffect(() => {
    setSelected(0);
    setSecret('');
  }, [mode]);

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

  const edit = (change: InputEdit) => {
    setRecall(null);
    setEditor(applyInputEdit(editor, change));
  };
  const insertText = (text: string) => edit({ type: 'insert', text: normalizeNewlines(text) });
  const recallPrevious = () => {
    if (history.length === 0) return;
    const index = recall ? recall.index - 1 : history.length - 1;
    if (index < 0) return;
    setRecall({ index, draft: recall?.draft ?? editor });
    setEditor({ text: history[index], cursor: history[index].length });
  };
  const recallNext = () => {
    if (!recall) return;
    const index = recall.index + 1;
    if (index >= history.length) {
      setEditor(recall.draft);
      setRecall(null);
      return;
    }
    setRecall({ ...recall, index });
    setEditor({ text: history[index], cursor: history[index].length });
  };

  // A paste lands whole, line breaks included, rather than as keystrokes.
  usePaste(text => {
    if (mode.type === 'secret') setSecret(current => current + text.trim());
    else if (mode.type === 'text') insertText(text);
  });

  useInput((enteredInput, key) => {
    if (isMouseInput(enteredInput)) return;
    // Session switching belongs to the sidebar in every input mode.
    if (key.meta && (key.upArrow || key.downArrow)) return;

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
    if (key.escape) {
      setCommandMenuDismissed(true);
      return;
    }
    if (key.tab && key.shift) {
      onCyclePermissionMode?.();
      return;
    }
    if (key.upArrow || key.downArrow) {
      // Modified arrows do not navigate the editor or prompt history.
      if (key.shift || key.ctrl || key.meta) return;
      if (commandMatches.length > 0) {
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
      // inside a long prompt the arrows move between its lines; past its
      // first or last line they walk the session's earlier prompts
      if (key.upArrow && !onFirstLine(editor)) {
        setEditor(applyInputEdit(editor, { type: 'up' }));
        return;
      }
      if (key.downArrow && !onLastLine(editor)) {
        setEditor(applyInputEdit(editor, { type: 'down' }));
        return;
      }
      if (key.upArrow) recallPrevious();
      else recallNext();
      return;
    }
    // cmd+backspace: reported with the super modifier under the kitty keyboard
    // protocol; other terminals map it to ctrl+u, readline's kill-line
    if ((isBackspace && key.super) || (key.ctrl && enteredInput === 'u')) {
      edit({ type: 'clear' });
      return;
    }
    // option+backspace: ESC DEL when option acts as meta, ctrl+w otherwise
    if ((isBackspace && key.meta) || (key.ctrl && enteredInput === 'w')) {
      edit({ type: 'delete-word-backward' });
      return;
    }
    if (isBackspace) {
      edit({ type: 'backspace' });
      return;
    }

    if (key.leftArrow) {
      setEditor(applyInputEdit(editor, { type: 'left' }));
      return;
    }
    if (key.rightArrow) {
      setEditor(applyInputEdit(editor, { type: 'right' }));
      return;
    }

    if (key.return) {
      // shift+enter under the kitty protocol, option+enter elsewhere
      if (key.shift || key.meta) {
        insertText('\n');
        return;
      }
      // a trailing backslash asks for a new line where the terminal cannot
      // report either modifier
      if (editor.cursor === input.length && input.endsWith('\\')) {
        setRecall(null);
        setEditor({ text: `${input.slice(0, -1)}\n`, cursor: input.length });
        return;
      }
      const selectedCommand = commandMatches[activeCommandNavigation.selected];
      const trimmed = selectedCommand ? `/${selectedCommand.name}` : input.trim();
      if (!trimmed) return; // nothing to send
      if (disabled) {
        if (!onQueue) return; // keep what's typed while sirus is thinking
        onQueue(trimmed);
      } else {
        send(trimmed);
      }
      setRecall(null);
      setEditor({ text: '', cursor: 0 });
      return;
    }

    if (!key.ctrl && !key.meta && !key.escape && !key.tab
      && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow
      && !key.pageUp && !key.pageDown && !key.home && !key.end) {
      insertText(enteredInput);
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
        <SubagentStatusRow
          permissionMode={permissionMode}
          model={model}
          thinkingLevel={thinkingLevel}
          queued={queued}
          contextUsage={contextUsage}
        />
      </>
    );
  }

  return (
    <>
      {!commandMenuDismissed && <CommandMenu
        input={input}
        selected={activeCommandNavigation.selected}
        offset={activeCommandNavigation.offset}
      />}
      <ParticipantMenu input={input} participants={participants} />
      <InputFeedback feedback={feedback} participantColors={participantColors} />
      <Box
        borderStyle="round"
        borderColor={disabled ? theme.border : theme.accent}
        paddingX={1}
        marginX={1}
        flexShrink={0}
        flexDirection="column"
      >
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            <Text color={disabled ? theme.textSubtle : theme.accentSoft}>
              ›{' '}
            </Text>
            {input ? (
              <Text color={theme.text} wrap="wrap">
                <MentionText colors={participantColors}>{input.slice(0, cursor)}</MentionText>
                <Text color={theme.accentSoft}>▌</Text>
                <MentionText colors={participantColors}>{input.slice(cursor)}</MentionText>
              </Text>
            ) : (
              <>
                <Text color={disabled ? theme.textSubtle : theme.accentSoft}>▌</Text>
                <Text color={theme.textSubtle}>
                  {disabled
                    ? onQueue ? ' agents are thinking… enter queues a message' : ' agents are thinking…'
                    : <> message sirus or <MentionText colors={participantColors}>@mention</MentionText> an agent…</>}
                </Text>
              </>
            )}
          </Box>
          <Box marginLeft={1} flexShrink={0}>
            {showCopied
              ? <Text color={theme.success}>copied ✓</Text>
              : <Text color={theme.textSubtle}>{disabled && onQueue ? 'enter queues ↵' : 'enter ↵'}</Text>}
          </Box>
        </Box>
      </Box>
      <SubagentStatusRow
        permissionMode={permissionMode}
        model={model}
        thinkingLevel={thinkingLevel}
        queued={queued}
        contextUsage={contextUsage}
      />
    </>
  );
}
