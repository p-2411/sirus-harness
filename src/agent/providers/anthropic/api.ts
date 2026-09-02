import Anthropic from "@anthropic-ai/sdk";
import { requireApiKey } from '../../credentials';
import type { Message, MessageBlock, TextBlock, ToolCallBlock, ToolResultBlock } from '../../../data/data';
import type { ModelContext, ModelStrategy, Response } from '../../chat';
import type { JudgePrompt } from '../../judge';
import { getSystemPrompt } from '../../prompt';
import { availableTools } from '../../tools';
import {
  fetchUrlCall,
  fetchUrlResult,
  webSearchCall,
  webSearchResult,
  type FetchUrlOutcome,
  type WebSearchOutcome,
} from '../../web';

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

export function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const content: Anthropic.TextBlockParam[] = message.content
        .filter((block): block is TextBlock => block.type === 'text' && Boolean(block.text))
        .map(block => ({ type: 'text', text: block.text }));
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
function getClient(): Anthropic {
  const key = requireApiKey('claude');
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
  model: string,
  directory: string,
  participantName: string,
  subagent: boolean,
  signal?: AbortSignal,
  onUpdate?: ModelContext['onUpdate'],
): Promise<Response> {
  const stream = getClient().messages.stream({
    model,
    max_tokens: 1024,
    system: getSystemPrompt(directory, participantName, subagent),
    messages,
    tools: [
      ...availableTools({ subagent }).map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: toInputSchema(tool.args),
      })),
      ...WEB_TOOLS,
    ],
  }, { signal });
  // The stream's own snapshot already holds text as it arrives and each
  // server tool call and result as a whole block, so it is the live view.
  for await (const event of stream) {
    if (event.type !== 'content_block_start'
      && event.type !== 'content_block_delta'
      && event.type !== 'content_block_stop') continue;
    const snapshot = stream.currentMessage;
    if (snapshot && onUpdate) onUpdate(normalizeContent(snapshot.content, { lenient: true }));
  }
  const response = await stream.finalMessage();
  const content = normalizeContent(response.content);

  // A long run of web tool calls can pause the turn. Resume it with the
  // content so far, and publish what the resumed request adds after it.
  if (response.stop_reason === 'pause_turn') {
    const resumed = await request(
      [...messages, { role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] }],
      model,
      directory,
      participantName,
      subagent,
      signal,
      onUpdate ? blocks => onUpdate([...content, ...blocks]) : undefined,
    );
    return { ...resumed, content: [...content, ...resumed.content] };
  }

  const finalResponse: Response = {
    stop_reason: response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
    content,
  };

  onUpdate?.(finalResponse.content);

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
      model,
      directory,
      participantName,
      subagent,
      signal,
      onUpdate,
    );
  }

  return finalResponse;
}

async function getResponse(messages: readonly Message[], model: string, context: ModelContext): Promise<Response> {
  const input = toAnthropicMessages(messages);
  if (context.turnPrompt) input.push({ role: 'user', content: context.turnPrompt });
  return request(
    input,
    model,
    context.directory,
    context.participantName ?? 'sirus',
    context.subagent ?? false,
    context.signal,
    context.onUpdate,
  );
}

// One tool-less request for the auto-approve judge; the answer is a word.
async function judge(prompt: JudgePrompt, model: string, signal?: AbortSignal): Promise<string> {
  const response = await getClient().messages.create({
    model,
    max_tokens: 8,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  }, { signal });
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('');
}

export const AnthropicProvider: ModelStrategy = {
  getResponse,
  judge,
};
