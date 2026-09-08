import { abortReason, throwIfAborted } from '../../abort';
import type { ToolCallBlock } from '../types';
import type { ToolClass } from './classify';
import type { JudgeVerdict } from './judge';

// The prompts the user is looking at, what they have already allowed for a
// session, and what the judge has already decided. One process-wide store,
// because the UI subscribes to it once and the gate is called from every
// turn of every session.

export type Requester = { participant: string } | { subagent: string };

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  requester: Requester;
  call: ToolCallBlock;
  toolClass: ToolClass;
  // why this prompt appeared, shown beside the tool name
  reason: string;
  // what the user is approving, one item per line
  detail: string[];
  // the allowance "allow for this session" would record; null when the
  // operation is sensitive and allowances cannot cover it
  allowanceKey: string | null;
}

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
}

const pending: PendingEntry[] = [];
const allowances = new Map<string, Set<string>>();
const judgeCache = new Map<string, Map<string, JudgeVerdict>>();
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

export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const index = pending.findIndex(entry => entry.request.id === id);
  if (index === -1) return false;
  const [entry] = pending.splice(index, 1);
  if (decision === 'allow-session' && entry.request.allowanceKey) {
    let keys = allowances.get(entry.request.sessionId);
    if (!keys) {
      keys = new Set();
      allowances.set(entry.request.sessionId, keys);
    }
    keys.add(entry.request.allowanceKey);
  }
  notifyListeners();
  entry.resolve(decision);
  return true;
}

export function isAwaitingApproval(callId: string, sessionId?: string): boolean {
  return pending.some(entry => entry.request.call.id === callId
    && (sessionId === undefined || entry.request.sessionId === sessionId));
}

// Already allowed for this session by an earlier "allow for this session".
export function hasAllowance(sessionId: string, key: string): boolean {
  return allowances.get(sessionId)?.has(key) ?? false;
}

// The judge is a model call: the same command in the same session is only
// ever paid for once.
export function cachedJudgeVerdict(sessionId: string, command: string): JudgeVerdict | undefined {
  return judgeCache.get(sessionId)?.get(command);
}

export function rememberJudgeVerdict(sessionId: string, command: string, verdict: JudgeVerdict): void {
  let cache = judgeCache.get(sessionId);
  if (!cache) {
    cache = new Map();
    judgeCache.set(sessionId, cache);
  }
  cache.set(command, verdict);
}

// Puts one prompt in front of the user and waits. A cancelled turn withdraws
// its prompt and throws the abort reason.
export function requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
  throwIfAborted(signal);
  return new Promise<ApprovalDecision>((resolve, reject) => {
    const entry: PendingEntry = { request, resolve, reject };
    const onAbort = () => {
      const index = pending.indexOf(entry);
      if (index !== -1) pending.splice(index, 1);
      notifyListeners();
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.resolve = decision => {
      signal?.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    pending.push(entry);
    notifyListeners();
  });
}
