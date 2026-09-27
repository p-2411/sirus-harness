import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { CommandMenu, useCommandMenu } from './CommandMenu';
import { isSirusCommand } from '../../commands/registry';
import { MentionMenu, useFileSuggestions, useMentionMenu } from './MentionMenu';
import { DraftText, TrailingImages } from './DraftText';
import { InputFeedback, QueuedRow } from './InputRows';
import { StatusRow, type StatusRowProps } from './StatusRow';
import { stripWorkers, WorkerStrip, type WorkerSelection } from './WorkerStrip';
import { PromptBar, type CommandPrompt } from './PromptBar';
import { ApprovalPrompt } from './ApprovalPrompt';
import { QuestionCard } from './QuestionCard';
import {
  applyInputEdit,
  isForeignInput,
  isTypedText,
  normalizeNewlines,
  onFirstLine,
  onLastLine,
  type InputEdit,
  type InputState,
} from './editor';
import { composeContent, removedPlaceholders, useDraftImages } from './draft';
import { MentionText, participantColorMap } from '../MentionText';
import { getSelectionSnapshot, subscribeSelection } from '../interaction/selection';
import type { Feedback } from '../../commands/feedback';
import type { Participant } from '../../agent_runtime/agent';
import type { QueuedMessage } from '../../agent_runtime/session/messageQueue';
import type { ImageBlock, MessageBlock, PermissionMode } from '../../agent_runtime/types';
import type { SubagentRun } from '../../agent_runtime/tools/subagents';
import type { ApprovalDecision, ApprovalRequest } from '../../agent_runtime/permissions/approvals';
import type { QuestionAnswer, QuestionRequest } from '../../agent_runtime/permissions/questions';
import type { NativeCommand } from '../../agent_runtime/runtime/commands';

// What the input bar is collecting: a message, the answer to an agent's
// approval request or question, or what a command's prompt asks for. Each of
// the others takes the bar over for a moment.
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
    type: 'question';
    request: QuestionRequest;
    // further questions queued behind this one for the same session
    waiting: number;
    onAnswer: (answer: QuestionAnswer) => void;
  }
  | CommandPrompt;

interface InputBarProps {
  send: (input: string, attachments?: readonly ImageBlock[], content?: MessageBlock[]) => void;
  inputContent: string;
  setInputContent: (inputContent: string) => void;
  disabled: boolean;
  feedback: Feedback | null;
  participants: readonly Participant[];
  // the session's background workers, for the strip above the status row
  workers?: readonly SubagentRun[];
  directory?: string;
  mode?: InputMode;
  // what the row under the input box says about the session: its permission
  // mode, its model and how full that model's context is
  status?: StatusRowProps;
  // shift+tab in text mode
  onCyclePermissionMode?: () => void;
  // Told whether the bar has something open that escape closes: the worker
  // strip's focus, a command or mention menu, a queued message being edited.
  // The bar closes it itself, and the chat cancels the turn on escape only
  // when there is nothing to close.
  onDismissibleChange?: (dismissible: boolean) => void;
  // images waiting to go with the next message, oldest first
  attachments?: readonly ImageBlock[];
  // ctrl+v in text mode
  onPasteImage?: () => void;
  // backspace over an image in the draft drops it
  onRemoveAttachment?: (image: ImageBlock) => void;
  // the session's earlier prompts, oldest first, for ↑/↓ recall
  history?: readonly string[];
  // messages waiting to go out once the agents are free, oldest first
  queuedMessages?: readonly QueuedMessage[];
  // where a message sent while the agents are working goes; without it the
  // draft simply stays put
  onQueue?: (text: string) => void;
  // Edits a waiting message in place; empty text removes it.
  onUpdateQueued?: (id: string, text: string) => void;
  // The vendor's own commands `/name` reaches, read while a slash command is
  // being typed.
  nativeCommands?: () => readonly NativeCommand[];
}

const TEXT_MODE: InputMode = { type: 'text' };
const NO_STATUS: StatusRowProps = {};
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
  status = NO_STATUS,
  onCyclePermissionMode,
  onDismissibleChange,
  attachments = NO_ATTACHMENTS,
  onPasteImage,
  onRemoveAttachment,
  history = NO_HISTORY,
  queuedMessages = NO_QUEUE,
  onQueue,
  onUpdateQueued,
  nativeCommands,
}: InputBarProps) {
  const participantColors = participantColorMap(participants);

  // ── The draft, and the waiting message standing in front of it ──────────
  // Identity survives edits and earlier messages draining from the queue.
  const [queueSelection, setQueueSelection] = useState<string | null>(null);
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
  const input = selectedQueued?.text ?? inputContent;
  const editor: InputState = { text: input, cursor: Math.min(cursor, input.length) };
  function leaveQueue(): void {
    setQueueSelection(null);
    setCursor(Math.min(draftCursor.current, inputContent.length));
  }
  function selectQueued(message: QueuedMessage): void {
    if (!selectedQueued) draftCursor.current = editor.cursor;
    setQueueSelection(message.id);
    setRecall(null);
    setCursor(message.text.length);
  }
  function setEditor(next: InputState): void {
    if (selectedQueued) {
      onUpdateQueued?.(selectedQueued.id, next.text);
      if (next.text.length === 0) {
        leaveQueue();
        return;
      }
    } else {
      setInputContent(next.text);
    }
    setCursor(next.cursor);
  }
  useEffect(() => {
    if (queueSelection !== null && !selectedQueued) leaveQueue();
  }, [queueSelection, selectedQueued]);
  useEffect(() => {
    if (mode.type !== 'text' && queueSelection !== null) leaveQueue();
  }, [mode]);

  // ── Attached images ────────────────────────────────────────────────────
  const { imageFor, placedImages, trailingImages } = useDraftImages({
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
  const sirusCommand = isSirusCommand(input, nativeList);
  const fileSuggestions = useFileSuggestions(
    mode.type === 'text' && !menusDismissed && !sirusCommand ? directory : undefined,
    input,
    editor.cursor,
  );
  const mentionActive = mode.type === 'text' && !menusDismissed
    && !sirusCommand && fileSuggestions.mention !== null;
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
  const [recall, setRecall] = useState<{ index: number; draft: InputState } | null>(null);
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

  // ── The worker strip ───────────────────────────────────────────────────
  // ↓ from the last line of the draft, where nothing else wants it, puts the
  // keyboard on the strip. The list is frozen as focus arrives, so the runs
  // cannot reorder or leave under the user while they walk it; ↑ past the
  // first line, escape, or simply typing gives the draft the keyboard back.
  const [workerSelection, setWorkerSelection] = useState<WorkerSelection | null>(null);
  useEffect(() => {
    if (mode.type !== 'text') setWorkerSelection(null);
  }, [mode]);
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

  // What escape closes here, which the chat has to know before it treats the
  // key as the turn's cancel. Reported after each render, so the chat reads
  // what was on screen when the key was pressed.
  const dismissible = workerSelection !== null || commands.matches.length > 0
    || mentionActive || selectedQueued !== undefined;
  useEffect(() => {
    onDismissibleChange?.(dismissible);
  }, [dismissible]);

  const edit = (change: InputEdit) => {
    setRecall(null);
    const next = applyInputEdit(editor, change);
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
    // The prompt modes read the keyboard themselves.
    if (mode.type !== 'text') return;
    if (isForeignInput(enteredInput, key)) return;

    // Most terminals (macOS included) send DEL for the backspace key, which
    // Ink reports as key.delete rather than key.backspace.
    const isBackspace = key.backspace || key.delete;

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
      if (!enteredInput || !isTypedText(key)) return;
      setWorkerSelection(null);
    }

    if (key.escape) {
      setMenusDismissed(true);
      if (queueSelection !== null) leaveQueue();
      return;
    }
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
      if (onUpdateQueued && queuedMessages.length > 0 && (selectedQueued || key.upArrow)) {
        if (key.upArrow) {
          selectQueued(queuedMessages[selectedQueueIndex === null ? queuedMessages.length - 1 : Math.max(0, selectedQueueIndex - 1)]);
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
      if (!selectedQueued && input.length === 0 && trailingImages.length > 0) onRemoveAttachment?.(trailingImages[trailingImages.length - 1]);
      else edit({ type: 'backspace' });
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
      if (selectedQueued) {
        leaveQueue();
        return;
      }
      const selectedCommand = commands.matches[commands.selected];
      const draft = draftMessage();
      const trimmed = selectedCommand ? `/${selectedCommand.name}` : draft.text.trim();
      if (!trimmed && draft.images.length === 0) return; // nothing to send
      if (disabled) {
        // The session queue contains text. Keep image drafts intact until
        // they can be sent together with their prompt.
        if (!onQueue || draft.images.length > 0) return;
        onQueue(trimmed);
      } else {
        // A command picked from the menu is sent by its full name; the
        // draft's content is only the prefix typed to find it.
        send(trimmed, draft.images, selectedCommand ? undefined : draft.content);
      }
      setRecall(null);
      setEditor({ text: '', cursor: 0 });
      return;
    }

    if (isTypedText(key)) insertText(enteredInput);
  });

  // The lines around the input box stay put whatever the box holds: the last
  // command's feedback and the waiting messages above it, the worker strip
  // and the status row below. A menu opens above them all.
  const frame = (menu: ReactNode, box: ReactNode) => (
    <>
      {menu}
      <InputFeedback feedback={feedback} participantColors={participantColors} />
      <QueuedRow messages={queuedMessages.map(message => message.text)} selected={selectedQueueIndex} participantColors={participantColors} />
      {box}
      <WorkerStrip workers={workers} selection={workerSelection} />
      <StatusRow {...status} />
    </>
  );

  // An approval or a question card stands where the input box stands. Each
  // is known by its request, which the chat wraps in a new mode every time
  // it draws: a redraw keeps the card's place, a new request starts afresh.
  if (mode.type === 'approval') {
    return frame(null, <ApprovalPrompt key={mode.request.id} request={mode.request} waiting={mode.waiting} onDecide={mode.onDecide} />);
  }
  if (mode.type === 'question') {
    return frame(null, <QuestionCard key={mode.request.id} request={mode.request} waiting={mode.waiting} onAnswer={mode.onAnswer} />);
  }
  if (mode.type !== 'text') return <PromptBar mode={mode} frame={frame} />;

  return frame(
    <>
      <CommandMenu matches={commands.matches} selected={commands.selected} offset={commands.offset} />
      {mentionActive && <MentionMenu
        items={mentions.items}
        participants={participants}
        selected={mentions.selected}
        offset={mentions.offset}
        loading={fileSuggestions.loading}
        error={fileSuggestions.error}
      />}
    </>,
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
            : <Text color={theme.textSubtle}>enter ↵</Text>}
        </Box>
      </Box>
    </Box>,
  );
}
