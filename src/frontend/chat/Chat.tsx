import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ImageBlock, Message, ToolCallBlock } from '../../agent_runtime/types';
import { Session } from '../../agent_runtime/session';
import { attachClipboardImage, describeImage, removeStoredImage } from '../../images';
import { Box, Text, measureElement, renderToString, useBoxMetrics, useInput, useStdout, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { HORSE } from '../branding/horse';
import { ChatMessage } from './ChatMessage';
import { Spinner } from './Spinner';
import { InputBar, InputFeedback, type InputMode } from './InputBar';
import {
  commandMenu,
  executeCommand,
  type CommandMenuEntry,
  type CommandMenuItem,
} from '../../commands/registry';
import { parseMouseWheel } from '../interaction/mouse';
import { SIDEBAR_WIDTH } from '../Sidebar';
import { useSelectionRegion } from '../interaction/useTextSelection';
import type { Feedback } from '../../commands/feedback';
import { participantColorMap, type ParticipantColors } from '../MentionText';
import { isAbortError, TurnCancelledError } from '../../abort';
import {
  getPermissionsVersion,
  nextPermissionMode,
  pendingApprovals,
  resolveApproval,
  subscribePermissions,
} from '../../agent_runtime/permissions/permissions';
import { permissionsCommand } from '../../commands/session/behavior';
// import { AppState, useModel } from '../../state';

export function ChatHeader({ session }: { session: Session }) {
  const participants = session.getParticipants();
  const participantColors = participantColorMap(participants);
  return (
    <Box paddingX={3} marginTop={1} justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={1}>
        <Text wrap="truncate-middle">
          <Text color={theme.textMuted}>{session.getName().toUpperCase()}</Text>
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
      .map(block => block.text)
      .join('\n')
      .trim();
    if (text && prompts[prompts.length - 1] !== text) prompts.push(text);
  }
  return prompts;
}

// What the agents are up to, read off the end of the transcript: a tool the
// turn is waiting on, text arriving, or nothing visible yet.
export function turnPhase(messages: readonly Message[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return 'thinking';
  const answered = new Set(
    last.content.flatMap(block => block.type === 'tool_result' ? [block.callId] : []),
  );
  const running = [...last.content]
    .reverse()
    .find((block): block is ToolCallBlock => block.type === 'tool_call' && !answered.has(block.id));
  if (running) return `running ${running.name}`;
  const tail = last.content[last.content.length - 1];
  if (tail?.type === 'text' && tail.text) return 'writing';
  return 'thinking';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// The line at the foot of the history while a turn runs: what the agents are
// doing, or that they are waiting on the user, and for how long.
function TurnStatus({ messages, awaitingApproval, startedAt }: {
  messages: readonly Message[];
  awaitingApproval: boolean;
  startedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const phase = awaitingApproval ? 'waiting for your approval' : turnPhase(messages);
  return (
    <Box paddingX={3} marginBottom={1}>
      <Spinner />
      <Text color={awaitingApproval ? theme.pending : theme.textSubtle}>  {phase}</Text>
      <Text color={theme.textSubtle} dimColor> · {formatElapsed(now - startedAt)}</Text>
    </Box>
  );
}

// Long command output borrows the history area, leaving the editor available.
// Its scroll position is independent from the conversation underneath it.
function CommandFeedbackPanel({ feedback, participantColors, sidebarWidth }: {
  feedback: Feedback;
  participantColors: ParticipantColors;
  sidebarWidth: number;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const { height: viewportHeight } = useBoxMetrics(viewportRef);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const [offset, setOffset] = useState(0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const pageSize = Math.max(1, viewportHeight - 2);
  const visibleOffset = Math.min(offset, maxScroll);
  const text = useCallback(() => {
    const width = contentRef.current ? measureElement(contentRef.current).width : 0;
    if (width <= 0) return [];
    return renderToString(
      <InputFeedback feedback={feedback} participantColors={participantColors} />,
      { columns: width },
    ).split('\n');
  }, [feedback, participantColors]);
  useSelectionRegion(viewportRef, { follows: contentRef, text });

  useInput((input, key) => {
    const wheel = parseMouseWheel(input);
    if (wheel && wheel.column > sidebarWidth) {
      setOffset(Math.max(0, Math.min(maxScroll, visibleOffset + (wheel.direction === 'up' ? -3 : 3))));
    } else if (key.pageUp) {
      setOffset(Math.max(0, visibleOffset - pageSize));
    } else if (key.pageDown) {
      setOffset(Math.min(maxScroll, visibleOffset + pageSize));
    } else if (key.home) {
      setOffset(0);
    } else if (key.end) {
      setOffset(maxScroll);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <Box ref={viewportRef} position="relative" flexGrow={1} minHeight={0} overflow="hidden">
        <Box ref={contentRef} position="absolute" top={-visibleOffset} width="100%" flexDirection="column" flexShrink={0}>
          <InputFeedback feedback={feedback} participantColors={participantColors} />
        </Box>
      </Box>
      <Box paddingX={3} height={1} flexShrink={0}>
        <Text color={theme.textSubtle}>pgup / pgdn · home / end · esc closes</Text>
      </Box>
    </Box>
  );
}

export default function Chat({ currSession, onStartSession, sidebarWidth = SIDEBAR_WIDTH }: {
  currSession: Session;
  sidebarWidth?: number;
  onStartSession?: (session: Session) => void;
}) {
  // Subscribe to the session: any mutation (append, setModel) bumps its
  // version and re-renders, so model and messages are read fresh below.
  useSyncExternalStore(
    (cb) => currSession.subscribe(cb),
    () => currSession.getVersion(),
  );
  const messages = currSession.getMessages();
  const participants = currSession.getParticipants();
  const participantColors = participantColorMap(participants);

  const [commandIsLoading, setCommandIsLoading] = useState(false);
  const [imageIsLoading, setImageIsLoading] = useState(false);
  const isLoading = commandIsLoading || imageIsLoading || currSession.getStatus() === 'working';
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const panelFeedback = feedback?.text.includes('\n') ? feedback : null;
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
        setFeedback({ kind: 'success', text: `Attached ${describeImage(image)}. It goes with your next message.` });
      })
      .catch((caught: unknown) => {
        if (mounted.current) setFeedback({ kind: 'error', text: caught instanceof Error ? caught.message : 'Could not read the clipboard.' });
      })
      .finally(() => { if (mounted.current) setImageIsLoading(false); });
  };
  const removeAttachment = () => {
    const image = attachmentsRef.current.at(-1);
    if (image) removeStoredImage(image);
    replaceAttachments(attachmentsRef.current.slice(0, -1));
  };
  const [commandStartedAt, setCommandStartedAt] = useState<number | null>(null);
  const queued = currSession.getQueuedMessageCount();
  const history = promptHistory(messages);
  // A tool call of this session (or of a subagent it spawned) waiting on the
  // user takes over the input bar until it is answered or the turn is cancelled.
  useSyncExternalStore(subscribePermissions, getPermissionsVersion);
  const approvals = pendingApprovals(currSession.getId());
  const effectiveInputMode: InputMode = approvals.length > 0 && inputMode.type === 'text'
    ? {
      type: 'approval',
      request: approvals[0],
      waiting: approvals.length - 1,
      onDecide: decision => { resolveApproval(approvals[0].id, decision); },
    }
    : inputMode;
  // shift+tab is /permissions <next mode>, feedback included
  const cyclePermissionMode = () => {
    setFeedback(permissionsCommand(nextPermissionMode(currSession.getPermissionMode()), currSession));
  };
  const [scrollOffset, setScrollOffset] = useState(0);
  const commandAbort = useRef<AbortController | null>(null);
  const { stdout } = useStdout();

  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const { height: viewportHeight } = useBoxMetrics(viewportRef);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  // The history content, rendered once into the scrolling box below and again
  // on demand at the same width when a selection is copied, so text that has
  // scrolled out of the clipped viewport is still part of the copy.
  const historyContent = useRef<ReactNode>(null);
  const historyText = useCallback(() => {
    const width = contentRef.current ? measureElement(contentRef.current).width : 0;
    if (width <= 0) return [];
    return renderToString(
      <Box flexDirection="column" width={width}>{historyContent.current}</Box>,
      { columns: width },
    ).split('\n');
  }, []);
  // a drag that starts in the history stays in the history, and the highlight
  // rides along with the content box as it scrolls
  useSelectionRegion(viewportRef, { follows: contentRef, text: historyText });
  const previousContentHeight = useRef(0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const pageSize = Math.max(1, viewportHeight - 2);

  useEffect(() => {
    if (panelFeedback || viewportHeight === 0) return;
    const addedHeight = Math.max(0, contentHeight - previousContentHeight.current);
    previousContentHeight.current = contentHeight;

    setScrollOffset(current => {
      const next = current > 0 ? current + addedHeight : 0;
      return Math.min(next, maxScroll);
    });
  }, [contentHeight, maxScroll, panelFeedback, viewportHeight]);

  useInput((input, key) => {
    if (key.escape) {
      setInputMode({ type: 'text' });
      setFeedback(null);
      // an interrupted turn should not be followed by whatever was waiting
      currSession.clearQueuedMessages();
      currSession.cancel();
      commandAbort.current?.abort(new TurnCancelledError());
      return;
    }
    if (panelFeedback) return;
    const wheel = parseMouseWheel(input);
    if (wheel && wheel.column > sidebarWidth) {
      const amount = 3;
      setScrollOffset(current => wheel.direction === 'up'
        ? Math.min(maxScroll, current + amount)
        : Math.max(0, current - amount));
    } else if (key.pageUp) {
      setScrollOffset(current => Math.min(maxScroll, current + pageSize));
    } else if (key.pageDown) {
      setScrollOffset(current => Math.max(0, current - pageSize));
    } else if (key.home) {
      setScrollOffset(maxScroll);
    } else if (key.end) {
      setScrollOffset(0);
    }
  });

  // A command with choices (like /login) turns the input bar into a
  // picker; the chosen item is sent as if the user had typed it, after any
  // secret it asks for.
  const openMenu = (items: readonly CommandMenuEntry[]) => {
    const close = () => setInputMode({ type: 'text' });
    const choose = (item: CommandMenuItem) => {
      if (!item.secret) {
        close();
        send(item.command);
        return;
      }
      setInputMode({
        type: 'secret',
        prompt: item.secret.prompt,
        onSubmit: value => {
          close();
          send(`${item.command} ${value}`);
        },
        onCancel: close,
      });
    };
    setInputMode({ type: 'menu', items, onSelect: choose, onCancel: close });
  };

  // A command leaves any attachments waiting for the next real message.
  const send = (text: string, images: readonly ImageBlock[] = []) => {
    if (text.startsWith('/')) {
      const command: string = text.split(' ')[0].slice(1);
      const args: string[] = text.split(' ').slice(1).filter(Boolean);
      setFeedback(null);
      let menu: CommandMenuEntry[] | null;
      try {
        menu = commandMenu(command, args, currSession);
      } catch (e) {
        commandAbort.current = null;
        setFeedback({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
        return;
      }
      if (menu) {
        openMenu(menu);
        return;
      }
      const controller = new AbortController();
      commandAbort.current = controller;
      let result;
      try {
        result = executeCommand(command, args, {
          session: currSession,
          notify: text => setFeedback({ kind: 'info', text }),
          attachImage,
          signal: controller.signal,
        });
      } catch (e) {
        commandAbort.current = null;
        setFeedback({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
        return;
      }
      if (result instanceof Promise) {
        // a long-running command (browser login) holds the input like a turn does
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
            if (commandAbort.current === controller) commandAbort.current = null;
            setCommandStartedAt(null);
            setCommandIsLoading(false);
          });
      } else if (result) {
        commandAbort.current = null;
        setFeedback(result);
      } else {
        commandAbort.current = null;
      }
    } else {
      // Images go first so the text can refer to them.
      const msg: Message = {
        role: 'user',
        content: [...images, ...(text ? [{ type: 'text' as const, text }] : [])],
      };
      setScrollOffset(0);
      setFeedback(null);
      // Chat is remounted per session (key={session id}), so if the user
      // navigates away mid-request the unmounted Chat no longer repaints its
      // history. The session-owned status still updates its sidebar row.
      const previousLength = currSession.getMessages().length;
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
          setFeedback(isAbortError(caught)
            ? null
            : { kind: 'error', text: caught instanceof Error ? caught.message : 'Something went wrong.' });
        });
    }
  }

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
      {messages.map((message, i) => {
        const participant = message.role === 'assistant'
          ? participants.find(candidate =>
            candidate.name.toLocaleLowerCase() === (message.participant ?? 'sirus').toLocaleLowerCase())
          : undefined;
        return (
          <ChatMessage
            key={i}
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
          startedAt={currSession.getActiveTurnStartedAt() ?? commandStartedAt ?? Date.now()}
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
        ref={viewportRef}
        display={panelFeedback ? 'none' : 'flex'}
        position="relative"
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        justifyContent={messages.length === 0 && !isLoading ? "center" : "flex-end"}
      >
        <Box
          ref={contentRef}
          position={messages.length === 0 && !isLoading ? "static" : "absolute"}
          bottom={messages.length === 0 && !isLoading ? undefined : -scrollOffset}
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
        mode={effectiveInputMode}
        permissionMode={currSession.getPermissionMode()}
        onCyclePermissionMode={cyclePermissionMode}
        attachments={attachments}
        onPasteImage={pasteImage}
        onRemoveAttachment={removeAttachment}
        model={currSession.getModel()}
        thinkingLevel={currSession.getThinkingLevel()}
        history={history}
        queued={queued}
        onQueue={text => currSession.queueMessage(text)}
        contextUsage={currSession.getContextUsage()}
      />
    </Box>
  );
}
