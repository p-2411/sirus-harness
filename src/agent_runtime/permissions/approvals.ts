import crypto from 'crypto';
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { toolCallBlockFrom } from '../runtime/runtime';
import type { ToolCallBlock } from '../types';
import type { PermissionContext } from './policy';

// The prompts the user is looking at and what they decided. One process-wide
// store, because the UI subscribes to it once and every runtime's escalations
// land here, whatever session they belong to. Nothing is kept as an
// allowance: "allow for this session" answers the vendor's allow-always
// option, and the vendor remembers that itself.

export type Requester = { participant: string } | { subagent: string };

export function describeRequester(requester: Requester): string {
  return 'participant' in requester ? `@${requester.participant}` : `subagent ${requester.subagent}`;
}

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  requester: Requester;
  // The call as the vendor described it: title, kind, locations, content and
  // raw input. The prompt renders from this and nothing else.
  toolCall: ToolCallBlock;
  // The vendor's options, in its order.
  options: PermissionOption[];
}

interface PendingEntry {
  request: ApprovalRequest;
  settle: (decision: ApprovalDecision) => void;
}

const pending: PendingEntry[] = [];
const listeners = new Set<() => void>();
let version = 0;

function notifyListeners(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribePermissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Monotonic counter for useSyncExternalStore; the queue is mutated in place.
export function getPermissionsVersion(): number {
  return version;
}

export function pendingApprovals(sessionId?: string): ApprovalRequest[] {
  return pending
    .map(entry => entry.request)
    .filter(request => sessionId === undefined || request.sessionId === sessionId);
}

export function isAwaitingApproval(callId: string, sessionId?: string): boolean {
  return pending.some(entry => entry.request.toolCall.id === callId
    && (sessionId === undefined || entry.request.sessionId === sessionId));
}

// What the user decided per tool call, so the transcript can say "declined by
// user" after the vendor has moved on. Per session and capped: a session can
// run for days, and the vendor never asks about an old call again.
const DECISIONS_PER_SESSION = 256;
const decisions = new Map<string, Map<string, ApprovalDecision>>();

function rememberDecision(sessionId: string, callId: string, decision: ApprovalDecision): void {
  let remembered = decisions.get(sessionId);
  if (!remembered) {
    remembered = new Map();
    decisions.set(sessionId, remembered);
  }
  remembered.delete(callId);
  remembered.set(callId, decision);
  // A Map iterates in insertion order, so the first key is the oldest.
  if (remembered.size > DECISIONS_PER_SESSION) remembered.delete(remembered.keys().next().value!);
}

export function lastDecision(callId: string, sessionId: string): ApprovalDecision | undefined {
  return decisions.get(sessionId)?.get(callId);
}

export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const index = pending.findIndex(entry => entry.request.id === id);
  if (index === -1) return false;
  const [entry] = pending.splice(index, 1);
  rememberDecision(entry.request.sessionId, entry.request.toolCall.id, decision);
  notifyListeners();
  entry.settle(decision);
  return true;
}

// The option kinds each decision prefers, best first. Both adapters offer all
// four, but only the kinds are trusted, never the order or the ids.
const OPTION_KINDS: Record<ApprovalDecision, readonly PermissionOptionKind[]> = {
  allow: ['allow_once', 'allow_always'],
  'allow-session': ['allow_always', 'allow_once'],
  deny: ['reject_once', 'reject_always'],
};

function optionFor(decision: ApprovalDecision, options: readonly PermissionOption[]): PermissionOption | undefined {
  for (const kind of OPTION_KINDS[decision]) {
    const option = options.find(candidate => candidate.kind === kind);
    if (option) return option;
  }
  // No kind matched: vendors list allows first and rejects last.
  return decision === 'deny' ? options[options.length - 1] : options[0];
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

// Puts one vendor escalation in front of the user and answers it with the
// option matching their choice. A cancelled turn withdraws its prompt and
// answers `cancelled` instead of throwing: the vendor is waiting on a reply
// and the runtime has to send one.
export function requestPermission(
  context: PermissionContext,
  request: RequestPermissionRequest,
  signal?: AbortSignal,
): Promise<RequestPermissionResponse> {
  if (signal?.aborted) return Promise.resolve(CANCELLED);
  const approval: ApprovalRequest = {
    id: crypto.randomUUID(),
    sessionId: context.sessionId,
    requester: context.requester,
    toolCall: toolCallBlockFrom(request.toolCall),
    options: request.options,
  };
  return new Promise<RequestPermissionResponse>(resolve => {
    const onAbort = () => {
      const index = pending.findIndex(entry => entry.request === approval);
      if (index !== -1) pending.splice(index, 1);
      notifyListeners();
      resolve(CANCELLED);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.push({
      request: approval,
      settle: decision => {
        signal?.removeEventListener('abort', onAbort);
        const option = optionFor(decision, approval.options);
        // Only an empty option list leaves nothing to select.
        resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : CANCELLED);
      },
    });
    notifyListeners();
  });
}
