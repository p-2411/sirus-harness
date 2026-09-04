import type { SessionAgent } from '../agent';
import type { PermissionContext } from '../permissions/permissions';

export interface ToolArgumentSchema {
  type: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  description?: string;
  [key: string]: unknown;
}

// The host-side identity of one model-requested call, for tools whose effect
// outlives the call (a spawned subagent is tied back to the call that made it).
export interface ToolCallContext {
  callId: string;
  signal?: AbortSignal;
  // The permission context of the caller, inherited by anything it spawns.
  permissions?: PermissionContext;
  // The agent making the call; it owns any subagent the call spawns.
  agent?: SessionAgent;
}

export interface Tool {
  name: string;
  description: string;
  args: Record<string, ToolArgumentSchema>;
  func: (
    args: Record<string, unknown>,
    directory: string,
    call?: ToolCallContext,
  ) => unknown | Promise<unknown>;
}

export interface ToolAudience {
  subagent?: boolean;
}
