import crypto from 'crypto';
import { throwIfAborted } from '../../abort';
import type { Tool } from '../tools/types';
import type { ToolCallBlock } from '../types';
import {
  cachedJudgeVerdict,
  hasAllowance,
  rememberJudgeVerdict,
  requestApproval,
  type Requester,
} from './approvals';
import { allowanceKeyFor, classifyToolCall, type ToolClass } from './classify';
import { describeToolCall, sensitiveReason } from './describe';
import { judgeShellCommand, type JudgeVerdict } from './judge';

// The gate every model-requested tool call passes through, whatever transport
// asked for it. Three modes:
//   ask    — ask for approval: deterministic; reads pass, everything else prompts
//   auto   — auto approve: reads and ordinary writes pass, sensitive operations
//            prompt, and a cheap model judges shell commands the rules cannot place
//   bypass — bypass permissions: everything passes, nothing is classified

export type PermissionMode = 'ask' | 'auto' | 'bypass';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'bypass'];

export const PERMISSION_MODE_NAMES: Record<PermissionMode, string> = {
  ask: 'ask for approval',
  auto: 'auto approve',
  bypass: 'bypass permissions',
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

export function parsePermissionMode(value: unknown): PermissionMode | null {
  return value === 'ask' || value === 'auto' || value === 'bypass' ? value : null;
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
}

// Who is asking, under which session's mode. `mode` is a live lookup so a
// mode change applies to the next call of every participant and subagent of
// the session.
export interface PermissionContext {
  sessionId: string;
  mode: () => PermissionMode;
  requester: Requester;
  model: string;
}

export const DECLINED_PREFIX = 'The user declined to allow';

export function isDeclinedResult(result: string): boolean {
  return result.startsWith(DECLINED_PREFIX);
}

async function judge(
  call: ToolCallBlock,
  directory: string,
  context: PermissionContext,
  signal?: AbortSignal,
): Promise<JudgeVerdict> {
  const command = String(call.arguments.command ?? '');
  const cached = cachedJudgeVerdict(context.sessionId, command);
  if (cached) return cached;
  const verdict = await judgeShellCommand(command, directory, context.model, signal);
  rememberJudgeVerdict(context.sessionId, command, verdict);
  return verdict;
}

// Returns null when the call may run, or the error text for the model when
// the user declined. Throws the abort reason if the turn is cancelled while
// a prompt or the judge is outstanding.
export async function authorizeToolCall(
  tool: Tool | undefined,
  call: ToolCallBlock,
  directory: string,
  context: PermissionContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const mode = context.mode();
  if (mode === 'bypass') return null;

  let toolClass: ToolClass = classifyToolCall(tool, call, directory);
  if (toolClass === 'read') return null;
  if (mode === 'auto' && toolClass === 'write') return null;

  let reason: string;
  if (mode === 'auto' && toolClass === 'unsure') {
    const verdict = await judge(call, directory, context, signal);
    throwIfAborted(signal);
    if (verdict === 'approve') return null;
    toolClass = 'sensitive';
    reason = 'judge: sensitive';
  } else {
    reason = toolClass === 'sensitive' ? sensitiveReason(call, directory) : toolClass;
  }

  const allowanceKey = toolClass === 'sensitive' ? null : allowanceKeyFor(call, directory);
  if (allowanceKey && hasAllowance(context.sessionId, allowanceKey)) return null;

  const decision = await requestApproval({
    id: crypto.randomUUID(),
    sessionId: context.sessionId,
    requester: context.requester,
    call,
    toolClass,
    reason,
    detail: describeToolCall(call, directory),
    allowanceKey,
  }, signal);
  if (decision === 'deny') {
    return `${DECLINED_PREFIX} ${call.name} (${describeToolCall(call, directory)[0]}). Do not retry it; explain what you wanted to do or ask the user.`;
  }
  return null;
}
