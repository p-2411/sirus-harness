import type { Message, MessageBlock, ToolCallBlock, ToolResultBlock } from './types';
import { modelStrategies, resolveStrategy } from './providers/providers';
import { runTool } from './tools'
import { abortable, throwIfAborted } from '../abort';
import type { TurnContext } from './turn';
export { systemPrompt } from './prompt';

export interface ModelStrategy {
  // One provider request for the turn's agent. Partial content goes to
  // turn.updateStream as it streams; the settled response comes back here.
  getResponse: (messages: readonly Message[], turn: TurnContext) => Promise<Response>;
  // The cheapest model of this provider, for one-shot questions such as the
  // permission judge.
  judgeModel?: string;
  // Providers that keep state per agent runtime drop it here, so the agent's
  // next turn starts afresh with its current options and history.
  resetRuntime?: (runtimeId: string) => void;
  resetAllRuntimes?: () => void;
}

export { modelStrategies, resolveStrategy };

export interface Response {
  content: MessageBlock[];
  stop_reason: 'end_turn' | 'tool_use';
  continueWithToolResults?: (toolResults: readonly ToolResultBlock[]) => Promise<Response>;
}

// Runs one turn to completion: provider requests and host-side tool calls
// alternate until the model ends its turn. Every finished piece is committed
// to the turn as it lands, so readers of the turn see progress throughout.
export async function getResponse(messages: readonly Message[], turn: TurnContext): Promise<Message> {
  const { agent, signal } = turn;
  try {
    throwIfAborted(signal);
    const strategy: ModelStrategy = resolveStrategy(agent.model);
    let response: Response = await abortable(strategy.getResponse(messages, turn), signal);

    while (response.stop_reason === 'tool_use') {
      throwIfAborted(signal);
      if (!turn.tools) throw new Error('Provider asked for a tool on a tool-less turn');
      turn.commit(response.content);
      const toolCalls: ToolCallBlock[] = response.content.filter(
        (block): block is ToolCallBlock => block.type === 'tool_call',
      );
      if (toolCalls.length === 0) {
        throw new Error('Provider stopped for tool use without returning a tool call');
      }

      const toolResults: ToolResultBlock[] = [];
      for (const toolCall of toolCalls) {
        throwIfAborted(signal);
        const toolResult = await runTool(toolCall, turn.directory, signal, turn.permissions, agent);
        toolResults.push(toolResult);
        turn.commit([toolResult]);
      }

      if (!response.continueWithToolResults) {
        throw new Error('Provider stopped for tool use without a continuation handler');
      }
      throwIfAborted(signal);
      response = await abortable(response.continueWithToolResults(toolResults), signal);
    }

    throwIfAborted(signal);
    turn.commit(response.content);
    return turn.finish();
  } catch (error) {
    turn.fail(error);
    throw error;
  }
}
