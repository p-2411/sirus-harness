import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  StopReason,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { abortable, abortReason, throwIfAborted, TurnCancelledError } from '../../abort';
import type { PermissionMode } from '../permissions/policy';
import type { ListedModel, Vendor } from '../providers/catalog';
import type {
  ImageBlock,
  NoticeBlock,
  PlanEntry,
  ThinkingLevel,
  ToolCallBlock,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
  TurnUsage,
} from '../types';
import type { ContextUsage } from '../usage';
import { startAcpRuntime } from './acp';
import type { NativeCommand } from './commands';

// A runtime is one agent process plus one ACP session inside it: the vendor's
// own harness running the vendor's own tools, reached through the protocol.
// Everything above this file is written once against these shapes; a vendor
// is a launch spec (`./launch`) and the ACP client (`./acp`) is the only code
// that speaks the wire protocol.

// The tag both adapters put on a session mode's `_meta.kind`, and what
// Sirus's own modes map onto.
export type ModeKind = 'standard' | 'auto_review' | 'full_access';

export interface RuntimeOptions {
  // Cancels startup only; the prompt has its own signal once the runtime is ready.
  signal?: AbortSignal;
  vendor: Vendor;
  model: string;
  // Unset leaves the model at its own default depth.
  thinkingLevel?: ThinkingLevel;
  // Where the session runs; relative paths in tool calls resolve here.
  directory: string;
  // Reopen the vendor's conversation in the directory it was created in.
  // Failure rejects creation; the owner decides whether to seed a fresh one.
  resume?: { sessionId: string; directory: string };
  // Sirus's system prompt for this participant, repository instructions
  // included. The launch spec decides how the vendor receives it.
  systemPrompt: string;
  // The environment of the agent process: the credential and the profile
  // directory, built by `subscriptionEnvironment` or from an API key.
  env: NodeJS.ProcessEnv;
  // The Sirus MCP server this session lists in `session/new`, with the
  // per-session token and the participant name in its headers. Null for a
  // bare runtime that gets no Sirus tools at all.
  mcpServer: { name: string; url: string; headers: { name: string; value: string }[] } | null;
  // A bare runtime answers one question and keeps nothing: no Sirus tools and
  // as few native tools as the vendor allows. Session naming uses one.
  bare?: boolean;
  // Read session metadata without selecting a model or preparing a turn.
  discoverModelsOnly?: boolean;
  tools?: readonly string[];
  readOnly?: boolean;
  permissionMode: PermissionMode;
  // Whatever the vendor escalates arrives here. A cancelled prompt must
  // answer `{ outcome: 'cancelled' }`; the signal is the prompt's.
  onPermission: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  // A question the agent puts to the user, as a form: Claude's
  // AskUserQuestion, Codex's request_user_input, an MCP server's form. A
  // runtime without it declines them. The signal is the prompt's.
  onElicitation?: (request: CreateElicitationRequest, signal: AbortSignal) => Promise<CreateElicitationResponse>;
  // Every `session/update` the runtime received, already reduced.
  onUpdate: (update: RuntimeUpdate) => void;
}

export interface BackgroundTask {
  id: string;
  name: string;
  description?: string;
  state: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  canStop: boolean;
  toolCallId?: string;
  summary?: string;
  outputFilePath?: string;
}

// AIR task updates are extensions to ACP, shared by both adapters. Keep a
// complete task when a progress update carries only one changed field.
export function backgroundTaskFrom(update: unknown, previous?: BackgroundTask): BackgroundTask | null {
  if (!update || typeof update !== 'object') return null;
  const value = update as Record<string, unknown>;
  if (!['async_task_spawned', 'async_task_progress', 'async_task_state_update'].includes(String(value.sessionUpdate))
    || typeof value.asyncTaskId !== 'string') return null;
  const task: BackgroundTask = previous ? { ...previous } : {
    id: value.asyncTaskId, name: 'Background task', state: 'running', canStop: false,
  };
  for (const field of ['name', 'description', 'toolCallId', 'summary', 'outputFilePath'] as const) {
    if (typeof value[field] === 'string') task[field] = value[field];
  }
  if (typeof value.canStop === 'boolean') task.canStop = value.canStop;
  if (['running', 'paused', 'completed', 'failed', 'stopped'].includes(String(value.state))) {
    task.state = value.state as BackgroundTask['state'];
  }
  if (task.state !== 'running' && task.state !== 'paused') task.canStop = false;
  return task;
}

export type RuntimeUpdate =
  | { type: 'async_task'; task: BackgroundTask }
  | { type: 'rate_limit'; resetsAt?: number }
  // A chunk of the reply. Chunks of one message share its id, when the
  // vendor sends one; a new id starts a new message.
  | { type: 'text'; text: string; messageId?: string }
  | { type: 'thought'; text: string }
  | NoticeBlock
  // A new call, or an update to one already reported: merge by id.
  | { type: 'tool_call'; call: ToolCallBlock }
  | { type: 'context'; usage: ContextUsage }
  // What the turn used, once it has ended.
  | { type: 'usage'; usage: TurnUsage }
  | { type: 'compaction'; status: 'in_progress' | 'completed' | 'failed' | 'cancelled'; summary?: string }
  // The vendor changed the session's mode, on request or on its own. Kind is
  // null when the vendor did not tag the mode.
  | { type: 'mode'; modeId: string; kind: ModeKind | null }
  // The slash commands the vendor's harness offers now, the whole list.
  | { type: 'commands'; commands: NativeCommand[] }
  // The models the vendor's harness offers, as its session opened.
  | { type: 'models'; models: ListedModel[] }
  // The reasoning depths the vendor's effort option offers for the model the
  // session is on now, empty when it has no such option, and the one the
  // vendor picks for that model when nobody sets one, once the session has seen it.
  | { type: 'efforts'; efforts: string[]; default?: string }
  // The MCP servers the vendor's harness has for this session and how each
  // connection stands, as Claude Code reports them at the start of a turn.
  | { type: 'mcp_servers'; servers: McpServerState[] }
  // The agent's plan, the whole of it: Claude's todo list, Codex's plan.
  | { type: 'plan'; entries: PlanEntry[] };

export interface McpServerState {
  name: string;
  // The vendor's word: connected, failed, needs-auth, pending, disabled.
  status: string;
}

export interface PromptInput {
  text: string;
  images: readonly ImageBlock[];
  // Text that goes ahead of the prompt as a block of its own, so the prompt
  // stays the last text block, where Claude Code reads a slash command.
  context?: string;
}

export interface PromptResult {
  stopReason: StopReason;
}

// What a forked runtime takes from the caller rather than inheriting from
// the runtime it was forked from: it runs somewhere else, for someone else,
// with its own callbacks and its own Sirus tool entry, which both adapters
// do honour. The conversation so far is inherited, and so, in practice, is
// the system prompt: Codex's is the process's instructions file, and Claude
// ignores the one a fork is opened with and keeps what the forked transcript
// was written under. `systemPrompt` is still what a fork would be given, so
// it is sent; a worker that needs its own instructions today has to carry
// them in its first prompt.
export type ForkOptions = Pick<RuntimeOptions,
  'directory' | 'model' | 'thinkingLevel' | 'systemPrompt' | 'permissionMode' | 'mcpServer' | 'onPermission'
  | 'onElicitation' | 'onUpdate' | 'tools' | 'readOnly'>;

export interface Runtime {
  readonly vendor: Vendor;
  // The vendor's persisted session/thread id, including for owner forks.
  readonly sessionId: string;
  readonly model: string;
  // The vendor's modes as `session/new` returned them, in the vendor's order.
  readonly modes: readonly SessionMode[];
  // The latest usage update, or null before the first.
  readonly context: ContextUsage | null;
  // True once this runtime can take no more prompts: its process ended, it
  // was disposed, or it never answered a cancel. Its owner rebuilds it.
  readonly lost: boolean;
  // Runs one turn: `session/prompt`, resolved when the vendor ends it. Aborting
  // the signal sends `session/cancel` and rejects with the abort reason. Any
  // other rejection means the runtime is lost and must be rebuilt.
  prompt(input: PromptInput, signal: AbortSignal): Promise<PromptResult>;
  // `session/set_mode` to the vendor mode whose kind matches Sirus's mode.
  // Resolves to the mode the vendor settled on, which may differ (Claude drops
  // to manual when the model lacks auto mode).
  setPermissionMode(mode: PermissionMode): Promise<{ modeId: string; kind: ModeKind | null }>;
  // `session/set_config_option` for the model. False when the option cannot
  // apply, in which case the caller rebuilds the runtime.
  setModel(model: string): Promise<boolean>;
  // Undefined puts the session back at its model's default depth.
  setThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
  // `session/fork`: a second session on the same adapter process that
  // starts from this one's conversation so far, prompted separately from
  // then on. Works while this runtime is mid-prompt. Rejects when the vendor
  // cannot fork, in which case the caller starts a fresh runtime instead.
  // The fork shares this runtime's process: disposing this runtime loses
  // the fork too, and its next prompt rejects like any lost runtime's.
  // What comes back is untracked, so whoever keeps it passes it through
  // `trackRuntime` the way `createRuntime` does for a runtime it started.
  fork(options: ForkOptions): Promise<Runtime>;
  // `_session/steering`: injects text into the prompt in flight, which the
  // vendor folds into the running turn. Rejects when this runtime is running
  // no prompt, when the vendor cannot steer, and when it takes the text some
  // other way than into the running turn; the caller then reports that
  // instead. Resolving means the text reached the turn, not that the turn
  // acted on it.
  steer(text: string): Promise<void>;
  // Stops one background shell without cancelling the participant’s turn.
  stopTask(id: string): Promise<boolean>;
  // Ends the process, or for a fork just its session, leaving the process up
  // for the runtime it was forked from. Idempotent.
  dispose(): void;
}

// A runtime bound directly to a model id, bypassing the catalog and the
// launch specs. Nothing in the app binds one; the test suite binds scripted
// runtimes here so sessions can run without an agent process.
export const boundRuntimes: Record<string, (options: RuntimeOptions) => Runtime | Promise<Runtime>> = {};

const live = new Set<Runtime>();
const starting = new Set<AbortController>();

// Every runtime the process started and has not yet disposed. The app tears
// them all down when Ink exits, so their stdio cannot keep the CLI alive; an
// exit that skips that still takes every agent process down with it.
process.once('exit', () => disposeAllRuntimes());

export function trackRuntime(runtime: Runtime): Runtime {
  live.add(runtime);
  const dispose = runtime.dispose.bind(runtime);
  runtime.dispose = () => {
    live.delete(runtime);
    dispose();
  };
  return runtime;
}

export function disposeAllRuntimes(): void {
  for (const controller of starting) controller.abort(new TurnCancelledError('Runtimes stopped'));
  for (const runtime of [...live]) runtime.dispose();
  live.clear();
}

// Bumped whenever something every runtime has baked in changes, such as the
// system prompt after /memory on or off. A participant whose runtime predates
// the current generation rebuilds it on its next turn.
let generation = 0;

export function runtimeGeneration(): number {
  return generation;
}

export function invalidateAllRuntimes(): void {
  generation++;
  disposeAllRuntimes();
}

// Starts a runtime for the model: a scripted one when the test suite bound
// it, otherwise the vendor's adapter process.
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  throwIfAborted(options.signal);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  options = { ...options, signal };
  starting.add(controller);
  const bound = boundRuntimes[options.model];
  const started = Promise.resolve().then(async () => {
    throwIfAborted(signal);
    const runtime = bound ? await bound(options) : await startAcpRuntime(options);
    if (signal.aborted) {
      runtime.dispose();
      throw abortReason(signal);
    }
    return trackRuntime(runtime);
  }).finally(() => starting.delete(controller));
  return abortable(started, signal);
}

// The first vendor mode of the kind Sirus's mode maps onto, in the vendor's
// order; null when the vendor offers none of that kind.
export const MODE_KINDS: Record<PermissionMode, ModeKind> = {
  ask: 'standard',
  auto: 'auto_review',
  bypass: 'full_access',
};

export function modeKindOf(mode: SessionMode): ModeKind | null {
  const kind = mode._meta?.kind;
  return kind === 'standard' || kind === 'auto_review' || kind === 'full_access' ? kind : null;
}

export function vendorModeFor(mode: PermissionMode, available: readonly SessionMode[]): SessionMode | null {
  return available.find(candidate => modeKindOf(candidate) === MODE_KINDS[mode]) ?? null;
}

// ACP tool calls into the block the transcript records. A `tool_call`
// notification starts a block; every `tool_call_update` folds into it, so
// the block always shows the latest of each field the updates carried.

function toolKind(kind: unknown): ToolKind {
  switch (kind) {
    case 'read': case 'edit': case 'delete': case 'move': case 'search':
    case 'execute': case 'think': case 'fetch': case 'switch_mode':
      return kind;
    default:
      return 'other';
  }
}

// Where each diff starts. Claude sends one diff per hunk of a change, each
// with a location carrying its line, in the same order. codex-acp sends whole
// files, old and new, tagged with the change's kind in `_meta`; so is a new
// file anyone sends. An excerpt with no line has no position to give.
function diffLine(
  item: { path: string; oldText?: string | null; _meta?: { [key: string]: unknown } | null },
  location: { path: string; line?: number | null } | undefined,
): number | undefined {
  if (location?.path === item.path && typeof location.line === 'number') return location.line;
  return item.oldText == null || typeof item._meta?.kind === 'string' ? 1 : undefined;
}

function toolContent(
  content: ToolCall['content'] | ToolCallUpdate['content'],
  locations: ToolCall['locations'] | ToolCallUpdate['locations'],
): ToolCallContent[] | undefined {
  if (!content) return undefined;
  const blocks: ToolCallContent[] = [];
  let diffs = 0;
  for (const item of content) {
    if (item.type === 'diff') {
      const line = diffLine(item, locations?.[diffs++]);
      blocks.push({
        type: 'diff', path: item.path, oldText: item.oldText ?? null, newText: item.newText,
        ...(line !== undefined ? { line } : {}),
      });
    } else if (item.type === 'content' && item.content.type === 'text') {
      blocks.push({ type: 'text', text: item.content.text });
    }
    // A terminal carries nothing to show: Sirus advertises none, yet
    // codex-acp names one for every shell command. The command's output
    // arrives as its raw output instead.
  }
  return blocks;
}

function toolLocations(locations: ToolCall['locations'] | ToolCallUpdate['locations']): ToolCallLocation[] | undefined {
  if (!locations) return undefined;
  return locations.map(location => ({
    path: location.path,
    ...(typeof location.line === 'number' ? { line: location.line } : {}),
  }));
}

export function toolCallBlockFrom(call: ToolCall | ToolCallUpdate, existing?: ToolCallBlock): ToolCallBlock {
  const base: ToolCallBlock = existing ?? {
    type: 'tool_call',
    id: call.toolCallId,
    title: '',
    kind: 'other',
    status: 'pending',
    locations: [],
    content: [],
  };
  const content = toolContent(call.content, call.locations);
  const locations = toolLocations(call.locations);
  return {
    ...base,
    ...(typeof call.title === 'string' && call.title ? { title: call.title } : {}),
    ...(call.kind ? { kind: toolKind(call.kind) } : {}),
    ...(call.status ? { status: call.status } : {}),
    ...(locations ? { locations } : {}),
    ...(content ? { content } : {}),
    ...(call.rawInput !== undefined ? { input: call.rawInput } : {}),
    ...(call.rawOutput !== undefined ? { output: call.rawOutput } : {}),
  };
}
