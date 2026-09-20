import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  StopReason,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { PermissionMode } from '../permissions/policy';
import type { Vendor } from '../providers/catalog';
import type {
  ImageBlock,
  ThinkingLevel,
  ToolCallBlock,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '../types';
import type { ContextUsage } from '../usage';
import { startAcpRuntime } from './acp';

// A runtime is one agent process plus one ACP session inside it: the vendor's
// own harness running the vendor's own tools, reached through the protocol.
// Everything above this file is written once against these shapes; a vendor
// is a launch spec (`./launch`) and the ACP client (`./acp`) is the only code
// that speaks the wire protocol.

// The tag both adapters put on a session mode's `_meta.kind`, and what
// Sirus's own modes map onto.
export type ModeKind = 'standard' | 'auto_review' | 'full_access';

export interface RuntimeOptions {
  vendor: Vendor;
  model: string;
  thinkingLevel: ThinkingLevel;
  // Where the session runs; relative paths in tool calls resolve here.
  directory: string;
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
  permissionMode: PermissionMode;
  // Whatever the vendor escalates arrives here. A cancelled prompt must
  // answer `{ outcome: 'cancelled' }`; the signal is the prompt's.
  onPermission: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  // Every `session/update` the runtime received, already reduced.
  onUpdate: (update: RuntimeUpdate) => void;
}

export type RuntimeUpdate =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  // A new call, or an update to one already reported: merge by id.
  | { type: 'tool_call'; call: ToolCallBlock }
  | { type: 'context'; usage: ContextUsage }
  | { type: 'compaction'; status: 'in_progress' | 'completed' | 'failed' | 'cancelled'; summary?: string }
  // The vendor changed the session's mode, on request or on its own. Kind is
  // null when the vendor did not tag the mode.
  | { type: 'mode'; modeId: string; kind: ModeKind | null };

export interface PromptInput {
  text: string;
  images: readonly ImageBlock[];
}

export interface PromptResult {
  stopReason: StopReason;
}

export interface Runtime {
  readonly vendor: Vendor;
  readonly model: string;
  // The vendor's modes as `session/new` returned them, in the vendor's order.
  readonly modes: readonly SessionMode[];
  // The latest usage update, or null before the first.
  readonly context: ContextUsage | null;
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
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  // Ends the process. Idempotent.
  dispose(): void;
}

// A runtime bound directly to a model id, bypassing the catalog and the
// launch specs. Nothing in the app binds one; the test suite binds scripted
// runtimes here so sessions can run without an agent process.
export const boundRuntimes: Record<string, (options: RuntimeOptions) => Runtime | Promise<Runtime>> = {};

const live = new Set<Runtime>();

// Every runtime the process started and has not yet disposed. The app tears
// them all down when Ink exits, so their stdio cannot keep the CLI alive.
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
  for (const runtime of [...live]) runtime.dispose();
  live.clear();
}

// Starts a runtime for the model: a scripted one when the test suite bound
// it, otherwise the vendor's adapter process.
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const bound = boundRuntimes[options.model];
  const runtime = bound ? await bound(options) : await startAcpRuntime(options);
  return trackRuntime(runtime);
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

function toolContent(content: ToolCall['content'] | ToolCallUpdate['content']): ToolCallContent[] | undefined {
  if (!content) return undefined;
  const blocks: ToolCallContent[] = [];
  for (const item of content) {
    if (item.type === 'diff') {
      blocks.push({ type: 'diff', path: item.path, oldText: item.oldText ?? null, newText: item.newText });
    } else if (item.type === 'content' && item.content.type === 'text') {
      blocks.push({ type: 'text', text: item.content.text });
    } else if (item.type === 'terminal') {
      // Terminals are never advertised, so none arrive; a vendor that sends
      // one anyway is shown its id and nothing else.
      blocks.push({ type: 'text', text: `[terminal ${item.terminalId}]` });
    }
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
  const content = toolContent(call.content);
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
