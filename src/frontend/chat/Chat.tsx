import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DEFAULT_PARTICIPANT, type ImageBlock, type Message, type MessageBlock, type ToolCallBlock } from '../../agent_runtime/types';
import { saveJevKeyRequested } from '../../persistence';
import { Session } from '../../agent_runtime/session';
import { attachClipboardImage, describeImage, removeStoredImage } from '../../images';
import { Box, Text, measureElement, renderToString, useApp, useBoxMetrics, useInput, useStdout, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { terminalText } from '../terminal/text';
import { HORSE } from '../branding/horse';
import { ChatMessage, toolLine } from './ChatMessage';
import { Spinner } from './Spinner';
import { InputBar, type InputMode } from './InputBar';
import { InputFeedback } from './InputRows';
import {
  commandMenu,
  executeCommand,
  isSirusCommand,
  parseCommandLine,
} from '../../commands/registry';
import type { CommandMenuEntry, CommandMenuItem } from '../../commands/types';
import { parseMouseWheel } from '../interaction/mouse';
import { SIDEBAR_WIDTH } from '../Sidebar';
import { useSelectionRegion } from '../interaction/useTextSelection';
import { clearSelection, hasSelection } from '../interaction/selection';
import type { Feedback } from '../../commands/feedback';
import { participantColorMap, type ParticipantColors } from '../MentionText';
import { isAbortError, TurnCancelledError } from '../../abort';
import {
  getPermissionsVersion,
  pendingApprovals,
  resolveApproval,
  subscribePermissions,
} from '../../agent_runtime/permissions/approvals';
import {
  getQuestionsVersion,
  pendingQuestions,
  resolveQuestion,
  subscribeQuestions,
} from '../../agent_runtime/permissions/questions';
import { nextPermissionMode } from '../../agent_runtime/permissions/policy';
import { getSubagentsVersion, subscribeSubagents } from '../../agent_runtime/tools/subagents';

export function ChatHeader({ session }: { session: Session }) {
  const participants = session.getParticipants();
  const participantColors = participantColorMap(participants);
  return (
    <Box paddingX={3} justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={1}>
        <Text wrap="truncate-middle">
          <Text color={theme.textMuted}>{terminalText(session.getName()).toUpperCase()}</Text>
          <Text color={theme.textSubtle} dimColor> {session.getDirectory()}</Text>
        </Text>
      </Box>
      <Box marginLeft={1} flexShrink={0}>
        <Text dimColor>
          {participants.map((participant, index) => (
            <Text key={participant.name} color={participantColors.get(participant.name.toLocaleLowerCase())}>
              {index > 0 ? ' · ' : ''}{participant.name}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  );
}

// The user's earlier prompts, oldest first, without immediate repeats, for
// the input bar's ↑/↓ recall.
export function promptHistory(messages: readonly Message[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content
      .filter(block => block.type === 'text')
      .filter(block => !block.filePath)
      .map(block => block.text)
      .join('\n')
      .trim();
    if (text && prompts[prompts.length - 1] !== text) prompts.push(text);
  }
  return prompts;
}

// Room for a tool title in the status line before it is cut.
const PHASE_TITLE_LENGTH = 40;

// What the agents are up to, read off the end of the timeline: the tool call
// the turn is waiting on, text arriving, or nothing visible yet.
export function turnPhase(messages: readonly Message[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return 'thinking';
  const running = [...last.content]
    .reverse()
    .find((block): block is ToolCallBlock =>
      block.type === 'tool_call' && block.status !== 'completed' && block.status !== 'failed');
  if (running) return `running ${toolLine(running, PHASE_TITLE_LENGTH)}`;
  const tail = last.content[last.content.length - 1];
  if (tail?.type === 'text' && tail.text) return 'writing';
  return 'thinking';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// A turn whose runtime has said nothing for this long says so, since a
// vendor that has stalled looks the same as one that is thinking.
const QUIET_NOTICE_MS = 60_000;

// The line at the foot of the history while a turn runs: what the agents are
// doing, or that they are waiting on the user, and for how long.
function TurnStatus({ messages, awaitingApproval, awaitingAnswer, compacting, startedAt, quietFor }: {
  messages: readonly Message[];
  awaitingApproval: boolean;
  awaitingAnswer: boolean;
  compacting: boolean;
  startedAt: number;
  // Read on every tick: how long the runtimes have been silent.
  quietFor: () => number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const waitingOnUser = awaitingApproval || awaitingAnswer;
  const phase = awaitingApproval ? 'waiting for your approval'
    : awaitingAnswer ? 'waiting for your answer'
    : compacting ? 'compacting context'
      : turnPhase(messages);
  const quiet = waitingOnUser || compacting ? 0 : quietFor();
  return (
    <Box paddingX={3} marginBottom={1}>
      <Spinner />
      <Text color={waitingOnUser ? theme.pending : theme.textSubtle}>  {phase}</Text>
      <Text color={theme.textSubtle} dimColor> · {formatElapsed(now - startedAt)}</Text>
      {quiet >= QUIET_NOTICE_MS && (
        <Text color={theme.pending}> · no output for {formatElapsed(quiet)} · esc to cancel</Text>
      )}
    </Box>
  );
}

// Lines the mouse wheel scrolls per notch.
const WHEEL_STEP = 3;

// A clipped viewport over content that may be taller than it: the refs for
// the viewport and the content box inside it, and how many lines the content
// is scrolled from the edge it rests on. The history rests on its last line
// (`fromEnd`), a command's output on its first. The wheel over the chat,
// pgup / pgdn and home / end scroll it while it is `active`. Copying a
// selection renders the content again at the same width, so text scrolled
// out of the clipped viewport is still part of the copy.
function useScrollViewport({ fromEnd, active, sidebarWidth, content }: {
  fromEnd: boolean;
  active: boolean;
  sidebarWidth: number;
  // What the content box holds, read again each time a selection is copied.
  content: () => ReactNode;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const { height: viewportHeight } = useBoxMetrics(viewportRef);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const [offset, setOffset] = useState(0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  // The copy reads the content through a ref, so the region is registered
  // once rather than again on every render.
  const latestContent = useRef(content);
  latestContent.current = content;
  const text = useCallback(() => {
    const width = contentRef.current ? measureElement(contentRef.current).width : 0;
    if (width <= 0) return [];
    return renderToString(
      <Box flexDirection="column" width={width}>{latestContent.current()}</Box>,
      { columns: width },
    ).split('\n');
  }, []);
  // A drag that starts in the viewport stays in it, and the highlight rides
  // along with the content box as it scrolls.
  useSelectionRegion(viewportRef, { follows: contentRef, text });

  // Resting on its end, the content grows under the view: scrolled back, the
  // view keeps its place on what the user is reading while new lines arrive
  // below it; at the end, it follows them.
  const previousContentHeight = useRef(0);
  useEffect(() => {
    if (!fromEnd || !active || viewportHeight === 0) return;
    const addedHeight = Math.max(0, contentHeight - previousContentHeight.current);
    previousContentHeight.current = contentHeight;
    setOffset(current => Math.min(current > 0 ? current + addedHeight : 0, maxScroll));
  }, [contentHeight, maxScroll, active, viewportHeight]);

  // Moves the content by lines toward its end, or toward its start when
  // negative, whichever edge it rests on.
  const scrollBy = (lines: number) => setOffset(current =>
    Math.max(0, Math.min(maxScroll, current + (fromEnd ? -lines : lines))));
  useInput((input, key) => {
    const wheel = parseMouseWheel(input);
    const page = Math.max(1, viewportHeight - 2);
    if (wheel && wheel.column > sidebarWidth) scrollBy(wheel.direction === 'up' ? -WHEEL_STEP : WHEEL_STEP);
    else if (key.pageUp) scrollBy(-page);
    else if (key.pageDown) scrollBy(page);
    else if (key.home) scrollBy(-Infinity);
    else if (key.end) scrollBy(Infinity);
  }, { isActive: active });

  return {
    viewportRef,
    contentRef,
    // The content may have shrunk since the offset was set.
    offset: Math.min(offset, maxScroll),
    setOffset,
  };
}

// Long command output borrows the history area, leaving the editor available.
// Its scroll position is independent from the conversation underneath it.
function CommandFeedbackPanel({ feedback, participantColors, sidebarWidth }: {
  feedback: Feedback;
  participantColors: ParticipantColors;
  sidebarWidth: number;
}) {
  const output = <InputFeedback feedback={feedback} participantColors={participantColors} />;
  const { viewportRef, contentRef, offset } = useScrollViewport({
    fromEnd: false,
    active: true,
    sidebarWidth,
    content: () => output,
  });

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <Box ref={viewportRef} position="relative" flexGrow={1} minHeight={0} overflow="hidden">
        <Box ref={contentRef} position="absolute" top={-offset} width="100%" flexDirection="column" flexShrink={0}>
          {output}
        </Box>
      </Box>
      <Box paddingX={3} height={1} flexShrink={0}>
        <Text color={theme.textSubtle}>pgup / pgdn · home / end · esc closes</Text>
      </Box>
    </Box>
  );
}

export default function Chat({ currSession, onStartSession, sidebarWidth = SIDEBAR_WIDTH, askJevKey, onJevKeyAsked }: {
  currSession: Session;
  sidebarWidth?: number;
  onStartSession?: (session: Session) => void;
  // The one-time request for a TypeSafe AI key: the app decides it is due,
  // this bar asks, and the answer (a key or a skip) settles it for good.
  askJevKey?: boolean;
  onJevKeyAsked?: () => void;
}) {
  // Subscribe to the session: any mutation (append, setModel) bumps its
  // version and re-renders, so model and messages are read fresh below.
  useSyncExternalStore(
    (cb) => currSession.subscribe(cb),
    () => currSession.getVersion(),
  );
  useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
  // A hidden entry belongs to the runtimes alone: a worker's report is in its
  // owner's record, but the user reads it under the SpawnAgent row that
  // started the worker, not as a message of its own.
  const messages = currSession.getMessages().filter(message => !message.hidden);
  const participants = currSession.getParticipants();
  const participantColors = participantColorMap(participants);

  const [commandIsLoading, setCommandIsLoading] = useState(false);
  const [imageIsLoading, setImageIsLoading] = useState(false);
  const isLoading = commandIsLoading || imageIsLoading || currSession.getStatus() === 'working';
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const panelFeedback = feedback?.panel ? feedback : null;
  const [inputMode, setInputMode] = useState<InputMode>({ type: 'text' });
  // Images attached to the message being composed, until it is sent.
  const [attachments, setAttachments] = useState<ImageBlock[]>([]);
  const attachmentsRef = useRef<ImageBlock[]>([]);
  const mounted = useRef(true);
  const replaceAttachments = (next: ImageBlock[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  const attachImage = (image: ImageBlock) => {
    if (!mounted.current) {
      removeStoredImage(image);
      return;
    }
    replaceAttachments([...attachmentsRef.current, image]);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const image of attachmentsRef.current) removeStoredImage(image);
      attachmentsRef.current = [];
    };
  }, []);
  const pasteImage = () => {
    if (imageIsLoading) return;
    setImageIsLoading(true);
    setFeedback({ kind: 'info', text: 'Reading the clipboard…' });
    attachClipboardImage()
      .then(image => {
        if (!mounted.current) {
          removeStoredImage(image);
          return;
        }
        attachImage(image);
        setFeedback({ kind: 'success', text: `Attached ${describeImage(image)}.` });
      })
      .catch((caught: unknown) => {
        if (mounted.current) setFeedback({ kind: 'error', text: caught instanceof Error ? caught.message : 'Could not read the clipboard.' });
      })
      .finally(() => { if (mounted.current) setImageIsLoading(false); });
  };
  const removeAttachment = (image: ImageBlock) => {
    removeStoredImage(image);
    replaceAttachments(attachmentsRef.current.filter(item => item.path !== image.path));
  };
  const [commandStartedAt, setCommandStartedAt] = useState<number | null>(null);
  // Whether the input bar has something open that escape closes.
  const inputBarDismissible = useRef(false);
  const queued = currSession.getQueuedMessageCount();
  const history = promptHistory(messages);
  // A tool call of this session (or of a subagent it spawned) waiting on the
  // user takes over the input bar until it is answered or the turn is cancelled.
  useSyncExternalStore(subscribePermissions, getPermissionsVersion);
  // A question an agent asks waits behind the approvals.
  useSyncExternalStore(subscribeQuestions, getQuestionsVersion);
  const approvals = pendingApprovals(currSession.getId());
  const questions = pendingQuestions(currSession.getId());
  const effectiveInputMode: InputMode = inputMode.type !== 'text' ? inputMode
    : approvals.length > 0
      ? {
        type: 'approval',
        request: approvals[0],
        waiting: approvals.length - 1 + questions.length,
        onDecide: decision => { resolveApproval(approvals[0].id, decision); },
      }
      : questions.length > 0
        ? {
          type: 'question',
          request: questions[0],
          waiting: questions.length - 1,
          onAnswer: answer => { resolveQuestion(questions[0].id, answer); },
        }
        : inputMode;
  // shift+tab is /permissions <next mode>, sent down the same path as typing it
  const cyclePermissionMode = () => {
    send(`/permissions ${nextPermissionMode(currSession.getPermissionMode())}`);
  };
  const commandAbort = useRef<AbortController | null>(null);
  const { stdout } = useStdout();
  const { exit } = useApp();

  // The history content, built at the end of each render: drawn into the
  // scrolling box below, and again whenever a selection is copied.
  const historyContent = useRef<ReactNode>(null);
  const scroll = useScrollViewport({
    fromEnd: true,
    // A command's panel covers the history and takes the scroll keys.
    active: !panelFeedback,
    sidebarWidth,
    content: () => historyContent.current,
  });

  // What escape means is decided here. It closes the nearest thing open, and
  // cancels the turn only when nothing is: pressed to close a menu, it must
  // not also stop the agents.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (hasSelection()) {
      clearSelection();
      return;
    }
    if (panelFeedback) {
      setFeedback(null);
      return;
    }
    // A menu or entry of the chat's own closes through its onCancel, and
    // whatever the input bar has open it closes itself.
    if (inputMode.type !== 'text' || inputBarDismissible.current) return;
    setFeedback(null);
    // The turn only: the session's workers keep going in the background and
    // are stopped from /agents. Queued messages stay, and the next one goes
    // out once the turn has stopped.
    currSession.cancel();
    commandAbort.current?.abort(new TurnCancelledError());
  });

  // A command with choices (like /login) turns the input bar into a
  // picker; the chosen item runs as if the user had typed it. An item that
  // still needs a value asks for it in the bar and hands it over as one final
  // argument, so a key or a message containing spaces survives whole and a
  // secret is never echoed into the input.
  const openMenu = (items: readonly CommandMenuEntry[]) => {
    const close = () => setInputMode({ type: 'text' });
    const choose = (item: CommandMenuItem) => {
      const asked = item.secret ?? item.input;
      if (!asked) {
        close();
        send(item.command);
        return;
      }
      const { name, args } = parseCommandLine(item.command);
      setInputMode({
        type: 'entry',
        prompt: asked.prompt,
        masked: item.secret !== undefined,
        onSubmit: value => {
          close();
          runCommand(name, [...args, value]);
        },
        onCancel: close,
      });
    };
    setInputMode({ type: 'menu', items, onSelect: choose, onCancel: close });
  };

  // The one path a command takes, however it was started: its menu opens if
  // it has one for these arguments, and otherwise it runs. commandAbort is
  // only ever written once we know a command is async (below) — a sync
  // command (e.g. shift+tab's /permissions, fired while /login is still
  // awaiting the browser) must never touch, let alone clear, another
  // command's still-live abort handle. A typed command also hands over its
  // arguments as they were typed.
  const runCommand = (command: string, args: readonly string[], argumentText?: string) => {
    setFeedback(null);
    let menu: CommandMenuEntry[] | null;
    try {
      // Args may carry a secret (see openMenu) — never let it reach a menu label.
      menu = commandMenu(command, args, currSession);
    } catch (e) {
      setFeedback({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
      return;
    }
    if (menu) {
      openMenu(menu);
      return;
    }
    const controller = new AbortController();
    let result;
    try {
      result = executeCommand(command, args, {
        session: currSession,
        notify: text => setFeedback({ kind: 'info', text }),
        attachImage,
        exit: () => exit(),
        signal: controller.signal,
        argumentText,
      });
    } catch (e) {
      setFeedback({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
      return;
    }
    if (result instanceof Promise) {
      // a long-running command (browser login) holds the input like a turn
      // does; only now is the controller stored, so escape can cancel it.
      commandAbort.current = controller;
      setCommandStartedAt(Date.now());
      setCommandIsLoading(true);
      result
        .then(outcome => { if (outcome) setFeedback(outcome); })
        .catch((caught: unknown) => {
          setFeedback(isAbortError(caught)
            ? null
            : { kind: 'error', text: caught instanceof Error ? caught.message : 'Something went wrong.' });
        })
        .finally(() => {
          // Guard against a newer async command having taken over the ref
          // since this one started.
          if (commandAbort.current === controller) commandAbort.current = null;
          setCommandStartedAt(null);
          setCommandIsLoading(false);
        });
    } else if (result) {
      setFeedback(result);
    }
  };

  // A command leaves any attachments waiting for the next real message.
  // Commands are exactly what the background queue leaves for a mounted Chat.
  const send = (text: string, images: readonly ImageBlock[] = [], content?: MessageBlock[]) => {
    // A `/name` for one of the agent's own commands is a prompt: the agent's
    // harness runs it.
    if (isSirusCommand(text, currSession.getNativeCommands())) {
      const { name, args, rest } = parseCommandLine(text);
      runCommand(name, args, rest);
    } else {
      // Images sit where the draft placed them. The session stamps the
      // entry's seq when it enters the transcript.
      const msg = {
        role: 'user' as const,
        content: content ?? [...images, ...(text ? [{ type: 'text' as const, text }] : [])],
      };
      scroll.setOffset(0);
      setFeedback(null);
      // Chat is remounted per session (key={session id}), so if the user
      // navigates away mid-request the unmounted Chat no longer repaints its
      // history. The session-owned status still updates its sidebar row.
      const previousLength = currSession.getMessages().length;
      const previousDraft = currSession.getInputContent();
      const turn = currSession.sendMessage(msg);
      // Validation can reject a turn before its user message is appended.
      // Keep those images available so the user can correct the prompt.
      if (currSession.getMessages().length > previousLength && images.length > 0) {
        const sentPaths = new Set(images.map(image => image.path));
        replaceAttachments(attachmentsRef.current.filter(image => !sentPaths.has(image.path)));
      }
      // A startup draft becomes a real sidebar session only after the turn is
      // valid and sendMessage has appended its user message.
      if (!currSession.isEmpty()) onStartSession?.(currSession);
      turn
        .catch((caught: unknown) => {
          if (currSession.getMessages().length === previousLength && !currSession.getInputContent()) {
            currSession.setInputContent(previousDraft);
          }
          setFeedback(isAbortError(caught)
            ? null
            : { kind: 'error', text: caught instanceof Error ? caught.message : 'Something went wrong.' });
        });
    }
  }

  // The first launch without a Jev key asks for one here, once. Escape
  // declines: Jev stays off and /jev can add a key later.
  useEffect(() => {
    if (!askJevKey) return;
    onJevKeyAsked?.();
    const close = () => setInputMode({ type: 'text' });
    setInputMode({
      type: 'entry',
      prompt: 'TypeSafe AI API key, so Jev can pick models per task (esc to skip)',
      masked: true,
      onSubmit: value => {
        close();
        runCommand('jev', ['key', value]);
      },
      onCancel: () => {
        close();
        saveJevKeyRequested();
        setFeedback({ kind: 'info', text: 'Jev is off: models stay on their defaults. /jev adds a key later.' });
      },
    });
  }, [askJevKey]);

  // Queued messages live on the session so they survive switching away and
  // back. Send one at a time as soon as that session is free again.
  useEffect(() => {
    if (isLoading || currSession.getStatus() === 'working'
      || queued === 0 || effectiveInputMode.type !== 'text') return;
    const next = currSession.shiftQueuedMessage();
    if (next !== undefined) send(next);
  }, [currSession, isLoading, queued, effectiveInputMode.type]);

  historyContent.current = (
    <>
      {messages.length === 0 && !isLoading && (
        <Box flexDirection="column" alignItems="center">
          {
            // art lines stay left-aligned inside their own box so the
            // center alignment of the parent can't shear the drawing
            <Box flexDirection="column" marginBottom={1} position="static">
              {HORSE.map((line, i) => (
                <Text key={i} color={theme.highlight}>{line}</Text>
              ))}
            </Box>
          }
          <Text color={theme.textMuted}>What shall we build?</Text>
        </Box>
      )}
      {messages.map(message => {
        const participant = message.role === 'assistant'
          ? participants.find(candidate =>
            candidate.name.toLocaleLowerCase() === (message.participant ?? DEFAULT_PARTICIPANT).toLocaleLowerCase())
          : undefined;
        return (
          // Known by its seq, which the session hands out once per entry: a
          // reply that joins the history above a peer's in the same round
          // must not take over the peer's component.
          <ChatMessage
            key={message.seq}
            sessionId={currSession.getId()}
            message={message}
            model={message.model ?? participant?.model}
            participantColors={participantColors}
          />
        );
      })}
      {isLoading && (
        <TurnStatus
          messages={messages}
          awaitingApproval={approvals.length > 0}
          awaitingAnswer={questions.length > 0}
          compacting={currSession.isCompacting()}
          startedAt={currSession.getActiveTurnStartedAt() ?? commandStartedAt ?? Date.now()}
          quietFor={() => currSession.getTurnQuietFor()}
        />
      )}
    </>
  );

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} height="100%" minHeight={0}>
      <ChatHeader session={currSession} />
      {/* marginLeft -1 lets the rule start in the sidebar border's cell with a
          ├ junction, so the two lines meet instead of leaving a half-cell gap */}
      <Box marginLeft={-1} flexShrink={0}>
        <Text color={theme.border} wrap="truncate">{'├' + '─'.repeat(Math.max(0, (stdout.columns ?? 80) - sidebarWidth))}</Text>
      </Box>
      {/* The absolutely positioned history moves only inside this clipped
          viewport, so scrolling cannot overwrite the header or divider. */}
      {panelFeedback && (
        <CommandFeedbackPanel
          key={panelFeedback.text}
          feedback={panelFeedback}
          participantColors={participantColors}
          sidebarWidth={sidebarWidth}
        />
      )}
      <Box
        ref={scroll.viewportRef}
        display={panelFeedback ? 'none' : 'flex'}
        position="relative"
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        justifyContent={messages.length === 0 && !isLoading ? "center" : "flex-end"}
      >
        <Box
          ref={scroll.contentRef}
          position={messages.length === 0 && !isLoading ? "static" : "absolute"}
          bottom={messages.length === 0 && !isLoading ? undefined : -scroll.offset}
          width="100%"
          flexDirection="column"
          flexShrink={0}
        >
          {historyContent.current}
        </Box>
      </Box>
      <InputBar
        send={send}
        inputContent={currSession.getInputContent()}
        setInputContent={inputContent => currSession.setInputContent(inputContent)}
        disabled={isLoading}
        feedback={panelFeedback ? null : feedback}
        participants={participants}
        workers={currSession.getWorkers()}
        directory={currSession.getDirectory()}
        mode={effectiveInputMode}
        status={{
          permissionMode: currSession.getPermissionMode(),
          modeNotice: currSession.getModeNotice(),
          model: currSession.isModelPending() ? undefined : currSession.getModel(),
          thinkingLevel: currSession.isModelPending() ? undefined : currSession.getThinkingLevel(),
          contextUsage: currSession.getContextUsage(),
        }}
        onCyclePermissionMode={cyclePermissionMode}
        onDismissibleChange={dismissible => { inputBarDismissible.current = dismissible; }}
        attachments={attachments}
        onPasteImage={pasteImage}
        onRemoveAttachment={removeAttachment}
        history={history}
        queuedMessages={currSession.getQueuedMessages()}
        onQueue={text => currSession.queueMessage(text)}
        onUpdateQueued={(id, text) => currSession.updateQueuedMessage(id, text)}
        nativeCommands={() => currSession.getNativeCommands()}
      />
    </Box>
  );
}
