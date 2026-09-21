import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { abortReason, isAbortError, throwIfAborted, TurnCancelledError } from '../abort';
import type { Requester } from './permissions/approvals';
import { PERMISSION_MODE_NAMES, type PermissionMode } from './permissions/policy';
import { providerFor } from './providers';
import { DEFAULT_MODEL, VENDOR_INFO, vendorOf, type Vendor } from './providers/catalog';
import { sourceEnvironment } from './providers/profiles';
import { maskApiKey, type Source } from './providers/sources';
import { routeWorker, vendorAllowance, workerCandidates } from './router';
import {
  createRuntime,
  MODE_KINDS,
  runtimeGeneration,
  trackRuntime,
  type ModeKind,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from './runtime/runtime';
import { Transcript, transcriptText } from './session/transcript';
import { notifySubagents, type SubagentRun } from './tools/subagents';
import { describeSubagents } from './tools/subagents/report';
import { cancelSubagent, checkSubagent, messageSubagent, startSubagent } from './tools/subagents/run';
import type { SubagentHandle, SubagentHost, WorkerContext } from './tools/types';
import {
  DEFAULT_THINKING_LEVEL,
  type ImageBlock,
  type Message,
  type ThinkingLevel,
  type ToolCallBlock,
} from './types';
import type { ContextUsage } from './usage';

// The persisted shape of an agent: what a session snapshot stores and what
// the UI lists.
export interface Participant {
  name: string;
  model: string;
  // Absent in older snapshots and for untouched participants; high is the
  // default in both cases.
  thinkingLevel?: ThinkingLevel;
}

// What a participant needs from the session it belongs to, or a worker from
// the session of the agent that spawned it: everything that is the session's
// rather than the participant's.
export interface RuntimeHost {
  readonly sessionId: string;
  readonly directory: string;
  systemPrompt(agent: SessionAgent): string;
  // The Sirus MCP server entry for this agent's runtime, or null for none.
  mcpServer(agent: SessionAgent): Promise<RuntimeOptions['mcpServer']>;
  permissionMode(): PermissionMode;
  requestPermission(agent: SessionAgent, request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  // The model a subagent spawned here runs on; null means Jev picks one.
  subagentModel(): string | null;
  // The host a worker of this session runs under: its own worktree, the
  // session's mode, the subagent contract, and permission requests
  // attributed to it.
  forWorker(id: string, directory: string): RuntimeHost;
  // A worker of this session reached a terminal status. Its report goes to
  // the transcript of the agent that spawned it and starts that agent's
  // turn, the way a message from another participant does.
  workerFinished(run: SubagentRun): void;
}

export interface AgentOptions extends Participant {
  // Key for the credential bookkeeping this agent's runtime is filed under,
  // so agents sharing a Sirus session never share a row in the sidebar.
  runtimeId: string;
  host: RuntimeHost;
  // A run spawned by another agent: it gets the subagent contract in its
  // prompt and no tools for spawning further agents.
  subagentId?: string;
}

export interface TurnInput {
  text: string;
  images?: readonly ImageBlock[];
}

export interface RespondOptions {
  // The assistant entry this turn fills in. Its content is replaced on
  // every update, so whoever holds it sees the response as it arrives.
  entry: Message;
  // Entries the prompt text already carries (the user prompt, the peer
  // messages delivered for this turn), left out of the seed a new runtime
  // gets: it would read them twice.
  carried?: readonly Message[];
  // Called after every change to the entry.
  onUpdate?: () => void;
  // An outer signal the turn follows: when it aborts, the turn aborts.
  signal?: AbortSignal;
}

// One agent in a session: its identity in the chat, the model it runs on,
// its own transcript, and the vendor runtime that answers for it. Runtimes
// come and go; this stays for as long as the agent is in the session.
export class SessionAgent {
  readonly name: string;
  model: string;
  readonly runtimeId: string;
  readonly subagentId: string | null;
  readonly transcript = new Transcript();
  // The latest usage update of the live runtime, or null before the first.
  context: ContextUsage | null = null;
  // Set when the vendor could not put the session in the mode Sirus asked
  // for, so the status row can say so instead of auto silently meaning ask.
  modeNotice: string | null = null;
  private readonly host: RuntimeHost;
  private level?: ThinkingLevel;
  private runtime: Runtime | null = null;
  private generation = -1;
  // The credential the runtime is on; a source that worked stays first.
  private source: Source | null = null;
  private turn: AbortController | null = null;
  // Where the runtime's updates go: the recorder of the turn in flight, and
  // the entry it fills. The runtime outlives turns, so it is handed one
  // stable callback and this is what that callback reads.
  private record: ((update: RuntimeUpdate) => void) | null = null;
  private entry: Message | null = null;
  private readonly subagents = new Map<string, SubagentRun>();
  // MCP does not carry the vendor's tool-call id. Claiming an open row before
  // async worker setup prevents two parallel SpawnAgent requests from seeing
  // and choosing the same row.
  private readonly claimedSpawnCallIds = new Set<string>();

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.runtimeId = options.runtimeId;
    this.host = options.host;
    this.subagentId = options.subagentId ?? null;
    if (options.thinkingLevel) this.level = options.thinkingLevel;
  }

  get subagent(): boolean {
    return this.subagentId !== null;
  }

  get sessionId(): string {
    return this.host.sessionId;
  }

  get directory(): string {
    return this.host.directory;
  }

  get requester(): Requester {
    return this.subagentId ? { subagent: this.subagentId } : { participant: this.name };
  }

  get thinkingLevel(): ThinkingLevel {
    return this.level ?? DEFAULT_THINKING_LEVEL;
  }

  set thinkingLevel(level: ThinkingLevel) {
    this.level = level;
    void this.runtime?.setThinkingLevel(level).catch(() => this.resetRuntime());
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  toParticipant(): Participant {
    return {
      name: this.name,
      model: this.model,
      ...(this.level ? { thinkingLevel: this.level } : {}),
    };
  }

  // Runs one turn: the vendor runtime is prompted and everything it reports
  // lands in the entry as it arrives. Credentials are tried in order; a
  // runtime lost mid-turn is rebuilt on the next credential and reseeded from
  // this agent's own record, which already holds the work completed so far.
  async respond(input: TurnInput, options: RespondOptions): Promise<void> {
    if (this.turn) throw new Error(`@${this.name} is already responding`);
    const controller = new AbortController();
    const outer = options.signal;
    const follow = () => controller.abort(outer?.reason);
    if (outer?.aborted) follow();
    else outer?.addEventListener('abort', follow, { once: true });
    this.turn = controller;
    const { signal } = controller;
    this.entry = options.entry;
    this.record = this.recorder(options.entry, options.onUpdate);
    try {
      throwIfAborted(signal);
      const failures: string[] = [];
      let text = input.text;
      for (const source of this.candidateSources()) {
        throwIfAborted(signal);
        try {
          const { runtime, fresh } = await this.ensureRuntime(source, signal);
          const prompt = fresh ? this.seeded(text, options.carried ?? []) : text;
          await runtime.prompt({ text: prompt, images: input.images ?? [] }, signal);
          this.source = source;
          return;
        } catch (error) {
          throwIfAborted(signal);
          if (isAbortError(error)) throw error;
          this.resetRuntime();
          // A scripted runtime has no credentials to fall back to; its
          // failure is the turn's failure.
          if (!source) throw error;
          failures.push(`${describeSource(source)}: ${maskSecrets(error, this.candidateSources())}`);
          // The next attempt reads the record, partial response included.
          text = `${input.text}\n\nThe previous attempt was interrupted. Continue from the completed work above without repeating it.`;
        }
      }
      const vendor = this.vendor;
      if (failures.length === 0) {
        throw new Error(`No ${VENDOR_INFO[vendor].displayName} API key. Run /login to sign in or paste a key.`);
      }
      throw new Error(`All ${VENDOR_INFO[vendor].displayName} sources failed (${failures.length}): ${failures.join('; ')}`);
    } finally {
      outer?.removeEventListener('abort', follow);
      this.turn = null;
      this.record = null;
      this.entry = null;
    }
  }

  // Sends text into the turn this agent's runtime is running now. Rejects
  // when no turn is running or the vendor cannot take it.
  async steer(text: string): Promise<void> {
    if (!this.runtime || !this.turn) throw new Error(`@${this.name} is not running a turn`);
    await this.runtime.steer(text);
  }

  // Starts this agent's first runtime as a fork of another's live one: the
  // same adapter process and the conversation it holds, in this agent's
  // directory, on its model, with its own tools and callbacks. False when
  // there is nothing to fork or the vendor refused, and the caller then lets
  // the ordinary credential loop start a fresh runtime. A lost fork (the
  // owner's runtime was disposed) is rebuilt fresh from this agent's own
  // record, like any other lost runtime.
  async forkFrom(owner: SessionAgent): Promise<boolean> {
    const source = owner.runtime;
    if (!source || this.runtime) return false;
    try {
      const forked = await source.fork({
        directory: this.host.directory,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        systemPrompt: this.host.systemPrompt(this),
        permissionMode: this.host.permissionMode(),
        mcpServer: await this.host.mcpServer(this),
        onPermission: (request, promptSignal) => this.host.requestPermission(this, request, promptSignal),
        onUpdate: update => this.record?.(update),
      });
      this.runtime = trackRuntime(forked);
      this.generation = runtimeGeneration();
      // The fork runs on the credential the owner's process was started on,
      // so the next turn does not mistake it for a runtime on another one.
      this.source = owner.source;
      this.context = forked.context;
      return true;
    } catch {
      return false;
    }
  }

  // Stops the turn still running. True if there was one.
  cancel(reason: Error = new TurnCancelledError()): boolean {
    if (!this.turn) return false;
    this.turn.abort(reason);
    return true;
  }

  // Drops the vendor runtime so the next turn starts a new one, reseeded
  // from this agent's record: after a rewind, a cleared history, or a change
  // the running session cannot take.
  resetRuntime(): void {
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      runtime.dispose();
      this.provider?.clearActive(this.runtimeId);
    }
  }

  // Applies the model to the live runtime when its config option can take
  // it; otherwise the next turn starts a runtime on the new model.
  setModel(model: string): void {
    if (this.model === model) return;
    this.model = model;
    const runtime = this.runtime;
    if (!runtime) return;
    void runtime.setModel(model).then(applied => {
      if (!applied && this.runtime === runtime) this.resetRuntime();
    }).catch(() => {
      if (this.runtime === runtime) this.resetRuntime();
    });
  }

  // Switches the live runtime's session; the next runtime starts in the
  // session's mode anyway.
  setPermissionMode(mode: PermissionMode): void {
    const runtime = this.runtime;
    if (!runtime) return;
    void runtime.setPermissionMode(mode)
      .then(settled => this.noteMode(mode, settled))
      .catch(() => { /* the vendor keeps its mode; the notice, if any, stands */ });
  }

  private get vendor(): Vendor {
    // A model the catalog does not know is a scripted runtime bound by the
    // test suite; it needs a vendor only as a label.
    return vendorOf(this.model) ?? vendorOf(DEFAULT_MODEL)!;
  }

  private get provider() {
    return vendorOf(this.model) ? providerFor(this.vendor) : null;
  }

  // The vendor's credentials in preference order, the one this agent is on
  // first. A model with no vendor (a scripted runtime) runs on the process
  // environment.
  private candidateSources(): (Source | null)[] {
    const provider = this.provider;
    if (!provider) return [null];
    const sources = provider.sources.list();
    const current = this.source;
    if (!current) return sources;
    return [...sources.filter(source => source.id === current.id), ...sources.filter(source => source.id !== current.id)];
  }

  private async ensureRuntime(
    source: Source | null,
    signal: AbortSignal,
  ): Promise<{ runtime: Runtime; fresh: boolean }> {
    const stale = this.runtime !== null
      && (this.generation !== runtimeGeneration() || this.source?.id !== source?.id || this.runtime.model !== this.model);
    if (stale) this.resetRuntime();
    if (this.runtime) return { runtime: this.runtime, fresh: false };
    const env = source && vendorOf(this.model) ? sourceEnvironment(this.vendor, source) : { ...process.env };
    const generation = runtimeGeneration();
    const runtime = await createRuntime({
      vendor: this.vendor,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      directory: this.host.directory,
      systemPrompt: this.host.systemPrompt(this),
      env,
      mcpServer: await this.host.mcpServer(this),
      permissionMode: this.host.permissionMode(),
      onPermission: (request, promptSignal) => this.host.requestPermission(this, request, promptSignal),
      onUpdate: update => this.record?.(update),
    });
    if (signal.aborted) {
      runtime.dispose();
      throw abortReason(signal);
    }
    this.runtime = runtime;
    this.generation = generation;
    this.source = source;
    this.context = runtime.context;
    if (source) this.provider?.markActive(this.runtimeId, source);
    return { runtime, fresh: true };
  }

  // A new runtime's first prompt carries the record it has never seen, the
  // way the vendor's own conversation would have held it.
  private seeded(text: string, carried: readonly Message[]): string {
    const earlier = this.transcript.entries().filter(entry => !carried.includes(entry));
    const history = transcriptText(earlier);
    if (!history) return text;
    return ['Earlier conversation, for context:', history, '', text].join('\n');
  }

  // Everything the runtime reports lands in the entry: text and thoughts as
  // blocks, tool calls merged by id, compaction as a boundary; usage and mode
  // changes on the agent itself.
  private recorder(entry: Message, onUpdate?: () => void): (update: RuntimeUpdate) => void {
    return update => {
      switch (update.type) {
        case 'text': {
          const last = entry.content[entry.content.length - 1];
          if (last?.type === 'text' && !last.filePath) last.text += update.text;
          else entry.content.push({ type: 'text', text: update.text });
          break;
        }
        case 'thought': {
          const last = entry.content[entry.content.length - 1];
          if (last?.type === 'thought') last.text += update.text;
          else entry.content.push({ type: 'thought', text: update.text });
          break;
        }
        case 'tool_call': {
          const index = entry.content.findIndex(
            (block): block is ToolCallBlock => block.type === 'tool_call' && block.id === update.call.id,
          );
          if (index === -1) entry.content.push(update.call);
          else entry.content[index] = update.call;
          break;
        }
        case 'compaction': {
          if (update.status === 'in_progress') return;
          if (update.status !== 'completed') return;
          entry.content.push({ type: 'compaction', ...(update.summary ? { summary: update.summary } : {}) });
          break;
        }
        case 'context':
          this.context = update.usage;
          break;
        case 'mode':
          this.noteMode(this.host.permissionMode(), update);
          break;
      }
      onUpdate?.();
    };
  }

  private noteMode(requested: PermissionMode, settled: { modeId: string; kind: ModeKind | null }): void {
    const honoured = settled.kind === null || settled.kind === MODE_KINDS[requested];
    const mode = this.runtime?.modes.find(candidate => candidate.id === settled.modeId);
    this.modeNotice = honoured
      ? null
      : `${PERMISSION_MODE_NAMES[requested]} is unavailable on ${this.model}; the agent is on ${mode?.name ?? settled.modeId}`;
  }

  // Workers this agent has spawned. It can only see and steer its own.
  // Spawning returns once the worker is on its way: it runs in the
  // background and reports back when it ends.
  async spawnSubagent(prompt: string, context: WorkerContext, callId?: string): Promise<SubagentRun> {
    try {
      const run = await startSubagent(this, prompt, {
        ...await this.workerModel(prompt),
        context,
        ...(callId ? { callId } : {}),
      });
      this.subagents.set(run.id, run);
      notifySubagents();
      return run;
    } finally {
      if (callId) this.claimedSpawnCallIds.delete(callId);
    }
  }

  // The model and thinking level a worker of this agent runs on: the
  // session's fixed subagent model with this agent's level, or Jev's pick
  // for the task. Jev is advisory — no key, no answer, an unsure answer or
  // an error all leave the worker on this agent's own model and level.
  private async workerModel(prompt: string): Promise<{ model: string; thinkingLevel: ThinkingLevel }> {
    const own = { model: this.model, thinkingLevel: this.thinkingLevel };
    const fixed = this.host.subagentModel();
    if (fixed) return { model: fixed, thinkingLevel: this.thinkingLevel };
    // A model the catalog does not know is a scripted runtime bound by the
    // test suite: there is nothing to route between, and a pick would move
    // the worker onto a real vendor with whatever key the machine holds.
    if (!vendorOf(this.model)) return own;
    try {
      const pick = await routeWorker(
        { task: prompt, directory: this.directory },
        workerCandidates(),
        vendorAllowance(),
        { fallbackLevel: this.thinkingLevel },
      );
      return pick ?? own;
    } catch {
      return own;
    }
  }

  // A run this agent owned in an earlier process, restored from the session
  // file as a record and nothing more.
  adoptSubagent(run: SubagentRun): void {
    this.subagents.set(run.id, run);
  }

  listSubagents(): SubagentRun[] {
    return [...this.subagents.values()];
  }

  describeSubagents(): Record<string, unknown>[] {
    return describeSubagents(this.listSubagents());
  }

  // The oldest open SpawnAgent row not yet claimed by a worker. Parallel MCP
  // requests arrive in the same order as the vendor's rows; claiming before
  // the first await keeps each request on its own row. The MCP request carries
  // no vendor call id, and the chat decorates the row by it.
  private openSpawnCallId(): string | undefined {
    const taken = new Set([...this.subagents.values()].map(run => run.callId));
    for (const callId of this.claimedSpawnCallIds) taken.add(callId);
    const blocks = this.entry?.content ?? [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (block.type !== 'tool_call' || taken.has(block.id)) continue;
      if (block.status === 'completed' || block.status === 'failed') continue;
      if (/(?:^|[^A-Za-z0-9])SpawnAgent\s*$/.test(block.title)) {
        this.claimedSpawnCallIds.add(block.id);
        return block.id;
      }
    }
    return undefined;
  }

  // The agent's own delegation, as the narrow port the agent tools speak to
  // over the MCP server. A worker outlives the tool call that started it:
  // the call's signal ends with its request, and stopping a worker is
  // CancelAgent, the /agents panel, or deleting the session.
  subagentHost(): SubagentHost {
    return {
      spawn: async (prompt, context, call): Promise<SubagentHandle> => {
        const callId = this.openSpawnCallId();
        const run = await this.spawnSubagent(prompt, context, callId ?? call.callId);
        return {
          id: run.id,
          model: run.model,
          thinkingLevel: run.thinkingLevel,
          status: run.status,
          branch: run.branch,
          context: run.context,
        };
      },
      check: id => checkSubagent(this.requireSubagent(id)),
      cancel: (id, signal) => cancelSubagent(this.requireSubagent(id), signal),
      message: (id, text) => messageSubagent(this.requireSubagent(id), text),
      list: () => this.describeSubagents(),
    };
  }

  // A worker of this agent ended: the session delivers its report here.
  workerFinished(run: SubagentRun): void {
    this.host.workerFinished(run);
  }

  // The agent that does one worker's work: its own runtime and record under
  // this agent's session, in its own directory, with the subagent contract.
  createSubagent(id: string, model: string, thinkingLevel: ThinkingLevel, directory: string): SessionAgent {
    return new SessionAgent({
      name: 'sirus',
      model,
      thinkingLevel,
      runtimeId: `${this.runtimeId}/subagents/${id}`,
      host: this.host.forWorker(id, directory),
      subagentId: id,
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

function describeSource(source: Source | null): string {
  if (!source) return 'process environment';
  return source.kind === 'api' ? `API ${maskApiKey(source.key)}` : `subscription ${source.label ?? source.id}`;
}

// A failure message must not carry a key it was handed.
function maskSecrets(error: unknown, sources: readonly (Source | null)[]): string {
  const detail = error instanceof Error ? error.message : String(error);
  return sources.reduce((text, source) => source?.kind === 'api'
    ? text.replaceAll(source.key, maskApiKey(source.key))
    : text, detail);
}
