import { useEffect, useRef } from 'react';
import type { Session, SessionStatus } from '../agent_runtime/session';
import {
  describeRequester,
  pendingApprovals,
  subscribePermissions,
} from '../agent_runtime/permissions/permissions';
import {
  listAllSubagents,
  subscribeSubagents,
  type SubagentStatus,
} from '../agent_runtime/tools/subagents';
import { notify } from './terminal/notifications';

const BODY_LENGTH = 120;

function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > BODY_LENGTH ? `${line.slice(0, BODY_LENGTH - 1)}…` : line;
}

// The closing words of the turn: the last thing an agent said.
export function turnSummary(session: Session, status: SessionStatus): string {
  if (status === 'error') return 'The turn failed.';
  const messages = session.getMessages();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' && message.content.some(block => block.type === 'text' || block.type === 'image')) break;
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    const line = firstLine(text);
    if (line) return `@${message.participant ?? 'sirus'}: ${line}`;
  }
  return 'Turn finished.';
}

// Keep subscriptions separate from React so each event source owns its cleanup.
export function subscribeSessionNotifications(sessions: readonly Session[], send = notify): () => void {
  const statuses = new Map<Session, SessionStatus>();
  const unsubscribes = sessions.map(session => {
    statuses.set(session, session.getStatus());
    return session.subscribe(() => {
      const previous = statuses.get(session);
      const current = session.getStatus();
      if (previous === current) return;
      statuses.set(session, current);
      if (previous === 'working' && current !== 'working' && !session.wasLastTurnCancelled()) {
        send(`Sirus · ${session.getName()}`, turnSummary(session, current));
      }
    });
  });
  return () => {
    for (const stop of unsubscribes) stop();
  };
}

export function subscribeApprovalNotifications(getSessions: () => readonly Session[], send = notify): () => void {
  let seen = new Set(pendingApprovals().map(request => request.id));
  return subscribePermissions(() => {
    const current = pendingApprovals();
    for (const request of current) {
      if (seen.has(request.id)) continue;
      const session = getSessions().find(candidate => candidate.getId() === request.sessionId);
      const detail = request.detail[0] ? `: ${firstLine(request.detail[0])}` : '';
      send(
        `Sirus · ${session?.getName() ?? 'approval needed'}`,
        `${describeRequester(request.requester)} wants to run ${request.call.name}${detail}`,
      );
    }
    seen = new Set(current.map(request => request.id));
  });
}

// Watches every session, the approval queue, and the subagent runs, and
// raises a desktop notification when something finishes or needs the user.
// Whether a notification actually shows is the notification module's call.
export function useNotifications(sessions: readonly Session[]) {
  const latestSessions = useRef(sessions);
  latestSessions.current = sessions;

  useEffect(() => subscribeSessionNotifications(sessions), [sessions]);
  useEffect(() => subscribeApprovalNotifications(() => latestSessions.current), []);

  useEffect(() => {
    const statuses = new Map<string, SubagentStatus>();
    for (const run of listAllSubagents()) statuses.set(run.id, run.status);
    return subscribeSubagents(() => {
      for (const run of listAllSubagents()) {
        const previous = statuses.get(run.id);
        statuses.set(run.id, run.status);
        if (previous !== 'working' || run.status === 'working' || run.status === 'cancelled') continue;
        // While its owner is still working the owner's own finish will say so.
        const session = latestSessions.current.find(candidate => candidate.getId() === run.permissions?.sessionId);
        if (session?.getStatus() === 'working') continue;
        notify(
          `Sirus · ${session?.getName() ?? 'subagent'}`,
          `Subagent ${run.id} ${run.status}: ${firstLine(run.finalMessage ?? run.error ?? '')}`,
        );
      }
    });
  }, []);
}
