import { createHash } from 'crypto';
import { statSync } from 'fs';
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { abortable, abortReason, errorMessage, isAbortError, throwIfAborted, TurnCancelledError } from '../abort';
import type { Requester } from './permissions/approvals';
import { PERMISSION_MODE_NAMES } from './permissions/policy';
import { providerFor } from './providers';
import { DEFAULT_MODEL, rememberListedModels, VENDOR_INFO, vendorOf, type Vendor } from './providers/catalog';
import { sourceEnvironment, sourceProfileHome } from './providers/profiles';
import { maskKeys, type Source } from './providers/sources';
import { turnFailure, type TurnFailure } from './runtime/errors';
import {
  createRuntime,
  MODE_KINDS,
  runtimeGeneration,
  trackRuntime,
  type BackgroundTask,
  type ModeKind,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from './runtime/runtime';
import { rememberNativeCommands } from './runtime/commands';
import { Transcript, transcriptText } from './session/transcript';
import { isSpawnAgentTitle } from './tools/agents';
import { notifySubagents, type SubagentRun } from './tools/subagents';
import { agentDefinitions, definitionModel, readOnlyTools, type AgentDefinition } from './tools/subagents/definitions';
import { describeSubagents, workerName, workerReport } from './tools/subagents/report';
import { awaitForeground, cancelSubagent, checkSubagent, messageSubagent, startSubagent, TOOL_WAIT_LIMIT_MS, waitSubagents } from './tools/subagents/run';
import type { SpawnOptions, SubagentHost } from './tools/types';
import {
  DEFAULT_PARTICIPANT,
  DEFAULT_THINKING_LEVEL,
  failOpenToolCalls,
  isPlanCall,
  planCall,
  type ImageBlock,
  type Message,
  type NativeSession,
  type NoticeBlock,
  type PermissionMode,
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
  nativeSession?: NativeSession;
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
  // A notice received between turns has no transcript entry to sit in.
  notice(agent: SessionAgent, notice: NoticeBlock): void;
  // The user’s subagent model pin; null leaves the choice to the caller.
  subagentModel(): string | null;
  // The host a worker of this session runs under: its own worktree, the
  // session's mode, the subagent contract, and permission requests
  // attributed to it.
  forWorker(id: string, directory: string): RuntimeHost;
  // A worker reached a terminal status. Foreground results return through
  // the call; background results notify the owner, in its current turn or a
  // new one.
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
  definition?: AgentDefinition;
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
  private readonly definition?: AgentDefinition;
  private readonly pendingNames = new Set<string>();
  private level?: ThinkingLevel;
  private runtime: Runtime | null = null;
  private opening: { controller: AbortController; promise: Promise<Runtime>; model: string; source: string } | null = null;
  private seededRuntime = false;
  private generation = runtimeGeneration();
  private savedSession?: NativeSession;
  // The credential the runtime is on; a source that worked stays first.
  private source: Source | null = null;
  private turn: AbortController | null = null;
  // When the runtime last reported anything, and how many of its approvals
  // and questions are waiting on the user: the turn is quiet, not stuck,
  // while one is.
  private heardAt = 0;
  private asking = 0;
  private limitResetsAt: number | undefined;
  // Where the runtime's updates go: the recorder of the turn in flight, and
  // the entry it fills. The runtime outlives turns, so it is handed one
  // stable callback and this is what that callback reads.
  private record: ((update: RuntimeUpdate) => void) | null = null;
  private entry: Message | null = null;
  private readonly subagents = new Map<string, SubagentRun>();
  private readonly backgroundTasks = new Map<string, BackgroundTask>();
  // Spawns whose run does not exist yet: the worktree and the fork come
  // first. The session counts them as working, since the worker starts from
  // the record as it stands then, and a session deleted meanwhile waits for
  // them so it can stop what they started.
  private readonly settingUp = new Set<Promise<SubagentRun>>();
  // Rows claimed by a SpawnAgent request whose worker is still being set up,
  // so two parallel requests never choose the same row.
  private readonly claimedSpawnCallIds = new Set<string>();

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.runtimeId = options.runtimeId;
    this.host = options.host;
    this.definition = options.definition;
    this.subagentId = options.subagentId ?? null;
    if (options.thinkingLevel) this.level = options.thinkingLevel;
    if (options.nativeSession) this.restoreNativeSession(options.nativeSession);
  }

  get nativeSession(): NativeSession | undefined {
    // Invalidating the system prompt also invalidates idle persisted handles.
    if (this.generation !== runtimeGeneration()) return undefined;
    return this.savedSession ? { ...this.savedSession } : undefined;
  }

  restoreNativeSession(session: NativeSession): void {
    this.savedSession = { ...session };
    this.generation = runtimeGeneration();
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
      if (this.runtime === runtime) this.releaseRuntime();
    });
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  get activeReply(): Message | null {
    return this.entry;
  }

  // How long the turn in flight has gone without a word from its runtime:
  // no text, no tool call update, nothing. Zero when no turn is running, the
  // turn is waiting on the user's approval, or one of its tool calls is still
  // running: a long build or test run is quiet, not stuck, and the vendor's
  // own tool timeouts bound it.
  get quietFor(): number {
    if (!this.turn || this.asking > 0) return 0;
    if (this.entry?.content.some(block => block.type === 'tool_call'
      && (block.status === 'pending' || block.status === 'in_progress'))) return 0;
    return Date.now() - this.heardAt;
  }

  toParticipant(): Participant {
    return {
      name: this.name,
      model: this.model,
      ...(this.level ? { thinkingLevel: this.level } : {}),
      ...(this.nativeSession ? { nativeSession: this.nativeSession } : {}),
    };
  }

  // Runs one turn: the vendor runtime is prompted and everything it reports
  // lands in the entry as it arrives. Credentials are tried in order; a
  // runtime lost mid-turn is retried once on the same credential, reopening
  // its durable session before falling back to the next credential.
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
      let failure: TurnFailure | undefined;
      let retried = false;
      let text = input.text;
      for (const source of this.candidateSources()) {
        let retry: boolean;
        do {
          retry = false;
          throwIfAborted(signal);
          try {
            const { runtime, fresh } = await this.ensureRuntime(source, signal);
            const prompt = fresh ? this.seeded(text, options.carried ?? []) : { text };
            this.seededRuntime = true;
            const result = await runtime.prompt({ ...prompt, images: input.images ?? [] }, signal);
            if (result.stopReason === 'refusal') throw new Error('Vendor refused the request');
            this.source = source;
            answered = true;
            return;
          } catch (error) {
            throwIfAborted(signal);
            if (isAbortError(error)) throw error;
            failure = turnFailure(error, this.vendor, this.name, this.limitResetsAt);
            // A failure message must not carry a key it was handed.
            failure.message = maskKeys(failure.message, [source, ...this.candidateSources()]);
            this.releaseRuntime();
            failOpenToolCalls(options.entry.content);
            if (failure.kind === 'crash' && !retried) {
              retried = true;
              retry = true;
              this.record?.({ type: 'notice', severity: 'info', title: `${VENDOR_INFO[this.vendor].displayName} adapter stopped; retrying once.` });
            }
            // The next attempt reads the record, partial response included.
            text = `${input.text}\n\nThe previous attempt was interrupted. Continue from the completed work above without repeating it.`;
          }
        } while (retry);
      }
      const vendor = this.vendor;
      if (!failure) {
        throw new Error(`No ${VENDOR_INFO[vendor].displayName} credentials. Run /login to connect a Claude or ChatGPT subscription, or add an API key.`);
      }
      throw new Error(failure.message);
    } catch (error) {
      if (!signal.aborted && !isAbortError(error)) {
        this.record?.({ type: 'notice', severity: 'error', title: errorMessage(error) });
      }
      throw error;
    } finally {
      outer?.removeEventListener('abort', follow);
      // A turn that was cancelled or failed reports nothing more: updates
      // arriving after this are dropped, so a call it left open would read
      // as running for good.
      if (!answered && this.opening) this.releaseRuntime();
      if (!answered && failOpenToolCalls(options.entry.content)) options.onUpdate?.();
      this.turn = null;
      this.record = null;
      this.entry = null;
    }
  }

  // Sends text into the turn this agent's runtime is running now. Rejects
  // when no turn is running or the vendor cannot take it.
  async steer(text: string): Promise<void> {
    // Spawn returns before the adapter finishes opening. A message sent
    // immediately afterwards still belongs to that first turn.
    while (this.turn && !this.runtime) await new Promise(resolve => setTimeout(resolve, 10));
    if (!this.runtime || !this.turn) throw new Error(`@${this.name} is not running a turn`);
    await this.runtime.steer(text);
  }

  // Starts this agent's first runtime as a fork of another's live one: the
  // same adapter process and the conversation it holds, in this agent's
  // directory, on its model, with its own tools and callbacks. False when
  // there is nothing to fork or the vendor refused, and the caller then lets
  // the ordinary credential loop start a fresh runtime. A lost fork (the
  // owner's runtime was disposed) reopens its own durable session on the
  // next turn, like any other lost runtime.
  async forkFrom(owner: SessionAgent): Promise<boolean> {
    const source = owner.runtime;
    if (!source || this.runtime || this.vendor !== owner.vendor) return false;
    // Codex config is per process, so a definition with a different tool
    // policy needs a fresh runtime seeded with the owner's record.
    if (this.vendor === 'gpt' && this.definition?.tools !== undefined) return false;
    try {
      const forked = await source.fork({
        directory: this.host.directory,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        systemPrompt: this.systemPrompt(),
        tools: this.definition?.tools,
        readOnly: readOnlyTools(this.definition?.tools),
        permissionMode: this.host.permissionMode(),
        mcpServer: await this.host.mcpServer(this),
        onPermission: (request, promptSignal) => this.askPermission(request, promptSignal),
        onElicitation: (request, promptSignal) => this.askUser(request, promptSignal),
        onUpdate: update => this.hear(update),
      });
      this.runtime = trackRuntime(forked);
      this.generation = runtimeGeneration();
      // The fork runs on the credential the owner's process was started on,
      // so the next turn does not mistake it for a runtime on another one.
      this.source = owner.source;
      this.context = forked.context;
      this.seededRuntime = true;
      this.saveNativeSession(forked, owner.source, owner.savedSession?.profileHome);
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
    this.savedSession = undefined;
    this.releaseRuntime();
  }

  // Process loss leaves its durable vendor session available for recovery.
  private releaseRuntime(): void {
    this.opening?.controller.abort(new TurnCancelledError());
    this.opening = null;
    const runtime = this.runtime;
    this.runtime = null;
    this.seededRuntime = false;
    this.context = null;
    this.limitResetsAt = undefined;
    for (const task of this.backgroundTasks.values()) {
      if (task.state === 'running' || task.state === 'paused') {
        this.hear({ type: 'async_task', task: { ...task, state: 'stopped', canStop: false } });
      }
    }
    if (runtime) {
      runtime.dispose();
      this.provider?.clearActive(this.runtimeId);
    }
  }

  // Applies the model to the live runtime when its config option can take
  // it; otherwise the next turn starts a runtime on the new model.
  setModel(model: string): void {
    if (this.model === model) return;
    const previousVendor = this.vendor;
    const warn = () => {
      if (this.transcript.entries().length) this.host.notice(this, {
        type: 'notice', severity: 'warning',
        title: `Switching @${this.name} to ${model} restarts its session; it keeps the conversation as text.`,
      });
    };
    if (this.opening || vendorOf(model) !== previousVendor) {
      if (this.runtime) warn();
      this.resetRuntime();
    }
    this.model = model;
    const runtime = this.runtime;
    if (!runtime) {
      this.savedSession = undefined;
      return;
    }
    if (runtime.vendor !== this.vendor) {
      this.resetRuntime();
      return;
    }
    void runtime.setModel(model).then(applied => {
      if (!applied && this.runtime === runtime && this.model === model) { this.resetRuntime(); warn(); }
    }).catch(() => {
      if (this.runtime === runtime && this.model === model) { this.resetRuntime(); warn(); }
    });
  }

  // Switches the live runtime's session; the next runtime starts in the
  // session's mode anyway.
  setPermissionMode(mode: PermissionMode): void {
    const runtime = this.runtime;
    if (!runtime) return;
    if (this.vendor === 'gpt' && readOnlyTools(this.definition?.tools)) mode = 'ask';
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
    const currentId = this.source?.id ?? this.savedSession?.sourceId;
    if (!currentId) return sources;
    return [...sources.filter(source => source.id === currentId), ...sources.filter(source => source.id !== currentId)];
  }

  // Opening is shared with the first prompt. A replaced draft cannot adopt
  // a late runtime from its old model or credential.
  async warmup(): Promise<void> {
    if (this.busy) return;
    const source = (this.provider?.sources.list() ?? this.candidateSources())[0];
    if (source === undefined) { this.resetRuntime(); return; }
    await this.ensureRuntime(source, new AbortController().signal);
  }

  releaseWarmup(): void {
    if (!this.busy && !this.seededRuntime && (this.runtime || this.opening)) this.resetRuntime();
  }

  private async ensureRuntime(
    source: Source | null,
    signal: AbortSignal,
  ): Promise<{ runtime: Runtime; fresh: boolean }> {
    const identity = JSON.stringify(source);
    const systemPrompt = this.systemPrompt();
    const promptHash = createHash('sha256').update(systemPrompt).digest('hex');
    if (this.generation !== runtimeGeneration()
      || (this.savedSession?.systemPromptHash && this.savedSession.systemPromptHash !== promptHash)
      || (this.runtime && this.runtime.model !== this.model)) {
      this.resetRuntime();
    } else if (this.runtime?.lost || (this.runtime && JSON.stringify(this.source) !== identity)
      || (this.opening && (this.opening.model !== this.model || this.opening.source !== identity))) {
      this.releaseRuntime();
    }
    if (this.runtime) return { runtime: this.runtime, fresh: !this.seededRuntime };
    if (!this.opening) {
      const controller = new AbortController();
      const model = this.model;
      const vendor = this.vendor;
      const generation = runtimeGeneration();
      // A new opening belongs to the current generation, including when a
      // first prompt joins a draft warmup after system-prompt invalidation.
      this.generation = generation;
      const opening = {
        controller, model, source: identity,
        promise: null as unknown as Promise<Runtime>,
      };
      this.opening = opening;
      opening.promise = (async () => {
        const profileHome = sourceProfileHome(vendor, source);
        let resume = this.savedSession;
        if (resume) {
          const reason = resume.vendor !== vendor ? 'the model uses another vendor'
            : resume.sourceId !== null && !this.candidateSources().some(candidate => candidate?.id === resume!.sourceId)
              ? 'the saved credential is no longer available'
            : resume.profileHome !== profileHome ? 'the credential uses a different profile home'
            : !isDirectory(resume.profileHome) ? 'the saved profile home is missing'
            : !isDirectory(resume.directory) ? 'the saved session directory is missing'
            : undefined;
          if (reason) {
            this.resumeFallback(reason);
            resume = undefined;
          }
        }
        const mcpServer = await this.host.mcpServer(this);
        throwIfAborted(controller.signal);
        const thinkingLevel = this.thinkingLevel;
        const permissionMode = this.host.permissionMode();
        const options: RuntimeOptions = {
          vendor, model,
          signal: controller.signal,
          thinkingLevel,
          directory: this.host.directory,
          systemPrompt,
          tools: this.definition?.tools,
          readOnly: readOnlyTools(this.definition?.tools),
          env: source && vendorOf(model) ? sourceEnvironment(vendor, source) : { ...process.env },
          mcpServer,
          permissionMode,
          onPermission: (request, promptSignal) => this.askPermission(request, promptSignal),
          onElicitation: (request, promptSignal) => this.askUser(request, promptSignal),
          onUpdate: update => { if (!controller.signal.aborted) this.hear(update); },
        };
        let runtime: Runtime;
        if (resume) {
          try {
            runtime = await createRuntime({ ...options, resume });
          } catch (error) {
            throwIfAborted(controller.signal);
            this.resumeFallback(maskKeys(errorMessage(error), this.candidateSources()));
            resume = undefined;
            runtime = await createRuntime(options);
          }
        } else {
          runtime = await createRuntime(options);
        }
        try {
          if (permissionMode !== this.host.permissionMode()) {
            const mode = vendor === 'gpt' && readOnlyTools(this.definition?.tools) ? 'ask' : this.host.permissionMode();
            this.noteMode(mode, await runtime.setPermissionMode(mode), false);
          }
          if (thinkingLevel !== this.thinkingLevel) await runtime.setThinkingLevel(this.thinkingLevel);
        } catch (error) {
          runtime.dispose();
          throw error;
        }
        if (controller.signal.aborted || generation !== runtimeGeneration()) {
          runtime.dispose();
          throw abortReason(controller.signal);
        }
        this.runtime = runtime;
        this.generation = generation;
        this.source = source;
        this.context = runtime.context;
        this.seededRuntime = !!resume;
        this.saveNativeSession(runtime, source, profileHome, resume?.directory);
        if (source) this.provider?.markActive(this.runtimeId, source);
        return runtime;
      })().finally(() => { if (this.opening === opening) this.opening = null; });
    }
    const runtime = await abortable(this.opening.promise, signal);
    return { runtime, fresh: !this.seededRuntime };
  }

  private saveNativeSession(runtime: Runtime, source: Source | null, profileHome?: string, directory?: string): void {
    this.savedSession = runtime.sessionId ? {
      vendor: runtime.vendor,
      sessionId: runtime.sessionId,
      directory: directory ?? this.host.directory,
      sourceId: source?.id ?? null,
      profileHome: profileHome ?? sourceProfileHome(runtime.vendor, source),
      systemPromptHash: createHash('sha256').update(this.systemPrompt()).digest('hex'),
    } : undefined;
  }

  private resumeFallback(reason: string): void {
    this.savedSession = undefined;
    this.hear({
      type: 'notice', severity: 'warning', title: 'Starting fresh with a conversation recap',
      description: `Could not reopen the vendor session: ${reason.replace(/\s+/g, ' ').slice(0, 240)}`,
    });
  }

  private hear(update: RuntimeUpdate): void {
    this.heardAt = Date.now();
    if (update.type === 'rate_limit') {
      this.limitResetsAt = update.resetsAt;
      return;
    }
    if (update.type === 'async_task') {
      const task = update.task;
      const previous = this.backgroundTasks.get(task.id);
      this.backgroundTasks.set(task.id, task);
      if (!previous || previous.state !== task.state) {
        const notice: NoticeBlock = {
          type: 'notice', severity: task.state === 'failed' ? 'error' : 'info',
          title: `Background task ${task.id} ${task.state}: ${task.name}`,
          description: task.summary ?? `Use /tasks @${this.subagentId ?? this.name} ${task.id} to inspect it.`,
        };
        if (!this.record) {
          const reply = [...this.transcript.entries()].reverse().find(entry => entry.role === 'assistant' && entry.participant === this.name);
          reply?.content.push(notice);
        }
        this.hear(notice);
      }
      return;
    }
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
    if (update.type === 'notice' && !this.record) {
      this.host.notice(this, update);
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
        case 'notice':
          entry.content.push(update);
          break;
        case 'tool_call': {
          const run = this.listSubagents().find(run => run.callId === update.call.id && run.status !== 'working');
          if (run) update.call.output = workerReport(run);
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

  async spawnSubagent(prompt: string, options: SpawnOptions = {}, callId?: string): Promise<SubagentRun> {
    const name = options.name;
    if (name && (this.pendingNames.has(name) || this.listSubagents().some(run => run.name === name || run.id === name))) {
      if (callId) this.claimedSpawnCallIds.delete(callId);
      throw new Error(`Subagent name "${name}" is already in use.`);
    }
    if (name) this.pendingNames.add(name);
    let setUp: Promise<SubagentRun> | undefined;
    try {
      const definitions = agentDefinitions(this.directory);
      const definition = options.agentType ? definitions.find(entry => entry.name === options.agentType) : undefined;
      if (options.agentType && !definition) throw new Error(`Unknown agent type "${options.agentType}". Available: ${definitions.map(entry => entry.name).join(', ') || '(none)'}`);
      setUp = startSubagent(this, prompt, {
        ...options, definition,
        model: this.host.subagentModel() ?? options.model ?? definitionModel(definition?.model, this.model),
        thinkingLevel: options.thinkingLevel ?? definition?.thinkingLevel ?? this.thinkingLevel,
        ...(callId ? { callId } : {}),
      });
      this.settingUp.add(setUp);
      const run = await setUp;
      this.subagents.set(run.id, run);
      notifySubagents();
      return run;
    } finally {
      if (setUp) this.settingUp.delete(setUp);
      if (name) this.pendingNames.delete(name);
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

  private systemPrompt(): string {
    return [this.host.systemPrompt(this), this.definition?.prompt].filter(Boolean).join('\n\n');
  }

  // A run this agent owned in an earlier process, restored from the session
  // file as a record and nothing more.
  adoptSubagent(run: SubagentRun): void {
    this.subagents.set(run.id, run);
  }

  listSubagents(): SubagentRun[] {
    return [...this.subagents.values()];
  }

  listBackgroundTasks(): BackgroundTask[] {
    return [...this.backgroundTasks.values()];
  }

  async stopBackgroundTask(id: string): Promise<boolean> {
    const task = this.backgroundTasks.get(id);
    if (!task?.canStop || !this.runtime) return false;
    const stopped = await this.runtime.stopTask(id);
    if (stopped && this.backgroundTasks.get(id)?.canStop) {
      this.hear({ type: 'async_task', task: { ...task, state: 'stopped', canStop: false } });
    }
    return stopped;
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
      spawn: async (prompt, options, call, signal) => {
        const deadline = Date.now() + TOOL_WAIT_LIMIT_MS;
        // Esc stops the owner's turn whether or not the vendor then closes
        // the call, so the wait follows the turn as well as the call.
        const turn = this.turn?.signal;
        const callId = this.spawnCallId(call.vendorCallId);
        const run = await this.spawnSubagent(prompt, options, callId ?? call.callId);
        if (options.runInBackground === false) {
          await awaitForeground(run, deadline - Date.now(), turn && signal ? AbortSignal.any([turn, signal]) : turn ?? signal);
        }
        const note = run.status !== 'working' ? null
          : options.runInBackground === false
            ? 'Still working when this call had to return, so it carries on in the background and reports to you when it ends. WaitAgent waits for it; SendMessage sends it instructions.'
            : 'Working in the background. WaitAgent waits; SendMessage sends instructions or resumes it later.';
        return { ...checkSubagent(run), context: run.context, branch: run.branch, ...(note ? { note } : {}) };
      },
      check: id => checkSubagent(this.requireSubagent(id)),
      cancel: (id, signal) => cancelSubagent(this.requireSubagent(id), signal),
      message: (id, text, interrupt) => messageSubagent(this.requireSubagent(id), this, text, interrupt),
      wait: (ids, timeoutMs, signal) => waitSubagents([...new Set(ids.map(id => this.requireSubagent(id)))], timeoutMs, signal),
      list: () => this.describeSubagents(),
    };
  }

  // A worker of this agent ended: the session delivers its report here.
  workerFinished(run: SubagentRun): void {
    this.host.workerFinished(run);
  }

  // The agent that does one worker's work: its own runtime and record under
  // this agent's session, in its own directory, with the subagent contract.
  createSubagent(id: string, model: string, thinkingLevel: ThinkingLevel, directory: string, definition?: AgentDefinition): SessionAgent {
    return new SessionAgent({
      name: DEFAULT_PARTICIPANT,
      model,
      thinkingLevel,
      runtimeId: `${this.runtimeId}/subagents/${id}`,
      host: this.host.forWorker(id, directory),
      subagentId: id,
      definition,
    });
  }

  private requireSubagent(id: string): SubagentRun {
    const run = this.subagents.get(id) ?? this.listSubagents().find(run => run.name === id);
    if (run) return run;
    const known = this.listSubagents().map(workerName);
    throw new Error(known.length > 0
      ? `Unknown subagent "${id}". Known subagents: ${known.join(', ')}`
      : `Unknown subagent "${id}". No subagent has been spawned yet.`);
  }
}

function isDirectory(directory: string): boolean {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}
