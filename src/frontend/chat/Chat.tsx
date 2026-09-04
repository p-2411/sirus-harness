import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Message } from '../../agent_runtime/types';
import { Session } from '../../agent_runtime/session';
import { Box, Text, measureElement, renderToString, useBoxMetrics, useInput, useStdout, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { HORSE } from '../branding/horse';
import { ChatMessage } from './ChatMessage';
import { Spinner } from './Spinner';
import { InputBar, type InputMode } from './InputBar';
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
import { participantColorMap } from '../MentionText';
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

export default function Chat({ currSession, onStartSession, onSirusModelChange }: {
  currSession: Session;
  onStartSession?: (session: Session) => void;
  onSirusModelChange: (model: string) => void;
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
  const isLoading = commandIsLoading || currSession.getStatus() === 'working';
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>({ type: 'text' });
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
    const addedHeight = Math.max(0, contentHeight - previousContentHeight.current);
    previousContentHeight.current = contentHeight;

    setScrollOffset(current => {
      const next = current > 0 ? current + addedHeight : 0;
      return Math.min(next, maxScroll);
    });
  }, [contentHeight, maxScroll]);

  useInput((input, key) => {
    if (key.escape) {
      currSession.cancel();
      commandAbort.current?.abort(new TurnCancelledError());
      return;
    }
    const wheel = parseMouseWheel(input);
    if (wheel && wheel.column > SIDEBAR_WIDTH) {
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

  const send = (text: string) => {
    if (text.startsWith('/')) {
      const command: string = text.split(' ')[0].slice(1);
      const args: string[] = text.split(' ').slice(1).filter(Boolean);
      setFeedback(null);
      let menu: CommandMenuEntry[] | null;
      try {
        menu = commandMenu(command, args);
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
          setSirusModel: onSirusModelChange,
          notify: text => setFeedback({ kind: 'info', text }),
          signal: controller.signal,
        });
      } catch (e) {
        commandAbort.current = null;
        setFeedback({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
        return;
      }
      if (result instanceof Promise) {
        // a long-running command (browser login) holds the input like a turn does
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
            setCommandIsLoading(false);
          });
      } else if (result) {
        commandAbort.current = null;
        setFeedback(result);
      } else {
        commandAbort.current = null;
      }
    } else {
      const msg: Message = { role: 'user', content: [{ type: 'text', text }] };
      setScrollOffset(0);
      setFeedback(null);
      // Chat is remounted per session (key={session id}), so if the user
      // navigates away mid-request the unmounted Chat no longer repaints its
      // history. The session-owned status still updates its sidebar row.
      const turn = currSession.sendMessage(msg);
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
        <Box paddingX={3} marginBottom={1}>
          <Spinner />
          <Text color={theme.textSubtle}>  thinking</Text>
        </Box>
      )}
    </>
  );

  return (
    <Box flexDirection="column" flexGrow={1} height="100%" minHeight={0}>
      <ChatHeader session={currSession} />
      {/* marginLeft -1 lets the rule start in the sidebar border's cell with a
          ├ junction, so the two lines meet instead of leaving a half-cell gap */}
      <Box marginLeft={-1} flexShrink={0}>
        <Text color={theme.border} wrap="truncate">{'├' + '─'.repeat(Math.max(0, (stdout.columns ?? 80) - 26))}</Text>
      </Box>
      {/* The absolutely positioned history moves only inside this clipped
          viewport, so scrolling cannot overwrite the header or divider. */}
      <Box
        ref={viewportRef}
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
        disabled={isLoading}
        feedback={feedback}
        participants={participants}
        mode={effectiveInputMode}
        permissionMode={currSession.getPermissionMode()}
        onCyclePermissionMode={cyclePermissionMode}
        model={currSession.getModel()}
        thinkingLevel={currSession.getThinkingLevel()}
      />
    </Box>
  );
}
