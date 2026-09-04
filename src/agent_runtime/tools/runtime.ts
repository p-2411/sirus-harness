import type { SessionAgent } from '../agent';
import type { ToolCallBlock, ToolResultBlock } from '../types';
import { abortReason, throwIfAborted } from '../../abort';
import { isMemoryAccessEnabled } from '../memory-access';
import { authorizeToolCall, classifyToolCall, type PermissionContext } from '../permissions/permissions';
import { errorMessage } from './arguments';
import type { Tool, ToolAudience, ToolCallContext } from './types';

export interface ToolRuntime {
  availableTools: (audience?: ToolAudience) => Tool[];
  findTool: (name: string) => Tool | null;
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    directory?: string,
    call?: ToolCallContext,
  ) => unknown | Promise<unknown>;
  runTool: (
    toolCall: ToolCallBlock,
    directory?: string,
    signal?: AbortSignal,
    permissions?: PermissionContext,
    agent?: SessionAgent,
  ) => Promise<ToolResultBlock>;
}

interface ToolRuntimeOptions {
  memoryToolNames: ReadonlySet<string>;
  agentToolNames: ReadonlySet<string>;
}

export function createToolRuntime(
  toolRegistry: readonly Tool[],
  options: ToolRuntimeOptions,
): ToolRuntime {
  const { memoryToolNames, agentToolNames } = options;

  const availableTools = (audience: ToolAudience = {}): Tool[] => {
    const memoryEnabled = isMemoryAccessEnabled();
    return toolRegistry.filter(tool =>
      (memoryEnabled || !memoryToolNames.has(tool.name))
      && (!audience.subagent || !agentToolNames.has(tool.name)));
  };

  const findTool = (name: string): Tool | null =>
    toolRegistry.find(tool => tool.name === name) ?? null;

  const executeTool = (
    toolName: string,
    args: Record<string, unknown>,
    directory: string = process.cwd(),
    call?: ToolCallContext,
  ): unknown | Promise<unknown> => {
    const tool = findTool(toolName);
    if (!tool) throw new Error(`Unknown tool: ${toolName}`);
    if (memoryToolNames.has(toolName) && !isMemoryAccessEnabled()) {
      throw new Error('Memory access is disabled. Use /memory on to enable it.');
    }
    return tool.func(args, directory, call);
  };

  const runTool = async (
    toolCall: ToolCallBlock,
    directory: string = process.cwd(),
    signal?: AbortSignal,
    permissions?: PermissionContext,
    agent?: SessionAgent,
  ): Promise<ToolResultBlock> => {
    throwIfAborted(signal);
    const tool = findTool(toolCall.name);
    if (!tool) {
      return {
        type: 'tool_result',
        callId: toolCall.id,
        result: `Unknown tool: ${toolCall.name}`,
        isError: true,
      };
    }

    if (permissions) {
      // Shell commands classified as reads can still write through flags
      // such as find -delete or sort -o. Always wait for their snapshot.
      if (permissions.beforeMutation && (toolCall.name === 'RunShell' || classifyToolCall(toolCall, directory) !== 'read')) {
        await permissions.beforeMutation();
        throwIfAborted(signal);
      }
      const declined = await authorizeToolCall(toolCall, directory, permissions, signal);
      if (declined) {
        return { type: 'tool_result', callId: toolCall.id, result: declined, isError: true };
      }
    }

    try {
      const result = await executeTool(toolCall.name, toolCall.arguments, directory, {
        callId: toolCall.id,
        signal,
        permissions,
        agent,
      });
      return {
        type: 'tool_result',
        callId: toolCall.id,
        result: formatToolResult(result),
        isError: false,
      };
    } catch (error) {
      // Cancellation belongs to the turn, not to the model-visible tool result.
      if (signal?.aborted) throw abortReason(signal);
      return {
        type: 'tool_result',
        callId: toolCall.id,
        result: errorMessage(error),
        isError: true,
      };
    }
  };

  return { availableTools, findTool, executeTool, runTool };
}

function formatToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return 'Tool completed successfully.';
  return JSON.stringify(result) ?? String(result);
}
