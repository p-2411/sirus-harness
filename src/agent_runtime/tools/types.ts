// The tool layer's vocabulary. It depends on nothing above itself: no agent,
// no session, no permission context. Everything a tool needs at call time
// arrives in its ToolContext.

export interface ToolArgumentSchema {
  type: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  description?: string;
  [key: string]: unknown;
}

export interface ToolAudience {
  subagent?: boolean;
}

// What one run of a subagent looks like to the tool that started it.
export interface SubagentHandle {
  id: string;
  model: string;
  status: string;
  streamFile: string | null;
}

// The identity of the tool call that is spawning a subagent, so the run can
// be tied back to it and stopped with the call that made it.
export interface SubagentSpawnCall {
  callId: string;
  signal?: AbortSignal;
}

// The narrow port the agent tools speak to. The session hands the MCP server
// one per participant that may delegate; a worker gets none, which is why a
// subagent cannot spawn a grandchild. The subagent's model is a session
// setting, not the spawner's choice.
export interface SubagentHost {
  spawn(prompt: string, call: SubagentSpawnCall): SubagentHandle;
  check(id: string, wait: boolean, signal?: AbortSignal): Promise<Record<string, unknown>>;
  cancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
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
