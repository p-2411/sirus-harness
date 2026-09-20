import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
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
import { launchFor } from './launch';
import {
  modeKindOf,
  toolCallBlockFrom,
  vendorModeFor,
  type ModeKind,
  type PromptInput,
  type PromptResult,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from './runtime';

// The ACP client: one adapter process on stdio, one session inside it. This
// is the only code that speaks the wire protocol; what it hands out is the
// runtime contract in `./runtime`.

const STDERR_TAIL_LINES = 20;
const KILL_GRACE_MS = 2_000;

// Sirus advertises compaction and nothing else: no fs, terminal, elicitation,
// plan or subagents, so the agents run their tools on disk themselves and
// nothing pulls execution back into this process.
const CLIENT_CAPABILITIES = { session: { compaction: {} } };

// The answer to a permission request that outlives its turn.
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

// The select option each adapter exposes for its reasoning depth.
const EFFORT_OPTION_IDS: Record<Vendor, string> = { claude: 'effort', gpt: 'reasoning_effort' };

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

  // Once set, every call rejects with it: the runtime is lost and the
  // participant rebuilds it.
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

  let sessionId = '';
  let modes: SessionMode[] = [];
  let currentModeId = '';
  // Counts `current_mode_update`s, so a set-mode call can tell whether the
  // vendor pushed a different mode while answering it.
  let modeUpdates = 0;
  let configOptions: SessionConfigOption[] = [];
  let context: ContextUsage | null = null;
  let model = options.model;
  const toolCalls = new Map<string, ToolCallBlock>();
  // Summary chunks by compaction id, until the terminal update carries them.
  const summaries = new Map<string, string>();
  // Compactions already reported as over. claude-agent-acp sends a second
  // terminal update for the same compaction to enrich its token counts, and a
  // `RuntimeUpdate` carries no id to merge the repeat onto, so it is dropped.
  const compacted = new Set<string>();

  // The turn in progress: its signal answers permission requests, and an
  // exception from `onUpdate` is kept to fail the turn with once it ends.
  let turn: { signal: AbortSignal; error: Error | null } | null = null;
  // A cancelled turn's `session/prompt` stays in flight until the vendor
  // answers it; the next turn waits for that answer so the adapter never
  // holds two prompts at once.
  let inFlight: Promise<unknown> = Promise.resolve();

  function compaction(id: string, status: CompactionStatus): RuntimeUpdate | null {
    if (compacted.has(id)) return null;
    const summary = summaries.get(id);
    if (status !== 'in_progress') {
      compacted.add(id);
      summaries.delete(id);
    }
    return { type: 'compaction', status, ...(summary ? { summary } : {}) };
  }

  function reduce(update: SessionUpdate): RuntimeUpdate | null {
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
          return status ? compaction(update.toolCallId, status) : null;
        }
        const call = toolCallBlockFrom(update, toolCalls.get(update.toolCallId));
        toolCalls.set(call.id, call);
        return { type: 'tool_call', call };
      }
      case 'usage_update':
        context = { tokens: update.used, window: update.size };
        return { type: 'context', usage: context };
      case 'compaction_summary_chunk':
        if (update.content.type === 'text') {
          summaries.set(update.compactionId, (summaries.get(update.compactionId) ?? '') + update.content.text);
        }
        return null;
      case 'compaction_update': {
        const status = compactionStatus(update.status);
        if (!status) return null;
        // The update's own summary replaces whatever the chunks built up.
        if (update.summary) summaries.set(update.compactionId, textOf(update.summary));
        return compaction(update.compactionId, status);
      }
      case 'current_mode_update': {
        currentModeId = update.currentModeId;
        modeUpdates++;
        const mode = modes.find(candidate => candidate.id === currentModeId);
        return { type: 'mode', modeId: currentModeId, kind: mode ? modeKindOf(mode) : null };
      }
      case 'config_option_update':
        configOptions = update.configOptions;
        return null;
      default:
        // User message echoes, plans, available commands and session info
        // carry nothing the transcript records.
        return null;
    }
  }

  function receive(update: SessionUpdate): void {
    const reduced = reduce(update);
    if (!reduced) return;
    try {
      options.onUpdate(reduced);
    } catch (error) {
      if (turn) turn.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  async function permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const signal = turn?.signal;
    if (!signal || signal.aborted) return CANCELLED;
    try {
      return await options.onPermission(request, signal);
    } catch (error) {
      if (signal.aborted) return CANCELLED;
      throw error;
    }
  }

  // One process, one session: every update on this connection is ours. The
  // casts bridge node's web-stream types and the runtime's globals, which
  // name the same objects.
  const connection = client({ name: 'sirus' })
    .onRequest(methods.client.session.requestPermission, ({ params }) => permission(params))
    .onNotification(methods.client.session.update, ({ params }) => { receive(params.update); })
    .connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    ));
  void connection.closed.then(() => { dead ??= lost('closed the connection'); });

  let disposed = false;
  function dispose(): void {
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

  function promptBlocks(input: PromptInput): ContentBlock[] {
    return [
      { type: 'text', text: input.text },
      ...input.images.map(image => ({ type: 'image' as const, data: imageData(image), mimeType: image.mediaType })),
    ];
  }

  async function prompt(input: PromptInput, signal: AbortSignal): Promise<PromptResult> {
    if (turn) throw new Error(`The ${options.vendor} runtime is already running a prompt`);
    await inFlight.catch(() => undefined);
    if (dead) throw dead;
    throwIfAborted(signal);
    const current = { signal, error: null as Error | null };
    turn = current;
    const cancel = () => {
      void connection.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    const request = connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: promptBlocks(input) });
    inFlight = request.catch(() => undefined);
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
      turn = null;
    }
  }

  async function setPermissionMode(mode: PermissionMode): Promise<{ modeId: string; kind: ModeKind | null }> {
    if (dead) throw dead;
    const target = vendorModeFor(mode, modes);
    if (target) {
      // A mode the vendor pushes while answering wins over the one asked for
      // (Claude drops to manual when the model lacks auto mode).
      const seen = modeUpdates;
      try {
        await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: target.id });
      } catch (error) {
        throw settled(error);
      }
      if (modeUpdates === seen) currentModeId = target.id;
    }
    const current = modes.find(candidate => candidate.id === currentModeId);
    return { modeId: currentModeId, kind: current ? modeKindOf(current) : null };
  }

  // Sends the value and says whether it took. The offered values are a hint,
  // not the whole truth — claude-agent-acp resolves ids it never lists, taking
  // `claude-sonnet-5` for `sonnet` — so asking is the only way to know.
  async function setOption(id: string, value: string): Promise<boolean> {
    const option = selectOption(configOptions, id);
    if (!option) return false;
    if (option.currentValue === value) return true;
    try {
      const response = await connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: id, value });
      configOptions = response.configOptions;
      return true;
    } catch (error) {
      if (refusedValue(error, id)) return false;
      throw settled(error);
    }
  }

  async function setModel(next: string): Promise<boolean> {
    if (dead) throw dead;
    if (!(await setOption('model', next))) return false;
    model = next;
    return true;
  }

  async function setThinkingLevel(level: ThinkingLevel): Promise<void> {
    if (dead) throw dead;
    const option = selectOption(configOptions, EFFORT_OPTION_IDS[options.vendor]);
    if (!option) return;
    // The level itself when the vendor offers it, else the nearest lower one
    // it does; nothing when none of Sirus's levels is on its list.
    const offered = selectValues(option);
    const value = THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf(level) + 1).reverse()
      .find(candidate => offered.includes(candidate));
    if (value) await setOption(option.id, value);
  }

  try {
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: 'sirus', version: SIRUS_VERSION },
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: options.directory,
      mcpServers: launch.mcpServers,
      ...(launch.meta ? { _meta: launch.meta } : {}),
    });
    sessionId = session.sessionId;
    modes = session.modes?.availableModes ?? [];
    currentModeId = session.modes?.currentModeId ?? '';
    configOptions = session.configOptions ?? [];
    await setPermissionMode(launch.mode);
    const modelOption = selectOption(configOptions, 'model');
    if (modelOption && !(await setOption('model', options.model))) {
      throw new Error(
        `${options.vendor} does not offer the model ${options.model}; it offers ${selectValues(modelOption).join(', ')}`,
      );
    }
    await setThinkingLevel(options.thinkingLevel);
  } catch (error) {
    const failure = settled(error);
    dispose();
    throw failure;
  }

  return {
    vendor: options.vendor,
    get model() { return model; },
    get modes() { return modes; },
    get context() { return context; },
    prompt,
    setPermissionMode,
    setModel,
    setThinkingLevel,
    dispose,
  };
}
