import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { abortReason, errorMessage, isAbortError, throwIfAborted, TurnCancelledError } from '../abort';
import type { Requester } from './permissions/approvals';
import { PERMISSION_MODE_NAMES } from './permissions/policy';
import { providerFor } from './providers';
import { DEFAULT_MODEL, rememberListedModels, VENDOR_INFO, vendorOf, type Vendor } from './providers/catalog';
import { sourceEnvironment } from './providers/profiles';
import { maskApiKey, maskKeys, type Source } from './providers/sources';
import { routeWorker, vendorAllowance, workerCandidates } from './router';
import {
  createRuntime,
  MODE_KINDS,
  runtimeGeneration,
  trackRuntime,
  type ForkOptions,
  type ModeKind,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from './runtime/runtime';
import { rememberNativeCommands } from './runtime/commands';
import { Transcript, transcriptText } from './session/transcript';
import { isSpawnAgentTitle } from './tools/agents';
import { notifySubagents, type SubagentRun } from './tools/subagents';
import { describeSubagents } from './tools/subagents/report';
import { cancelSubagent, checkSubagent, messageSubagent, startSubagent } from './tools/subagents/run';
import type { SubagentHandle, SubagentHost } from './tools/types';
import {
  DEFAULT_PARTICIPANT,
  DEFAULT_THINKING_LEVEL,
  failOpenToolCalls,
  isPlanCall,
  planCall,
  type ImageBlock,
  type Message,
  type PermissionMode,
  type ThinkingLevel,
  type ToolCallBlock,
  type WorkerContext,
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
  requestAnswers(agent: SessionAgent, request: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse>;
  // The model a subagent spawned here runs on; null lets Jev pick one, and
  // without a key or an answer from Jev the worker runs on its owner's.
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
  // When the runtime last reported anything, and how many of its approvals
  // and questions are waiting on the user: the turn is quiet, not stuck,
  // while one is.
  private heardAt = 0;
  private asking = 0;
  // Where the runtime's updates go: the recorder of the turn in flight, and
  // the entry it fills. The runtime outlives turns, so it is handed one
  // stable callback and this is what that callback reads.
  private record: ((update: RuntimeUpdate) => void) | null = null;
  private entry: Message | null = null;
  private readonly subagents = new Map<string, SubagentRun>();
  // Spawns whose run does not exist yet: Jev's pick, the worktree and the
  // fork come first. The session counts them as working, since the worker
  // starts from the record as it stands then, and a session deleted
  // meanwhile waits for them so it can stop what they started.
  private readonly settingUp = new Set<Promise<SubagentRun>>();
  // Rows claimed by a SpawnAgent request whose worker is still being set up,
  // so two parallel requests never choose the same row.
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

  // A live runtime that cannot take the level is rebuilt on it, unless it
  // has been replaced by the time the vendor says so, as with `setModel`.
  set thinkingLevel(level: ThinkingLevel) {
    this.level = level;
    const runtime = this.runtime;
    if (!runtime) return;
    void runtime.setThinkingLevel(level).catch(() => {
      if (this.runtime === runtime) this.resetRuntime();
    });
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  // How long the turn in flight has gone without a word from its runtime:
  // no text, no tool call update, nothing. Zero when no turn is running or
  // the turn is waiting on the user's approval.
  get quietFor(): number {
    if (!this.turn || this.asking > 0) return 0;
    return Date.now() - this.heardAt;
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
    this.heardAt = Date.now();
    const { signal } = controller;
    this.entry = options.entry;
    this.record = this.recorder(options.entry, options.onUpdate);
    let answered = false;
    try {
      throwIfAborted(signal);
      const failures: string[] = [];
      let text = input.text;
      for (const source of this.candidateSources()) {
        throwIfAborted(signal);
        try {
          const { runtime, fresh } = await this.ensureRuntime(source, signal);
          const prompt = fresh ? this.seeded(text, options.carried ?? []) : { text };
          await runtime.prompt({ ...prompt, images: input.images ?? [] }, signal);
          this.source = source;
          answered = true;
          return;
        } catch (error) {
          throwIfAborted(signal);
          if (isAbortError(error)) throw error;
          this.resetRuntime();
          // A scripted runtime has no credentials to fall back to; its
          // failure is the turn's failure.
          if (!source) throw error;
          // A failure message must not carry a key it was handed.
          failures.push(`${describeSource(source)}: ${maskKeys(errorMessage(error), this.candidateSources())}`);
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
      // A turn that was cancelled or failed reports nothing more: updates
      // arriving after this are dropped, so a call it left open would read
      // as running for good.
      if (!answered && failOpenToolCalls(options.entry.content)) options.onUpdate?.();
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
      const forked = await source.fork(await this.runtimeOptions());
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
      .then(settled => this.noteMode(mode, settled, false))
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
      && (this.runtime.lost
        || this.generation !== runtimeGeneration()
        || this.source?.id !== source?.id
        || this.runtime.model !== this.model);
    if (stale) this.resetRuntime();
    if (this.runtime) return { runtime: this.runtime, fresh: false };
    const env = source && vendorOf(this.model) ? sourceEnvironment(this.vendor, source) : { ...process.env };
    const generation = runtimeGeneration();
    const runtime = await createRuntime({ ...await this.runtimeOptions(), vendor: this.vendor, env }, signal);
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

  // What every runtime of this agent is opened with, started fresh or forked:
  // where and on what it runs, the session's prompt, mode and tools, and the
  // callbacks that bring what it reports and escalates back to this agent.
  private async runtimeOptions(): Promise<ForkOptions> {
    return {
      directory: this.host.directory,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.host.systemPrompt(this),
      permissionMode: this.host.permissionMode(),
      mcpServer: await this.host.mcpServer(this),
      onPermission: (request, promptSignal) => this.askPermission(request, promptSignal),
      onElicitation: (request, promptSignal) => this.askUser(request, promptSignal),
      onUpdate: update => this.hear(update),
    };
  }

  private hear(update: RuntimeUpdate): void {
    this.heardAt = Date.now();
    // The vendor's commands are the menu's, whether or not a turn is running.
    // A worker's are its worktree's, which the menu never asks about.
    if (update.type === 'commands') {
      const vendor = vendorOf(this.model);
      if (vendor && !this.subagentId) rememberNativeCommands(vendor, this.host.directory, update.commands);
      return;
    }
    // So are its models, which `/model` lists.
    if (update.type === 'models') {
      const vendor = vendorOf(this.model);
      if (vendor) rememberListedModels(vendor, update.models);
      return;
    }
    this.record?.(update);
  }

  private askPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    return this.waitOnUser(() => this.host.requestPermission(this, request, signal));
  }

  private askUser(request: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse> {
    return this.waitOnUser(() => this.host.requestAnswers(this, request, signal));
  }

  // Time the turn spends waiting on the user is not silence.
  private async waitOnUser<T>(ask: () => Promise<T>): Promise<T> {
    this.asking++;
    try {
      return await ask();
    } finally {
      this.asking--;
      this.heardAt = Date.now();
    }
  }

  // A new runtime's first prompt carries the record it has never seen, the
  // way the vendor's own conversation would have held it. A slash command
  // must stay the prompt's own text for the vendor to read it as one, so the
  // record goes ahead of it as context instead.
  private seeded(text: string, carried: readonly Message[]): { text: string; context?: string } {
    const earlier = this.transcript.entries().filter(entry => !carried.includes(entry));
    const history = transcriptText(earlier);
    if (!history) return { text };
    const seed = ['Earlier conversation, for context:', history].join('\n');
    return text.startsWith('/') ? { text, context: seed } : { text: [seed, '', text].join('\n') };
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
        case 'plan': {
          // Each change shows where the turn is now, as the vendors' own
          // terminals show it, unless nothing came since the last one.
          const last = entry.content.length - 1;
          const previous = entry.content[last];
          if (previous?.type === 'tool_call' && isPlanCall(previous)) entry.content[last] = planCall(update.entries, previous.id);
          else entry.content.push(planCall(update.entries));
          break;
        }
        case 'compaction': {
          if (update.status !== 'completed') return;
          entry.content.push({ type: 'compaction', ...(update.summary ? { summary: update.summary } : {}) });
          break;
        }
        case 'context':
          this.context = update.usage;
          break;
        case 'mode':
          this.noteMode(this.host.permissionMode(), update, true);
          break;
      }
      onUpdate?.();
    };
  }

  // Says when the agent's mode is not the session's: either the vendor could
  // not take the one asked for (the model lacks it, or the user's settings
  // switch it off), or the agent moved on its own, as Claude does to the
  // mode picked when a plan is approved.
  private noteMode(
    requested: PermissionMode,
    settled: { modeId: string; kind: ModeKind | null },
    byVendor: boolean,
  ): void {
    const honoured = settled.kind === null || settled.kind === MODE_KINDS[requested];
    const mode = this.runtime?.modes.find(candidate => candidate.id === settled.modeId)?.name ?? settled.modeId;
    if (honoured) this.modeNotice = null;
    else if (byVendor) this.modeNotice = `@${this.name} switched to ${mode}; the session is on ${PERMISSION_MODE_NAMES[requested]}`;
    else this.modeNotice = `${PERMISSION_MODE_NAMES[requested]} is unavailable to @${this.name}, which is on ${mode}`;
  }

  // Workers this agent has spawned. It can only see and steer its own.
  // Spawning returns once the worker is on its way: it runs in the
  // background and reports back when it ends.
  async spawnSubagent(prompt: string, context: WorkerContext, callId?: string): Promise<SubagentRun> {
    const setUp = this.workerModel(prompt).then(settled => startSubagent(this, prompt, {
      ...settled,
      context,
      ...(callId ? { callId } : {}),
    }));
    this.settingUp.add(setUp);
    try {
      const run = await setUp;
      this.subagents.set(run.id, run);
      notifySubagents();
      return run;
    } finally {
      this.settingUp.delete(setUp);
      if (callId) this.claimedSpawnCallIds.delete(callId);
    }
  }

  // How many of this agent's spawns are still setting up their worker.
  get spawningSubagents(): number {
    return this.settingUp.size;
  }

  // Resolves once none of this agent's spawns is still being set up, however
  // they ended. A run that was set up is in `listSubagents` by then.
  async spawnsSettled(): Promise<void> {
    while (this.settingUp.size > 0) await Promise.allSettled([...this.settingUp]);
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

  // The SpawnAgent row a request belongs to, which the chat decorates with
  // the run. Claude names it in the request. Codex does not, so its request
  // takes the oldest open SpawnAgent row not yet claimed, on the grounds that
  // parallel requests arrive in the order of their rows; claiming before the
  // first await keeps each request on its own row.
  private spawnCallId(vendorCallId: string | undefined): string | undefined {
    if (vendorCallId) {
      this.claimedSpawnCallIds.add(vendorCallId);
      return vendorCallId;
    }
    return this.openSpawnCallId();
  }

  private openSpawnCallId(): string | undefined {
    const taken = new Set([...this.subagents.values()].map(run => run.callId));
    for (const callId of this.claimedSpawnCallIds) taken.add(callId);
    const blocks = this.entry?.content ?? [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (block.type !== 'tool_call' || taken.has(block.id)) continue;
      if (block.status === 'completed' || block.status === 'failed') continue;
      if (isSpawnAgentTitle(block.title)) {
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
        const callId = this.spawnCallId(call.vendorCallId);
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
      name: DEFAULT_PARTICIPANT,
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
