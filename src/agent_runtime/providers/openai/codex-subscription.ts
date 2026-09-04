import { subscriptionEnvironment } from '../profiles';
import { dataDirectory } from '../../../persistence';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ImageBlock, Message, MessageBlock, ToolCallBlock, Usage } from '../../types';
import type { Response } from '../../chat';
import type { Transport } from '../provider';
import type { TurnContext } from '../../turn';
import { systemPromptFor } from '../../prompt';
import { availableTools, runTool, type ToolArgumentSchema } from '../../tools';
import { latestUserText, promptWithSharedHistory, unseenImages } from '../subscription';
import { CodexRpc } from './codex-rpc';
import { abortReason, abortable, throwIfAborted } from '../../../abort';
import type { PermissionContext } from '../../permissions/permissions';
import { SIRUS_VERSION } from '../../../version';
import {
  WEB_SEARCH_TOOL,
  fetchUrlCall,
  fetchUrlResult,
  webSearchCall,
  webSearchResult,
} from '../../tools/web';
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from '../../types';
import { validatedImagePath } from '../../../images';

// Codex, reduced to a model transport: one app-server per account, one thread per
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

// One side of Codex's thread/tokenUsage/updated notification: the thread's
// running total, or the last request alone.
export interface TokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const NO_TOKENS: TokenBreakdown = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

interface Turn {
  blocks: MessageBlock[];
  partialText: Map<string, Extract<MessageBlock, { type: 'text' }>>;
  updateStream?: TurnContext['updateStream'];
  failure: string | null;
  finish: (error?: Error) => void;
  // the thread total when the turn started, so its own cost is the difference
  usageBaseline: TokenBreakdown;
  usage: Usage | null;
  signal?: AbortSignal;
  permissions?: PermissionContext;
}

interface CodexSession {
  threadId: string;
  agent: TurnContext['agent'];
  model: string;
  turn: Turn | null;
  hasSpoken: boolean;
  seenMessageCount: number;
  participantName: string;
  directory: string;
  // the latest thread total Codex reported
  usageTotal: TokenBreakdown;
}

type Json = Record<string, unknown>;

export function codexTurnUsage(
  total: TokenBreakdown,
  last: TokenBreakdown,
  baseline: TokenBreakdown,
  contextWindow?: number,
): Usage {
  return {
    inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
    contextTokens: Math.max(0, last.totalTokens),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

export function codexTurnInput(text: string, images: readonly ImageBlock[]): Json[] {
  const input: Json[] = [];
  for (const image of images) {
    try {
      input.push({ type: 'localImage', path: validatedImagePath(image) });
    } catch {
      input.push({ type: 'text', text: '[An attached image is no longer available.]' });
    }
  }
  if (text) input.push({ type: 'text', text });
  return input;
}

function createCodexRuntime(profile: string) {
  const sessions = new Map<string, CodexSession>();

  function resetRuntime(runtimeId: string): void {
    sessions.delete(runtimeId);
  }

  function resetAllRuntimes(): void {
    sessions.clear();
  }
  let rpcPromise: Promise<CodexRpc> | null = null;

  function getCodexRpc(): Promise<CodexRpc> {
    rpcPromise ??= CodexRpc.start(CODEX_CLIENT_INFO, { ...PROCESS_CONFIG, ...(profile !== 'default' ? { cli_auth_credentials_store: 'file' } : {}) }, subscriptionEnvironment('gpt', profile)).then(rpc => {
      rpc.onNotification(handleNotification);
      rpc.onRequest('item/tool/call', handleToolCall);
      return rpc;
    }).catch(error => { rpcPromise = null; throw error; });
    return rpcPromise.then(rpc => {
      if (rpc.isAlive) return rpc;
      // the server died; every thread it held is gone with it
      rpcPromise = null;
      sessions.clear();
      return getCodexRpc();
    });
  }

  function shutdown(): void {
    const activeRpc = rpcPromise;
    rpcPromise = null;
    sessions.clear();
    // The app-server's stdio pipes keep the event loop alive after Ink unmounts.
    // Close a server that is already ready, or as soon as an in-flight startup
    // finishes, without making terminal shutdown wait on provider initialization.
    void activeRpc?.then(
      rpc => rpc.close(),
      () => void 0,
    );
  }

  function sessionForThread(threadId: unknown): CodexSession | undefined {
    for (const session of sessions.values()) {
      if (session.threadId === threadId) return session;
    }
    return undefined;
  }

  function tokenBreakdown(value: unknown): TokenBreakdown {
    const json = typeof value === 'object' && value !== null ? value as Json : {};
    const field = (name: keyof TokenBreakdown) => typeof json[name] === 'number' ? json[name] as number : 0;
    return {
      totalTokens: field('totalTokens'),
      inputTokens: field('inputTokens'),
      outputTokens: field('outputTokens'),
      reasoningOutputTokens: field('reasoningOutputTokens'),
    };
  }



  // Codex reports the thread's running total and the last request; the turn's
  // own cost is the total less what the thread had used when it started, while
  // the last request's total is the active context size.
  function recordTokenUsage(session: CodexSession, params: Json): void {
    const reported = typeof params.tokenUsage === 'object' && params.tokenUsage !== null ? params.tokenUsage as Json : {};
    const total = tokenBreakdown(reported.total);
    const last = tokenBreakdown(reported.last);
    session.usageTotal = total;
    const turn = session.turn;
    if (!turn) return;
    const window = typeof reported.modelContextWindow === 'number' ? reported.modelContextWindow : null;
    turn.usage = codexTurnUsage(total, last, turn.usageBaseline, window ?? undefined);
  }

  function handleNotification(method: string, params: Json): void {
    const session = sessionForThread(params.threadId);
    if (!session) return;
    if (method === 'thread/tokenUsage/updated') {
      recordTokenUsage(session, params);
      return;
    }
    const turn = session.turn;
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
    turn.updateStream?.([...turn.blocks, ...turn.partialText.values()].map(block => ({ ...block })));
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
    const result = await runTool(
      toolCall,
      session.directory,
      turn.signal,
      turn.permissions,
      session.agent,
    );
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
    // If configuration cannot be read, do not start a thread with unknown MCP
    // tools that could bypass Sirus permissions and checkpoint barriers.
    const response = await rpc.request<Json>('config/read', { includeLayers: false, cwd: directory });
    const config = response.config as Json | undefined;
    const servers = (config?.mcp_servers ?? (config?.additional as Json | undefined)?.mcp_servers) as Json | undefined;
    return Object.fromEntries(Object.keys(servers ?? {}).map(name => [name, { enabled: false }]));
  }

  async function ensureSession(rpc: CodexRpc, turn: TurnContext): Promise<CodexSession> {
    const { agent, directory } = turn;
    const { model, subagent, runtimeId: sessionId } = agent;
    const participantName = agent.name;
    const existing = sessions.get(sessionId);
    if (existing) return existing;

    const response = await rpc.request<Json>('thread/start', {
      model,
      cwd: directory,
      approvalPolicy: 'never',
      // Sirus executes dynamic tools itself and applies its own permission checks.
      // The sandbox here is only what the model is told about its environment:
      // anything narrower makes it refuse writes (outside cwd, or at all) before
      // Sirus ever gets a chance to authorize and run them.
      sandbox: 'danger-full-access',
      ephemeral: true,
      // no environment means no environment-bound tools (apply_patch, view_image)
      environments: [],
      serviceName: CODEX_CLIENT_INFO.name,
      baseInstructions: systemPromptFor(turn),
      config: {
        ...MODEL_ONLY_CONFIG,
        ...(turn.tools ? {} : { web_search: 'disabled' }),
        mcp_servers: await disabledMcpServers(rpc, directory),
      },
      dynamicTools: (turn.tools ? availableTools({ subagent }) : []).map(definition => ({
        type: 'function',
        name: definition.name,
        description: definition.description,
        inputSchema: toInputSchema(definition.args),
      })),
    });
    const thread = response.thread as Json;
    const session: CodexSession = {
      threadId: String(thread.id),
      agent,
      model,
      turn: null,
      hasSpoken: false,
      seenMessageCount: 0,
      participantName,
      directory,
      usageTotal: NO_TOKENS,
    };
    sessions.set(sessionId, session);
    return session;
  }



  async function runTurn(
    rpc: CodexRpc,
    session: CodexSession,
    text: string,
    images: readonly ImageBlock[],
    model: string,
    signal?: AbortSignal,
    updateStream?: TurnContext['updateStream'],
    permissions?: PermissionContext,
    thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL,
  ): Promise<{ content: MessageBlock[]; usage: Usage | null }> {
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
    const turn: Turn = {
      blocks: [],
      partialText: new Map(),
      updateStream,
      failure: null,
      finish,
      usageBaseline: session.usageTotal,
      usage: null,
      signal,
      permissions,
    };
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
      // Codex reads attached images straight from disk.
      const starting = rpc.request<Json>('turn/start', {
        threadId: session.threadId,
        input: codexTurnInput(text, images),
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
      return { content: turn.blocks, usage: turn.usage };
    } finally {
      signal?.removeEventListener('abort', interrupt);
      session.turn = null;
    }
  }

  async function getResponse(
    messages: readonly Message[],
    turn: TurnContext,
  ): Promise<Response> {
    const { agent, signal } = turn;
    throwIfAborted(signal);
    if (!turn.tools) return bareRequest(messages, turn);
    const rpc = await abortable(getCodexRpc(), signal);
    const session = await abortable(ensureSession(rpc, turn), signal);
    throwIfAborted(signal);
    const { content, usage } = await runTurn(
      rpc,
      session,
      promptWithSharedHistory(
        messages,
        !session.hasSpoken,
        session.seenMessageCount,
        agent.name,
        turn.turnPrompt,
      ),
      unseenImages(messages, !session.hasSpoken, session.seenMessageCount),
      agent.model,
      signal,
      blocks => turn.updateStream(blocks),
      turn.permissions,
      agent.thinkingLevel,
    );
    session.seenMessageCount = messages.length;
    return { content, stop_reason: 'end_turn', ...(usage ? { usage } : {}) };
  }

  // A tool-less turn is one short exchange on a throwaway thread: the turn's
  // system prompt is the base instructions, the answer is the agent message.
  // Nothing is kept for the runtime id.
  async function bareRequest(messages: readonly Message[], turn: TurnContext): Promise<Response> {
    const { agent, signal } = turn;
    const rpc = await abortable(getCodexRpc(), signal);
    const { directory } = turn;
    const started = await abortable(rpc.request<Json>('thread/start', {
      model: agent.model,
      cwd: directory,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      environments: [],
      serviceName: CODEX_CLIENT_INFO.name,
      baseInstructions: systemPromptFor(turn),
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
          else reject(new Error(`Codex turn ${String(result.status)}`));
        }
      });
      const onAbort = () => {
        unsubscribe();
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    void answer.catch(() => void 0);
    const textInput = latestUserText(messages);
    const last = messages[messages.length - 1];
    const images = last?.role === 'user'
      ? last.content.filter((block): block is ImageBlock => block.type === 'image')
      : [];
    await abortable(rpc.request('turn/start', {
      threadId,
      input: codexTurnInput(textInput, images),
    }), signal);
    return { content: [{ type: 'text', text: await answer }], stop_reason: 'end_turn' };
  }

  const transport: Transport = {
    dispose: shutdown,
    getResponse,
    resetRuntime,
    resetAllRuntimes,
  };

  return { transport, getCodexRpc, shutdown };
}

const runtimes = new Map<string, ReturnType<typeof createCodexRuntime>>();
function runtimeFor(profile = 'default') {
  const key = JSON.stringify([dataDirectory(), profile]);
  let runtime = runtimes.get(key);
  if (!runtime) { runtime = createCodexRuntime(profile); runtimes.set(key, runtime); }
  return runtime;
}
export function getCodexRpc(profile = 'default'): Promise<CodexRpc> { return runtimeFor(profile).getCodexRpc(); }
export function codexSubscriptionTransport(profile: string): Transport { return runtimeFor(profile).transport; }
export function shutdownCodexRuntime(): void {
  for (const runtime of runtimes.values()) runtime.shutdown();
  runtimes.clear();
}
export const subscriptionTransport: Transport = {
  getResponse: (messages, turn) => runtimeFor().transport.getResponse(messages, turn),
  resetRuntime: id => { for (const runtime of runtimes.values()) runtime.transport.resetRuntime?.(id); },
  resetAllRuntimes: () => { for (const runtime of runtimes.values()) runtime.transport.resetAllRuntimes?.(); },
};
