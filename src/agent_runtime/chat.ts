import type { Message, ToolCallBlock, ToolResultBlock } from './types';
import { providerForModel } from './providers';
import { abortable, throwIfAborted } from '../abort';
import type { TurnContext } from './turn';
export { systemPrompt } from './prompt';

// Response moved to the transport contract; re-exported here because the
// agent loop is where most callers meet it.
export type { Response } from './providers/provider';

// Runs one turn to completion: provider requests and host-side tool calls
// alternate until the model ends its turn. Every finished piece is committed
// to the turn as it lands, so readers of the turn see progress throughout.
export async function getResponse(messages: readonly Message[], turn: TurnContext): Promise<Message> {
  const { agent, signal } = turn;
  try {
    throwIfAborted(signal);
    let response = await abortable(providerForModel(agent.model).getResponse(messages, turn), signal);
    if (response.usage) turn.addUsage(response.usage);

    while (response.stop_reason === 'tool_use') {
      throwIfAborted(signal);
      const toolbox = turn.toolbox;
      if (!toolbox) throw new Error('Provider asked for a tool on a tool-less turn');
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
        const toolResult = await toolbox.run(toolCall, signal);
        toolResults.push(toolResult);
        turn.commit([toolResult]);
      }

      if (!response.continueWithToolResults) {
        throw new Error('Provider stopped for tool use without a continuation handler');
      }
      throwIfAborted(signal);
      response = await abortable(response.continueWithToolResults(toolResults), signal);
      if (response.usage) turn.addUsage(response.usage);
    }

    throwIfAborted(signal);
    turn.commit(response.content);
    return turn.finish();
  } catch (error) {
    turn.fail(error);
    throw error;
  }
}
