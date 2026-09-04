import { getResponse, modelStrategies } from './chat';
import {
  cancelSubagent,
  checkSubagent,
  describeSubagents,
  startSubagent,
  type SubagentRun,
  type SubagentSpawnOptions,
} from './tools/subagents';
import { TurnContext, type TurnOptions } from './turn';
import { DEFAULT_THINKING_LEVEL, type Message, type ThinkingLevel } from './types';

// The persisted shape of an agent: what a session snapshot stores and what
// the UI lists.
export interface Participant {
  name: string;
  model: string;
  // Absent in older snapshots and for untouched participants; high is the
  // default in both cases.
  thinkingLevel?: ThinkingLevel;
}

export interface AgentOptions extends Participant {
  // Key for the provider-owned session that subscription runtimes keep for
  // this agent, so agents sharing a Sirus session never share a provider one.
  runtimeId: string;
  // A run spawned by another agent: it gets the subagent contract in its
  // prompt and no tools for spawning further agents.
  subagent?: boolean;
}

// One agent in a session: its identity in the chat, the model it runs on, and
// the session-level wiring every turn of it needs. Turns come and go; this
// stays for as long as the agent is in the session.
export class SessionAgent {
  readonly name: string;
  model: string;
  readonly runtimeId: string;
  readonly subagent: boolean;
  private level?: ThinkingLevel;
  private readonly activeTurns = new Set<TurnContext>();
  private readonly subagents = new Map<string, SubagentRun>();

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.runtimeId = options.runtimeId;
    this.subagent = options.subagent ?? false;
    if (options.thinkingLevel) this.level = options.thinkingLevel;
  }

  get thinkingLevel(): ThinkingLevel {
    return this.level ?? DEFAULT_THINKING_LEVEL;
  }

  set thinkingLevel(level: ThinkingLevel) {
    this.level = level;
  }

  toParticipant(): Participant {
    return {
      name: this.name,
      model: this.model,
      ...(this.level ? { thinkingLevel: this.level } : {}),
    };
  }

  // Starts one turn of this agent over the shared history and returns its
  // live state. Read turn.content, iterate turn.changes(), await turn.result.
  respond(history: readonly Message[], options: TurnOptions): TurnContext {
    const turn = new TurnContext(this, options);
    this.activeTurns.add(turn);
    turn.result.finally(() => this.activeTurns.delete(turn)).catch(() => {});
    // The loop settles turn.result itself; that promise is where the outcome lives.
    getResponse(history, turn).catch(() => {});
    return turn;
  }

  // Stops every turn of this agent still running. True if there was one.
  cancel(reason?: Error): boolean {
    let cancelled = false;
    for (const turn of this.activeTurns) {
      turn.cancel(reason);
      cancelled = true;
    }
    return cancelled;
  }

  // Drops whatever the provider keeps for this agent between turns, so the
  // next turn starts afresh: after a thinking-level change or a cleared history.
  resetRuntime(): void {
    modelStrategies[this.model]?.resetRuntime?.(this.runtimeId);
  }

  // Subagents this agent has spawned. It can only see and steer its own.
  spawnSubagent(prompt: string, model: string, options: SubagentSpawnOptions): SubagentRun {
    const run = startSubagent(this, prompt, model, options);
    this.subagents.set(run.id, run);
    return run;
  }

  listSubagents(): SubagentRun[] {
    return [...this.subagents.values()];
  }

  checkSubagent(id: string, wait: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return checkSubagent(this.requireSubagent(id), wait, signal);
  }

  cancelSubagent(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return cancelSubagent(this.requireSubagent(id), signal);
  }

  describeSubagents(): Record<string, unknown>[] {
    return describeSubagents(this.listSubagents());
  }

  // Stops every working subagent of this agent. Returns how many were stopped.
  cancelSubagents(): number {
    let cancelled = 0;
    for (const run of this.subagents.values()) {
      if (run.status === 'working' && run.worker.cancel()) cancelled++;
    }
    return cancelled;
  }

  // The agent that does one subagent's work: its own provider runtime under
  // this agent's, and the subagent contract.
  createSubagent(id: string, model: string): SessionAgent {
    return new SessionAgent({
      name: 'sirus',
      model,
      runtimeId: `${this.runtimeId}/subagents/${id}`,
      subagent: true,
    });
  }

  private requireSubagent(id: string): SubagentRun {
    const run = this.subagents.get(id);
    if (run) return run;
    const known = [...this.subagents.keys()];
    throw new Error(known.length > 0
      ? `Unknown subagent "${id}". Known subagents: ${known.join(', ')}`
      : `Unknown subagent "${id}". No subagent has been spawned yet.`);
  }
}
