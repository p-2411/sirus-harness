import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type ClientCapabilities,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionMode,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { abortable, abortReason, throwIfAborted } from '../../abort';
import { imageData } from '../../images';
import { SIRUS_VERSION } from '../../version';
import type { PermissionMode } from '../permissions/policy';
import type { Vendor } from '../providers/catalog';
import { THINKING_LEVELS, type ThinkingLevel, type ToolCallBlock } from '../types';
import type { ContextUsage } from '../usage';
import { launchFor, type SessionParams } from './launch';
import {
  modeKindOf,
  toolCallBlockFrom,
  vendorModeFor,
  type ForkOptions,
  type ModeKind,
  type PromptInput,
  type PromptResult,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from './runtime';

// The ACP client: one adapter process on stdio, holding the session it was
// started for and every session forked from it. This is the only code that
// speaks the wire protocol; what it hands out is the runtime contract in
// `./runtime`, one `Runtime` object per session.
//
// A fork is a second session in the same process, so nothing here can assume
// an update belongs to the session that started the process. Every
// `session/update` and `session/request_permission` names its session, and
// the connection routes by that name to the session's own reducer state,
// turn and callbacks. Everything the process owns — the child, the
// connection, the loss that ends them both — stays shared.

const STDERR_TAIL_LINES = 20;
const KILL_GRACE_MS = 2_000;

// Sirus advertises compaction and nothing else: no fs, terminal, elicitation,
// plan or subagents, so the agents run their tools on disk themselves and
// nothing pulls execution back into this process.
const CLIENT_CAPABILITIES: ClientCapabilities = { session: { compaction: {} } };

// The answer to a permission request that outlives its turn.
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

// The select option each adapter exposes for its reasoning depth.
const EFFORT_OPTION_IDS: Record<Vendor, string> = { claude: 'effort', gpt: 'reasoning_effort' };

// The steering extension both adapters implement, and what they answer with.
// `injected` is the only outcome Sirus wants: the text reached the turn in
// flight. The `promptRequired` opt-in makes an adapter that finds no turn
// hand the text back instead of starting a detached turn nobody asked for,
// which would stream into a session the caller thinks is idle.
const STEERING_METHOD = '_session/steering';
const STEERING_IDLE_BEHAVIOR = { steering: { idleBehavior: 'promptRequired' } };

interface SteeringResponse {
  outcome?: string;
  reason?: string;
}

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>;

function selectOption(options: readonly SessionConfigOption[], id: string): SelectOption | null {
  const option = options.find(candidate => candidate.id === id);
  return option?.type === 'select' ? option : null;
}

function selectValues(option: SelectOption): string[] {
  return option.options.flatMap(item => ('options' in item ? item.options : [item]).map(choice => choice.value));
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('');
}

type CompactionStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

function compactionStatus(status: string): CompactionStatus | null {
  return status === 'in_progress' || status === 'completed' || status === 'failed' || status === 'cancelled'
    ? status
    : null;
}

// What a failed request actually said. Both adapters answer a refusal that
// came from the vendor — a rate limit, a spent allowance, an expired login —
// with the JSON-RPC "Internal error" and the real sentence in the error's
// data: `details` from claude-agent-acp, `message` from codex-acp. Without it
// the user is told only "Internal error".
function detailOf(error: unknown): string {
  if (!(error instanceof RequestError) || !error.data || typeof error.data !== 'object') return '';
  const data = error.data as { details?: unknown; message?: unknown };
  for (const value of [data.details, data.message]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// The vendor refused the value itself, rather than failing the request:
// codex-acp answers an unlisted value with JSON-RPC's invalid params, while
// claude-agent-acp answers with an internal error whose detail names the
// option. Anything else — a rate limit, a lost login — is a real failure and
// must not be reported as a model the vendor does not have.
function refusedValue(error: unknown, id: string): boolean {
  return error instanceof RequestError
    && (error.code === -32602 || detailOf(error).includes(`config option ${id}`));
}

// Where a session sends what it produces. The root's are the runtime's own;
// a fork's belong to the worker it was taken for.
type SessionHooks = Pick<RuntimeOptions, 'onPermission' | 'onUpdate'>;

// Everything one session owns: what its reducer has folded so far, the turn
// it is running, and who to hand the result to. Sessions on one process share
// nothing but the process.
interface SessionState {
  id: string;
  // Where the session runs. A fork keeps its parent's too, since Claude's
  // adapter looks a session up under the directory it was created in.
  directory: string;
  hooks: SessionHooks;
  model: string;
  modes: SessionMode[];
  currentModeId: string;
  // Counts `current_mode_update`s, so a set-mode call can tell whether the
  // vendor pushed a different mode while answering it.
  modeUpdates: number;
  configOptions: SessionConfigOption[];
  context: ContextUsage | null;
  toolCalls: Map<string, ToolCallBlock>;
  // Summary chunks by compaction id, until the terminal update carries them.
  summaries: Map<string, string>;
  // Compactions already reported as over. claude-agent-acp sends a second
  // terminal update for the same compaction to enrich its token counts, and a
  // `RuntimeUpdate` carries no id to merge the repeat onto, so it is dropped.
  compacted: Set<string>;
  // The turn in progress: its signal answers permission requests, and an
  // exception from `onUpdate` is kept to fail the turn with once it ends.
  turn: { signal: AbortSignal; error: Error | null } | null;
  // A cancelled turn's `session/prompt` stays in flight until the vendor
  // answers it; the next turn waits for that answer so the adapter never
  // holds two prompts at once.
  inFlight: Promise<unknown>;
  // Set when this session alone is gone: a fork that was disposed. The root
  // never sets it, because disposing the root ends the process instead.
  closed: boolean;
}

export async function startAcpRuntime(options: RuntimeOptions): Promise<Runtime> {
  const launch = launchFor(options);
  const child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env: launch.env });

  // Both adapters write their errors to stderr; the last lines are what the
  // user sees when the process is lost.
  let stderrTail: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail.push(...chunk.split('\n').filter(Boolean));
    stderrTail = stderrTail.slice(-STDERR_TAIL_LINES);
  });

  // Once set, every call on every session of this process rejects with it:
  // the runtime is lost and the participant rebuilds it.
  let dead: Error | null = null;
  const lost = (what: string): Error => new Error(
    `${options.vendor} adapter ${what}${stderrTail.length ? `: ${stderrTail.join(' | ')}` : ''}`,
  );
  child.on('error', error => { dead ??= lost(`failed to start (${error.message})`); });
  child.on('exit', (code, signal) => { dead ??= lost(`exited (${signal ?? code})`); });

  // The error a failed request is reported as: the loss of the process or
  // the connection when that is why it failed, the vendor's error otherwise.
  function settled(error: unknown): Error {
    if (dead) return dead;
    if (connection.signal.aborted) return (dead = lost('closed the connection'));
    if (!(error instanceof Error)) return new Error(String(error));
    const detail = detailOf(error);
    return detail ? new Error(`${error.message}: ${detail}`) : error;
  }

  // The live sessions by id, which is also the routing table: a session is
  // in here exactly while updates for it should reach a caller.
  const sessions = new Map<string, SessionState>();
  // What the adapter said it can do, read from the initialize response.
  let canFork = false;
  let canSteer = false;

  function register(id: string, directory: string, hooks: SessionHooks, model: string): SessionState {
    const state: SessionState = {
      id,
      directory,
      hooks,
      model,
      modes: [],
      currentModeId: '',
      modeUpdates: 0,
      configOptions: [],
      context: null,
      toolCalls: new Map(),
      summaries: new Map(),
      compacted: new Set(),
      turn: null,
      inFlight: Promise.resolve(),
      closed: false,
    };
    sessions.set(id, state);
    return state;
  }

  // The error a call on a session that can no longer answer rejects with.
  // The loss of the process comes first: it is the whole runtime's, and a
  // fork on a disposed process is lost rather than closed.
  function live(state: SessionState): void {
    if (dead) throw dead;
    if (state.closed) throw new Error(`${options.vendor} runtime was disposed`);
  }

  function compaction(state: SessionState, id: string, status: CompactionStatus): RuntimeUpdate | null {
    if (state.compacted.has(id)) return null;
    const summary = state.summaries.get(id);
    if (status !== 'in_progress') {
      state.compacted.add(id);
      state.summaries.delete(id);
    }
    return { type: 'compaction', status, ...(summary ? { summary } : {}) };
  }

  function reduce(state: SessionState, update: SessionUpdate): RuntimeUpdate | null {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return update.content.type === 'text' ? { type: 'text', text: update.content.text } : null;
      case 'agent_thought_chunk':
        return update.content.type === 'text' ? { type: 'thought', text: update.content.text } : null;
      case 'tool_call':
      case 'tool_call_update': {
        // codex-acp reports its own compaction as a tool call tagged in
        // `_meta`, not as a compaction update; Sirus shows it as the latter.
        if (update._meta?.contextCompaction) {
          const status = compactionStatus(update.status ?? 'in_progress');
          return status ? compaction(state, update.toolCallId, status) : null;
        }
        const call = toolCallBlockFrom(update, state.toolCalls.get(update.toolCallId));
        state.toolCalls.set(call.id, call);
        return { type: 'tool_call', call };
      }
      case 'usage_update':
        state.context = { tokens: update.used, window: update.size };
        return { type: 'context', usage: state.context };
      case 'compaction_summary_chunk':
        if (update.content.type === 'text') {
          state.summaries.set(
            update.compactionId,
            (state.summaries.get(update.compactionId) ?? '') + update.content.text,
          );
        }
        return null;
      case 'compaction_update': {
        const status = compactionStatus(update.status);
        if (!status) return null;
        // The update's own summary replaces whatever the chunks built up.
        if (update.summary) state.summaries.set(update.compactionId, textOf(update.summary));
        return compaction(state, update.compactionId, status);
      }
      case 'current_mode_update': {
        state.currentModeId = update.currentModeId;
        state.modeUpdates++;
        const mode = state.modes.find(candidate => candidate.id === state.currentModeId);
        return { type: 'mode', modeId: state.currentModeId, kind: mode ? modeKindOf(mode) : null };
      }
      case 'config_option_update':
        state.configOptions = update.configOptions;
        return null;
      default:
        // User message echoes, plans, available commands and session info
        // carry nothing the transcript records.
        return null;
    }
  }

  // An update for a session nobody is listening to any more — a fork closed
  // while the vendor was still streaming — is dropped.
  function receive(sessionId: string, update: SessionUpdate): void {
    const state = sessions.get(sessionId);
    if (!state) return;
    const reduced = reduce(state, update);
    if (!reduced) return;
    try {
      state.hooks.onUpdate(reduced);
    } catch (error) {
      if (state.turn) state.turn.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  async function permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const state = sessions.get(request.sessionId);
    const signal = state?.turn?.signal;
    if (!state || !signal || signal.aborted) return CANCELLED;
    try {
      return await state.hooks.onPermission(request, signal);
    } catch (error) {
      if (signal.aborted) return CANCELLED;
      throw error;
    }
  }

  // The casts bridge node's web-stream types and the runtime's globals, which
  // name the same objects.
  const connection = client({ name: 'sirus' })
    .onRequest(methods.client.session.requestPermission, ({ params }) => permission(params))
    .onNotification(methods.client.session.update, ({ params }) => { receive(params.sessionId, params.update); })
    .connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    ));
  void connection.closed.then(() => { dead ??= lost('closed the connection'); });

  let disposed = false;
  // Ends the process, and with it every session on it. Forks do not come
  // through here: they close their own session and leave the process alone.
  function disposeProcess(): void {
    if (disposed) return;
    disposed = true;
    dead ??= new Error(`${options.vendor} runtime was disposed`);
    connection.close();
    if (child.exitCode === null && child.signalCode === null) {
      // EOF on stdin is how both adapters learn to stop and take their own
      // child (the CLI, the app-server) with them; the signals are for one
      // that does not.
      child.stdin.end();
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      force.unref();
      child.once('exit', () => clearTimeout(force));
    }
    launch.cleanup();
  }

  // Ends one forked session: stop routing to it and tell the adapter to drop
  // it, which frees the vendor's own session state. The process stays up for
  // the owner and the other forks.
  function closeSession(state: SessionState): void {
    if (state.closed) return;
    state.closed = true;
    sessions.delete(state.id);
    if (dead) return;
    void connection.agent.request(methods.agent.session.close, { sessionId: state.id }).catch(() => undefined);
  }

  function promptBlocks(input: PromptInput): ContentBlock[] {
    return [
      { type: 'text', text: input.text },
      ...input.images.map(image => ({ type: 'image' as const, data: imageData(image), mimeType: image.mediaType })),
    ];
  }

  async function prompt(state: SessionState, input: PromptInput, signal: AbortSignal): Promise<PromptResult> {
    if (state.turn) throw new Error(`The ${options.vendor} runtime is already running a prompt`);
    await state.inFlight.catch(() => undefined);
    live(state);
    throwIfAborted(signal);
    const current = { signal, error: null as Error | null };
    state.turn = current;
    const cancel = () => {
      void connection.agent.notify(methods.agent.session.cancel, { sessionId: state.id }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    const request = connection.agent.request(methods.agent.session.prompt, {
      sessionId: state.id,
      prompt: promptBlocks(input),
    });
    state.inFlight = request.catch(() => undefined);
    try {
      const response = await abortable(request, signal);
      if (response.stopReason === 'cancelled' && signal.aborted) throw abortReason(signal);
      if (current.error) throw current.error;
      return { stopReason: response.stopReason };
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw settled(error);
    } finally {
      signal.removeEventListener('abort', cancel);
      state.turn = null;
    }
  }

  async function setPermissionMode(
    state: SessionState,
    mode: PermissionMode,
  ): Promise<{ modeId: string; kind: ModeKind | null }> {
    live(state);
    const target = vendorModeFor(mode, state.modes);
    if (target) {
      // A mode the vendor pushes while answering wins over the one asked for
      // (Claude drops to manual when the model lacks auto mode).
      const seen = state.modeUpdates;
      try {
        await connection.agent.request(methods.agent.session.setMode, { sessionId: state.id, modeId: target.id });
      } catch (error) {
        throw settled(error);
      }
      if (state.modeUpdates === seen) state.currentModeId = target.id;
    }
    const current = state.modes.find(candidate => candidate.id === state.currentModeId);
    return { modeId: state.currentModeId, kind: current ? modeKindOf(current) : null };
  }

  // Sends the value and says whether it took. The offered values are a hint,
  // not the whole truth — claude-agent-acp resolves ids it never lists, taking
  // `claude-sonnet-5` for `sonnet` — so asking is the only way to know.
  async function setOption(state: SessionState, id: string, value: string): Promise<boolean> {
    const option = selectOption(state.configOptions, id);
    if (!option) return false;
    if (option.currentValue === value) return true;
    try {
      const response = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: state.id,
        configId: id,
        value,
      });
      state.configOptions = response.configOptions;
      return true;
    } catch (error) {
      if (refusedValue(error, id)) return false;
      throw settled(error);
    }
  }

  async function setModel(state: SessionState, next: string): Promise<boolean> {
    live(state);
    if (!(await setOption(state, 'model', next))) return false;
    state.model = next;
    return true;
  }

  async function setThinkingLevel(state: SessionState, level: ThinkingLevel): Promise<void> {
    live(state);
    const option = selectOption(state.configOptions, EFFORT_OPTION_IDS[options.vendor]);
    if (!option) return;
    // The level itself when the vendor offers it, else the nearest lower one
    // it does; nothing when none of Sirus's levels is on its list.
    const offered = selectValues(option);
    const value = THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf(level) + 1).reverse()
      .find(candidate => offered.includes(candidate));
    if (value) await setOption(state, option.id, value);
  }

  // What every session takes on before its first prompt, in the order the
  // adapters want it: the mode first, since it decides what the model may do,
  // then the model, then the depth that model offers. A model the vendor
  // refuses fails the session outright — a fresh runtime would fall back to
  // another, but a fork exists only to carry this conversation on.
  async function configure(state: SessionState, mode: PermissionMode, model: string, level: ThinkingLevel): Promise<void> {
    await setPermissionMode(state, mode);
    const modelOption = selectOption(state.configOptions, 'model');
    if (modelOption && !(await setModel(state, model))) {
      throw new Error(
        `${options.vendor} does not offer the model ${model}; it offers ${selectValues(modelOption).join(', ')}`,
      );
    }
    await setThinkingLevel(state, level);
  }

  async function steer(state: SessionState, text: string): Promise<void> {
    live(state);
    if (!canSteer) throw new Error(`The ${options.vendor} adapter cannot take a message mid-turn`);
    // Asked here as well as by the adapter: the answer is the caller's to
    // report, and an adapter that has already let its turn settle would
    // otherwise decide it for us.
    if (!state.turn) throw new Error(`The ${options.vendor} runtime is not running a prompt`);
    let response: SteeringResponse;
    try {
      response = await connection.agent.request<SteeringResponse>(STEERING_METHOD, {
        sessionId: state.id,
        prompt: [{ type: 'text', text }],
        _meta: STEERING_IDLE_BEHAVIOR,
      });
    } catch (error) {
      throw settled(error);
    }
    if (response.outcome !== 'injected') {
      const reason = response.reason ? `: ${response.reason}` : '';
      throw new Error(
        `The ${options.vendor} runtime did not take the message (${response.outcome ?? 'no outcome'}${reason})`,
      );
    }
  }

  async function fork(parent: SessionState, forked: ForkOptions): Promise<Runtime> {
    live(parent);
    if (!canFork) throw new Error(`The ${options.vendor} adapter cannot fork a session`);
    const params: SessionParams = launch.session({
      systemPrompt: forked.systemPrompt,
      mcpServer: forked.mcpServer,
    });
    const extras = { mcpServers: params.mcpServers, ...(params.meta ? { _meta: params.meta } : {}) };
    let created;
    try {
      created = await connection.agent.request(methods.agent.session.fork, {
        sessionId: parent.id,
        // Where the adapter finds the session being forked when the fork only
        // copies its transcript, and where the new session runs when it does
        // not; the launch spec says which this vendor does.
        cwd: launch.forkNeedsResume ? parent.directory : forked.directory,
        ...extras,
      });
    } catch (error) {
      throw settled(error);
    }
    // Registered before the resume, since the adapter starts pushing updates
    // for the new session the moment it opens it.
    const state = register(created.sessionId, forked.directory, forked, parent.model);
    try {
      const opened = launch.forkNeedsResume
        ? await connection.agent.request(methods.agent.session.resume, {
          sessionId: created.sessionId,
          cwd: forked.directory,
          ...extras,
        })
        : created;
      state.modes = opened.modes?.availableModes ?? [];
      state.currentModeId = opened.modes?.currentModeId ?? '';
      state.configOptions = opened.configOptions ?? [];
      await configure(state, forked.permissionMode, forked.model, forked.thinkingLevel);
    } catch (error) {
      const failure = settled(error);
      closeSession(state);
      throw failure;
    }
    return runtimeFor(state, () => closeSession(state));
  }

  function runtimeFor(state: SessionState, dispose: () => void): Runtime {
    return {
      vendor: options.vendor,
      get model() { return state.model; },
      get modes() { return state.modes; },
      get context() { return state.context; },
      prompt: (input, signal) => prompt(state, input, signal),
      setPermissionMode: mode => setPermissionMode(state, mode),
      setModel: next => setModel(state, next),
      setThinkingLevel: level => setThinkingLevel(state, level),
      fork: forked => fork(state, forked),
      steer: text => steer(state, text),
      dispose,
    };
  }

  try {
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: 'sirus', version: SIRUS_VERSION },
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    // Both adapters list `fork` among their session capabilities and answer
    // `_meta.steering.supported`; a vendor that does not is told so by name
    // rather than made to fail at the wire.
    canFork = initialized.agentCapabilities?.sessionCapabilities?.fork != null;
    const meta = initialized._meta as { steering?: { supported?: boolean } } | null | undefined;
    canSteer = meta?.steering?.supported === true;

    const params = launch.session({ systemPrompt: options.systemPrompt, mcpServer: options.mcpServer });
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: options.directory,
      mcpServers: params.mcpServers,
      ...(params.meta ? { _meta: params.meta } : {}),
    });
    const state = register(session.sessionId, options.directory, options, options.model);
    state.modes = session.modes?.availableModes ?? [];
    state.currentModeId = session.modes?.currentModeId ?? '';
    state.configOptions = session.configOptions ?? [];
    await configure(state, launch.mode, options.model, options.thinkingLevel);
    return runtimeFor(state, disposeProcess);
  } catch (error) {
    const failure = settled(error);
    disposeProcess();
    throw failure;
  }
}
