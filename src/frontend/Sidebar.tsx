import { Session, type SessionStatus } from '../agent_runtime/session';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, measureElement, useBoxMetrics, useInput, type DOMElement } from 'ink';
import { theme } from './styles/theme';
import { useSelectionRegion } from './interaction/useTextSelection';
import { useClickable } from './interaction/clickable';
import { parseMouseWheel } from './interaction/mouse';
import { rowToLine } from './terminal/screen';
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

// The most recently started conversation first. Replies within a conversation
// update the displayed time without moving its row. Ties keep creation order.
export function sessionsByRecency(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((left, right) => right.getConversationStartedAt() - left.getConversationStartedAt());
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

export function SessionItem({ session, isSelected, onSelect, onDelete, now = Date.now(), collapsed = false, visible = true }: {
  session: Session;
  isSelected: boolean;
  onSelect: (session: Session) => void;
  onDelete: (session: Session) => void;
  now?: number;
  collapsed?: boolean;
  visible?: boolean;
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

  // Keep unread state while offscreen, but remove the row's mouse target.
  if (!visible) return null;

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
        {/*{!collapsed && hovered && (
          <Box ref={deleteRef} marginLeft={1} flexShrink={0}>
            <Text color={theme.textSubtle}>×</Text>
          </Box>
        )}*/}
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
  const listRef = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(listRef);
  const visibleRows = Math.max(0, Math.floor(height));
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxOffset = Math.max(0, ordered.length - visibleRows);
  const offset = Math.min(scrollOffset, maxOffset);
  const selectedId = currSession?.getId();
  const selectedIndex = ordered.findIndex(session => session.getId() === selectedId);

  // Follow selection and resizing, while letting the wheel browse freely.
  useEffect(() => {
    if (visibleRows === 0) return;
    setScrollOffset(previous => {
      const clamped = Math.min(previous, maxOffset);
      if (selectedIndex < 0) return clamped;
      if (selectedIndex < clamped) return selectedIndex;
      if (selectedIndex >= clamped + visibleRows) return selectedIndex - visibleRows + 1;
      return clamped;
    });
  }, [selectedId, selectedIndex, visibleRows, maxOffset]);

  const thumbSize = Math.max(1, Math.floor(visibleRows * visibleRows / Math.max(1, ordered.length)));
  const thumbTop = maxOffset > 0 ? Math.round(offset / maxOffset * (visibleRows - thumbSize)) : 0;

  useInput((input, key) => {
    const wheel = parseMouseWheel(input);
    if (wheel && listRef.current) {
      const { x, y, width, height: listHeight } = measureElement(listRef.current);
      const column = wheel.column - 1;
      const line = rowToLine(wheel.row);
      if (column >= x && column < x + width && line >= y && line < y + listHeight) {
        setScrollOffset(previous => Math.max(0, Math.min(maxOffset,
          Math.min(previous, maxOffset) + (wheel.direction === 'up' ? -3 : 3))));
      }
      return;
    }
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
    >
      <Box flexDirection="column" flexShrink={0}>
        <Box height={1} flexShrink={0} flexDirection="column">
          {!collapsed && <SidebarHeader updateAvailable={updateAvailable} />}
        </Box>
        {!collapsed && <SubscriptionLimits />}
      </Box>
      <Box ref={listRef} flexGrow={1} minHeight={0} overflow="hidden" marginTop={2}>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {ordered.map((session, index) => (
            <SessionItem
              key={session.getId()}
              session={session}
              isSelected={currSession?.getId() === session.getId()}
              onSelect={selectSession}
              onDelete={deleteSession}
              now={now}
              collapsed={collapsed}
              visible={index >= offset && index < offset + visibleRows}
            />
          ))}
        </Box>
        {!collapsed && maxOffset > 0 && visibleRows > 0 && (
          <Box width={1} flexShrink={0} flexDirection="column">
            {Array.from({ length: visibleRows }, (_, index) => (
              <Text key={index} color={theme.textSubtle}>
                {index >= thumbTop && index < thumbTop + thumbSize ? '┃' : '│'}
              </Text>
            ))}
          </Box>
        )}
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
