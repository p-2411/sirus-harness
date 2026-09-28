import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout, type DOMElement } from 'ink';
import type { Session } from '../agent_runtime/session';
import { formatRelativeTime, matchesSession, sessionsByRecency } from './Sidebar';
import { useClickable } from './interaction/clickable';
import { isMouseInput } from './interaction/mouse';
import { isFocusInput } from './terminal/window-focus';
import { theme } from './styles/theme';
import { terminalText } from './terminal/text';

function ResumeRow({ session, selected, onSelect }: {
  session: Session; selected: boolean; onSelect: (session: Session) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const hovered = useClickable(ref, () => onSelect(session));
  return <Box ref={ref} flexDirection="column" flexShrink={0}>
    <Text color={selected || hovered ? theme.highlight : theme.text} bold={selected} wrap="truncate-end">
      {selected ? '› ' : '  '}{terminalText(session.getName())}{session.isArchived() ? ' [archived]' : ''} · {formatRelativeTime(session.getLastActivity())}
    </Text>
    <Text color={theme.textSubtle} wrap="truncate-middle">  {terminalText(session.getDirectory())}</Text>
  </Box>;
}

export default function ResumePicker({ sessions, directory, initialQuery = '', onSelect, onClose }: {
  sessions: readonly Session[];
  directory: string;
  initialQuery?: string;
  onSelect: (session: Session) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [allProjects, setAllProjects] = useState(false);
  const [selected, setSelected] = useState(0);
  const { stdout } = useStdout();
  const subscribe = useCallback((listener: () => void) => {
    const stops = sessions.map(session => session.subscribe(listener));
    return () => { for (const stop of stops) stop(); };
  }, [sessions]);
  const getSnapshot = useCallback(() => sessions.map(session => session.getVersion()).join(','), [sessions]);
  useSyncExternalStore(subscribe, getSnapshot);
  const matches = sessionsByRecency(sessions, directory).filter(session =>
    (allProjects || session.getDirectory() === directory) && matchesSession(session, query));
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  const visibleRows = Math.max(1, Math.floor(((stdout.rows ?? 24) - 9) / 2));
  const offset = Math.max(0, index - visibleRows + 1);
  const toggle = () => { setAllProjects(previous => !previous); setSelected(0); };
  const toggleRef = useRef<DOMElement>(null);
  const toggleHovered = useClickable(toggleRef, toggle);

  useInput((input, key) => {
    if (key.eventType === 'release' || isMouseInput(input) || isFocusInput(input)) return;
    if (key.escape) { onClose(); return; }
    if (key.tab) { toggle(); return; }
    if (key.ctrl && input === 'u') { setQuery(''); setSelected(0); return; }
    if (key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow) {
      if (matches.length) setSelected((index + (key.upArrow ? -1 : 1) + matches.length) % matches.length);
    } else if (key.return) {
      if (matches[index]) onSelect(matches[index]);
    } else if (key.backspace || key.delete) { setQuery(previous => [...previous].slice(0, -1).join('')); setSelected(0); }
    else if (!key.leftArrow && !key.rightArrow && !key.pageUp && !key.pageDown && !key.home && !key.end) {
      setQuery(previous => previous + input);
      setSelected(0);
    }
  });

  return <Box flexGrow={1} minWidth={0} flexDirection="column" padding={1}>
    <Text bold color={theme.accent}>Resume session</Text>
    <Box ref={toggleRef} marginTop={1}>
      <Text color={toggleHovered ? theme.highlight : theme.textMuted} wrap="truncate-middle">
        {allProjects ? 'All projects' : `This project: ${terminalText(directory)}`} · tab to toggle
      </Text>
    </Box>
    <Box marginBottom={1}><Text color={theme.text}>Search name, id or directory: {terminalText(query)}▌</Text></Box>
    {matches.length === 0 ? <Text color={theme.textMuted}>No matching sessions. Try another search or show all projects.</Text> :
      matches.slice(offset, offset + visibleRows).map((session, row) => <ResumeRow
        key={session.getId()} session={session} selected={offset + row === index} onSelect={onSelect} />)}
    <Box marginTop={1}><Text color={theme.textMuted}>↑↓ select · enter resume · esc cancel{matches.length ? ` · ${index + 1}/${matches.length}` : ''}</Text></Box>
  </Box>;
}
