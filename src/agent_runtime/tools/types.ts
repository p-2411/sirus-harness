import type { ThinkingLevel } from '../types';

// The tool layer's vocabulary. It depends on nothing above itself: no agent,
// no session, no permission context. Everything a tool needs at call time
// arrives in its ToolContext.

export interface ToolArgumentSchema {
  type: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  description?: string;
  // An argument the caller may leave out, and what it means when it does.
  // Everything else is required, which is how every provider was told about
  // these tools before any of them had an optional argument.
  default?: unknown;
  [key: string]: unknown;
}

export interface ToolAudience {
  subagent?: boolean;
}

export type WorkerContext = 'fresh' | 'owner';

// The identity of the tool call that is spawning a subagent, so the run can
// be tied back to it. A worker outlives the call: nothing here stops it.
export interface SubagentSpawnCall {
  callId: string;
  // The vendor's id for the call, when the vendor sent one.
  vendorCallId?: string;
}

export interface SpawnOptions {
  context?: WorkerContext;
  description?: string;
  name?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  agentType?: string;
  isolation?: 'none' | 'worktree';
  cwd?: string;
  runInBackground?: boolean;
}

// The caller can address only its own workers, by id or by name.
export interface SubagentHost {
  spawn(prompt: string, options: SpawnOptions, call: SubagentSpawnCall, signal?: AbortSignal): Promise<Record<string, unknown>>;
  check(id: string): Record<string, unknown>;
  cancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  message(id: string, text: string, interrupt?: boolean): Promise<Record<string, unknown>>;
  wait(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
  list(): Record<string, unknown>[];
}

// Everything one tool call knows about where and for whom it runs.
export interface ToolContext {
  // Where the call runs: the session's directory. Relative paths resolve here.
  directory: string;
  // Aborted when the caller cancels the call or drops the connection: a tool
  // that can outlive a keystroke watches it.
  signal?: AbortSignal;
  // An id for this call, for effects that outlive it.
  callId: string;
  // The id the vendor gave this call, which is its row in the chat, when the
  // vendor sent one with the request.
  vendorCallId?: string;
  subagents?: SubagentHost;
}

export interface Tool<A = Record<string, unknown>> {
  name: string;
  description: string;
  args: Record<string, ToolArgumentSchema>;
  // Which callers may see and run it. Absent means everyone.
  audience?: ToolAudience;
  // A capability the tool needs switched on; without it the tool is hidden
  // and direct calls are refused.
  requires?: 'memory';
  run(args: A, ctx: ToolContext): Promise<unknown>;
}
