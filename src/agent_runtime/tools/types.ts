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

// The host identity of the model-requested call that is spawning a subagent,
// so the run can be tied back to it and stopped with the turn that made it.
export interface SubagentSpawnCall {
  callId: string;
  signal?: AbortSignal;
}

// The narrow port the agent tools speak to. The session binds one of these to
// the agent whose turn the toolbox belongs to; a subagent's toolbox has none,
// which is why a subagent cannot spawn a grandchild.
export interface SubagentHost {
  spawn(prompt: string, model: string, call: SubagentSpawnCall): SubagentHandle;
  check(id: string, wait: boolean, signal?: AbortSignal): Promise<Record<string, unknown>>;
  cancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  list(): Record<string, unknown>[];
}

// Everything one tool call knows about where and for whom it runs.
export interface ToolContext {
  // Where the call runs: the turn's directory. Relative paths resolve here.
  directory: string;
  // The turn's signal: a tool that can outlive a keystroke watches it.
  signal?: AbortSignal;
  // The model's id for this call, for effects that outlive it.
  callId: string;
  subagents?: SubagentHost;
}

// What the call does to the world: 'read' passes the checkpoint barrier and
// the permission gate untouched. A tool whose effect depends on its arguments
// answers as a function of them.
export type ToolEffect = 'read' | 'mutates';

export interface Tool<A = Record<string, unknown>> {
  name: string;
  description: string;
  args: Record<string, ToolArgumentSchema>;
  // The function form decides from the call's own arguments — `RunShell` reads
  // `command`, and the gate refines a mutating call by the `path` argument a
  // tool declares. `SaveMemory` and `DeleteMemory` are `'read'` despite
  // writing, because memories live outside the working directory: nothing
  // there is covered by the checkpoint snapshot or the directory's approvals.
  effect: ToolEffect | ((args: A, directory: string) => ToolEffect);
  // Which callers may see and run it. Absent means everyone.
  audience?: ToolAudience;
  // A capability the tool needs switched on; without it the tool is hidden
  // and direct calls are refused.
  requires?: 'memory';
  run(args: A, ctx: ToolContext): Promise<unknown>;
}
