import type { Message, MessageBlock, ToolResultBlock } from '../../types';
import { OpenAI } from 'openai';
import type { Response } from '../../chat';
import type { Transport } from '../provider';
import type { TurnContext } from '../../turn';
import { systemPromptFor } from '../../prompt';
import { availableTools } from '../../tools';
import { fetchUrlCall, fetchUrlResult, webSearchCall, webSearchResult } from '../../tools/web';

// The Responses API runs web search inside the request and reports the action
// the model took: a search and the pages it consulted, a page it opened, or a
// pattern it looked for on a page. What it read never leaves the request.
const OPENAI_WEB_NOTE = 'The model read the results directly inside the request; only the pages it consulted are reported.';

function webSearchBlocks(
  item: OpenAI.Responses.ResponseFunctionWebSearch,
  titles: ReadonlyMap<string, string> = new Map(),
): MessageBlock[] {
  const action = item.action;
  const failed = item.status === 'failed';
  if (action.type === 'search') {
    const call = webSearchCall(item.id, { query: action.query ?? action.queries?.join(' | ') ?? '' });
    if (failed) return [call, webSearchResult(call, { hits: [], error: 'the search failed' })];
    const hits = (action.sources ?? []).map(source => {
      const title = titles.get(source.url);
      return title ? { url: source.url, title } : { url: source.url };
    });
    return [call, webSearchResult(call, { hits, note: OPENAI_WEB_NOTE })];
  }
  const call = fetchUrlCall(item.id, {
    url: action.url ?? '',
    ...(action.type === 'find_in_page' ? { prompt: action.pattern } : {}),
  });
  return [call, fetchUrlResult(call, failed ? { error: 'the page could not be opened' } : { note: OPENAI_WEB_NOTE })];
}

// Titles for consulted pages come from the citations in the model's text.
function citationTitles(output: readonly OpenAI.Responses.ResponseOutputItem[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type !== 'output_text') continue;
      for (const annotation of part.annotations) {
        if (annotation.type === 'url_citation' && annotation.title) titles.set(annotation.url, annotation.title);
      }
    }
  }
  return titles;
}

function toToolArgs(argumentsJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(argumentsJson);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('OpenAI returned invalid tool arguments');
  }

  return parsed as Record<string, unknown>;
}

export function toOpenAIInput(messages: readonly Message[]): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInput = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.participant) {
      input.push({ role: 'assistant', content: `[Response from @${message.participant}]` });
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            input.push({ role: message.role, content: block.text });
          }
          break;
        case 'tool_call':
          input.push({
            type: 'function_call' as const,
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
          break;
        case 'tool_result':
          input.push({
            type: 'function_call_output' as const,
            call_id: block.callId,
            output: block.result,
          });
          break;
      }
    }
  }

  return input;
}

// Created on first request, not at import time, so modules that only need
// model names (command registry, tests) load without this provider's API key.
// Rebuilt whenever the key changes (a pasted key, or /logout back to the
// environment), so a new key takes effect on the next request.
let client: { key: string; sdk: OpenAI } | undefined;
function getClient(requireApiKey: () => string): OpenAI {
  const key = requireApiKey();
  if (client?.key !== key) client = { key, sdk: new OpenAI({ apiKey: key }) };
  return client.sdk;
}

function toOpenAIToolResults(
  toolResults: readonly ToolResultBlock[],
): OpenAI.Responses.ResponseInput {
  return toolResults.map(toolResult => ({
    type: 'function_call_output' as const,
    call_id: toolResult.callId,
    output: toolResult.result,
  }));
}

export function toOpenAIContinuationInput(
  input: OpenAI.Responses.ResponseInput,
  output: readonly OpenAI.Responses.ResponseOutputItem[],
  toolResults: readonly ToolResultBlock[],
): OpenAI.Responses.ResponseInput {
  return [
    ...input,
    ...output.map(item => item as OpenAI.Responses.ResponseInputItem),
    ...toOpenAIToolResults(toolResults),
  ];
}

async function request(
  input: OpenAI.Responses.ResponseInput,
  turn: TurnContext,
  requireApiKey: () => string,
  updateStream?: TurnContext['updateStream'],
): Promise<Response> {
  const { agent, signal } = turn;
  const { model, thinkingLevel } = agent;
  const stream = await getClient(requireApiKey).responses.create({
    model,
    reasoning: { effort: thinkingLevel },
    instructions: systemPromptFor(turn),
    input,
    stream: true,
    tools: turn.tools
      ? [
        ...availableTools({ subagent: agent.subagent }).map(tool => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: tool.args,
            required: Object.keys(tool.args),
            additionalProperties: false,
          },
          strict: true,
        })),
        { type: 'web_search' as const },
      ]
      : [],
    include: ['web_search_call.action.sources'],
  }, { signal });

  const partial = new Map<number, MessageBlock[]>();
  const publish = () => updateStream?.(
    [...partial.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, blocks]) => blocks),
  );
  const appendText = (outputIndex: number, delta: string) => {
    const blocks = partial.get(outputIndex) ?? [];
    const text = blocks.find((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text');
    if (text) text.text += delta;
    else blocks.push({ type: 'text', text: delta });
    partial.set(outputIndex, blocks);
    publish();
  };
  let response: OpenAI.Responses.Response | undefined;

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      appendText(event.output_index, event.delta);
    } else if (event.type === 'response.refusal.delta') {
      appendText(event.output_index, event.delta);
    } else if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
      partial.set(event.output_index, [{
        type: 'tool_call',
        id: event.item.call_id,
        name: event.item.name,
        arguments: toToolArgs(event.item.arguments),
      }]);
      publish();
    } else if (event.type === 'response.output_item.done' && event.item.type === 'web_search_call') {
      partial.set(event.output_index, webSearchBlocks(event.item));
      publish();
    } else if (event.type === 'response.completed') {
      response = event.response;
    } else if (event.type === 'response.failed') {
      throw new Error(event.response.error?.message ?? 'OpenAI response failed');
    } else if (event.type === 'response.incomplete') {
      // Preserve output produced before a token/output limit stopped the model,
      // matching the non-streaming Responses API behavior.
      response = event.response;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }

  if (!response) throw new Error('OpenAI stream ended without a completed response');

  const finalResponse: Response = {
    stop_reason: 'end_turn',
    content: [],
  };
  const titles = citationTitles(response.output);

  for (const item of response.output) {
    if (item.type === 'web_search_call') {
      finalResponse.content.push(...webSearchBlocks(item, titles));
    } else if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') {
          finalResponse.content.push({ type: 'text', text: part.text });
        } else if (part.type === 'refusal') {
          finalResponse.content.push({ type: 'text', text: part.refusal });
        }
      }
    } else if (item.type === 'function_call') {
      finalResponse.stop_reason = 'tool_use';
      finalResponse.content.push({
        type: 'tool_call',
        id: item.call_id,
        name: item.name,
        arguments: toToolArgs(item.arguments),
      });
    }
  }

  updateStream?.(finalResponse.content);

  if (finalResponse.stop_reason === 'tool_use') {
    finalResponse.continueWithToolResults = toolResults => request(
      toOpenAIContinuationInput(input, response.output, toolResults),
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
  const input = toOpenAIInput(messages);
  if (turn.turnPrompt) input.push({ role: 'user', content: turn.turnPrompt });
  return request(input, turn, requireApiKey, blocks => turn.updateStream(blocks));
}

export function apiTransport(requireApiKey: () => string): Transport {
  return {
    getResponse: (messages, turn) => getResponse(messages, turn, requireApiKey),
  };
}
