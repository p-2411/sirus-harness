import crypto from 'crypto';
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { PERMISSION_CANCELLED, toolCallBlockFrom } from '../runtime/runtime';
import type { ToolCallBlock } from '../types';
import type { PermissionContext } from './policy';

// The prompts the user is looking at and what they decided. One process-wide
// store, because the UI subscribes to it once and every runtime's escalations
// land here, whatever session they belong to. Nothing is kept as an
// allowance: an option that says "don't ask again" is the vendor's, and the
// vendor remembers it itself.

export type Requester = { participant: string } | { subagent: string };

export function describeRequester(requester: Requester): string {
  return 'participant' in requester ? `@${requester.participant}` : `subagent ${requester.subagent}`;
}

// What the user picked: one of the vendor's options by id, as the prompt
// offers them, or the kind of answer wanted, for a caller with no prompt in
// front of it.
export type ApprovalDecision = 'allow' | 'allow-session' | 'deny' | { optionId: string };

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

// Requests waiting on the user, in the order they arrived: this file's
// approvals and the questions in `./questions`. The UI subscribes to each
// queue once and reads it whole.
export interface UserRequestQueue<Request extends { id: string; sessionId: string }, Answer> {
  subscribe(listener: () => void): () => void;
  // Monotonic counter for useSyncExternalStore; the queue is mutated in place.
  version(): number;
  pending(sessionId?: string): Request[];
  // Answers the request with this id. False when it is no longer waiting.
  resolve(id: string, answer: Answer): boolean;
  // Queues the request and turns the user's answer into the vendor's reply.
  // A cancelled turn withdraws it and replies `cancelled` instead of
  // throwing: the vendor is waiting on a reply and the runtime has to send
  // one.
  ask<Reply>(request: Request, signal: AbortSignal | undefined, reply: (answer: Answer) => Reply, cancelled: Reply): Promise<Reply>;
}

export function userRequestQueue<Request extends { id: string; sessionId: string }, Answer>(): UserRequestQueue<Request, Answer> {
  const waiting: { request: Request; settle: (answer: Answer) => void }[] = [];
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const take = (found: (request: Request) => boolean) => {
    const index = waiting.findIndex(entry => found(entry.request));
    return index === -1 ? undefined : waiting.splice(index, 1)[0];
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
    pending: sessionId => waiting
      .map(entry => entry.request)
      .filter(request => sessionId === undefined || request.sessionId === sessionId),
    resolve(id, answer) {
      const entry = take(request => request.id === id);
      if (!entry) return false;
      changed();
      entry.settle(answer);
      return true;
    },
    ask(request, signal, reply, cancelled) {
      if (signal?.aborted) return Promise.resolve(cancelled);
      return new Promise(resolve => {
        const onAbort = () => {
          take(waitingRequest => waitingRequest === request);
          changed();
          resolve(cancelled);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push({
          request,
          settle: answer => {
            signal?.removeEventListener('abort', onAbort);
            resolve(reply(answer));
          },
        });
        changed();
      });
    },
  };
}

const approvals = userRequestQueue<ApprovalRequest, ApprovalDecision>();

export const subscribePermissions = approvals.subscribe;
export const getPermissionsVersion = approvals.version;
export const pendingApprovals = approvals.pending;

export function isAwaitingApproval(callId: string, sessionId?: string): boolean {
  return approvals.pending(sessionId).some(request => request.toolCall.id === callId);
}

// What the user decided per tool call, so the transcript can say "declined by
// user" after the vendor has moved on. Per session and capped: a session can
// run for days, and the vendor never asks about an old call again.
const DECISIONS_PER_SESSION = 256;
type Outcome = 'allow' | 'deny';
const decisions = new Map<string, Map<string, Outcome>>();

function rememberDecision(sessionId: string, callId: string, decision: Outcome): void {
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

export function lastDecision(callId: string, sessionId: string): Outcome | undefined {
  return decisions.get(sessionId)?.get(callId);
}

export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const request = approvals.pending().find(candidate => candidate.id === id);
  if (!request) return false;
  const option = chosenOption(decision, request.options);
  const denied = option ? option.kind.startsWith('reject') : decision === 'deny';
  rememberDecision(request.sessionId, request.toolCall.id, denied ? 'deny' : 'allow');
  return approvals.resolve(id, decision);
}

// The option kinds each kind of answer prefers, best first. Only the kinds
// are trusted, never the order or the ids.
const OPTION_KINDS: Record<Exclude<ApprovalDecision, object>, readonly PermissionOptionKind[]> = {
  allow: ['allow_once', 'allow_always'],
  'allow-session': ['allow_always', 'allow_once'],
  deny: ['reject_once', 'reject_always'],
};

function chosenOption(decision: ApprovalDecision, options: readonly PermissionOption[]): PermissionOption | undefined {
  if (typeof decision === 'object') return options.find(option => option.optionId === decision.optionId);
  for (const kind of OPTION_KINDS[decision]) {
    const option = options.find(candidate => candidate.kind === kind);
    if (option) return option;
  }
  // No kind matched. Vendors list allows first, so an allow takes the first
  // option; a denial with nothing to reject picks none and is answered
  // cancelled, since any option left would let the call through.
  return decision === 'deny' ? undefined : options[0];
}

// Puts one vendor escalation in front of the user and answers it with the
// option matching their choice.
export function requestPermission(
  context: PermissionContext,
  request: RequestPermissionRequest,
  signal?: AbortSignal,
): Promise<RequestPermissionResponse> {
  const approval: ApprovalRequest = {
    id: crypto.randomUUID(),
    sessionId: context.sessionId,
    requester: context.requester,
    toolCall: toolCallBlockFrom(request.toolCall),
    options: request.options,
  };
  return approvals.ask(approval, signal, decision => {
    const option = chosenOption(decision, approval.options);
    // An empty option list, or a denial the vendor offered no way to
    // reject, leaves nothing to select.
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : PERMISSION_CANCELLED;
  }, PERMISSION_CANCELLED);
}
