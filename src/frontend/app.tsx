import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import Chat from "./chat/Chat";
import Sidebar, { COLLAPSED_SIDEBAR_WIDTH, SIDEBAR_WIDTH } from "./Sidebar";
import { DEFAULT_MODEL, Session } from "../agent_runtime/session";
import {
  loadSessionSnapshots,
  loadSessionSnapshot,
  loadSessionRevision,
  loadSirusModelPreference,
  saveSessionSnapshot,
  saveSessionMetadata,
  deleteSessionSnapshot,
  type PersistedSessions,
} from "../persistence";
import { useTextSelection } from "./interaction/useTextSelection";
import { useTerminalFocus } from "./interaction/useTerminalFocus";
import { useNotifications } from "./useNotifications";
import { isKnownModel } from '../agent_runtime/providers/catalog';
import ResumePicker from './ResumePicker';
import type { CliOptions } from '../cli';
import type { SessionSnapshot } from '../agent_runtime/session';
import { theme } from './styles/theme';
import { checkSirusUpdate } from '../updater';
import { onProviderChange } from '../agent_runtime/providers';

export function nextSessionName(sessions: readonly Session[]): string {
  let sessionCount = sessions.length + 1;
  while (sessions.some(session => session.getName() === `Session ${sessionCount}`)) sessionCount++;
  return `Session ${sessionCount}`;
}

export function createWorkspace(
  saved: PersistedSessions,
  launchDirectory: string,
  preferredSirusModel: string | null = loadSirusModelPreference(),
) {
  return {
    sessions: [...saved.sessions],
    selectedSession: null as Session | null,
    draftSession: createDraft(saved.sessions, launchDirectory, preferredSirusModel),
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

function createDraft(
  sessions: readonly Session[],
  directory: string,
  preference: string | null = loadSirusModelPreference(),
): Session {
  const model = preference && isKnownModel(preference) ? preference : DEFAULT_MODEL;
  return new Session({ name: nextSessionName(sessions), directory, model, autoNamePending: true });
}

export function startSession(
  workspace: Workspace,
  session: Session,
  launchDirectory: string,
): Workspace {
  if (workspace.sessions.includes(session)) {
    return { ...workspace, selectedSession: session };
  }
  const sessions = [...workspace.sessions, session];
  return {
    sessions,
    selectedSession: session,
    draftSession: createDraft(sessions, launchDirectory),
  };
}

export default function App({ launchDirectory = process.cwd(), startup }: { launchDirectory?: string; startup?: CliOptions }) {
  const diskSnapshots = useRef(new Map<string, string>());
  const savedVersions = useRef(new WeakMap<Session, number>());
  const savedSnapshots = useRef(new WeakMap<Session, string>());
  const removedIds = useRef(new Set<string>());
  const retiredSessions = useRef(new WeakSet<Session>());
  const replacements = useRef(new WeakMap<Session, Promise<Session>>());
  const initialNotices = useRef<string[]>([]);
  const [workspace, setWorkspace] = useState(() => {
    const saved = loadSessionSnapshots(undefined, launchDirectory);
    initialNotices.current = saved.notices ?? [];
    for (const snapshot of saved.snapshots) diskSnapshots.current.set(snapshot.id, JSON.stringify(snapshot));
    const initial = createWorkspace({
      sessions: saved.snapshots.map(snapshot => Session.fromSnapshot(snapshot)),
      selectedSessionId: saved.selectedSessionId,
    }, launchDirectory);
    for (const session of initial.sessions) {
      savedVersions.current.set(session, session.getVersion());
      savedSnapshots.current.set(session, JSON.stringify(session.toSnapshot()));
    }
    const eligible = initial.sessions.filter(session => session.getDirectory() === launchDirectory && !session.isArchived());
    if (startup?.continueSession) initial.selectedSession = eligible.sort((a, b) => b.getLastActivity() - a.getLastActivity())[0] ?? null;
    if (startup?.resume) {
      const query = startup.resume.toLocaleLowerCase();
      const exact = initial.sessions.find(session => session.getId().toLocaleLowerCase() === query);
      const names = initial.sessions.filter(session => session.getName().toLocaleLowerCase() === query);
      const matches = initial.sessions.filter(session => session.getId().toLocaleLowerCase().includes(query) || session.getName().toLocaleLowerCase().includes(query));
      initial.selectedSession = exact ?? (names.length === 1 ? names[0] : matches.length === 1 ? matches[0] : null);
    }
    const active = initial.selectedSession ?? initial.draftSession;
    if (active.isArchived()) active.setArchived(false);
    if (startup?.model) active.changeParticipantModel(active.toSnapshot().defaultModel.name, startup.model);
    if (startup?.permissionMode) active.setPermissionMode(startup.permissionMode);
    return initial;
  });
  const currentWorkspace = useRef(workspace);
  currentWorkspace.current = workspace;
  const [resumeQuery, setResumeQuery] = useState<string | null>(() => startup?.resume != null && !workspace.selectedSession ? startup.resume : null);
  const [sidebarFocused, setSidebarFocused] = useState(false);
  const [storageNotice, setStorageNotice] = useState(initialNotices.current.join('\n'));
  const promptStarted = useRef(false);
  const { sessions, selectedSession, draftSession } = workspace;
  const activeSession = selectedSession ?? draftSession;
  const { stdout } = useStdout();
  const [terminalHeight, setTerminalHeight] = useState(() => stdout.rows ?? 24);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarWidth = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  // tracked so width-only resizes also re-render (the header rule spans the width)
  const [terminalWidth, setTerminalWidth] = useState(() => stdout.columns ?? 80);
  // mouse tracking and drag-to-copy live for the whole app, not per chat
  useTextSelection();
  // focus reporting and the notifications that depend on it, likewise
  useTerminalFocus();
  useNotifications(useMemo(() => [...sessions, draftSession], [sessions, draftSession]));

  useEffect(() => {
    let mounted = true;
    const warm = () => queueMicrotask(() => {
      if (mounted) void activeSession.warmup().catch(() => { /* The first turn reports a failed startup. */ });
    });
    warm();
    const stopSession = activeSession.subscribe(warm);
    const stopSources = onProviderChange(warm);
    return () => {
      mounted = false;
      stopSession();
      stopSources();
      activeSession.releaseWarmup();
    };
  }, [activeSession]);

  useInput((input, key) => {
    if (key.ctrl && input === 'b' && key.eventType !== 'release' && !sidebarFocused) setSidebarCollapsed(collapsed => !collapsed);
  });

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | undefined;
    const checkForUpdate = () => {
      activeController?.abort();
      activeController = new AbortController();
      void checkSirusUpdate(activeController.signal)
        .then(result => {
          if (!disposed) setUpdateVersion(result.updateAvailable ? result.latestVersion : null);
        })
        .catch(() => void 0);
    };
    checkForUpdate();
    const timer = setInterval(checkForUpdate, 60 * 60 * 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      activeController?.abort();
    };
  }, []);

  useEffect(() => {
    const updateTerminalSize = () => {
      setTerminalHeight(stdout.rows ?? 24);
      setTerminalWidth(stdout.columns ?? 80);
    };
    stdout.on("resize", updateTerminalSize);
    return () => {
      stdout.off("resize", updateTerminalSize);
    };
  }, [stdout]);

  useEffect(() => {
    const persistableSessions = [...new Set([...sessions, draftSession])];
    const persist = (session: Session, checkFinal = false) => {
      if (retiredSessions.current.has(session) || removedIds.current.has(session.getId()) || session.isEmpty()
        || (!checkFinal && savedVersions.current.get(session) === session.getVersion())) return;
      const snapshot = session.toSnapshot();
      const serialized = JSON.stringify(snapshot);
      // A stream mutates its entry before the throttled change notification.
      // Check the actual final contents without rewriting unchanged sessions.
      if (checkFinal && savedSnapshots.current.get(session) === serialized) return;
      if (diskSnapshots.current.has(session.getId()) && loadSessionRevision(session.getId()) === null) {
        removedIds.current.add(session.getId());
        setStorageNotice(`${session.getName()} was removed by another window. The copy in memory will not recreate it.`);
        return;
      }
      if (saveSessionSnapshot(snapshot)) {
        savedVersions.current.set(session, session.getVersion());
        savedSnapshots.current.set(session, serialized);
        diskSnapshots.current.set(session.getId(), serialized);
      } else setStorageNotice(`Could not save ${session.getName()}. Your conversation is still in memory.`);
    };
    const unsubscribe = persistableSessions.map(session => session.subscribe(() => persist(session)));
    const persistOnExit = () => { for (const session of persistableSessions) persist(session, true); };
    process.on('exit', persistOnExit);
    for (const session of persistableSessions) persist(session);
    saveSessionMetadata(sessions.filter(session => !session.isEmpty()).map(session => session.getId()), selectedSession?.getId() ?? null);
    return () => {
      for (const stop of unsubscribe) stop();
      process.off('exit', persistOnExit);
      persistOnExit();
    };
  }, [sessions, selectedSession, draftSession]);

  // Retire the old object before restoring the same id: disposal unregisters
  // its tool server and workers, which must not remove the new object's bindings.
  function replaceSession(old: Session, snapshot: SessionSnapshot): Promise<Session> {
    const existing = replacements.current.get(old);
    if (existing) return existing;
    retiredSessions.current.add(old);
    const replacement = old.dispose().then(() => {
      const session = Session.fromSnapshot(snapshot);
      savedVersions.current.set(session, session.getVersion());
      savedSnapshots.current.set(session, JSON.stringify(session.toSnapshot()));
      diskSnapshots.current.set(snapshot.id, JSON.stringify(snapshot));
      return session;
    });
    replacements.current.set(old, replacement);
    return replacement;
  }

  // Another window may add, archive, or change an inactive conversation.
  // The visible session and sessions still running here retain their own state.
  useEffect(() => {
    let refreshing = false;
    let disposed = false;
    const timer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const saved = loadSessionSnapshots(undefined, launchDirectory);
        if (saved.notices?.length) setStorageNotice(saved.notices.join('\n'));
        const previous = currentWorkspace.current;
        const byId = new Map(previous.sessions.map(session => [session.getId(), session]));
        const restored = new Map<Session, Session>();
        const added: Session[] = [];
        const existingIds = new Set(saved.snapshots.map(snapshot => snapshot.id));
        for (const snapshot of saved.snapshots) {
          if (removedIds.current.has(snapshot.id)) continue;
          const old = byId.get(snapshot.id);
          if (old && (old === currentWorkspace.current.selectedSession || old.getStatus() === 'working'
            || old.getWorkers().some(worker => worker.status === 'working')
            || diskSnapshots.current.get(snapshot.id) === JSON.stringify(snapshot))) continue;
          if (old) restored.set(old, await replaceSession(old, snapshot));
          else {
            const session = Session.fromSnapshot(snapshot);
            savedVersions.current.set(session, session.getVersion());
            savedSnapshots.current.set(session, JSON.stringify(session.toSnapshot()));
            diskSnapshots.current.set(snapshot.id, JSON.stringify(snapshot));
            added.push(session);
          }
        }
        if (disposed) return;
        setWorkspace(current => {
          let changed = false;
          const next = current.sessions.flatMap(old => {
            const replacement = restored.get(old);
            if (replacement) { changed = true; return [replacement]; }
            if (!existingIds.has(old.getId()) && byId.get(old.getId()) === old
              && old !== current.selectedSession && old.getStatus() !== 'working'
              && !old.getWorkers().some(worker => worker.status === 'working') && !old.isEmpty()) {
              retiredSessions.current.add(old);
              removedIds.current.add(old.getId());
              changed = true;
              void old.dispose();
              return [];
            }
            return [old];
          });
          for (const session of added) {
            if (!next.some(existing => existing.getId() === session.getId())) {
              next.push(session);
              changed = true;
            }
          }
          return changed ? {
            ...current, sessions: next,
            selectedSession: current.selectedSession ? restored.get(current.selectedSession) ?? current.selectedSession : null,
          } : current;
        });
      } catch (error) {
        if (!disposed) setStorageNotice(`Could not refresh sessions: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        refreshing = false;
      }
    }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [launchDirectory]);

  useEffect(() => {
    if (!startup?.prompt || promptStarted.current || resumeQuery !== null) return;
    promptStarted.current = true;
    const turn = activeSession.sendMessage({ role: 'user', content: [{ type: 'text', text: startup.prompt }] });
    if (!activeSession.isEmpty()) activateSession(activeSession);
    void turn.catch(error => setStorageNotice(error instanceof Error ? error.message : String(error)));
  }, [startup?.prompt, resumeQuery, activeSession]);

  async function selectSession(session: Session) {
    // Refresh at selection too, including switches before the next poll.
    let selected = session;
    if (session !== activeSession && session.getStatus() !== 'working'
      && !session.getWorkers().some(worker => worker.status === 'working')) {
      const notices: string[] = [];
      const snapshot = loadSessionSnapshot(session.getId(), undefined, launchDirectory, notices);
      if (notices.length) setStorageNotice(notices.join('\n'));
      if (!snapshot && !session.isEmpty()) {
        removedIds.current.add(session.getId());
        setStorageNotice(`${session.getName()} is no longer available on disk.`);
        setWorkspace(current => ({ ...current, sessions: current.sessions.filter(item => item !== session) }));
        return;
      }
      if (snapshot && JSON.stringify(snapshot) !== diskSnapshots.current.get(snapshot.id)) {
        selected = await replaceSession(session, snapshot);
      }
    }
    selected.setArchived(false);
    setResumeQuery(null);
    setWorkspace(current => ({ ...current, sessions: current.sessions.map(item => item === session ? selected : item), selectedSession: selected }));
  }

  function addSession() {
    setWorkspace(current => ({ ...current, selectedSession: null }));
  }

  function newSession() {
    const previous = activeSession.toSnapshot();
    const fresh = new Session({
      name: nextSessionName(sessions), directory: previous.directory,
      participants: previous.participants, defaultParticipant: previous.defaultModel.name,
      model: previous.defaultModel.model, permissionMode: previous.permissionMode,
      subagentModel: previous.subagentModel, autoNamePending: true,
    });
    setWorkspace(current => ({ ...current, selectedSession: null, draftSession: fresh }));
  }

  function activateSession(session: Session) {
    setWorkspace(current => startSession(current, session, launchDirectory));
  }

  function openSession(snapshot: SessionSnapshot) {
    const session = Session.fromSnapshot(snapshot);
    setWorkspace(current => ({ ...current, sessions: [...current.sessions, session], selectedSession: session }));
  }

  function archiveSession(session: Session) {
    session.setArchived(true);
    if (!session.isEmpty()) saveSessionSnapshot(session.toSnapshot());
    setWorkspace(current => ({ ...current, selectedSession: current.selectedSession === session ? null : current.selectedSession }));
  }

  function deleteSession(session: Session) {
    if (session.getStatus() === 'working' || session.getWorkers().some(worker => worker.status === 'working')) {
      setStorageNotice('Stop this session and its workers before deleting it.');
      return;
    }
    if (!deleteSessionSnapshot(session.getId())) { setStorageNotice(`Could not delete ${session.getName()}.`); return; }
    removedIds.current.add(session.getId());
    void session.dispose();
    setWorkspace(current => ({
      ...current, sessions: current.sessions.filter(candidate => candidate !== session),
      selectedSession: current.selectedSession === session ? null : current.selectedSession,
      draftSession: current.draftSession === session ? createDraft(current.sessions, launchDirectory) : current.draftSession,
    }));
  }

	return (
    // Always a full-screen frame: the sidebar spans the terminal and messages
    // render inside the chat column (bottom-anchored, clipped at the top), so
    // nothing ever lands in scrollback outside the viewport.
    <Box flexDirection="row" width={terminalWidth} height={Math.max(terminalHeight, 14)}>
      <Sidebar isActive={resumeQuery === null} sessions={sessions.filter(session => !session.isArchived())} directory={launchDirectory} onArchive={archiveSession} onFocusChange={setSidebarFocused} currSession={selectedSession} selectSession={selectSession} addSession={addSession} deleteSession={deleteSession} collapsed={sidebarCollapsed} />
      <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      {updateVersion && <Text color={theme.success} wrap="truncate-end">Sirus {updateVersion} available · /update</Text>}
      {storageNotice && <Text color="yellow">{storageNotice}</Text>}
      {resumeQuery !== null && <ResumePicker sessions={sessions} directory={launchDirectory} initialQuery={resumeQuery} onSelect={selectSession} onClose={() => setResumeQuery(null)} />}
      {sidebarFocused && <Box padding={3}><Text>Manage sessions in the sidebar. Esc returns to the conversation.</Text></Box>}
      <Box display={resumeQuery !== null || sidebarFocused ? 'none' : 'flex'} flexGrow={1} minHeight={0}>
      <Chat
        active={resumeQuery === null && !sidebarFocused}
        key={activeSession.getId()}
        currSession={activeSession}
        onNewSession={newSession}
        onOpenSession={openSession}
        onResumeSession={query => setResumeQuery(query ?? '')}
        onArchiveSession={() => archiveSession(activeSession)}
        onDeleteSession={() => deleteSession(activeSession)}
        sidebarWidth={sidebarWidth}
        onStartSession={selectedSession === null ? activateSession : undefined}
      />
      </Box>
      </Box>
    </Box>
	);
}
