import { useEffect, useMemo, useState } from "react";
import { Box, useInput, useStdout } from "ink";
import Chat from "./chat/Chat";
import Sidebar, { COLLAPSED_SIDEBAR_WIDTH, SIDEBAR_WIDTH } from "./Sidebar";
import { DEFAULT_MODEL, Session } from "../agent_runtime/session";
import {
  loadSessions,
  loadSirusModelPreference,
  saveSessions,
  type PersistedSessions,
} from "../persistence";
import { useTextSelection } from "./interaction/useTextSelection";
import { useTerminalFocus } from "./interaction/useTerminalFocus";
import { useNotifications } from "./useNotifications";
import { modelStrategies } from '../agent_runtime/chat';
import { checkSirusUpdate } from '../updater';

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
  const model = preference && modelStrategies[preference] ? preference : DEFAULT_MODEL;
  return Session.create(nextSessionName(sessions), directory, model);
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

export default function App({ launchDirectory = process.cwd() }: { launchDirectory?: string }) {
  const [workspace, setWorkspace] = useState(() => {
    const saved = loadSessions(undefined, launchDirectory);
    return createWorkspace(saved, launchDirectory);
  });
  const { sessions, selectedSession, draftSession } = workspace;
  const activeSession = selectedSession ?? draftSession;
  const { stdout } = useStdout();
  const [terminalHeight, setTerminalHeight] = useState(() => stdout.rows ?? 24);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarWidth = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  // tracked so width-only resizes also re-render (the header rule spans the width)
  const [terminalWidth, setTerminalWidth] = useState(() => stdout.columns ?? 80);
  // mouse tracking and drag-to-copy live for the whole app, not per chat
  useTextSelection();
  // focus reporting and the notifications that depend on it, likewise
  useTerminalFocus();
  useNotifications(useMemo(() => [...sessions, draftSession], [sessions, draftSession]));

  useInput((input, key) => {
    if (key.ctrl && input === 'k') setSidebarCollapsed(collapsed => !collapsed);
  });

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | undefined;
    const checkForUpdate = () => {
      activeController?.abort();
      activeController = new AbortController();
      void checkSirusUpdate(activeController.signal)
        .then(result => {
          if (!disposed) setUpdateAvailable(result.updateAvailable);
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
    // Include the startup draft so its first streamed turn is durable even if
    // the process exits before React promotes it into the sidebar state.
    const persistableSessions = [...new Set([...sessions, draftSession])];
    const persist = () => saveSessions(persistableSessions, selectedSession?.getId() ?? null);
    const unsubscribe = persistableSessions.map(session => session.subscribe(persist));
    // Session messages are mutated with the latest streamed snapshot before
    // throttled UI notifications. A synchronous exit save captures that final
    // in-memory snapshot when the app is quit mid-response.
    const persistOnExit = () => { persist(); };
    process.on('exit', persistOnExit);
    persist();
    return () => {
      for (const stop of unsubscribe) stop();
      process.off('exit', persistOnExit);
      persist();
    };
  }, [sessions, selectedSession, draftSession]);

  function selectSession(session: Session) {
    setWorkspace(current => ({ ...current, selectedSession: session }));
  }

  function addSession() {
    setWorkspace(current => {
      const session = createDraft(current.sessions, launchDirectory);
      const sessions = [...current.sessions, session];
      return {
        sessions,
        selectedSession: session,
        draftSession: createDraft(sessions, launchDirectory),
      };
    });
  }

  function activateSession(session: Session) {
    setWorkspace(current => startSession(current, session, launchDirectory));
  }

  function deleteSession(session: Session) {
    setWorkspace(current => {
      const index = current.sessions.indexOf(session);
      if (index === -1) return current;
      const sessions = current.sessions.filter(candidate => candidate !== session);
      const selectedSession = current.selectedSession === session
        ? sessions[Math.min(index, sessions.length - 1)] ?? null
        : current.selectedSession;
      return {
        sessions,
        selectedSession,
        draftSession: selectedSession === null && sessions.length === 0
          ? createDraft(sessions, launchDirectory)
          : current.draftSession,
      };
    });
  }
	return (
    // Always a full-screen frame: the sidebar spans the terminal and messages
    // render inside the chat column (bottom-anchored, clipped at the top), so
    // nothing ever lands in scrollback outside the viewport.
    <Box flexDirection="row" width={terminalWidth} height={Math.max(terminalHeight, 14)}>
      <Sidebar sessions={sessions} currSession={selectedSession} selectSession={selectSession} addSession={addSession} deleteSession={deleteSession} updateAvailable={updateAvailable} collapsed={sidebarCollapsed} />
      <Chat
        key={activeSession.getId()}
        currSession={activeSession}
        sidebarWidth={sidebarWidth}
        onStartSession={selectedSession === null ? activateSession : undefined}
      />
    </Box>
	);
}
