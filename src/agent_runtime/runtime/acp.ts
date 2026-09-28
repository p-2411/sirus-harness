import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type ClientCapabilities,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionMode,
  type SessionUpdate,
  type Usage,
} from '@agentclientprotocol/sdk';
import { abortable, abortReason, throwIfAborted } from '../../abort';
import { imageData } from '../../images';
import { SIRUS_VERSION } from '../../version';

import { VENDOR_INFO, type ListedModel, type Vendor } from '../providers/catalog';
import { fitThinkingLevel, offeredThinkingLevels, PLAN_ENTRY_STATUSES, type PermissionMode, type ThinkingLevel, type ToolCallBlock, type ToolCallOutcome, type TurnUsage } from '../types';
import type { ContextUsage } from '../usage';
import { nativeCommandFrom } from './commands';
import { AdapterLostError } from './errors';
import { launchFor, type Launch, type SessionParams } from './launch';
import {
  backgroundTaskFrom,
  COMPACTION_STATUSES,
  modeKindOf,
  PERMISSION_CANCELLED,
  QUESTION_CANCELLED,
  QUESTION_DECLINED,
  toolCallBlockFrom,
  vendorModeFor,
  type BackgroundTask,
type CompactionStatus,
  type ForkOptions,
  type ModeKind,
  type PromptInput,
  type PromptResult,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from './runtime';

// A prompt response's usage as the transcript keeps it, with the turn's share
// of the session's cost when the vendor reports one.
function turnUsage(usage: Usage, cost: number | null): TurnUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(typeof usage.cachedReadTokens === 'number' ? { cachedReadTokens: usage.cachedReadTokens } : {}),
    ...(typeof usage.cachedWriteTokens === 'number' ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(typeof usage.thoughtTokens === 'number' ? { thoughtTokens: usage.thoughtTokens } : {}),
    ...(cost !== null && cost >= 0 ? { costUsd: cost } : {}),
  };
}



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
// How long a cancelled prompt may go unanswered before its session is taken
// as stuck. The adapter normally answers within a second or two.
const CANCEL_GRACE_MS = 30_000;

// Sirus advertises compaction, notices, async tasks and form elicitation: no fs,
// terminal, plan or subagents, so the agents run their tools on disk
// themselves and nothing pulls execution back into this process. Forms are
// how both adapters put a question to the user; codex-acp still sends its
// tool approvals as permission requests either way.
const CLIENT_CAPABILITIES: ClientCapabilities = {
  session: { compaction: {}, notices: {} },
  elicitation: { form: {} },
  _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
};

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

// The models the vendor offers, from its model option: the value is what
// Sirus names the model by. `default` is left out: it names whatever the
// vendor recommends, and Sirus's own `default` means something else.
function listedModelsIn(options: readonly SessionConfigOption[]): ListedModel[] {
  const option = selectOption(options, 'model');
  if (!option) return [];
  return option.options
    .flatMap(item => ('options' in item ? item.options : [item]))
    .filter(choice => choice.value !== 'default')
    .map(choice => ({ id: choice.value, description: choice.description || choice.name }));
}

function selectValues(option: SelectOption): string[] {
  return option.options.flatMap(item => ('options' in item ? item.options : [item]).map(choice => choice.value));
}

// The Agent SDK message claude-agent-acp forwards when a session asks for
// it (`emitRawSDKMessages` in the launch spec). Only the init frame is asked
// for, and only its MCP servers are read.
const SDK_MESSAGE_METHOD = '_claude/sdkMessage';

function mcpServersIn(message: unknown): { name: string; status: string }[] | null {
  const frame = message as { type?: unknown; subtype?: unknown; mcp_servers?: unknown } | null;
  if (frame?.type !== 'system' || frame.subtype !== 'init' || !Array.isArray(frame.mcp_servers)) return null;
  return frame.mcp_servers.flatMap(server => {
    const { name, status } = (server ?? {}) as { name?: unknown; status?: unknown };
    return typeof name === 'string' && typeof status === 'string' ? [{ name, status }] : [];
  });
}

// The Agent call a vendor's subagent request came from, as Claude tags it.
function parentToolUseIdOf(value: unknown): string | null {
  const meta = (value as { _meta?: { claudeCode?: { parentToolUseId?: unknown } } } | null | undefined)?._meta;
  const id = meta?.claudeCode?.parentToolUseId;
  return typeof id === 'string' ? id : null;
}

// The session a vendor opened for one of its own subagents, when the update
// announces one. Both adapters send this only to a client that advertises
// subagent sessions; it is not in the protocol's own list of updates.
function announcedSubagent(update: SessionUpdate): string | null {
  const announcement = update as { sessionUpdate: string; subagentSessionId?: unknown };
  return announcement.sessionUpdate === 'subagent_spawned' && typeof announcement.subagentSessionId === 'string'
    ? announcement.subagentSessionId
    : null;
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('');
}

// The updates that make up a turn's reply: text, thoughts, tool calls, the
// plan and compaction. The rest describe the session and may arrive at any
// time: its commands, mode, options and context gauge.
const TURN_CONTENT = new Set<SessionUpdate['sessionUpdate']>([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'compaction_summary_chunk',
  'compaction_update',
]);

function compactionStatus(status: string): CompactionStatus | null {
  return (COMPACTION_STATUSES as readonly string[]).includes(status) ? status as CompactionStatus : null;
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
type SessionHooks = Pick<RuntimeOptions, 'onPermission' | 'onElicitation' | 'onUpdate'>;

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
  // The effort the vendor picked for the session's model while Sirus had set
  // none: that model's default, which an agent with no level runs at.
  modelEffort?: { model: string; value: string };
  effortSet?: boolean;
  context: ContextUsage | null;
  // The running turn's tool calls, so each update folds into its call and a
  // request from a vendor's subagent finds the Agent call it came from.
  // Cleared when the turn ends: the transcript keeps them, and nothing more
  // arrives for them.
  cost: number | null;
  // What the usage updates of the turn in flight added up to, one per model
  // call, and how many calls that was: a Codex turn's total, since codex-acp
  // answers a prompt with its last call's usage alone. Codex repeats a call's
  // count when only its rate limits changed, so a repeat is not counted.
  turnTokens: number;
  turnCalls: number;
  lastCallTokens: number | null;
  toolCalls: Map<string, ToolCallBlock>;
  // Calls the user declined, or whose approval the turn's end withdrew, with
  // why: the vendors report either as failed, and may report the call only
  // after its approval was answered.
  stopped: Map<string, ToolCallOutcome>;
  tasks: Map<string, BackgroundTask>;
  stoppingTasks: Set<string>;
  stopBackgroundOnCancel: boolean;
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
  // Set when a cancelled prompt went unanswered past its grace: the adapter
  // is holding a turn nobody can end, so the session takes no more prompts
  // and its owner rebuilds it.
  stuck: boolean;
  // A load can replay transcript updates before it answers. Sirus already
  // owns that transcript; only live metadata should reach its callbacks.
  reopening: boolean;
}

// The launch is the vendor's own; the test suite passes one that runs a
// stand-in adapter.
export async function startAcpRuntime(options: RuntimeOptions, testLaunch?: Launch): Promise<Runtime> {
  throwIfAborted(options.signal);
  if (options.resume) options = { ...options, directory: options.resume.directory };
  const launch = testLaunch ?? launchFor(options);
  const vendorName = VENDOR_INFO[options.vendor].displayName;
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
  const lost = (what: string): Error => new AdapterLostError(
    `${vendorName} adapter ${what}${stderrTail.length ? `: ${stderrTail.join(' | ')}` : ''}`,
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
    return detail ? new Error(`${error.message}: ${detail}`, { cause: error }) : error;
  }

  // The live sessions by id, which is also the routing table: a session is
  // in here exactly while updates for it should reach a caller.
  const sessions = new Map<string, SessionState>();
  // A new session can send notices or recover background tasks before its
  // response gives us its id.
  const openingUpdates = new Map<string, SessionUpdate[]>();
  let openingSessions = 0;
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
      cost: null,
      turnTokens: 0,
      turnCalls: 0,
      lastCallTokens: null,
      toolCalls: new Map(),
      stopped: new Map(),
      tasks: new Map(),
      stoppingTasks: new Set(),
      stopBackgroundOnCancel: false,
      summaries: new Map(),
      compacted: new Set(),
      turn: null,
      inFlight: Promise.resolve(),
      closed: false,
      stuck: false,
      reopening: false,
    };
    sessions.set(id, state);
    for (const update of openingUpdates.get(id) ?? []) receive(id, update);
    openingUpdates.delete(id);
    return state;
  }

  async function openSession<T extends { sessionId: string }>(
    request: () => Promise<T>, directory: string, hooks: SessionHooks, model: string,
  ): Promise<{ opened: T; state: SessionState }> {
    openingSessions++;
    try {
      const opened = await request();
      return { opened, state: register(opened.sessionId, directory, hooks, model) };
    } finally {
      openingSessions--;
      if (openingSessions === 0) openingUpdates.clear();
    }
  }

  async function finishReopening(state: SessionState): Promise<void> {
    // The SDK resolves responses ahead of its asynchronous notification
    // handlers. Drain updates already read before enabling transcript output,
    // including the last replay chunk immediately preceding the response.
    await new Promise<void>(resolve => setImmediate(resolve));
    state.reopening = false;
  }

  // The error a call on a session that can no longer answer rejects with.
  // The loss of the process comes first: it is the whole runtime's, and a
  // fork on a disposed process is lost rather than closed.
  function live(state: SessionState): void {
    if (dead) throw dead;
    if (state.closed) throw new Error(`${vendorName} runtime was disposed`);
    if (state.stuck) throw new AdapterLostError(`${vendorName} runtime did not answer a cancel`);
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
    const taskId = (update as { asyncTaskId?: string }).asyncTaskId;
    const task = backgroundTaskFrom(update, taskId ? state.tasks.get(taskId) : undefined);
    if (task) {
      state.tasks.set(task.id, task);
      return { type: 'async_task', task };
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return update.content.type === 'text' ? {
          type: 'text', text: update.content.text, ...(update.messageId ? { messageId: update.messageId } : {}),
        } : null;
      case 'agent_thought_chunk':
        return update.content.type === 'text' ? { type: 'thought', text: update.content.text } : null;
      case 'notice':
        return {
          type: 'notice',
          severity: update.severity,
          title: update.title,
          ...(update.description != null ? { description: update.description } : {}),
        };
      case 'tool_call':
      case 'tool_call_update': {
        // codex-acp reports its own compaction as a tool call tagged in
        // `_meta`, not as a compaction update; Sirus shows it as the latter.
        if (update._meta?.contextCompaction) {
          const status = compactionStatus(update.status ?? 'in_progress');
          return status ? compaction(state, update.toolCallId, status) : null;
        }
        const reduced = toolCallBlockFrom(update, state.toolCalls.get(update.toolCallId));
        const outcome = state.stopped.get(reduced.id);
        const call = outcome && !reduced.outcome ? { ...reduced, outcome } : reduced;
        state.toolCalls.set(call.id, call);
        return { type: 'tool_call', call };
      }
      case 'usage_update':
        state.context = { tokens: update.used, window: update.size };
        if (typeof update.cost?.amount === 'number' && Number.isFinite(update.cost.amount)) state.cost = update.cost.amount;
        if (state.turn && update.used !== state.lastCallTokens) {
          state.turnTokens += update.used;
          state.turnCalls++;
          state.lastCallTokens = update.used;
        }
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
        return effortsUpdate(state);
      case 'available_commands_update':
        return { type: 'commands', commands: update.availableCommands.flatMap(command => nativeCommandFrom(command) ?? []) };
      case 'plan':
        return {
          type: 'plan',
          entries: update.entries.map(entry => ({
            content: entry.content,
            status: PLAN_ENTRY_STATUSES.includes(entry.status) ? entry.status : 'pending',
          })),
        };
      default:
        // User message echoes and session info carry nothing the transcript
        // records.
        return null;
    }
  }

  // The sessions the vendor opened on its own for a subagent of one of ours,
  // by id, and the session each works for. Sirus advertises no subagent
  // sessions, so neither adapter should announce one; if one does, what it
  // asks still reaches the user.
  const subagentOwners = new Map<string, SessionState>();

  // Who answers a request naming a session this client never opened: the
  // session whose subagent it is, known from its announcement or from the
  // Agent call Claude says it came from. A request from a fork already
  // closed matches neither and is cancelled, as before.
  function answeringSession(sessionId: string, request: unknown): SessionState | undefined {
    const own = sessions.get(sessionId) ?? subagentOwners.get(sessionId);
    if (own) return own;
    const parentCall = parentToolUseIdOf(request);
    return parentCall ? [...sessions.values()].find(state => state.toolCalls.has(parentCall)) : undefined;
  }

  // An update for a session nobody is listening to any more — a fork closed
  // while the vendor was still streaming — is dropped, and so is anything a
  // vendor's own subagent streams: only its announcement is kept, so its
  // requests can be routed. So is a turn's content arriving while the
  // session runs none: what the adapter still streams for a cancelled prompt
  // until it answers it, which the next prompt waits for with its reply
  // already listening.
  function receive(sessionId: string, update: SessionUpdate): void {
    const announced = announcedSubagent(update);
    if (announced) {
      const owner = sessions.get(sessionId) ?? subagentOwners.get(sessionId);
      if (owner) subagentOwners.set(announced, owner);
      return;
    }
    const state = sessions.get(sessionId);
    if (!state) {
      if (openingSessions > 0 && (update.sessionUpdate === 'notice' || String(update.sessionUpdate).startsWith('async_task_'))) {
        const updates = openingUpdates.get(sessionId) ?? [];
        updates.push(update);
        openingUpdates.set(sessionId, updates);
      }
      return;
    }
    if (state.reopening && !String(update.sessionUpdate).startsWith('async_task_') && ![
      'notice', 'usage_update', 'current_mode_update', 'config_option_update', 'available_commands_update',
    ].includes(update.sessionUpdate)) return;
    if (!state.turn && TURN_CONTENT.has(update.sessionUpdate)) return;
    const reduced = reduce(state, update);
    if (!reduced) return;
    try {
      const rateLimit = update.sessionUpdate === 'usage_update' ? update._meta?.['_claude/rateLimit'] : undefined;
      if (rateLimit && typeof rateLimit === 'object') {
        const resetsAt = (rateLimit as { resetsAt?: unknown }).resetsAt;
        state.hooks.onUpdate({ type: 'rate_limit',
          ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? { resetsAt } : {}),
        });
      }
      state.hooks.onUpdate(reduced);
      if (reduced.type === 'async_task' && reduced.task.canStop && state.stopBackgroundOnCancel) {
        stopCancelledTask(state, reduced.task.id);
      }
    } catch (error) {
      if (state.turn) state.turn.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  async function permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const state = answeringSession(request.sessionId, request.toolCall);
    const signal = state?.turn?.signal;
    if (!state || !signal || signal.aborted) return PERMISSION_CANCELLED;
    let response: RequestPermissionResponse;
    try {
      response = await state.hooks.onPermission(request, signal);
    } catch (error) {
      if (signal.aborted) return PERMISSION_CANCELLED;
      throw error;
    }
    const { outcome } = response;
    const chosen = outcome.outcome === 'selected'
      ? request.options.find(option => option.optionId === outcome.optionId)
      : undefined;
    if (!chosen || chosen.kind.startsWith('reject')) {
      stopCall(state, request.toolCall.toolCallId, chosen || !signal.aborted ? 'declined' : 'cancelled');
    }
    return response;
  }

  // Records why a call will not run, and says so at once when the call is
  // already in the transcript.
  function stopCall(state: SessionState, id: string, outcome: ToolCallOutcome): void {
    state.stopped.set(id, outcome);
    const call = state.toolCalls.get(id);
    if (!call || call.outcome) return;
    const stopped = { ...call, outcome };
    state.toolCalls.set(id, stopped);
    try {
      state.hooks.onUpdate({ type: 'tool_call', call: stopped });
    } catch (error) {
      if (state.turn) state.turn.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  // A question outside a turn, or one tied to no session (asked while the
  // adapter is still starting up), has nobody to answer it.
  async function elicitation(request: CreateElicitationRequest, requestSignal: AbortSignal): Promise<CreateElicitationResponse> {
    const sessionId = 'sessionId' in request && typeof request.sessionId === 'string' ? request.sessionId : null;
    const state = sessionId ? answeringSession(sessionId, request) : undefined;
    const turnSignal = state?.turn?.signal;
    if (!state || !turnSignal) return QUESTION_CANCELLED;
    // Codex can withdraw a question without ending the turn, including when
    // it auto-resolves one. The card must stop waiting along with the request.
    const signal = AbortSignal.any([turnSignal, requestSignal]);
    if (signal.aborted) return QUESTION_CANCELLED;
    if (!state.hooks.onElicitation) return QUESTION_DECLINED;
    try {
      return await state.hooks.onElicitation(request, signal);
    } catch (error) {
      if (signal.aborted) return QUESTION_CANCELLED;
      throw error;
    }
  }

  // The casts bridge node's web-stream types and the runtime's globals, which
  // name the same objects.
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  // Stable ACP's schema does not include AIR task notifications. Route only
  // those extensions before validation; standard updates keep the SDK's
  // schema checks.
  const readable = stream.readable.pipeThrough(new TransformStream({
    transform(message, controller) {
      if ('method' in message && message.method === methods.client.session.update && !('id' in message)) {
        const params = message.params as { sessionId?: unknown; update?: unknown } | undefined;
        if (typeof params?.sessionId === 'string' && backgroundTaskFrom(params.update)) {
          receive(params.sessionId, params.update as SessionUpdate);
          return;
        }
      }
      // Claude's init frame, forwarded raw: the one read is its MCP servers.
      if ('method' in message && message.method === SDK_MESSAGE_METHOD && !('id' in message)) {
        const params = message.params as { sessionId?: unknown; message?: unknown } | undefined;
        const state = typeof params?.sessionId === 'string' ? sessions.get(params.sessionId) : undefined;
        const servers = mcpServersIn(params?.message);
        if (state && servers && !state.reopening) {
          try { state.hooks.onUpdate({ type: 'mcp_servers', servers }); } catch { /* advisory */ }
        }
        return;
      }
      controller.enqueue(message);
    },
  }));
  const connection = client({ name: 'sirus' })
    .onRequest(methods.client.session.requestPermission, ({ params }) => permission(params))
    .onRequest(methods.client.elicitation.create, ({ params, signal }) => elicitation(params, signal))
    .onNotification(methods.client.session.update, ({ params }) => { receive(params.sessionId, params.update); })
    .connect({ ...stream, readable });
  void connection.closed.then(() => { dead ??= lost('closed the connection'); });

  let disposed = false;
  // Ends the process, and with it every session on it. Forks do not come
  // through here: they close their own session and leave the process alone.
  function disposeProcess(): void {
    if (disposed) return;
    disposed = true;
    dead ??= new Error(`${vendorName} runtime was disposed`);
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

  // The prompt's text goes last, after its context and images, the way
  // Claude Code's own input is sent: its last text block is where it looks
  // for a slash command, and what comes before rides along with it.
  function promptBlocks(input: PromptInput): ContentBlock[] {
    return [
      ...(input.context ? [{ type: 'text' as const, text: input.context }] : []),
      ...input.images.map(image => ({ type: 'image' as const, data: imageData(image), mimeType: image.mediaType })),
      { type: 'text', text: input.text },
    ];
  }

  async function prompt(state: SessionState, input: PromptInput, signal: AbortSignal): Promise<PromptResult> {
    if (state.turn) throw new Error(`The ${vendorName} runtime is already running a prompt`);
    await state.inFlight.catch(() => undefined);
    live(state);
    throwIfAborted(signal);
    const current = { signal, error: null as Error | null };
    state.turn = current;
    state.stopBackgroundOnCancel = false;
    state.turnTokens = 0;
    state.turnCalls = 0;
    state.lastCallTokens = null;
    let answered = false;
    let giveUp: () => void = () => undefined;
    const unanswered = new Promise<void>(resolve => { giveUp = resolve; });
    const cancel = () => {
      state.stopBackgroundOnCancel = true;
      for (const task of state.tasks.values()) if (task.canStop) stopCancelledTask(state, task.id);
      void connection.agent.notify(methods.agent.session.cancel, { sessionId: state.id }).catch(() => undefined);
      // The next prompt waits for this one's answer; one that never comes
      // must not hold it for good.
      const timer = setTimeout(() => {
        if (answered) return;
        state.stuck = true;
        giveUp();
      }, CANCEL_GRACE_MS);
      timer.unref?.();
    };
    signal.addEventListener('abort', cancel, { once: true });
    const request = connection.agent.request(methods.agent.session.prompt, {
      sessionId: state.id,
      prompt: promptBlocks(input),
    });
    state.inFlight = Promise.race([
      request.then(() => undefined, () => undefined).finally(() => { answered = true; }),
      unanswered,
    ]);
    try {
      const costBefore = state.cost ?? 0;
      const response = await abortable(request, signal);
      if (response.stopReason === 'cancelled' && signal.aborted) throw abortReason(signal);
      // The SDK answers a request ahead of the notifications read before it,
      // and the vendor's last usage and cost updates are among those.
      await new Promise<void>(resolve => setImmediate(resolve));
      const usage = usageOfTurn(state, response.usage, state.cost === null ? null : state.cost - costBefore);
      if (usage) state.hooks.onUpdate({ type: 'usage', usage });
      if (current.error) throw current.error;
      return { stopReason: response.stopReason };
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw settled(error);
    } finally {
      signal.removeEventListener('abort', cancel);
      state.turn = null;
      state.toolCalls.clear();
    }
  }

  // What the turn used: the prompt response's tally, which is the whole
  // turn's from Claude and the last call's from Codex. A Codex turn of several
  // calls is what their usage updates added up to, without a breakdown. A
  // turn that counted nothing and cost nothing, such as Claude's /compact,
  // reports nothing.
  function usageOfTurn(state: SessionState, reported: Usage | null | undefined, cost: number | null): TurnUsage | null {
    const usage = launch.turnTokens === 'usage_updates' && (state.turnCalls > 1 || !reported)
      ? { totalTokens: state.turnTokens, ...(cost !== null && cost > 0 ? { costUsd: cost } : {}) }
      : reported ? turnUsage(reported, cost) : null;
    return usage && (usage.totalTokens > 0 || (usage.costUsd ?? 0) > 0) ? usage : null;
  }

  async function stopTask(state: SessionState, id: string): Promise<boolean> {
    live(state);
    if (!state.tasks.get(id)?.canStop || state.stoppingTasks.has(id)) return false;
    state.stoppingTasks.add(id);
    try {
      const response = await connection.agent.request<{ stopped: boolean }>('_session/async_task/stop', {
        sessionId: state.id, asyncTaskId: id,
      });
      return response.stopped === true;
    } catch (error) {
      throw settled(error);
    } finally {
      state.stoppingTasks.delete(id);
    }
  }

  function stopCancelledTask(state: SessionState, id: string): void {
    void stopTask(state, id).catch(() => {
      state.hooks.onUpdate({ type: 'notice', severity: 'warning', title: 'Background task could not be stopped',
        description: `Use /tasks to stop ${id}.` });
    });
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
    // The effort option is the new model's now.
    reportEfforts(state);
    return true;
  }

  // The depths the effort option offers for the model the session is on:
  // none when the model has no such option (Claude's Haiku), and nothing to
  // report when the session lists no model option to tie them to.
  function reportEfforts(state: SessionState): void {
    const update = effortsUpdate(state);
    if (update) state.hooks.onUpdate(update);
  }

  function effortsUpdate(state: SessionState): RuntimeUpdate | null {
    noteModelEffort(state);
    if (!selectOption(state.configOptions, 'model')) return null;
    const option = selectOption(state.configOptions, EFFORT_OPTION_IDS[options.vendor]);
    const modelDefault = modelEffortOf(state);
    return { type: 'efforts', efforts: option ? selectValues(option) : [], ...(modelDefault ? { default: modelDefault } : {}) };
  }

  function noteModelEffort(state: SessionState): void {
    const option = selectOption(state.configOptions, EFFORT_OPTION_IDS[options.vendor]);
    if (option && !state.effortSet) state.modelEffort = { model: state.model, value: option.currentValue };
  }

  function modelEffortOf(state: SessionState): string | undefined {
    return state.modelEffort?.model === state.model ? state.modelEffort.value : undefined;
  }

  async function setThinkingLevel(state: SessionState, level: ThinkingLevel | undefined): Promise<void> {
    live(state);
    const option = selectOption(state.configOptions, EFFORT_OPTION_IDS[options.vendor]);
    if (!option) return;
    if (!level) {
      // Back to the model's default, when this session has seen what it is.
      const modelDefault = modelEffortOf(state);
      if (state.effortSet && modelDefault && await setOption(state, option.id, modelDefault)) state.effortSet = false;
      return;
    }
    // Exactly what the participant records as the level it runs at.
    const value = fitThinkingLevel(level, offeredThinkingLevels(selectValues(option)) ?? []);
    if (value && await setOption(state, option.id, value)) state.effortSet = true;
  }

  // What every session takes on before its first prompt, in the order the
  // adapters want it: the mode first, since it decides what the model may do,
  // then the model, then the depth, when the agent has one; without one the
  // model keeps the default the vendor picked for it. A model the vendor
  // refuses fails the session outright — a fresh runtime would fall back to
  // another, but a fork exists only to carry this conversation on.
  async function configure(state: SessionState, mode: PermissionMode, model: string, level: ThinkingLevel | undefined): Promise<void> {
    await setPermissionMode(state, mode);
    const modelOption = selectOption(state.configOptions, 'model');
    if (modelOption && !(await setModel(state, model))) {
      throw new Error(
        `${vendorName} does not offer the model ${model}; it offers ${selectValues(modelOption).join(', ')}`,
      );
    }
    noteModelEffort(state);
    await setThinkingLevel(state, level);
  }

  async function steer(state: SessionState, text: string): Promise<void> {
    live(state);
    if (!canSteer) throw new Error(`The ${vendorName} adapter cannot take a message mid-turn`);
    // Asked here as well as by the adapter: the answer is the caller's to
    // report, and an adapter that has already let its turn settle would
    // otherwise decide it for us.
    if (!state.turn) throw new Error(`The ${vendorName} runtime is not running a prompt`);
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
        `The ${vendorName} runtime did not take the message (${response.outcome ?? 'no outcome'}${reason})`,
      );
    }
  }

  async function fork(parent: SessionState, forked: ForkOptions): Promise<Runtime> {
    live(parent);
    throwIfAborted(forked.setupSignal);
    if (!canFork) throw new Error(`The ${vendorName} adapter cannot fork a session`);
    const opening = openFork();
    // The vendor may answer a fork request after its caller has gone away.
    // Let cancellation release the caller promptly, then close that session
    // when the outstanding request finally settles.
    void opening.then(runtime => {
      if (forked.setupSignal?.aborted) runtime.dispose();
    }).catch(() => undefined);
    return abortable(opening, forked.setupSignal);

    async function openFork(): Promise<Runtime> {
      const params: SessionParams = launch.session({
        directory: forked.directory,
        systemPrompt: forked.systemPrompt,
        mcpServer: forked.mcpServer,
        tools: forked.tools,
      });
      const extras = {
        mcpServers: params.mcpServers,
        ...(params.meta ? { _meta: params.meta } : {}),
        ...(params.additionalDirectories ? { additionalDirectories: params.additionalDirectories } : {}),
      };
      let created;
      let state: SessionState;
      try {
        ({ opened: created, state } = await openSession(() => connection.agent.request(methods.agent.session.fork, {
          sessionId: parent.id,
          // Where the adapter finds the session being forked when the fork only
          // copies its transcript, and where the new session runs when it does
          // not; the launch spec says which this vendor does.
          cwd: options.vendor === 'claude' ? parent.directory : forked.directory,
          ...extras,
        }), forked.directory, forked, parent.model));
      } catch (error) {
        throw settled(error);
      }
      // Registered before the resume, since the adapter starts pushing updates
      // for the new session the moment it opens it.
      try {
        throwIfAborted(forked.setupSignal);
        state.reopening = launch.forkNeedsResume;
        const opened = launch.forkNeedsResume
          ? await connection.agent.request(methods.agent.session.resume, {
            sessionId: created.sessionId,
            cwd: forked.directory,
            ...extras,
          })
          : created;
        if (state.reopening) await finishReopening(state);
        state.modes = opened.modes?.availableModes ?? [];
        state.currentModeId = opened.modes?.currentModeId ?? '';
        state.configOptions = opened.configOptions ?? [];
        await configure(state, forked.readOnly ? 'ask' : forked.permissionMode, forked.model, forked.thinkingLevel);
        throwIfAborted(forked.setupSignal);
      } catch (error) {
        const failure = settled(error);
        closeSession(state);
        throw failure;
      }
      return runtimeFor(state, () => closeSession(state));
    }
  }

  function runtimeFor(state: SessionState, dispose: () => void): Runtime {
    return {
      vendor: options.vendor,
      sessionId: state.id,
      get model() { return state.model; },
      get modes() { return state.modes; },
      get context() { return state.context; },
      get lost() { return dead !== null || state.closed || state.stuck; },
      prompt: (input, signal) => prompt(state, input, signal),
      setPermissionMode: mode => setPermissionMode(state, mode),
      setModel: next => setModel(state, next),
      setThinkingLevel: level => setThinkingLevel(state, level),
      fork: forked => fork(state, forked),
      steer: text => steer(state, text),
      stopTask: id => stopTask(state, id),
      dispose,
    };
  }

  // Startup waits on the adapter several times over, and one that never
  // answers would hold the turn for good. Cancelling the turn, which the
  // user or a worker's watchdog does, ends the process instead, and that
  // fails whichever request is still waiting.
  const cancelStartup = () => disposeProcess();
  options.signal?.addEventListener('abort', cancelStartup, { once: true });
  try {
    if (options.signal?.aborted) cancelStartup();
    throwIfAborted(options.signal);
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
    if (launch.authenticate) {
      await connection.agent.request(methods.agent.authenticate, { methodId: launch.authenticate.methodId });
    }

    const params = launch.session({
      directory: options.directory,
      systemPrompt: options.systemPrompt,
      mcpServer: options.mcpServer,
      tools: options.tools,
    });
    const openingParams = {
      cwd: options.directory,
      mcpServers: params.mcpServers,
      ...(params.meta ? { _meta: params.meta } : {}),
      ...(params.additionalDirectories ? { additionalDirectories: params.additionalDirectories } : {}),
    };
    let session;
    let state: SessionState;
    if (options.resume) {
      // Resume preserves the conversation without replay; older adapters may
      // offer only load, whose historical notifications are discarded below.
      const capabilities = initialized.agentCapabilities;
      const method = capabilities?.sessionCapabilities?.resume != null
        ? methods.agent.session.resume
        : capabilities?.loadSession ? methods.agent.session.load : null;
      if (!method) throw new Error(`The ${vendorName} adapter cannot reopen a session`);
      state = register(options.resume.sessionId, options.directory, options, options.model);
      state.reopening = true;
      session = await connection.agent.request(method, { sessionId: state.id, ...openingParams });
      await finishReopening(state);
    } else {
      ({ opened: session, state } = await openSession(
        () => connection.agent.request(methods.agent.session.new, openingParams),
        options.directory, options, options.model,
      ));
    }
    state.modes = session.modes?.availableModes ?? [];
    state.currentModeId = session.modes?.currentModeId ?? '';
    state.configOptions = session.configOptions ?? [];
    const models = listedModelsIn(state.configOptions);
    if (selectOption(state.configOptions, 'model')) options.onUpdate({ type: 'models', models });
    if (!options.discoverModelsOnly) await configure(state, launch.mode, options.model, options.thinkingLevel);
    return runtimeFor(state, disposeProcess);
  } catch (error) {
    const failure = options.signal?.aborted ? abortReason(options.signal) : settled(error);
    disposeProcess();
    throw failure;
  } finally {
    options.signal?.removeEventListener('abort', cancelStartup);
  }
}
