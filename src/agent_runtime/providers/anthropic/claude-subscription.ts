import crypto from 'crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ImageBlock, Message, MessageBlock, ToolCallBlock, ToolResultBlock } from '../../types';
import type { Response } from '../../chat';
import type { Transport } from '../provider';
import type { TurnContext } from '../../turn';
import { systemPromptFor } from '../../prompt';
import { availableTools, runTool, type ToolArgumentSchema } from '../../tools';
import { latestUserText, promptWithSharedHistory, unseenImages } from '../subscription';
import { imageBlockParam } from './api';
import { abortable, throwIfAborted } from '../../../abort';
import type { PermissionContext } from '../../permissions/permissions';
import type { ThinkingLevel } from '../../types';
import { legacyClaudeThinkingBudget, usesLegacyClaudeThinking } from './api';
import { SIRUS_CLIENT_ID } from '../../../version';
import {
  WEB_SEARCH_TOOL,
  fetchUrlCall,
  fetchUrlResult,
  webSearchCall,
  webSearchResult,
  type WebSearchHit,
} from '../../tools/web';

// Claude Code, reduced to a model transport: Sirus's own prompt, Sirus's own
// tools (as an in-process MCP server), no built-in tools beyond its web
// search and fetch, no user settings, and the user's own claude.ai login
// supplying the credential. Sirus never reads or stores that credential.

const MCP_SERVER_NAME = 'sirus';
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Claude Code's own web tools. It runs them itself; Sirus records the call
// and the result it reports under Sirus's tool names.
const CLAUDE_WEB_SEARCH = 'WebSearch';
const CLAUDE_WEB_FETCH = 'WebFetch';

interface Turn {
  blocks: MessageBlock[];
  partialText: Map<number, Extract<MessageBlock, { type: 'text' }>>;
  updateStream?: TurnContext['updateStream'];
  // tool_call ids that already have a result, so repeated identical calls in
  // one turn pair with the right block
  resolved: Set<string>;
  // built-in web calls whose result Claude Code has not reported yet
  pendingWeb: Map<string, ToolCallBlock>;
  signal?: AbortSignal;
  permissions?: PermissionContext;
}

interface ClaudeSession {
  query: Query;
  iterator: AsyncIterator<SDKMessage>;
  send: (text: string, images?: readonly ImageBlock[]) => void;
  agent: TurnContext['agent'];
  model: string;
  thinkingLevel: ThinkingLevel;
  turn: Turn | null;
  hasSpoken: boolean;
  seenMessageCount: number;
  participantName: string;
  directory: string;
}

const sessions = new Map<string, ClaudeSession>();

function resetRuntime(runtimeId: string): void {
  const session = sessions.get(runtimeId);
  if (!session) return;
  sessions.delete(runtimeId);
  session.query.close();
}

function resetAllRuntimes(): void {
  for (const session of sessions.values()) session.query.close();
  sessions.clear();
}

function zodField(schema: ToolArgumentSchema): z.ZodTypeAny {
  let field: z.ZodTypeAny;
  switch (schema.type) {
    case 'string': field = z.string(); break;
    case 'number': field = z.number(); break;
    case 'integer': field = z.number().int(); break;
    case 'boolean': field = z.boolean(); break;
    case 'array': field = z.array(z.any()); break;
    case 'object': field = z.record(z.string(), z.any()); break;
  }
  return schema.description ? field.describe(schema.description) : field;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(key =>
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function toolArgs(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Claude returned invalid tool arguments');
  }
  return input as Record<string, unknown>;
}

// The SDK executes tools by calling this handler; it runs the same helper as
// the API loop and records the call and result into the turn being collected.
async function handleToolCall(session: ClaudeSession, name: string, args: Record<string, unknown>) {
  const turn = session.turn;
  if (!turn) {
    throw new Error(`Claude called ${name} outside of a turn`);
  }
  const wanted = stableStringify(args);
  const existing = turn.blocks.find((block): block is ToolCallBlock =>
    block.type === 'tool_call'
    && block.name === name
    && !turn.resolved.has(block.id)
    && stableStringify(block.arguments) === wanted,
  );
  const toolCall: ToolCallBlock = existing ?? {
    type: 'tool_call',
    id: crypto.randomUUID(),
    name,
    arguments: args,
  };
  if (!existing) turn.blocks.push(toolCall);
  turn.resolved.add(toolCall.id);
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
  return result;
}

function publishTurn(turn: Turn): void {
  turn.updateStream?.([...turn.blocks, ...turn.partialText.values()].map(block => ({ ...block })));
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function claudeWebCall(id: string, name: string, input: Json): ToolCallBlock | null {
  if (name === CLAUDE_WEB_SEARCH) {
    return webSearchCall(id, {
      query: String(input.query ?? ''),
      ...(Array.isArray(input.allowed_domains) ? { allowed_domains: input.allowed_domains.map(String) } : {}),
      ...(Array.isArray(input.blocked_domains) ? { blocked_domains: input.blocked_domains.map(String) } : {}),
    });
  }
  if (name === CLAUDE_WEB_FETCH) {
    return fetchUrlCall(id, {
      url: String(input.url ?? ''),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    });
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => asObject(part))
    .filter((part): part is Json => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n');
}

// Claude Code reports a WebSearch as the links it found plus its own summary
// of them, and a WebFetch as the page's answer to the prompt it was given.
function claudeWebResult(call: ToolCallBlock, block: Json, structured: unknown): ToolResultBlock {
  const text = toolResultText(block.content);
  const data = asObject(structured);
  if (call.name === WEB_SEARCH_TOOL) {
    if (block.is_error) return webSearchResult(call, { hits: [], error: text || 'the search failed' });
    if (!data) return webSearchResult(call, { hits: [], summary: text });
    const hits: WebSearchHit[] = [];
    const summary: string[] = [];
    for (const entry of Array.isArray(data.results) ? data.results : []) {
      if (typeof entry === 'string') {
        summary.push(entry);
        continue;
      }
      const links = asObject(entry)?.content;
      for (const link of Array.isArray(links) ? links.map(asObject) : []) {
        if (typeof link?.url !== 'string') continue;
        hits.push(typeof link.title === 'string' && link.title ? { url: link.url, title: link.title } : { url: link.url });
      }
    }
    return webSearchResult(call, { hits, summary: summary.join('\n\n') });
  }

  if (block.is_error) return fetchUrlResult(call, { error: text || 'the fetch failed' });
  const code = typeof data?.code === 'number' ? data.code : null;
  if (code !== null && code >= 400) {
    return fetchUrlResult(call, { error: `HTTP ${code}${typeof data?.codeText === 'string' ? ` ${data.codeText}` : ''}` });
  }
  return fetchUrlResult(call, {
    content: typeof data?.result === 'string' ? data.result : text,
    ...(typeof call.arguments.prompt === 'string'
      ? { note: 'Claude Code returned its answer to the prompt above, not the full page.' }
      : {}),
  });
}

// Built-in tool results arrive as user messages; only the web calls recorded
// from this turn's assistant messages are ours to translate.
function collectWebResults(turn: Turn, message: SDKUserMessage): void {
  if (message.parent_tool_use_id || turn.pendingWeb.size === 0) return;
  const content = message.message.content;
  if (!Array.isArray(content)) return;
  let changed = false;
  for (const part of content) {
    const block = asObject(part);
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const call = turn.pendingWeb.get(block.tool_use_id);
    if (!call) continue;
    turn.pendingWeb.delete(call.id);
    turn.blocks.push(claudeWebResult(call, block, message.tool_use_result));
    changed = true;
  }
  if (changed) publishTurn(turn);
}

function createInbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  return {
    push(message: SDKUserMessage) {
      queue.push(message);
      wake?.();
      wake = null;
    },
    async *messages(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    },
  };
}

function userMessage(text: string, images: readonly ImageBlock[]): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: images.length === 0
        ? text
        : [...images.map(imageBlockParam), ...(text ? [{ type: 'text' as const, text }] : [])],
    },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

async function* oneShotPrompt(text: string, images: readonly ImageBlock[]): AsyncGenerator<SDKUserMessage> {
  yield userMessage(text, images);
}

function latestUserImages(messages: readonly Message[]): ImageBlock[] {
  const last = messages[messages.length - 1];
  return last?.role === 'user'
    ? last.content.filter((block): block is ImageBlock => block.type === 'image')
    : [];
}

function createSession(turn: TurnContext): ClaudeSession {
  const { agent, directory } = turn;
  const { model, thinkingLevel, subagent } = agent;
  const participantName = agent.name;
  const inbox = createInbox();
  const session: Partial<ClaudeSession> = {
    agent,
    model,
    thinkingLevel,
    turn: null,
    hasSpoken: false,
    seenMessageCount: 0,
    participantName,
    directory,
  };

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: (turn.tools ? availableTools({ subagent }) : []).map(definition => tool(
      definition.name,
      definition.description,
      Object.fromEntries(
        Object.entries(definition.args).map(([name, schema]) => [name, zodField(schema)]),
      ),
      async args => {
        const result = await handleToolCall(session as ClaudeSession, definition.name, toolArgs(args));
        return { content: [{ type: 'text', text: result.result }], isError: result.isError };
      },
    )),
  });

  const q = query({
    prompt: inbox.messages(),
    options: {
      model,
      ...(usesLegacyClaudeThinking(model)
        ? { thinking: { type: 'enabled' as const, budgetTokens: legacyClaudeThinkingBudget(thinkingLevel) } }
        : { thinking: { type: 'adaptive' as const }, effort: thinkingLevel }),
      cwd: directory,
      systemPrompt: systemPromptFor(turn),
      tools: turn.tools ? [CLAUDE_WEB_SEARCH, CLAUDE_WEB_FETCH] : [],
      includePartialMessages: true,
      mcpServers: { [MCP_SERVER_NAME]: server },
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: SIRUS_CLIENT_ID },
    },
  });

  session.query = q;
  session.iterator = q[Symbol.asyncIterator]();
  // Attached images ride along as content blocks beside the turn's text.
  session.send = (text: string, images: readonly ImageBlock[] = []) => inbox.push(
    userMessage(text, images),
  );
  return session as ClaudeSession;
}

function collectAssistant(turn: Turn, message: Extract<SDKMessage, { type: 'assistant' }>): void {
  if (message.parent_tool_use_id) return;
  if (message.error) {
    throw new Error(`Claude subscription request failed: ${message.error}${
      message.error === 'authentication_failed' ? ' (run /login claude)' : ''}`);
  }

  for (const block of message.message.content) {
    if (block.type === 'text') {
      if (block.text) turn.blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      const webCall = claudeWebCall(block.id, block.name, toolArgs(block.input));
      if (webCall) {
        turn.pendingWeb.set(webCall.id, webCall);
        turn.blocks.push(webCall);
        continue;
      }
      turn.blocks.push({
        type: 'tool_call',
        id: block.id,
        name: block.name.startsWith(MCP_TOOL_PREFIX) ? block.name.slice(MCP_TOOL_PREFIX.length) : block.name,
        arguments: toolArgs(block.input),
      });
    }
  }
  publishTurn(turn);
}

async function runTurn(
  sessionId: string,
  session: ClaudeSession,
  text: string,
  images: readonly ImageBlock[],
  signal?: AbortSignal,
  updateStream?: TurnContext['updateStream'],
  permissions?: PermissionContext,
): Promise<MessageBlock[]> {
  throwIfAborted(signal);
  const turn: Turn = {
    blocks: [],
    partialText: new Map(),
    updateStream,
    resolved: new Set(),
    pendingWeb: new Map(),
    signal,
    permissions,
  };
  session.turn = turn;
  const interrupt = () => { void session.query.interrupt().catch(() => void 0); };
  signal?.addEventListener('abort', interrupt, { once: true });
  try {
    session.send(text, images);
    while (true) {
      const { value, done } = await abortable(session.iterator.next(), signal);
      if (done) {
        throw new Error('Claude session ended unexpectedly');
      }
      if (value.type === 'stream_event' && !value.parent_tool_use_id) {
        const event = value.event;
        if (event.type === 'message_start') {
          turn.partialText.clear();
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          let block = turn.partialText.get(event.index);
          if (!block) {
            block = { type: 'text', text: '' };
            turn.partialText.set(event.index, block);
          }
          block.text += event.delta.text;
          publishTurn(turn);
        }
      } else if (value.type === 'assistant') {
        turn.partialText.clear();
        collectAssistant(turn, value);
      } else if (value.type === 'user') {
        collectWebResults(turn, value);
      } else if (value.type === 'result') {
        if (value.subtype !== 'success') {
          throw new Error(value.errors.join('; ') || `Claude stopped: ${value.subtype}`);
        }
        if (value.is_error) {
          throw new Error(value.result || 'Claude returned an error');
        }
        session.hasSpoken = true;
        return turn.blocks;
      }
    }
  } catch (error) {
    // the SDK process is most likely gone; start fresh next turn
    sessions.delete(sessionId);
    session.query.close();
    throw error;
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
  let session = sessions.get(agent.runtimeId);
  const { model, thinkingLevel } = agent;
  // Query options cannot be changed after creation. Rebuild when either the
  // model or level changes so switching to/from Haiku also swaps between its
  // legacy thinking budget and Claude 5's adaptive thinking.
  if (session && (session.model !== model || session.thinkingLevel !== thinkingLevel)) {
    sessions.delete(agent.runtimeId);
    session.query.close();
    session = undefined;
  }
  if (!session) {
    session = createSession(turn);
    sessions.set(agent.runtimeId, session);
  }

  const content = await runTurn(
    agent.runtimeId,
    session,
    promptWithSharedHistory(
      messages,
      !session.hasSpoken,
      session.seenMessageCount,
      agent.name,
      turn.turnPrompt,
    ),
    unseenImages(messages, !session.hasSpoken, session.seenMessageCount),
    signal,
    blocks => turn.updateStream(blocks),
    turn.permissions,
  );
  session.seenMessageCount = messages.length;
  return { content, stop_reason: 'end_turn' };
}

// A tool-less turn is one short Claude Code run: a fresh process that answers
// the latest user message and exits, keeping nothing for the runtime id.
async function bareRequest(messages: readonly Message[], turn: TurnContext): Promise<Response> {
  const { agent, signal } = turn;
  const text = latestUserText(messages);
  const images = latestUserImages(messages);
  const q = query({
    prompt: images.length > 0 ? oneShotPrompt(text, images) : text,
    options: {
      model: agent.model,
      cwd: turn.directory,
      systemPrompt: systemPromptFor(turn),
      tools: [],
      maxTurns: 1,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: SIRUS_CLIENT_ID },
    },
  });
  const stop = () => q.close();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const message of q) {
      throwIfAborted(signal);
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        throw new Error(message.errors.join('; ') || `Claude stopped: ${message.subtype}`);
      }
      if (message.is_error) throw new Error(message.result || 'Claude returned an error');
      return { content: [{ type: 'text', text: message.result }], stop_reason: 'end_turn' };
    }
    throw new Error('Claude ended without a result');
  } finally {
    signal?.removeEventListener('abort', stop);
    q.close();
  }
}

export const subscriptionTransport: Transport = {
  getResponse,
  resetRuntime,
  resetAllRuntimes,
};
