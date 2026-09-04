import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageBlock, ToolCallBlock, ToolResultBlock } from '../../types';
import { imageData } from '../../../images';
import type { Response } from '../../chat';
import type { Transport } from '../provider';
import type { TurnContext } from '../../turn';
import { systemPromptFor } from '../../prompt';
import { availableTools } from '../../tools';
import {
  fetchUrlCall,
  fetchUrlResult,
  webSearchCall,
  webSearchResult,
  type FetchUrlOutcome,
  type WebSearchOutcome,
} from '../../tools/web';
import type { ThinkingLevel } from '../../types';

const CLAUDE_MAX_TOKENS = 16_384;

const LEGACY_CLAUDE_THINKING_BUDGET: Record<ThinkingLevel, number> = {
  low: 1_024,
  medium: 2_048,
  high: 4_096,
  xhigh: 8_192,
  max: 12_288,
};

// Haiku 4.5 predates adaptive thinking and effort levels. It uses the legacy
// manual-thinking budget while the Claude 5 models use adaptive thinking.
export function usesLegacyClaudeThinking(model: string): boolean {
  return /claude-haiku-4(?:[.-])5/.test(model);
}

export function legacyClaudeThinkingBudget(level: ThinkingLevel): number {
  return LEGACY_CLAUDE_THINKING_BUDGET[level];
}

export function anthropicThinkingConfig(model: string, level: ThinkingLevel) {
  return usesLegacyClaudeThinking(model)
    ? {
      thinking: { type: 'enabled' as const, budget_tokens: legacyClaudeThinkingBudget(level) },
    }
    : {
      thinking: { type: 'adaptive' as const },
      output_config: { effort: level },
    };
}

// The API runs web search and fetch itself, inside the request, and reports
// each use as a server_tool_use block followed by its result block. Sirus
// records the pair under its own tool names.
const WEB_TOOLS: Anthropic.ToolUnion[] = [
  { type: 'web_search_20260318', name: 'web_search' },
  { type: 'web_fetch_20260318', name: 'web_fetch' },
];

function toInputSchema(args: Record<string, unknown> | null): Anthropic.Tool.InputSchema {
  const properties = Object.fromEntries(
    Object.entries(args ?? {}).map(([name, schema]) => [
      name,
      typeof schema === 'string' ? { type: schema } : schema,
    ]),
  );

  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
  };
}

function toToolArgs(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Anthropic returned invalid tool arguments');
  }

  return input as Record<string, unknown>;
}

function webToolCall(block: Anthropic.ServerToolUseBlock): ToolCallBlock | null {
  const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>;
  if (block.name === 'web_search') return webSearchCall(block.id, { query: String(input.query ?? '') });
  if (block.name === 'web_fetch') return fetchUrlCall(block.id, { url: String(input.url ?? '') });
  return null;
}

function describeError(code: string): string {
  return code.replace(/_/g, ' ');
}

function webSearchOutcome(content: Anthropic.WebSearchToolResultBlockContent): WebSearchOutcome {
  if (!Array.isArray(content)) return { hits: [], error: describeError(content.error_code) };
  return {
    hits: content.map(hit => ({
      url: hit.url,
      title: hit.title,
      ...(hit.page_age ? { age: hit.page_age } : {}),
    })),
  };
}

function fetchUrlOutcome(content: Anthropic.WebFetchToolResultBlock['content']): FetchUrlOutcome {
  if (content.type === 'web_fetch_tool_result_error') return { error: describeError(content.error_code) };
  const document = content.content;
  const source = document.source;
  return {
    ...(document.title ? { title: document.title } : {}),
    content: source.type === 'text'
      ? source.data
      : `[${source.media_type} document of ${source.data.length} base64 characters; the model read it directly]`,
  };
}

// Translates one response's content into Sirus blocks: text (merged across
// the citation boundaries web results introduce), Sirus tool calls, and each
// server web tool use paired with its result. In lenient mode, used on the
// streaming snapshot, a block whose input is still arriving is skipped.
function normalizeContent(
  content: readonly Anthropic.ContentBlock[],
  options: { lenient?: boolean } = {},
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const webCalls = new Map<string, ToolCallBlock>();
  for (const block of content) {
    try {
      if (block.type === 'text') {
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') last.text += block.text;
        else blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        blocks.push({
          type: 'tool_call',
          id: block.id,
          name: block.name,
          arguments: toToolArgs(block.input),
        });
      } else if (block.type === 'server_tool_use') {
        const call = webToolCall(block);
        if (call) {
          webCalls.set(call.id, call);
          blocks.push(call);
        }
      } else if (block.type === 'web_search_tool_result') {
        const call = webCalls.get(block.tool_use_id);
        if (call) blocks.push(webSearchResult(call, webSearchOutcome(block.content)));
      } else if (block.type === 'web_fetch_tool_result') {
        const call = webCalls.get(block.tool_use_id);
        if (call) blocks.push(fetchUrlResult(call, fetchUrlOutcome(block.content)));
      }
    } catch (error) {
      if (!options.lenient) throw error;
    }
  }
  return blocks;
}

// An attached image as the API takes it, or a note in its place when the
// file behind it is gone.
export function imageBlockParam(block: Extract<MessageBlock, { type: 'image' }>): Anthropic.ContentBlockParam {
  try {
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mediaType, data: imageData(block) },
    };
  } catch {
    return { type: 'text', text: `[An attached image is no longer available: ${block.path}]` };
  }
}

export function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          content.push(imageBlockParam(block));
        }
      }
      if (content.length > 0) {
        result.push({ role: 'user', content });
      }
      continue;
    }

    let assistantContent: Anthropic.ContentBlockParam[] = message.participant
      ? [{ type: 'text', text: `[Response from @${message.participant}]` }]
      : [];
    let toolResults: Anthropic.ToolResultBlockParam[] = [];

    const flushAssistant = () => {
      if (assistantContent.length > 0) {
        result.push({ role: 'assistant', content: assistantContent });
        assistantContent = [];
      }
    };
    const flushToolResults = () => {
      if (toolResults.length > 0) {
        result.push({ role: 'user', content: toolResults });
        toolResults = [];
      }
    };

    for (const block of message.content) {
      if (block.type === 'tool_result') {
        flushAssistant();
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.callId,
          content: block.result,
          is_error: block.isError,
        });
        continue;
      }

      flushToolResults();
      if (block.type === 'text' && block.text) {
        assistantContent.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_call') {
        assistantContent.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.arguments,
        });
      }
    }

    flushAssistant();
    flushToolResults();
  }

  return result;
}

// Created on first request, not at import time, so modules that only need
// model names (command registry, tests) load without this provider's API key.
// Rebuilt whenever the key changes (a pasted key, or /logout back to the
// environment), so a new key takes effect on the next request.
let client: { key: string; sdk: Anthropic } | undefined;
function getClient(requireApiKey: () => string): Anthropic {
  const key = requireApiKey();
  if (client?.key !== key) client = { key, sdk: new Anthropic({ apiKey: key }) };
  return client.sdk;
}

function toAnthropicToolResults(
  toolResults: readonly ToolResultBlock[],
): Anthropic.ToolResultBlockParam[] {
  return toolResults.map(toolResult => ({
    type: 'tool_result',
    tool_use_id: toolResult.callId,
    content: toolResult.result,
    is_error: toolResult.isError,
  }));
}

async function request(
  messages: Anthropic.MessageParam[],
  turn: TurnContext,
  requireApiKey: () => string,
  updateStream?: TurnContext['updateStream'],
): Promise<Response> {
  const { agent, signal } = turn;
  const { model, thinkingLevel } = agent;
  const stream = getClient(requireApiKey).messages.stream({
    model,
    max_tokens: CLAUDE_MAX_TOKENS,
    ...anthropicThinkingConfig(model, thinkingLevel),
    system: systemPromptFor(turn),
    messages,
    tools: turn.tools
      ? [
        ...availableTools({ subagent: agent.subagent }).map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: toInputSchema(tool.args),
        })),
        ...WEB_TOOLS,
      ]
      : [],
  }, { signal });
  // The stream's own snapshot already holds text as it arrives and each
  // server tool call and result as a whole block, so it is the live view.
  for await (const event of stream) {
    if (event.type !== 'content_block_start'
      && event.type !== 'content_block_delta'
      && event.type !== 'content_block_stop') continue;
    const snapshot = stream.currentMessage;
    if (snapshot && updateStream) updateStream(normalizeContent(snapshot.content, { lenient: true }));
  }
  const response = await stream.finalMessage();
  const content = normalizeContent(response.content);

  // A long run of web tool calls can pause the turn. Resume it with the
  // content so far, and publish what the resumed request adds after it.
  if (response.stop_reason === 'pause_turn') {
    const resumed = await request(
      [...messages, { role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] }],
      turn,
      requireApiKey,
      updateStream ? blocks => updateStream([...content, ...blocks]) : undefined,
    );
    return { ...resumed, content: [...content, ...resumed.content] };
  }

  const finalResponse: Response = {
    stop_reason: response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
    content,
  };

  updateStream?.(finalResponse.content);

  if (finalResponse.stop_reason === 'tool_use') {
    const continuationMessages: Anthropic.MessageParam[] = [
      ...messages,
      {
        role: 'assistant',
        content: response.content as Anthropic.ContentBlockParam[],
      },
    ];

    finalResponse.continueWithToolResults = toolResults => request(
      [
        ...continuationMessages,
        { role: 'user', content: toAnthropicToolResults(toolResults) },
      ],
      turn,
      requireApiKey,
      updateStream,
    );
  }

  return finalResponse;
}

async function getResponse(
  messages: readonly Message[],
  turn: TurnContext,
  requireApiKey: () => string,
): Promise<Response> {
  const input = toAnthropicMessages(messages);
  if (turn.turnPrompt) input.push({ role: 'user', content: turn.turnPrompt });
  return request(input, turn, requireApiKey, blocks => turn.updateStream(blocks));
}

export function apiTransport(requireApiKey: () => string): Transport {
  return {
    getResponse: (messages, turn) => getResponse(messages, turn, requireApiKey),
  };
}
