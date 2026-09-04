import { useEffect, useMemo, useState } from "react";
import { Box, useStdout } from "ink";
import Chat from "./chat/Chat";
import Sidebar from "./Sidebar";
import { DEFAULT_MODEL, Session } from "../agent_runtime/session";
import {
  loadSessions,
  loadSirusModelPreference,
  saveSessions,
  saveSirusModelPreference,
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
  preferredSirusModel?: string | null,
) {
  const previousSession = saved.sessions.find(session => session.getId() === saved.selectedSessionId)
    ?? saved.sessions[0];
  const previousModel = previousSession?.getModel();
  const sirusModel = preferredSirusModel && modelStrategies[preferredSirusModel]
    ? preferredSirusModel
    : previousModel && modelStrategies[previousModel] ? previousModel : DEFAULT_MODEL;
  for (const session of saved.sessions) {
    if (session.getModel() !== sirusModel) session.setModel(sirusModel);
  }
  return {
    sessions: [...saved.sessions],
    selectedSession: null as Session | null,
    draftSession: Session.create(nextSessionName(saved.sessions), launchDirectory, sirusModel),
    sirusModel,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

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
    draftSession: Session.create(nextSessionName(sessions), launchDirectory, workspace.sirusModel),
    sirusModel: workspace.sirusModel,
  };
}

export function setSirusModel(workspace: Workspace, model: string): Workspace {
  for (const session of new Set([...workspace.sessions, workspace.draftSession])) {
    if (session.getModel() !== model) session.setModel(model);
  }
  return { ...workspace, sirusModel: model };
}

export default function App({ launchDirectory = process.cwd() }: { launchDirectory?: string }) {
  const [workspace, setWorkspace] = useState(() => {
    const saved = loadSessions(undefined, launchDirectory);
    return createWorkspace(saved, launchDirectory, loadSirusModelPreference());
  });
  const { sessions, selectedSession, draftSession } = workspace;
  const activeSession = selectedSession ?? draftSession;
  const { stdout } = useStdout();
  const [terminalHeight, setTerminalHeight] = useState(() => stdout.rows ?? 24);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  // tracked so width-only resizes also re-render (the header rule spans the width)
  const [, setTerminalWidth] = useState(() => stdout.columns ?? 80);
  // mouse tracking and drag-to-copy live for the whole app, not per chat
  useTextSelection();
  // focus reporting and the notifications that depend on it, likewise
  useTerminalFocus();
  useNotifications(useMemo(() => [...sessions, draftSession], [sessions, draftSession]));

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
      const session = Session.create(nextSessionName(current.sessions), launchDirectory, current.sirusModel);
      const sessions = [...current.sessions, session];
      return {
        sessions,
        selectedSession: session,
        draftSession: Session.create(nextSessionName(sessions), launchDirectory, current.sirusModel),
        sirusModel: current.sirusModel,
      };
    });
  }

  function activateSession(session: Session) {
    setWorkspace(current => startSession(current, session, launchDirectory));
  }

  function changeSirusModel(model: string) {
    setWorkspace(current => setSirusModel(current, model));
    saveSirusModelPreference(model);
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
          ? Session.create(nextSessionName(sessions), launchDirectory, current.sirusModel)
          : current.draftSession,
        sirusModel: current.sirusModel,
      };
    });
  }
	return (
    // Always a full-screen frame: the sidebar spans the terminal and messages
    // render inside the chat column (bottom-anchored, clipped at the top), so
    // nothing ever lands in scrollback outside the viewport.
    <Box flexDirection="row" width="100%" height={Math.max(terminalHeight, 14)}>
      <Sidebar sessions={sessions} currSession={selectedSession} selectSession={selectSession} addSession={addSession} deleteSession={deleteSession} updateAvailable={updateAvailable} />
      <Chat
        key={activeSession.getId()}
        currSession={activeSession}
        onStartSession={selectedSession === null ? activateSession : undefined}
        onSirusModelChange={changeSirusModel}
      />
    </Box>
	);
}
