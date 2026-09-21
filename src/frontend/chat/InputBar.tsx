import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { CommandMenu, useCommandMenu } from './CommandMenu';
import { MentionMenu, useMentionMenu } from './MentionMenu';
import { useFileSuggestions } from './FileMenu';
import { DraftText, TrailingImages } from './DraftText';
import { InputFeedback, QueuedRow } from './InputRows';
import { SubagentStatusRow, type StatusRowProps } from './StatusRow';
import { WorkerStrip } from './WorkerStrip';
import { PromptBar, type PromptMode } from './PromptBar';
import { applyInputEdit, normalizeNewlines, onFirstLine, onLastLine, type InputEdit, type InputState } from './editor';
import { composeContent, removedPlaceholders, useDraftImages } from './draft';
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

// What the input bar is collecting: a message, or one of the prompts that
// take the bar over for a moment.
export type InputMode = { type: 'text' } | PromptMode;

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
  permissionMode?: PermissionMode;
  // what the vendor made of that mode, when it could not honour it
  modeNotice?: string | null;
  // shift+tab in text mode
  onCyclePermissionMode?: () => void;
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
  // where a message sent while the agents are working goes; without it the
  // draft simply stays put
  onQueue?: (text: string) => void;
  // Edits a waiting message in place; empty text removes it.
  onUpdateQueued?: (id: string, text: string) => void;
  contextUsage?: ContextUsage | null;
}

const TEXT_MODE: InputMode = { type: 'text' };
const NO_WORKERS: readonly SubagentRun[] = [];
const NO_ATTACHMENTS: readonly ImageBlock[] = [];
const NO_HISTORY: readonly string[] = [];
const NO_QUEUE: readonly QueuedMessage[] = [];

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
  attachments = NO_ATTACHMENTS,
  onPasteImage,
  onRemoveAttachment,
  model,
  thinkingLevel,
  history = NO_HISTORY,
  queuedMessages = NO_QUEUE,
  onQueue,
  onUpdateQueued,
  contextUsage,
}: InputBarProps) {
  const participantColors = participantColorMap(participants);
  const status: StatusRowProps = { permissionMode, modeNotice, model, thinkingLevel, contextUsage };

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
  const commands = useCommandMenu(input, mode.type === 'text' && !selectedQueued && !menusDismissed);
  const fileSuggestions = useFileSuggestions(
    mode.type === 'text' && !menusDismissed && !input.startsWith('/') ? directory : undefined,
    input,
    editor.cursor,
  );
  const mentionActive = mode.type === 'text' && !menusDismissed
    && !input.startsWith('/') && fileSuggestions.mention !== null;
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
    // Mouse and window-focus reports are not typing.
    if (isMouseInput(enteredInput) || isFocusInput(enteredInput)) return;
    // Session switching belongs to the sidebar in every input mode.
    if (key.meta && (key.upArrow || key.downArrow)) return;

    // Most terminals (macOS included) send DEL for the backspace key, which
    // Ink reports as key.delete rather than key.backspace.
    const isBackspace = key.backspace || key.delete;

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
        send(trimmed, draft.images, draft.content);
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
              : <Text color={theme.textSubtle}>enter ↵</Text>}
          </Box>
        </Box>
      </Box>
      <WorkerStrip workers={workers} />
      <SubagentStatusRow {...status} />
    </>
  );
}
