import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useBoxMetrics, useInput, usePaste, useStdout, type DOMElement } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../styles/theme';
import { CommandMenu, useCommandMenu } from './CommandMenu';
import { isNativeCommand, isSirusCommand } from '../../commands/registry';
import { MentionMenu, useFileSuggestions, useMentionMenu } from './MentionMenu';
import { DraftRow, TrailingImages } from './DraftText';
import { describeImage, attachImageFile } from '../../images';
import { readPromptHistory, appendPromptHistory } from '../../persistence/promptHistory';
import { editInExternalEditor } from './externalEditor';
import { KEY_BINDINGS } from '../../commands/help/commands';
import { InputFeedback, QueuedRow } from './InputRows';
import { StatusRow, type StatusRowProps } from './StatusRow';
import { stripWorkers, WorkerStrip, type WorkerSelection } from './WorkerStrip';
import { PromptBar, type PromptMode } from './PromptBar';
import {
  applyInputEdit,
  backspaceAtEnd,
  createInputHistory,
  draftCursorRow,
  draftRows,
  inputEditForKey,
  isForeignInput,
  isKeyboardProtocolReport,
  isTypedText,
  moveDraftRow,
  normalizeNewlines,
  type InputEdit,
  type InputState,
} from './editor';
import { composeContent, removedPlaceholders, reserveImagePlaceholder, stripPlaceholders, useDraftImages, createDraftImageState, type DraftImageState } from './draft';
import { MentionText, participantColorMap } from '../MentionText';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';
import { clearSelection, getSelectionSnapshot, hasSelection, subscribeSelection } from '../interaction/selection';
import { useSelectionRegion } from '../interaction/useTextSelection';
import type { Feedback } from '../../commands/feedback';
import type { Participant } from '../../agent_runtime/agent';
import type { QueuedMessage } from '../../agent_runtime/session/messageQueue';
import { DEFAULT_PARTICIPANT, type ImageBlock, type MessageBlock, type PermissionMode } from '../../agent_runtime/types';
import type { SubagentRun } from '../../agent_runtime/tools/subagents';
import type { ContextUsage } from '../../agent_runtime/usage';
import { errorMessage } from '../../abort';
import type { NativeCommand } from '../../agent_runtime/runtime/commands';

// What the input bar is collecting: a message, or one of the prompts that
// take the bar over for a moment.
export type InputMode = { type: 'text' } | PromptMode;

export interface InputDraftState {
  pastes: Map<string, { text: string; label: string }>;
  pasteNumber: number;
  cursor?: number;
  images: DraftImageState;
}

export function createInputDraftState(): InputDraftState {
  return { pastes: new Map(), pasteNumber: 0, images: createDraftImageState() };
}

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
  onOverlayChange?: (open: boolean) => void;
  // images waiting to go with the next message, oldest first
  attachments?: readonly ImageBlock[];
  // A paste shortcut forwarded by the terminal: text or image, one action.
  onPasteClipboard?: () => string | void | Promise<string | void>;
  onAttachImage?: (image: ImageBlock) => void;
  // backspace over an image in the draft drops it
  onRemoveAttachment?: (image: ImageBlock) => void;
  // the selected agent's model, shown under the input bar
  model?: string;
  thinkingLevel?: string;
  // the session's earlier prompts, oldest first, for ↑/↓ recall
  history?: readonly string[];
  // messages waiting to go out once the agents are free, oldest first
  queuedMessages?: readonly QueuedMessage[];
  // Ctrl+Enter (or Ctrl+X Ctrl+S) delivers the waiting messages now.
  onSendNow?: (text?: string, images?: readonly ImageBlock[], content?: MessageBlock[]) => void;
  // ↑ takes these messages out of the queue; returns the ones it removed.
  onTakeQueued?: (ids: readonly string[]) => readonly QueuedMessage[];
  onEscape?: () => void;
  onRewind?: () => void;
  onInterrupt?: () => boolean;
  onExit?: () => void;
  onExitHint?: () => void;
  contextUsage?: ContextUsage | null;
  // The vendor's own commands `/name` reaches, read while a slash command is
  // being typed.
  nativeCommands?: () => readonly NativeCommand[];
  tasksVisible?: boolean;
  recipient?: string;
  draftState?: InputDraftState;
  onSelectAgent?: (direction: -1 | 1) => void;
}

const TEXT_MODE: InputMode = { type: 'text' };
const NO_WORKERS: readonly SubagentRun[] = [];
const NO_ATTACHMENTS: readonly ImageBlock[] = [];
const NO_HISTORY: readonly string[] = [];
const NO_QUEUE: readonly QueuedMessage[] = [];
const NO_NATIVE_COMMANDS: readonly NativeCommand[] = [];

export function InputBar({
  send,
  inputContent: externalInputContent,
  setInputContent: setExternalInputContent,
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
  onOverlayChange,
  attachments = NO_ATTACHMENTS,
  onPasteClipboard,
  onAttachImage,
  onRemoveAttachment,
  model,
  thinkingLevel,
  history = NO_HISTORY,
  queuedMessages = NO_QUEUE,
  onSendNow,
  onTakeQueued,
  onEscape,
  onRewind,
  onInterrupt,
  onExit,
  onExitHint,
  contextUsage,
  nativeCommands,
  tasksVisible,
  recipient = DEFAULT_PARTICIPANT,
  draftState,
  onSelectAgent,
}: InputBarProps) {
  const memory = useRef(draftState ?? createInputDraftState()).current;
  const pastes = useRef(memory.pastes);
  const expandPastes = (text: string) => [...text].map(character => pastes.current.get(character)?.text ?? character).join('');
  const [input, setLocalInput] = useState(externalInputContent);
  const setInputContent = (text: string) => {
    setLocalInput(text);
    // Session snapshots always keep the full text, including while a paste is folded.
    setExternalInputContent(expandPastes(text));
  };
  useEffect(() => {
    if (externalInputContent !== expandPastes(input)) setLocalInput(externalInputContent);
  }, [externalInputContent]);
  const [savedHistory, setSavedHistory] = useState(() => directory ? readPromptHistory(directory) : []);
  useEffect(() => { setSavedHistory(directory ? readPromptHistory(directory) : []); }, [directory]);
  const [search, setSearch] = useState<{ query: string; index: number; draft: InputState } | null>(null);
  const [shortcuts, setShortcuts] = useState<number | null>(null);
  const [localFeedback, setLocalFeedback] = useState<Feedback | null>(null);
  const [editingExternally, setEditingExternally] = useState(false);
  useEffect(() => { onOverlayChange?.(search !== null || shortcuts !== null || editingExternally); }, [search !== null, shortcuts !== null, editingExternally]);
  useEffect(() => () => onOverlayChange?.(false), []);
  const editorPrefix = useRef(false);
  const { suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const shortcutPageSize = Math.max(1, Math.min(12, Math.floor(((stdout.rows || 24) - 12) / 3)));
  const inputBox = useRef<DOMElement>(null);
  const { width: boxWidth } = useBoxMetrics(inputBox);
  // A drag in the bar stays in the bar, and one that starts on the draft
  // stays on the draft: the prompt mark, hint and border are not text.
  const draftColumn = useRef<DOMElement>(null);
  useSelectionRegion(inputBox);
  useSelectionRegion(draftColumn);
  const participantColors = participantColorMap(participants);
  const status: StatusRowProps = { permissionMode, modeNotice, model, thinkingLevel, contextUsage, tasksVisible };

  // ── The draft ──────────────────────────────────────────────────────────
  const editHistory = useRef(createInputHistory());
  const clearedPrompts = useRef<{ text: string; after: number }[]>([]);
  const lastEscape = useRef(0);
  const lastInterrupt = useRef(0);
  const [cursor, setCursor] = useState(memory.cursor ?? input.length);
  useEffect(() => { memory.cursor = cursor; }, [cursor, memory]);
  const previousInputContent = useRef(input);
  useEffect(() => {
    // A rejected attachment restores the cleared draft from Chat. Resume
    // editing at its end, just as when recalling a previous prompt.
    if (!previousInputContent.current && input && cursor === 0) setCursor(input.length);
    previousInputContent.current = input;
  }, [input, cursor]);
  const editor: InputState = { text: input, cursor: Math.min(cursor, input.length) };
  function setEditor(next: InputState): void {
    setInputContent(next.text);
    setCursor(next.cursor);
  }

  // ── Attached images ────────────────────────────────────────────────────
  const { imageFor, isKnownPlaceholder, placedImages, trailingImages } = useDraftImages({
    state: memory.images,
    attachments,
    text: input,
    getDraft: () => editor,
    setDraft: setEditor,
  });
  const draftMessage = () => {
    const content = composeContent(expandPastes(input).trim(), imageFor, trailingImages);
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
  const commands = useCommandMenu(input, mode.type === 'text' && !menusDismissed, nativeList);
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
  const recallHistory = [...savedHistory];
  const recalled = new Set(recallHistory);
  for (const prompt of history) {
    if (recalled.has(prompt)) continue;
    recallHistory.push(prompt);
    recalled.add(prompt);
  }
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

  // ── Queued messages ────────────────────────────────────────────────────
  // ↑ from the draft's first line takes back everything queued for this
  // agent: the messages leave the queue and open the draft, one per line
  // ahead of what was typed. From there it is an ordinary draft, so Enter
  // sends or queues it as one message and clearing it drops them.
  const takeBackQueued = (): boolean => {
    if (!onTakeQueued || queuedMessages.length === 0) return false;
    const taken = onTakeQueued(queuedMessages.map(message => message.id));
    if (taken.length === 0) return false;
    const images: ImageBlock[] = [];
    let text = '';
    for (const message of taken) {
      const content = message.content ?? [{ type: 'text' as const, text: message.text }, ...(message.images ?? [])];
      let line = '';
      for (const block of content) {
        if (block.type === 'image' && onAttachImage) {
          line += reserveImagePlaceholder(memory.images, block, text + line + input);
          images.push(block);
        } else if (block.type === 'text') line += block.text;
      }
      if (line) text += `${text ? '\n' : ''}${line}`;
    }
    editHistory.current.undo = [];
    setEditor({ text: text && input ? `${text}\n${input}` : text + input, cursor: text.length });
    // Attach the images for the reserved positions in the restored draft.
    for (const image of images) onAttachImage?.(image);
    return true;
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
    setLocalFeedback(null);
    const next = stripPlaceholders(applyInputEdit(editor, change, editHistory.current),
      placeholder => !isKnownPlaceholder(placeholder) || imageFor(placeholder) !== undefined);
    for (const placeholder of removedPlaceholders(editor.text, next.text)) {
      const image = imageFor(placeholder);
      if (image) onRemoveAttachment?.(image);
    }
    setEditor(next);
  };
  const insertText = (text: string) => edit({ type: 'insert', text: normalizeNewlines(text) });
  // What Enter does, or with messages queued how to reach them, sits at the
  // right of the draft's first line, and the draft wraps short of it; a long
  // draft's position shows on its last line.
  const enterHint = queuedMessages.length > 0 ? '↑ · ctrl+enter' : disabled ? '' : 'enter ↵';
  const hintWidth = Math.max(stringWidth(enterHint), stringWidth('copied ✓'), 11) + 1;
  const rows = draftRows(input, Math.max(1, (boxWidth || stdout.columns || 80) - 6 - hintWidth), character => {
    const image = imageFor(character);
    return image ? `[${describeImage(image)}]` : pastes.current.get(character)?.label;
  });
  const cursorRow = draftCursorRow(rows, editor.cursor);
  const maxRows = Math.max(2, Math.min(8, Math.floor((stdout.rows || 24) / 3)));
  const rowOffset = Math.max(0, cursorRow - maxRows + 1);
  const shownRows = rows.slice(rowOffset, rowOffset + maxRows);
  const searchMatches = search ? recallHistory.filter(text => text.toLowerCase().includes(search.query.toLowerCase())).reverse() : [];
  const searchResult = searchMatches[search?.index ?? 0];
  const openEditor = async () => {
    if (editingExternally) return;
    setEditingExternally(true);
    try {
      const text = await editInExternalEditor(expandPastes(input), suspendTerminal);
      setLocalFeedback(null);
      for (const placeholder of removedPlaceholders(input, text)) {
        const image = imageFor(placeholder);
        if (image) onRemoveAttachment?.(image);
      }
      editHistory.current.undo.push(editor);
      setRecall(null);
      setEditor({ text, cursor: text.length });
    } catch (error) {
      setLocalFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Could not open the editor.' });
    } finally { setEditingExternally(false); }
  };


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
  const pasteText = (text: string) => {
    if (mode.type !== 'text' || editingExternally || shortcuts !== null) return;
    if (search) { setSearch({ ...search, query: search.query + normalizeNewlines(text), index: 0 }); return; }
    // Some terminals bracket an image-only paste without textual content.
    if (text.length === 0) { pasteClipboard(); return; }
    const normalized = normalizeNewlines(text);
    // Terminals drop files as quoted or shell-escaped paths.
    const file = normalized.trim().replace(/^(['"])(.*)\1$/s, '$2').replace(/\\(.)/g, '$1');
    if (onAttachImage && /\.(png|jpe?g|gif|webp)$/i.test(file)) {
      try {
        onAttachImage(attachImageFile(file.startsWith('file://') ? decodeURIComponent(new URL(file).pathname) : file, directory));
        return;
      } catch (error) {
        setLocalFeedback({ kind: 'warning', text: error instanceof Error ? error.message : 'Could not attach image.' });
      }
    }
    if (normalized.length > 1000 || normalized.split('\n').length > 10) {
      const number = ++memory.pasteNumber;
      const placeholder = String.fromCodePoint(0xF0000 + number);
      pastes.current.set(placeholder, { text: normalized, label: `[Pasted text #${number} · ${normalized.split('\n').length} lines]` });
      insertText(placeholder);
    } else insertText(normalized);
  };
  const pasteTextRef = useRef(pasteText);
  pasteTextRef.current = pasteText;
  const pasteClipboard = () => {
    void Promise.resolve(onPasteClipboard?.()).then(text => {
      if (text) pasteTextRef.current(text);
    });
  };
  usePaste(pasteText);

  useInput((enteredInput, key) => {
    if (isKeyboardProtocolReport(enteredInput)) return;
    if (key.eventType === 'release') return;
    if (isMouseInput(enteredInput) || isFocusInput(enteredInput)) return;
    if (editingExternally) return;
    if (shortcuts === null && !search && onSelectAgent && !key.ctrl && !key.meta && !key.shift
      && (key.leftArrow || key.rightArrow)) {
      onSelectAgent(key.leftArrow ? -1 : 1);
      return;
    }
    if (shortcuts !== null) {
      if (key.escape || enteredInput === '?' || (key.ctrl && enteredInput === 'c')) setShortcuts(null);
      else if (key.downArrow || key.pageDown) setShortcuts(Math.min(KEY_BINDINGS.length - shortcutPageSize, shortcuts + (key.pageDown ? shortcutPageSize : 1)));
      else if (key.upArrow || key.pageUp) setShortcuts(Math.max(0, shortcuts - (key.pageUp ? shortcutPageSize : 1)));
      return;
    }
    if (search) {
      if (key.meta && (key.upArrow || key.downArrow)) return;
      if (key.escape || (key.ctrl && enteredInput === 'c')) { setEditor(search.draft); setSearch(null); }
      else if (key.return) { if (searchResult !== undefined) setEditor({ text: searchResult, cursor: searchResult.length }); setSearch(null); }
      else if (key.ctrl && enteredInput === 'r') setSearch({ ...search, index: Math.min(search.index + 1, Math.max(0, searchMatches.length - 1)) });
      else if (key.ctrl && enteredInput === 's') setSearch({ ...search, index: Math.max(0, search.index - 1) });
      else if (key.backspace) setSearch({ ...search, query: backspaceAtEnd(search.query), index: 0 });
      else if (!key.ctrl && !key.meta && !key.pageUp && !key.pageDown && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && enteredInput) setSearch({ ...search, query: search.query + enteredInput, index: 0 });
      return;
    }
    if (key.ctrl && enteredInput === 'c') {
      if (onInterrupt?.()) {
        lastInterrupt.current = 0;
        return;
      }
      const now = Date.now();
      if (!input && attachments.length === 0 && now - lastInterrupt.current < 1000) {
        onExit?.();
        return;
      }
      if (input || attachments.length > 0) {
        const text = draftMessage().text;
        if (text) clearedPrompts.current.push({ text, after: history.length });
        for (const image of attachments) onRemoveAttachment?.(image);
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
    if (isForeignInput(enteredInput, key)) return;

    const sendImmediately = (key.return && key.ctrl)
      || (editorPrefix.current && key.ctrl && enteredInput === 's');
    if (key.ctrl && enteredInput === 'r') {
      setSearch({ query: '', index: 0, draft: editor });
      return;
    }
    if (key.ctrl && (enteredInput === 'g' || (editorPrefix.current && enteredInput === 'e'))) {
      editorPrefix.current = false;
      void openEditor();
      return;
    }
    editorPrefix.current = key.ctrl && enteredInput === 'x';
    if (editorPrefix.current) return;
    if (enteredInput === '?' && !input && !key.ctrl && !key.meta) { setShortcuts(0); return; }

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

    // Escape closes the nearest thing open, a selection first, and cancels
    // the turn only when nothing is.
    if (key.escape) {
      if (hasSelection()) {
        clearSelection();
        lastEscape.current = 0;
      } else if (commands.matches.length > 0 || mentionActive) {
        setMenusDismissed(true);
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
      && (key.tab || key.return) && !key.ctrl && !key.shift && !key.meta) return;
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
    // Cmd+V / Ctrl+V use the same clipboard handler when forwarded; native
    // terminal paste actions arrive through usePaste above.
    if ((key.ctrl || key.super || key.meta) && enteredInput.toLowerCase() === 'v') {
      pasteClipboard();
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
      // first line ↑ takes back what is queued, and past its first or last
      // line they walk the session's earlier prompts
      if (key.upArrow && cursorRow > 0) {
        setEditor(moveDraftRow(editor, rows, -1));
        return;
      }
      if (key.downArrow && cursorRow < rows.length - 1) {
        setEditor(moveDraftRow(editor, rows, 1));
        return;
      }
      if (key.upArrow && !recall && takeBackQueued()) return;
      // ↓ with no earlier prompt to walk forward to would do nothing; the
      // strip takes it instead.
      if (key.downArrow && !recall && focusWorkers()) return;
      if (key.upArrow) recallPrevious();
      else recallNext();
      return;
    }
    const mappedEdit = inputEditForKey(enteredInput, key);
    if (mappedEdit) {
      if (mappedEdit.type === 'backspace' && input.length === 0 && trailingImages.length > 0) {
        onRemoveAttachment?.(trailingImages[trailingImages.length - 1]);
      } else edit(mappedEdit);
      return;
    }

    if (key.return || sendImmediately) {
      // shift+enter under the kitty protocol, option+enter elsewhere
      if (key.shift || key.meta) {
        insertText('\n');
        return;
      }
      // a trailing backslash asks for a new line where the terminal cannot
      // report either modifier
      if (!sendImmediately && editor.cursor === input.length && input.endsWith('\\')) {
        setRecall(null);
        setEditor({ text: `${input.slice(0, -1)}\n`, cursor: input.length });
        return;
      }
      const selectedCommand = !sendImmediately && commands.matches[commands.selected];
      const draft = draftMessage();
      const trimmed = selectedCommand ? `/${selectedCommand.name}` : draft.text.trim();
      if (!trimmed && draft.images.length === 0) {
        if (sendImmediately) onSendNow?.();
        return;
      }
      // A command picked from the menu goes as its full name, not as the
      // prefix typed so far, which the draft's own content still holds.
      const content = selectedCommand ? undefined : draft.content;
      if (sendImmediately && onSendNow) onSendNow(trimmed, draft.images, content);
      else if (send(trimmed, draft.images, content) === false) return;
      if (directory && trimmed && (!trimmed.startsWith('/') || isNativeCommand(trimmed, nativeList))) {
        try { appendPromptHistory(directory, trimmed); }
        catch (error) { setLocalFeedback({ kind: 'warning', text: `Could not save prompt history: ${errorMessage(error)}` }); }
        setSavedHistory(current => [...current, trimmed].slice(-1000));
      }
      editHistory.current.undo = [];
      setRecall(null);
      setEditor({ text: '', cursor: 0 });
      return;
    }

    if (isTypedText(key)) {
      if (enteredInput.length > 1) pasteText(enteredInput);
      else insertText(enteredInput);
    }
  });

  if (mode.type !== 'text') {
    return (
      <PromptBar
        mode={mode}
        agentArrows={Boolean(onSelectAgent)}
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
      <CommandMenu matches={commands.matches} selected={commands.selected} offset={commands.offset} />
      {mentionActive && <MentionMenu
        items={mentions.items}
        participants={participants}
        selected={mentions.selected}
        offset={mentions.offset}
        loading={fileSuggestions.loading}
        error={fileSuggestions.error}
      />}
      <InputFeedback feedback={localFeedback ?? feedback} participantColors={participantColors} />
      <QueuedRow messages={queuedMessages.map(message => message.text)} participantColors={participantColors} />
      {shortcuts !== null && <Box marginX={1} paddingX={1} borderStyle="round" borderColor={theme.border} flexDirection="column">
        <Text color={theme.accent}>Keyboard shortcuts · ↑/↓ scroll · esc closes</Text>
        {KEY_BINDINGS.slice(shortcuts, shortcuts + shortcutPageSize).map(([keys, action]) =>
          <Text key={keys} wrap="wrap"><Text color={theme.accentSoft}>{keys}</Text>{'  '}{action}</Text>)}
        <Text color={theme.textSubtle}>{shortcuts + 1}–{Math.min(KEY_BINDINGS.length, shortcuts + shortcutPageSize)} of {KEY_BINDINGS.length}</Text>
      </Box>}
      {search && <Box marginX={1} paddingX={1} flexDirection="column">
        <Text color={theme.accent}>History search: {search.query}<Text inverse> </Text></Text>
        <Text wrap="truncate-end" color={searchResult ? theme.text : theme.textSubtle}>{searchResult?.replace(/\n/g, ' ↵ ') ?? 'No matching prompts'}</Text>
        <Text color={theme.textSubtle}>ctrl+r older · ctrl+s newer · enter selects · esc restores</Text>
      </Box>}
      <Box ref={inputBox} borderStyle="round" borderColor={theme.accent} paddingX={1} marginX={1} flexShrink={0} flexDirection="column">
        {/* columns rather than rows, so the draft is one box a selection can be held to */}
        <Box>
          <Box width={2} flexShrink={0} flexDirection="column">
            {shownRows.map((_, index) => <Text key={rowOffset + index} color={theme.accentSoft}>{rowOffset + index === 0 ? '› ' : '  '}</Text>)}
          </Box>
          <Box ref={draftColumn} flexGrow={1} minWidth={0} flexDirection="column">
            {input
              ? shownRows.map((cells, index) => <DraftRow key={rowOffset + index} cells={cells} cursor={editor.cursor} participantColors={participantColors} />)
              : <Text wrap="truncate-end"><Text inverse> </Text><Text color={theme.textSubtle}> message {recipient} or <MentionText colors={participantColors}>@mention</MentionText> an agent…</Text></Text>}
          </Box>
          <Box width={hintWidth} flexShrink={0} flexDirection="column">
            {shownRows.map((_, index) => <Box key={rowOffset + index} height={1} justifyContent="flex-end">
              {index === 0
                ? <Text color={showCopied ? theme.success : theme.textSubtle} wrap="truncate-end">{showCopied ? 'copied ✓' : enterHint}</Text>
                : index === shownRows.length - 1 && rows.length > maxRows
                  ? <Text color={theme.textSubtle}>{rowOffset + 1}–{Math.min(rows.length, rowOffset + maxRows)}/{rows.length}</Text>
                  : null}
            </Box>)}
          </Box>
        </Box>
        {trailingImages.length > 0 && <TrailingImages images={trailingImages} after={false} />}
      </Box>
      <WorkerStrip workers={workers} selection={workerSelection} />
      <StatusRow {...status} />
    </>
  );
}
