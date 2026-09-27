import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { CommandMenu, useCommandMenu } from './CommandMenu';
import { isNativeCommand } from '../../commands/registry';
import { MentionMenu, useMentionMenu } from './MentionMenu';
import { useFileSuggestions } from './FileMenu';
import { DraftText, TrailingImages } from './DraftText';
import { InputFeedback, QueuedRow } from './InputRows';
import { SubagentStatusRow, type StatusRowProps } from './StatusRow';
import { stripWorkers, WorkerStrip, type WorkerSelection } from './WorkerStrip';
import { PromptBar, type PromptMode } from './PromptBar';
import { applyInputEdit, createInputHistory, inputEditForKey, isKeyboardProtocolReport, normalizeNewlines, onFirstLine, onLastLine, type InputEdit, type InputState } from './editor';
import { composeContent, removedPlaceholders, stripPlaceholders, useDraftImages } from './draft';
import { MentionText, participantColorMap } from '../MentionText';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';
import { getSelectionSnapshot, subscribeSelection } from '../interaction/selection';
import type { Feedback } from '../../commands/feedback';
import type { Participant, QueuedMessage } from '../../agent_runtime/session';
import type { ImageBlock, MessageBlock } from '../../agent_runtime/types';
import type { SubagentRun } from '../../agent_runtime/tools/subagents';
import type { ContextUsage } from '../../agent_runtime/usage';
import type { PermissionMode } from '../../agent_runtime/permissions/policy';
import type { NativeCommand } from '../../agent_runtime/runtime/commands';

// What the input bar is collecting: a message, or one of the prompts that
// take the bar over for a moment.
export type InputMode = { type: 'text' } | PromptMode;

interface InputBarProps {
  send: (input: string, attachments?: readonly ImageBlock[], content?: MessageBlock[]) => unknown;
  inputContent: string;
  setInputContent: (inputContent: string) => void;
  disabled: boolean;
  feedback: Feedback | null;
  participants: readonly Participant[];
  // the session's background workers, for the strip above the status row
  workers?: readonly SubagentRun[];
  directory?: string;
  mode?: InputMode;
  permissionMode?: PermissionMode;
  // what the vendor made of that mode, when it could not honour it
  modeNotice?: string | null;
  // shift+tab in text mode
  onCyclePermissionMode?: () => void;
  // Told when the worker strip takes the keyboard and when it gives it back,
  // so the chat's own Escape leaves a focused strip alone.
  onWorkerFocusChange?: (focused: boolean) => void;
  // images waiting to go with the next message, oldest first
  attachments?: readonly ImageBlock[];
  // ctrl+v in text mode
  onPasteImage?: () => void;
  // backspace over an image in the draft drops it
  onRemoveAttachment?: (image: ImageBlock) => void;
  // the session's current model, shown under the input bar
  model?: string;
  thinkingLevel?: string;
  // the session's earlier prompts, oldest first, for ↑/↓ recall
  history?: readonly string[];
  // messages waiting to go out once the agents are free, oldest first
  queuedMessages?: readonly QueuedMessage[];
  // Tab queues the complete draft for after the running turn.
  onQueue?: (text: string, images?: readonly ImageBlock[], content?: MessageBlock[]) => void;
  onBeginQueuedEdit?: (id: string) => void;
  onCancelQueuedEdit?: (id: string) => void;
  onEscape?: () => void;
  onRewind?: () => void;
  onInterrupt?: () => boolean;
  onExit?: () => void;
  onExitHint?: () => void;
  // Enter commits the private queue draft; empty text removes a text-only item.
  onUpdateQueued?: (id: string, text: string) => void;
  contextUsage?: ContextUsage | null;
  // The vendor's own commands `/name` reaches, read while a slash command is
  // being typed.
  nativeCommands?: () => readonly NativeCommand[];
  tasksVisible?: boolean;
}

const TEXT_MODE: InputMode = { type: 'text' };
const NO_WORKERS: readonly SubagentRun[] = [];
const NO_ATTACHMENTS: readonly ImageBlock[] = [];
const NO_HISTORY: readonly string[] = [];
const NO_QUEUE: readonly QueuedMessage[] = [];
const NO_NATIVE_COMMANDS: readonly NativeCommand[] = [];

export function InputBar({
  send,
  inputContent,
  setInputContent,
  disabled,
  feedback,
  participants,
  workers = NO_WORKERS,
  directory,
  mode = TEXT_MODE,
  permissionMode,
  modeNotice,
  onCyclePermissionMode,
  onWorkerFocusChange,
  attachments = NO_ATTACHMENTS,
  onPasteImage,
  onRemoveAttachment,
  model,
  thinkingLevel,
  history = NO_HISTORY,
  queuedMessages = NO_QUEUE,
  onQueue,
  onBeginQueuedEdit,
  onCancelQueuedEdit,
  onEscape,
  onRewind,
  onInterrupt,
  onExit,
  onExitHint,
  onUpdateQueued,
  contextUsage,
  nativeCommands,
  tasksVisible,
}: InputBarProps) {
  const participantColors = participantColorMap(participants);
  const status: StatusRowProps = { permissionMode, modeNotice, model, thinkingLevel, contextUsage, tasksVisible };

  // ── The draft, and the waiting message standing in front of it ──────────
  // Identity survives edits and earlier messages draining from the queue.
  const [queueSelection, setQueueSelection] = useState<string | null>(null);
  const [queueText, setQueueText] = useState('');
  const editHistory = useRef(createInputHistory());
  const clearedPrompts = useRef<{ text: string; after: number }[]>([]);
  const lastEscape = useRef(0);
  const lastInterrupt = useRef(0);
  const editingRef = useRef<string | null>(null);
  const cancelEditRef = useRef(onCancelQueuedEdit);
  cancelEditRef.current = onCancelQueuedEdit;
  useEffect(() => () => {
    if (editingRef.current) cancelEditRef.current?.(editingRef.current);
  }, []);
  const selectedQueued = queuedMessages.find(message => message.id === queueSelection);
  const selectedQueueIndex = selectedQueued ? queuedMessages.indexOf(selectedQueued) : null;
  const draftCursor = useRef(inputContent.length);
  const [cursor, setCursor] = useState(inputContent.length);
  const previousInputContent = useRef(inputContent);
  useEffect(() => {
    // A rejected attachment restores the cleared draft from Chat. Resume
    // editing at its end, just as when recalling a previous prompt.
    if (!previousInputContent.current && inputContent && cursor === 0 && queueSelection === null) {
      setCursor(inputContent.length);
    }
    previousInputContent.current = inputContent;
  }, [inputContent, cursor, queueSelection]);
  const input = selectedQueued ? queueText : inputContent;
  const editor: InputState = { text: input, cursor: Math.min(cursor, input.length) };
  function leaveQueue(commit = false): void {
    if (queueSelection) {
      if (commit) onUpdateQueued?.(queueSelection, queueText);
      else onCancelQueuedEdit?.(queueSelection);
    }
    editingRef.current = null;
    setQueueSelection(null);
    editHistory.current.undo = [];
    setCursor(Math.min(draftCursor.current, inputContent.length));
  }
  function selectQueued(message: QueuedMessage): void {
    if (!selectedQueued) draftCursor.current = editor.cursor;
    else if (queueSelection) onCancelQueuedEdit?.(queueSelection);
    onBeginQueuedEdit?.(message.id);
    editingRef.current = message.id;
    setQueueSelection(message.id);
    setQueueText(message.text);
    editHistory.current.undo = [];
    setRecall(null);
    setCursor(message.text.length);
  }
  function setEditor(next: InputState): void {
    if (selectedQueued) setQueueText(next.text);
    else setInputContent(next.text);
    setCursor(next.cursor);
  }
  useEffect(() => {
    if (queueSelection !== null && !selectedQueued) leaveQueue();
  }, [queueSelection, selectedQueued]);
  useEffect(() => {
    if (mode.type !== 'text' && queueSelection !== null) leaveQueue();
  }, [mode]);

  // ── Attached images ────────────────────────────────────────────────────
  const { imageFor, isKnownPlaceholder, placedImages, trailingImages } = useDraftImages({
    attachments,
    text: input,
    // The images belong to the draft even while a queued message is showing.
    getDraft: () => ({ text: inputContent, cursor: selectedQueued ? draftCursor.current : editor.cursor }),
    setDraft: next => {
      setInputContent(next.text);
      if (selectedQueued) draftCursor.current = next.cursor;
      else setCursor(next.cursor);
    },
  });
  const draftMessage = () => {
    const content = composeContent(input.trim(), imageFor, trailingImages);
    const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    return { text, images: [...placedImages, ...trailingImages], content };
  };

  // ── The menus the draft opens: /commands and @mentions ─────────────────
  // Escape closes both until the draft changes again.
  const [menusDismissed, setMenusDismissed] = useState(false);
  useEffect(() => {
    setMenusDismissed(false);
  }, [input]);
  const nativeList = input.startsWith('/') ? nativeCommands?.() ?? NO_NATIVE_COMMANDS : NO_NATIVE_COMMANDS;
  const commands = useCommandMenu(input, mode.type === 'text' && !selectedQueued && !menusDismissed, nativeList);
  // A Sirus command takes no @mentions; a vendor command's arguments are a
  // prompt and do, once its name is complete.
  const commandText = input.startsWith('/') && !(input.includes(' ') && isNativeCommand(input, nativeList));
  const fileSuggestions = useFileSuggestions(
    mode.type === 'text' && !menusDismissed && !commandText ? directory : undefined,
    input,
    editor.cursor,
  );
  const mentionActive = mode.type === 'text' && !menusDismissed
    && !commandText && fileSuggestions.mention !== null;
  const mentions = useMentionMenu({
    active: mentionActive,
    input,
    cursor: editor.cursor,
    participants,
    files: fileSuggestions.files,
  });

  // ── Earlier prompts ────────────────────────────────────────────────────
  // Which one ↑ has brought back, and the draft it replaced so ↓ past the
  // newest one restores it. Editing leaves the recall.
  const recallHistory = [...history];
  for (const [offset, prompt] of clearedPrompts.current.entries()) {
    recallHistory.splice(Math.min(prompt.after + offset, recallHistory.length), 0, prompt.text);
  }
  const [recall, setRecall] = useState<{ index: number; draft: InputState } | null>(null);
  const recallPrevious = () => {
    editHistory.current.undo = [];
    if (recallHistory.length === 0) return;
    const index = recall ? recall.index - 1 : recallHistory.length - 1;
    if (index < 0) return;
    setRecall({ index, draft: recall?.draft ?? editor });
    setEditor({ text: recallHistory[index], cursor: recallHistory[index].length });
  };
  const recallNext = () => {
    if (!recall) return;
    const index = recall.index + 1;
    if (index >= recallHistory.length) {
      setEditor(recall.draft);
      setRecall(null);
      return;
    }
    setRecall({ ...recall, index });
    setEditor({ text: recallHistory[index], cursor: recallHistory[index].length });
  };

  // ── The worker strip ───────────────────────────────────────────────────
  // ↓ from the last line of the draft, where nothing else wants it, puts the
  // keyboard on the strip. The list is frozen as focus arrives, so the runs
  // cannot reorder or leave under the user while they walk it; ↑ past the
  // first line, escape, or simply typing gives the draft the keyboard back.
  const [workerSelection, setWorkerSelection] = useState<WorkerSelection | null>(null);
  useEffect(() => {
    if (mode.type !== 'text') setWorkerSelection(null);
  }, [mode]);
  useEffect(() => {
    onWorkerFocusChange?.(workerSelection !== null);
  }, [workerSelection !== null]);
  const focusWorkers = (): boolean => {
    const runs = stripWorkers(workers);
    if (runs.length === 0) return false;
    setWorkerSelection({ runs, index: 0 });
    return true;
  };
  const moveWorkerSelection = (delta: -1 | 1): void => {
    setWorkerSelection(current => {
      if (!current) return null;
      const index = current.index + delta;
      if (index < 0) return null;
      return index < current.runs.length ? { ...current, index } : current;
    });
  };

  const edit = (change: InputEdit) => {
    setRecall(null);
    const next = stripPlaceholders(applyInputEdit(editor, change, editHistory.current),
      placeholder => !isKnownPlaceholder(placeholder) || imageFor(placeholder) !== undefined);
    for (const placeholder of removedPlaceholders(editor.text, next.text)) {
      const image = imageFor(placeholder);
      if (image) onRemoveAttachment?.(image);
    }
    setEditor(next);
  };
  const insertText = (text: string) => edit({ type: 'insert', text: normalizeNewlines(text) });

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

  // A paste lands whole, line breaks included, rather than as keystrokes.
  usePaste(text => {
    if (mode.type === 'text') insertText(text);
  });

  useInput((enteredInput, key) => {
    if (isKeyboardProtocolReport(enteredInput)) return;
    if (key.eventType === 'release') return;
    if (key.ctrl && enteredInput === 'c') {
      if (onInterrupt?.()) {
        lastInterrupt.current = 0;
        return;
      }
      const now = Date.now();
      if (!input && now - lastInterrupt.current < 1000) {
        onExit?.();
        return;
      }
      if (input) {
        clearedPrompts.current.push({ text: draftMessage().text, after: history.length });
        if (selectedQueued) leaveQueue();
        setInputContent('');
        setCursor(0);
        setRecall(null);
        editHistory.current.undo = [];
      }
      lastInterrupt.current = now;
      onExitHint?.();
      return;
    }
    lastInterrupt.current = 0;
    // The prompt modes read their own Escape and editing keys.
    if (mode.type !== 'text') return;
    // Mouse and window-focus reports are not typing.
    if (isMouseInput(enteredInput) || isFocusInput(enteredInput)) return;
    // Session switching belongs to the sidebar in every input mode.
    if (key.meta && (key.upArrow || key.downArrow)) return;

    // Ink distinguishes the raw DEL backspace byte from forward Delete.
    const isBackspace = key.backspace;

    // While the strip has the keyboard it answers first, and keys it has no
    // use for do nothing. Enter opens the run's actions the way typing
    // `/agents <id>` would; a printable character returns to the draft and
    // lands in it, so a user who came here by accident simply carries on.
    if (workerSelection) {
      if (key.upArrow || key.downArrow) {
        moveWorkerSelection(key.upArrow ? -1 : 1);
        return;
      }
      if (key.return) {
        const run = workerSelection.runs[workerSelection.index];
        setWorkerSelection(null);
        if (run) send(`/agents ${run.id}`);
        return;
      }
      if (key.escape) {
        setWorkerSelection(null);
        return;
      }
      if (!enteredInput || isBackspace || key.ctrl || key.meta || key.tab
        || key.leftArrow || key.rightArrow
        || key.pageUp || key.pageDown || key.home || key.end) return;
      setWorkerSelection(null);
    }

    if (key.escape) {
      if (commands.matches.length > 0 || mentionActive) {
        setMenusDismissed(true);
        lastEscape.current = 0;
      } else if (queueSelection !== null) {
        leaveQueue();
        lastEscape.current = 0;
      } else {
        const now = Date.now();
        if (now - lastEscape.current < 500) {
          lastEscape.current = 0;
          if (input) {
            clearedPrompts.current.push({ text: draftMessage().text, after: history.length });
            setRecall(null);
            edit({ type: 'clear' });
          } else onRewind?.();
        } else {
          lastEscape.current = now;
          onEscape?.();
        }
      }
      return;
    }
    lastEscape.current = 0;
    if (key.tab && key.shift) {
      onCyclePermissionMode?.();
      return;
    }
    if (mentionActive && fileSuggestions.loading && mentions.items[mentions.selected]?.kind !== 'participant'
      && (key.tab || key.return) && !key.shift && !key.meta) return;
    if (mentionActive && fileSuggestions.mention && mentions.items.length > 0 && !key.ctrl && !key.meta && !key.shift) {
      if (key.upArrow || key.downArrow) {
        mentions.move(key.upArrow ? -1 : 1);
        return;
      }
      if (key.tab || key.return) {
        const { start, end } = fileSuggestions.mention;
        const replacement = mentions.items[mentions.selected].replacement;
        setRecall(null);
        setEditor({ text: input.slice(0, start) + replacement + input.slice(end), cursor: start + replacement.length });
        return;
      }
    }
    // tab completes the highlighted command, so its arguments can follow
    if (key.tab && !key.shift && commands.matches.length > 0) {
      const completed = `/${commands.matches[commands.selected].name} `;
      setRecall(null);
      setEditor({ text: completed, cursor: completed.length });
      return;
    }
    // ctrl+v (not cmd+v, which the terminal keeps for text) attaches the
    // clipboard image
    if (key.ctrl && enteredInput === 'v') {
      if (selectedQueued) leaveQueue();
      onPasteImage?.();
      return;
    }
    if (key.upArrow || key.downArrow) {
      // Modified arrows do not navigate the editor or prompt history.
      if (key.shift || key.ctrl || key.meta) return;
      if (commands.matches.length > 0) {
        commands.move(key.upArrow ? -1 : 1);
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
      if (onUpdateQueued && queuedMessages.length > 0 && !recall && (selectedQueued || key.upArrow)) {
        if (key.upArrow) {
          if (selectedQueueIndex === 0) {
            leaveQueue();
            if (recallHistory.length > 0) {
              const index = recallHistory.length - 1;
              setRecall({ index, draft: { text: inputContent, cursor: draftCursor.current } });
              setInputContent(recallHistory[index]);
              setCursor(recallHistory[index].length);
            }
          } else selectQueued(queuedMessages[selectedQueueIndex === null ? queuedMessages.length - 1 : selectedQueueIndex - 1]);
        } else if (selectedQueueIndex === queuedMessages.length - 1) {
          leaveQueue();
        } else if (selectedQueueIndex !== null) {
          selectQueued(queuedMessages[selectedQueueIndex + 1]);
        }
        return;
      }
      // ↓ with no earlier prompt to walk forward to would do nothing; the
      // strip takes it instead.
      if (key.downArrow && !recall && focusWorkers()) return;
      if (key.upArrow) recallPrevious();
      else recallNext();
      return;
    }
    const mappedEdit = inputEditForKey(enteredInput, key);
    if (mappedEdit) {
      if (mappedEdit.type === 'backspace' && !selectedQueued && input.length === 0 && trailingImages.length > 0) {
        onRemoveAttachment?.(trailingImages[trailingImages.length - 1]);
      } else edit(mappedEdit);
      return;
    }

    if (key.return || (key.tab && !key.shift && onQueue)) {
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
      if (selectedQueued) {
        leaveQueue(true);
        return;
      }
      const selectedCommand = commands.matches[commands.selected];
      const draft = draftMessage();
      const trimmed = selectedCommand ? `/${selectedCommand.name}` : draft.text.trim();
      if (!trimmed && draft.images.length === 0) return; // nothing to send
      if (key.tab) onQueue?.(trimmed, draft.images, draft.content);
      else if (send(trimmed, draft.images, draft.content) === false) return;
      editHistory.current.undo = [];
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
      <PromptBar
        mode={mode}
        feedback={feedback}
        participantColors={participantColors}
        queuedMessages={queuedMessages.map(message => message.text)}
        workers={workers}
        status={status}
      />
    );
  }

  return (
    <>
      {!selectedQueued && !menusDismissed && <CommandMenu
        input={input}
        selected={commands.selected}
        offset={commands.offset}
        nativeCommands={nativeList}
      />}
      {mentionActive && <MentionMenu
        items={mentions.items}
        participants={participants}
        selected={mentions.selected}
        offset={mentions.offset}
        loading={fileSuggestions.loading}
        error={fileSuggestions.error}
      />}
      <InputFeedback feedback={feedback} participantColors={participantColors} />
      <QueuedRow messages={queuedMessages.map(message => message.text)} selected={selectedQueueIndex} participantColors={participantColors} />
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
            <Box flexShrink={0}>
              <Text color={disabled ? theme.textSubtle : theme.accentSoft}>
                ›{' '}
              </Text>
            </Box>
            <Text color={theme.text} wrap="wrap">
              {!selectedQueued && !input && <TrailingImages images={trailingImages} after={false} />}
              {input ? (
                <>
                  <DraftText text={input.slice(0, cursor)} imageFor={imageFor} participantColors={participantColors} />
                  <Text color={theme.accentSoft}>▌</Text>
                  <DraftText text={input.slice(cursor)} imageFor={imageFor} participantColors={participantColors} />
                  {!selectedQueued && <TrailingImages images={trailingImages} after />}
                </>
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
            </Text>
          </Box>
          <Box marginLeft={1} flexShrink={0}>
            {showCopied
              ? <Text color={theme.success}>copied ✓</Text>
              : <Text color={theme.textSubtle}>{selectedQueued ? 'enter saves · esc restores' : disabled ? 'enter steers · tab queues' : 'enter ↵'}</Text>}
          </Box>
        </Box>
      </Box>
      <WorkerStrip workers={workers} selection={workerSelection} />
      <SubagentStatusRow {...status} />
    </>
  );
}
