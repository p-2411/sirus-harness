import path from 'path';
import { fileURLToPath } from 'url';
import type { Message, MessageBlock, ToolCallBlock } from '../../../data/data';
import type { ModelContext, ModelStrategy, Response } from '../../chat';
import { getSystemPrompt } from '../../prompt';
import { availableTools, runTool, type ToolArgumentSchema } from '../../tools';
import { promptWithSharedHistory } from '../../subscriptions';
import { CodexRpc } from './codex-rpc';
import { abortReason, abortable, throwIfAborted } from '../../../abort';
import type { PermissionContext } from '../../permissions';
import type { JudgePrompt } from '../../judge';
import { SIRUS_VERSION } from '../../../version';
import {
  WEB_SEARCH_TOOL,
  fetchUrlCall,
  fetchUrlResult,
  webSearchCall,
  webSearchResult,
} from '../../web';
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from '../../thinking';

// Codex, reduced to a model transport: one app-server process, one thread per
// Sirus session, every built-in tool except web search switched off, Sirus's
// prompt as the base instructions, and Sirus's tools registered as dynamic
// tools that the server asks us to run. The ChatGPT login lives in Codex's
// own store.

export const CODEX_CLIENT_INFO = { name: 'sirus', title: 'Sirus', version: SIRUS_VERSION };

// Mirrors the overrides Codex itself uses for a tool-less, ephemeral thread,
// plus the apply_patch tool and AGENTS.md discovery.
const MODEL_ONLY_CONFIG: Record<string, unknown> = {
  'features.apps': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  // some models default to code mode; without a host it falls back to direct tools
  'features.code_mode_host': false,
  'features.current_time_reminder': false,
  'features.deferred_executor': false,
  'features.enable_fanout': false,
  'features.goals': false,
  'features.hooks': false,
  'features.image_generation': false,
  'features.memories': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.plugins': false,
  'features.request_permissions_tool': false,
  'features.shell_snapshot': false,
  'features.shell_tool': false,
  'features.standalone_web_search': false,
  'features.token_budget': false,
  'features.tool_suggest': false,
  'features.unified_exec': false,
  'features.view_image': false,
  'orchestrator.skills.enabled': false,
  'skills.include_instructions': false,
  'token_budget.use_history_notes_extension': false,
  'tools.experimental_request_user_input.enabled': false,
  'tools.update_plan.enabled': false,
  // The model provider's own web search, reported back as webSearch items.
  'web_search': 'live',
  // multi-agent tools hang off [agents], not the feature flag
  'agents.enabled': false,
  'project_doc_max_bytes': 0,
};

// Codex's bundled catalog hard-wires code mode, the shell, and apply_patch
// per model; this trimmed copy of it turns those off for the models Sirus uses.
const MODEL_CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-models.json');

const PROCESS_CONFIG: Record<string, unknown> = {
  ...MODEL_ONLY_CONFIG,
  model_catalog_json: MODEL_CATALOG_PATH,
};

const TURN_TIMEOUT_MS = 10 * 60 * 1000;

interface Turn {
  blocks: MessageBlock[];
  partialText: Map<string, Extract<MessageBlock, { type: 'text' }>>;
  onUpdate?: ModelContext['onUpdate'];
  failure: string | null;
  finish: (error?: Error) => void;
  signal?: AbortSignal;
  permissions?: PermissionContext;
}

interface CodexSession {
  threadId: string;
  model: string;
  turn: Turn | null;
  hasSpoken: boolean;
  seenMessageCount: number;
  participantName: string;
  directory: string;
}

type Json = Record<string, unknown>;

const sessions = new Map<string, CodexSession>();

export function clearCodexSubscriptionSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function clearAllCodexSubscriptionSessions(): void {
  sessions.clear();
}
let rpcPromise: Promise<CodexRpc> | null = null;

export function getCodexRpc(): Promise<CodexRpc> {
  rpcPromise ??= CodexRpc.start(CODEX_CLIENT_INFO, PROCESS_CONFIG).then(rpc => {
    rpc.onNotification(handleNotification);
    rpc.onRequest('item/tool/call', handleToolCall);
    return rpc;
  });
  return rpcPromise.then(rpc => {
    if (rpc.isAlive) return rpc;
    // the server died; every thread it held is gone with it
    rpcPromise = null;
    sessions.clear();
    return getCodexRpc();
  });
}

function sessionForThread(threadId: unknown): CodexSession | undefined {
  for (const session of sessions.values()) {
    if (session.threadId === threadId) return session;
  }
  return undefined;
}

function handleNotification(method: string, params: Json): void {
  const session = sessionForThread(params.threadId);
  const turn = session?.turn;
  if (!turn) return;

  if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
    const itemId = String(params.itemId ?? 'agent-message');
    let block = turn.partialText.get(itemId);
    if (!block) {
      block = { type: 'text', text: '' };
      turn.partialText.set(itemId, block);
    }
    block.text += params.delta;
    publishTurn(turn);
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = params.item as Json;
    if (item.type === 'webSearch') {
      recordWebSearch(turn, item, method === 'item/completed');
    } else if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
      turn.partialText.delete(String(item.id ?? 'agent-message'));
      turn.blocks.push({ type: 'text', text: item.text });
      publishTurn(turn);
    }
  } else if (method === 'error') {
    const error = params.error as Json | undefined;
    if (!params.willRetry && typeof error?.message === 'string') {
      turn.failure = error.message;
    }
  } else if (method === 'turn/completed') {
    const result = params.turn as Json;
    if (result.status === 'completed') {
      turn.finish();
    } else {
      const error = result.error as Json | null;
      turn.finish(turn.signal?.aborted ? abortReason(turn.signal) : new Error(
        (typeof error?.message === 'string' && error.message) || turn.failure || `Codex turn ${result.status}`,
      ));
    }
  }
}

function publishTurn(turn: Turn): void {
  turn.onUpdate?.([...turn.blocks, ...turn.partialText.values()].map(block => ({ ...block })));
}

// Codex runs web search inside the model provider and reports only what the
// model asked for: a search query, or a page it opened or searched within.
// The results themselves reach the model directly and are never sent to us.
const CODEX_WEB_NOTE = 'Codex ran this inside the model provider and read the results directly; it reports only what was searched or opened, not the content.';

function codexWebCall(item: Json): ToolCallBlock {
  const id = String(item.id);
  const action = (typeof item.action === 'object' && item.action !== null ? item.action : {}) as Json;
  const kind = String(action.type ?? 'search');
  if (kind === 'openPage' || kind === 'open_page' || kind === 'findInPage' || kind === 'find_in_page') {
    return fetchUrlCall(id, {
      url: String(action.url ?? ''),
      ...(typeof action.pattern === 'string' ? { prompt: action.pattern } : {}),
    });
  }
  const queries = Array.isArray(action.queries) ? action.queries.map(String) : [];
  const query = typeof action.query === 'string' && action.query
    ? action.query
    : typeof item.query === 'string' && item.query ? item.query : queries.join(' | ');
  return webSearchCall(id, { query });
}

// The query can still be filling in when the item starts, so a completed item
// replaces the call it recorded earlier before its result is appended.
function recordWebSearch(turn: Turn, item: Json, completed: boolean): void {
  const call = codexWebCall(item);
  const index = turn.blocks.findIndex(block => block.type === 'tool_call' && block.id === call.id);
  if (index === -1) turn.blocks.push(call);
  else turn.blocks[index] = call;
  if (completed) {
    turn.blocks.push(call.name === WEB_SEARCH_TOOL
      ? webSearchResult(call, { hits: [], note: CODEX_WEB_NOTE })
      : fetchUrlResult(call, { note: CODEX_WEB_NOTE }));
  }
  publishTurn(turn);
}

async function handleToolCall(params: Json): Promise<unknown> {
  const session = sessionForThread(params.threadId);
  const turn = session?.turn;
  if (!turn) {
    throw new Error(`Codex called ${String(params.tool)} outside of a turn`);
  }
  const args = params.arguments;
  const toolCall: ToolCallBlock = {
    type: 'tool_call',
    id: String(params.callId),
    name: String(params.tool),
    arguments: typeof args === 'object' && args !== null && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {},
  };
  turn.blocks.push(toolCall);
  publishTurn(turn);
  const result = await runTool(toolCall, session.directory, turn.signal, turn.permissions);
  turn.blocks.push(result);
  publishTurn(turn);
  return {
    contentItems: [{ type: 'inputText', text: result.result }],
    success: !result.isError,
  };
}

function toInputSchema(args: Record<string, ToolArgumentSchema>): Json {
  return {
    type: 'object',
    properties: args,
    required: Object.keys(args),
    additionalProperties: false,
  };
}

// Codex's own model-only threads disable every configured MCP server by
// name; do the same so nothing from the user's ~/.codex config leaks in.
async function disabledMcpServers(rpc: CodexRpc, directory: string): Promise<Json> {
  try {
    const response = await rpc.request<Json>('config/read', { includeLayers: false, cwd: directory });
    const config = response.config as Json | undefined;
    const servers = (config?.mcp_servers ?? (config?.additional as Json | undefined)?.mcp_servers) as Json | undefined;
    return Object.fromEntries(Object.keys(servers ?? {}).map(name => [name, { enabled: false }]));
  } catch {
    return {};
  }
}

async function ensureSession(
  rpc: CodexRpc,
  sessionId: string,
  model: string,
  directory: string,
  participantName: string,
  subagent: boolean,
): Promise<CodexSession> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const response = await rpc.request<Json>('thread/start', {
    model,
    cwd: directory,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    // no environment means no environment-bound tools (apply_patch, view_image)
    environments: [],
    serviceName: CODEX_CLIENT_INFO.name,
    baseInstructions: getSystemPrompt(directory, participantName, subagent),
    config: { ...MODEL_ONLY_CONFIG, mcp_servers: await disabledMcpServers(rpc, directory) },
    dynamicTools: availableTools({ subagent }).map(definition => ({
      type: 'function',
      name: definition.name,
      description: definition.description,
      inputSchema: toInputSchema(definition.args),
    })),
  });
  const thread = response.thread as Json;
  const session: CodexSession = {
    threadId: String(thread.id),
    model,
    turn: null,
    hasSpoken: false,
    seenMessageCount: 0,
    participantName,
    directory,
  };
  sessions.set(sessionId, session);
  return session;
}

async function runTurn(
  rpc: CodexRpc,
  session: CodexSession,
  text: string,
  model: string,
  signal?: AbortSignal,
  onUpdate?: ModelContext['onUpdate'],
  permissions?: PermissionContext,
  thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL,
): Promise<MessageBlock[]> {
  throwIfAborted(signal);
  let finish!: (error?: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex turn timed out')), TURN_TIMEOUT_MS);
    let finished = false;
    finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
  });
  // Cancellation can happen while turn/start is still awaiting its response.
  // Keep that early rejection observed even if we never reach `await completed`.
  void completed.catch(() => void 0);
  const turn: Turn = { blocks: [], partialText: new Map(), onUpdate, failure: null, finish, signal, permissions };
  session.turn = turn;
  let turnId: string | undefined;
  const interrupt = () => {
    if (!signal) return;
    finish(abortReason(signal));
    if (turnId) {
      void rpc.request('turn/interrupt', { threadId: session.threadId, turnId }).catch(() => void 0);
    }
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  try {
    const starting = rpc.request<Json>('turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text }],
      effort: thinkingLevel,
      ...(session.model !== model ? { model } : {}),
    });
    // If Escape lands while turn/start itself is in flight, interrupt the turn
    // as soon as app-server gives us its id instead of leaving it orphaned.
    void starting.then(started => {
      const startedTurn = started.turn as Json | undefined;
      turnId = typeof startedTurn?.id === 'string' ? startedTurn.id : undefined;
      if (signal?.aborted && turnId) {
        void rpc.request('turn/interrupt', { threadId: session.threadId, turnId }).catch(() => void 0);
      }
    }, () => void 0);
    await abortable(starting, signal);
    session.model = model;
    await completed;
    session.hasSpoken = true;
    publishTurn(turn);
    return turn.blocks;
  } finally {
    signal?.removeEventListener('abort', interrupt);
    session.turn = null;
  }
}

async function getResponse(
  messages: readonly Message[],
  model: string,
  context: ModelContext,
): Promise<Response> {
  throwIfAborted(context.signal);
  const rpc = await abortable(getCodexRpc(), context.signal);
  const participantName = context.participantName ?? 'sirus';
  const session = await abortable(ensureSession(
    rpc,
    context.sessionId,
    model,
    context.directory,
    participantName,
    context.subagent ?? false,
  ), context.signal);
  throwIfAborted(context.signal);
  const content = await runTurn(
    rpc,
    session,
    promptWithSharedHistory(
      messages,
      !session.hasSpoken,
      session.seenMessageCount,
      participantName,
      context.turnPrompt,
    ),
    model,
    context.signal,
    context.onUpdate,
    context.permissions,
    context.thinkingLevel,
  );
  session.seenMessageCount = messages.length;
  return { content, stop_reason: 'end_turn' };
}

// One short, tool-less turn on a throwaway thread: the prompt is the base
// instructions, the answer is the agent message. Used by the auto-approve
// judge.
async function judge(prompt: JudgePrompt, model: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const rpc = await abortable(getCodexRpc(), signal);
  const directory = process.cwd();
  const started = await abortable(rpc.request<Json>('thread/start', {
    model,
    cwd: directory,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    environments: [],
    serviceName: CODEX_CLIENT_INFO.name,
    baseInstructions: prompt.system,
    config: { ...MODEL_ONLY_CONFIG, web_search: 'disabled', mcp_servers: await disabledMcpServers(rpc, directory) },
    dynamicTools: [],
  }), signal);
  const threadId = String((started.thread as Json).id);

  let text = '';
  const answer = new Promise<string>((resolve, reject) => {
    const unsubscribe = rpc.onNotification((method, params) => {
      if (params.threadId !== threadId) return;
      if (method === 'item/completed') {
        const item = params.item as Json;
        if (item.type === 'agentMessage' && typeof item.text === 'string') text += item.text;
      } else if (method === 'turn/completed') {
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        const result = params.turn as Json;
        if (result.status === 'completed') resolve(text);
        else reject(new Error(`Codex judge turn ${String(result.status)}`));
      }
    });
    const onAbort = () => {
      unsubscribe();
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  void answer.catch(() => void 0);
  await abortable(rpc.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt.user }],
  }), signal);
  return answer;
}

export const CodexSubscriptionProvider: ModelStrategy = {
  getResponse,
  judge,
};
