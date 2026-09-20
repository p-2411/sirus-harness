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
  thinkingLevel: string;
  status: string;
  // The git branch the worker works on in its own worktree, or null when the
  // project is not a git repository and it works in place.
  branch: string | null;
  // How the worker's conversation started: from nothing, or as a fork of
  // the conversation of the agent that spawned it.
  context: WorkerContext;
}

export type WorkerContext = 'fresh' | 'owner';

// The identity of the tool call that is spawning a subagent, so the run can
// be tied back to it. A worker outlives the call: nothing here stops it.
export interface SubagentSpawnCall {
  callId: string;
}

// The narrow port the agent tools speak to. The session hands the MCP server
// one per participant that may delegate; a worker gets none, which is why a
// subagent cannot spawn a grandchild. The subagent's model is a session
// setting or Jev's pick, not the spawner's choice. Every worker is a
// background task: spawn returns once the worker is on its way, and the
// worker's report reaches its owner as a message when it ends.
export interface SubagentHost {
  spawn(prompt: string, context: WorkerContext, call: SubagentSpawnCall): Promise<SubagentHandle>;
  check(id: string): Record<string, unknown>;
  cancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  // Sends text into a running worker's turn. A worker that has ended refuses.
  message(id: string, text: string): Promise<Record<string, unknown>>;
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
