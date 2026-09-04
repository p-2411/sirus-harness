import { Session, type SessionStatus } from '../agent_runtime/session';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, type DOMElement } from 'ink';
import { theme } from './styles/theme';
import { useSelectionRegion } from './interaction/useTextSelection';
import { useClickable } from './interaction/clickable';
import SubscriptionLimits from './SubscriptionLimits';

export const SIDEBAR_WIDTH = 26;
// Left padding, the status dot, right padding, and the divider.
export const COLLAPSED_SIDEBAR_WIDTH = 4;

const SIDEBAR_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const SIDEBAR_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export function formatSidebarTime(time: Date | number): string {
  return SIDEBAR_TIME_FORMAT.format(time);
}

// How long ago a session was last active, in the fewest characters: nothing
// for a session that predates activity tracking.
export function formatRelativeTime(then: number, now: number = Date.now()): string {
  if (then <= 0) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return SIDEBAR_DATE_FORMAT.format(then);
}

// The most recently active session first. Ties keep their creation order.
export function sessionsByRecency(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((left, right) => right.getLastActivity() - left.getLastActivity());
}

// The wall clock, refreshed on the minute, for the header and relative times.
function useMinuteClock(): number {
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
  return now;
}

export function SidebarHeader({ updateAvailable = false }: { updateAvailable?: boolean }) {
  const now = useMinuteClock();

  return (
    <Box justifyContent="space-between">
      <Text color={theme.accent}>sirus</Text>
      {updateAvailable
        ? <Text color={theme.success}>/update</Text>
        : <Text color={theme.textSubtle} dimColor>{formatSidebarTime(now)}</Text>}
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

export function SessionItem({ session, isSelected, onSelect, onDelete, now = Date.now(), collapsed = false }: {
  session: Session;
  isSelected: boolean;
  onSelect: (session: Session) => void;
  onDelete: (session: Session) => void;
  now?: number;
  collapsed?: boolean;
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
  const activity = formatRelativeTime(session.getLastActivity(), now);

  return (
    <Box ref={ref} flexDirection="column" height={1} flexShrink={0}>
      <Box justifyContent="space-between">
        <Box flexShrink={1}>
          <Box width={1} flexShrink={0}>
            <Text color={status.color}>{status.symbol}</Text>
          </Box>
          {!collapsed && <Text color={hovered ? theme.highlight : isSelected ? theme.text : theme.textMuted} bold={isSelected} wrap="truncate-end"> {session.getName()}</Text>}
        </Box>
        {!collapsed && activity && (
          <Box marginLeft={1} flexShrink={0}>
            <Text color={theme.textSubtle} dimColor>{activity}</Text>
          </Box>
        )}
        {!collapsed && hovered && (
          <Box ref={deleteRef} marginLeft={1} flexShrink={0}>
            <Text color={theme.textSubtle}>×</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export default function SideBar({ sessions, currSession, selectSession, addSession, deleteSession, updateAvailable = false, collapsed = false }: {
  sessions: Session[]; currSession: Session | null; selectSession: (session: Session) => void; addSession: () => void; deleteSession: (session: Session) => void; updateAvailable?: boolean; collapsed?: boolean;
}) {
  const ref = useRef<DOMElement>(null);
  useSelectionRegion(ref);
  const newSessionRef = useRef<DOMElement>(null);
  const newSessionHovered = useClickable(newSessionRef, addSession);
  const now = useMinuteClock();
  // Activity in any session can change the order, so the list follows them all.
  const subscribeAll = useCallback((listener: () => void) => {
    const unsubscribe = sessions.map(session => session.subscribe(listener));
    return () => {
      for (const stop of unsubscribe) stop();
    };
  }, [sessions]);
  const versions = useCallback(() => sessions.map(session => session.getVersion()).join(','), [sessions]);
  useSyncExternalStore(subscribeAll, versions);
  const ordered = sessionsByRecency(sessions);

  useInput((input, key) => {
    if (key.ctrl && input === 'n') addSession();
    // Option+arrows switch sessions even while the input bar shows a picker.
    if (!key.meta || ordered.length === 0) return;
    if (key.downArrow) {
      const currentIndex = currSession ? ordered.indexOf(currSession) : -1;
      selectSession(ordered[(currentIndex + 1) % ordered.length]);
    }
    if (key.upArrow) {
      const currentIndex = currSession ? ordered.indexOf(currSession) : 0;
      selectSession(ordered[(currentIndex - 1 + ordered.length) % ordered.length]);
    }
  })

  return (
    <Box
      ref={ref}
      width={collapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH}
      flexShrink={0}
      overflow="hidden"
      flexDirection="column"
      paddingX={1}
      paddingBottom={1}
      borderStyle="single"
      borderColor={theme.border}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      justifyContent="space-between"
    >
      <Box flexDirection="column">
        <Box height={1} flexShrink={0} flexDirection="column">
          {!collapsed && <SidebarHeader updateAvailable={updateAvailable} />}
        </Box>
        {!collapsed && <SubscriptionLimits />}
        <Box flexDirection="column" marginTop={2}>
          {ordered.map((session) => (
            <SessionItem
              key={session.getId()}
              session={session}
              isSelected={currSession?.getId() === session.getId()}
              onSelect={selectSession}
              onDelete={deleteSession}
              now={now}
              collapsed={collapsed}
            />
          ))}
        </Box>
      </Box>
      {!collapsed && <Box flexDirection="column" flexShrink={0}>
        <Box ref={newSessionRef} justifyContent="space-between">
          <Text color={newSessionHovered ? theme.highlight : theme.textMuted}>new session</Text>
          <Text color={theme.textSubtle}>ctrl+n</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.textMuted}>switch session</Text>
          <Text color={theme.textSubtle}>⌥+↑↓</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.textMuted}>help</Text>
          <Text color={theme.textSubtle}>/help</Text>
        </Box>
      </Box>}
    </Box>
  );
}
