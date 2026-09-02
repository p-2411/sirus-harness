import type { Message, MessageBlock, ToolCallBlock, ToolResultBlock } from '../data/data';
import { OpenAIProvider } from './providers/openai/api'
import { AnthropicProvider } from './providers/anthropic/api'
import {
  ClaudeSubscriptionProvider,
  clearAllClaudeSubscriptionSessions,
  clearClaudeSubscriptionSession,
} from './providers/anthropic/subscription';
import {
  CodexSubscriptionProvider,
  clearAllCodexSubscriptionSessions,
  clearCodexSubscriptionSession,
} from './providers/openai/codex-subscription';
import { runTool } from './tools'
import { isSubscriptionEnabled, vendorOf, type Vendor } from './subscriptions';
import type { PermissionContext } from './permissions';
import type { JudgePrompt } from './judge';
import { abortable, throwIfAborted } from '../abort';
export { systemPrompt } from './prompt';

export interface ModelContext {
  // Sirus session id: subscription runtimes keep one provider session per
  // Sirus session so the conversation carries across turns.
  sessionId: string;
  directory: string;
  participantName?: string;
  // A host-generated user turn used when another participant mentioned this
  // agent. It is sent to the provider but is not persisted in chat history.
  turnPrompt?: string;
  // Set for a run spawned by another agent: it gets the subagent contract in
  // its prompt and no tools for spawning further agents.
  subagent?: boolean;
  // One signal owns the complete turn, including every provider continuation
  // and every host-side tool it starts.
  signal?: AbortSignal;
  // Providers publish the blocks collected for their current request here.
  // The agent loop folds them into the complete response across tool rounds.
  onUpdate?: (content: readonly MessageBlock[]) => void;
  // The permission gate every tool call of this request goes through. Absent
  // only for direct programmatic callers (tests); every session passes one.
  permissions?: PermissionContext;
}

export interface ModelStrategy {
  getResponse: (messages: readonly Message[], model: string, context: ModelContext) => Promise<Response>;
  // One tool-less request answering a short question, for the auto-approve
  // judge. Providers that cannot answer leave it out and the judge stays
  // conservative.
  judge?: (prompt: JudgePrompt, model: string, signal?: AbortSignal) => Promise<string>;
}

export const modelStrategies: Record<string, ModelStrategy> = {
  'gpt-5.6-luna': OpenAIProvider,
  'gpt-5.6-terra': OpenAIProvider,
  'gpt-5.6-sol': OpenAIProvider,
  'claude-opus-5': AnthropicProvider,
  'claude-sonnet-5': AnthropicProvider,
  'claude-haiku-4.5': AnthropicProvider,
  'claude-fable-5': AnthropicProvider,
}

// Same model names, different wire: once /login enables a provider, its models
// go through the user's subscription runtime instead of the API key.
export const subscriptionStrategies: Record<Vendor, ModelStrategy> = {
  claude: ClaudeSubscriptionProvider,
  gpt: CodexSubscriptionProvider,
};

export function clearSessionRuntime(sessionId: string): void {
  clearClaudeSubscriptionSession(sessionId);
  clearCodexSubscriptionSession(sessionId);
}

export function clearAllSessionRuntimes(): void {
  clearAllClaudeSubscriptionSessions();
  clearAllCodexSubscriptionSessions();
}

export function resolveStrategy(model: string): ModelStrategy {
  const apiStrategy = modelStrategies[model];
  if (!apiStrategy) {
    throw new Error(`Model strategy not found for model: ${model}`);
  }
  const vendor = vendorOf(model);
  if (vendor && isSubscriptionEnabled(vendor)) {
    return subscriptionStrategies[vendor];
  }
  return apiStrategy;
}

export interface Response {
  content: MessageBlock[];
  stop_reason: 'end_turn' | 'tool_use';
  continueWithToolResults?: (toolResults: readonly ToolResultBlock[]) => Promise<Response>;
}

export async function getResponse(
  messages: readonly Message[],
  model: string,
  sessionId: string = 'default',
  directory: string = process.cwd(),
  participantName?: string,
  turnPrompt?: string,
  onUpdate?: (message: Message) => void,
  subagent: boolean = false,
  signal?: AbortSignal,
  permissions?: PermissionContext,
): Promise<Message> {
  throwIfAborted(signal);
  const strategy: ModelStrategy = resolveStrategy(model);

  const output: Message = {
    role: 'assistant',
    content: [],
  };
  const publish = (current: readonly MessageBlock[]) => {
    if (signal?.aborted) return;
    onUpdate?.({ ...output, content: [...output.content, ...current] });
  };
  const context: ModelContext = {
    sessionId,
    directory,
    ...(participantName ? { participantName } : {}),
    ...(turnPrompt ? { turnPrompt } : {}),
    ...(onUpdate ? { onUpdate: publish } : {}),
    ...(subagent ? { subagent } : {}),
    ...(signal ? { signal } : {}),
    ...(permissions ? { permissions } : {}),
  };
  let response: Response = await abortable(strategy.getResponse(messages, model, context), signal);

  while (response.stop_reason === 'tool_use') {
    throwIfAborted(signal);
    output.content.push(...response.content);
    const toolCalls: ToolCallBlock[] = response.content.filter(
      (block): block is ToolCallBlock => block.type === 'tool_call',
    );
    if (toolCalls.length === 0) {
      throw new Error('Provider stopped for tool use without returning a tool call');
    }

    const toolResults: ToolResultBlock[] = [];
    for (const toolCall of toolCalls) {
      throwIfAborted(signal);
      const toolResult = await runTool(toolCall, directory, signal, permissions);
      toolResults.push(toolResult);
      output.content.push(toolResult);
      publish([]);
    }

    if (!response.continueWithToolResults) {
      throw new Error('Provider stopped for tool use without a continuation handler');
    }
    throwIfAborted(signal);
    response = await abortable(response.continueWithToolResults(toolResults), signal);
  }

  throwIfAborted(signal);
  output.content.push(...response.content);
  publish([]);
  return output;
}
