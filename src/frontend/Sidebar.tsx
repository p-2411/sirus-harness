import { Session, type SessionStatus } from '../runtime/session';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, type DOMElement } from 'ink';
import { theme } from './theme';
import { useSelectionRegion } from './useTextSelection';
import { useClickable } from './clickable';
import { arrowKeysCaptured } from './focus';

export const SIDEBAR_WIDTH = 26;

const SIDEBAR_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export function formatSidebarTime(time: Date | number): string {
  return SIDEBAR_TIME_FORMAT.format(time);
}

export function SidebarHeader() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNextMinute = () => {
      const delay = 60_000 - (Date.now() % 60_000) + 10;
      timer = setTimeout(() => {
        setNow(Date.now());
        scheduleNextMinute();
      }, delay);
    };
    scheduleNextMinute();
    return () => clearTimeout(timer);
  }, []);

  return (
    <Box justifyContent="space-between">
      <Text color={theme.accent}>sirus</Text>
      <Text color={theme.textSubtle} dimColor>{formatSidebarTime(now)}</Text>
    </Box>
  );
}

export const SESSION_STATUS_APPEARANCE = {
  idle: { symbol: '○', color: theme.textSubtle },
  unread: { symbol: '●', color: theme.textSubtle },
  working: { symbol: '○', color: theme.pending },
  error: { symbol: '●', color: theme.danger },
} as const;

export function sessionStatusAppearance(status: SessionStatus, hasUnread: boolean) {
  return SESSION_STATUS_APPEARANCE[status === 'idle' && hasUnread ? 'unread' : status];
}

export function SessionItem({ session, isSelected, onSelect, onDelete }: {
  session: Session; isSelected: boolean; onSelect: (session: Session) => void; onDelete: (session: Session) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const select = useCallback(() => onSelect(session), [onSelect, session]);
  const hovered = useClickable(ref, select);
  // the delete control only exists while the row is hovered; unmounted, its
  // ref is null and it cannot be hit
  const deleteRef = useRef<DOMElement>(null);
  const remove = useCallback(() => onDelete(session), [onDelete, session]);
  useClickable(deleteRef, remove);
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSnapshot = useCallback(() => session.getVersion(), [session]);
  useSyncExternalStore(subscribe, getSnapshot);
  const assistantVersion = session.getAssistantVersion();
  const observedAssistantVersion = useRef(assistantVersion);
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    const receivedOutput = assistantVersion > observedAssistantVersion.current;
    observedAssistantVersion.current = assistantVersion;
    if (isSelected) {
      setHasUnread(false);
    } else if (receivedOutput) {
      setHasUnread(true);
    }
  }, [assistantVersion, isSelected]);

  const status = sessionStatusAppearance(session.getStatus(), hasUnread && !isSelected);

  return (
    <Box ref={ref} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text color={status.color}>{status.symbol}</Text>
        <Text color={hovered ? theme.highlight : isSelected ? theme.text : theme.textMuted} bold={isSelected} wrap="truncate-end"> {session.getName()}</Text>
      </Box>
      {hovered && (
        <Box ref={deleteRef} marginLeft={1} flexShrink={0}>
          <Text color={theme.textSubtle}>×</Text>
        </Box>
      )}
    </Box>
  );
}
export default function SideBar({ sessions, currSession, selectSession, addSession, deleteSession }: {
  sessions: Session[]; currSession: Session | null; selectSession: (session: Session) => void; addSession: () => void; deleteSession: (session: Session) => void;
}) {
  const ref = useRef<DOMElement>(null);
  useSelectionRegion(ref);
  const newSessionRef = useRef<DOMElement>(null);
  const newSessionHovered = useClickable(newSessionRef, addSession);

  useInput((input, key) => {
    if (key.ctrl && input === 'n') addSession();
    if (arrowKeysCaptured()) return;
    if (sessions.length > 0 && key.downArrow) {
      const currentIndex = currSession ? sessions.indexOf(currSession) : -1;
      selectSession(sessions[(currentIndex + 1) % sessions.length]);
    }
    if (sessions.length > 0 && key.upArrow) {
      const currentIndex = currSession ? sessions.indexOf(currSession) : 0;
      selectSession(sessions[(currentIndex - 1 + sessions.length) % sessions.length]);
    }
  })

  return (
    <Box
      ref={ref}
      width={SIDEBAR_WIDTH}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={theme.border}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      justifyContent="space-between"
    >
      <Box flexDirection="column">
        <SidebarHeader />
        <Box flexDirection="column" marginTop={2}>
          {sessions.map((session) => (
            <SessionItem key={session.getId()} session={session} isSelected={currSession?.getId() === session.getId()} onSelect={selectSession} onDelete={deleteSession} />
          ))}
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box ref={newSessionRef} justifyContent="space-between">
          <Text color={newSessionHovered ? theme.highlight : theme.textMuted}>new session</Text>
          <Text color={theme.textSubtle}>ctrl+n</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.textMuted}>switch session</Text>
          <Text color={theme.textSubtle}>↑↓</Text>
        </Box>
      </Box>
    </Box>
  );
}
