import { abortReason, throwIfAborted } from '../../abort';
import { isMemoryAccessEnabled } from '../memory-access';
import { authorizeToolCall, type PermissionContext } from '../permissions/policy';
import type { ToolCallBlock, ToolResultBlock } from '../types';
import { errorMessage } from './arguments';
import { isVisible, toolRegistry, visibleTools } from './index';
import type { SubagentHost, Tool, ToolAudience } from './types';

// What a turn hands its transport: the tools that turn may use, and the one
// way to run one. Everything a tool call passes through on its way to the
// world — the checkpoint barrier, the permission gate, the working directory,
// the subagent host — is bound here, once, by whoever built the turn.
export interface Toolbox {
  // Visible to this turn's audience, recomputed on read so a live setting
  // change (memory access) shows up in the next request.
  readonly tools: readonly Tool[];
  // barrier → gate → execute → format. A tool's own failure comes back as an
  // error result; a cancelled turn throws its abort reason.
  run(call: ToolCallBlock, signal?: AbortSignal): Promise<ToolResultBlock>;
}

export interface ToolboxOptions {
  // Defaults to the whole registry; tests and narrower callers may cut it down.
  tools?: readonly Tool[];
  audience?: ToolAudience;
  // Where every call of this turn runs.
  directory: string;
  // Live lookup, so the memory switch applies to the next call.
  memoryEnabled?: () => boolean;
  // The gate. Absent for direct programmatic callers (tests); every session
  // and subagent turn passes one.
  permissions?: PermissionContext;
  // A turn may start the provider while its pre-turn checkpoint is still
  // being captured. Mutating calls wait here so no write beats the snapshot.
  beforeMutation?: () => Promise<void>;
  // Present only for an agent that may delegate; a subagent's toolbox has
  // none, so its agent tools are both hidden and refused.
  subagents?: SubagentHost;
}

const MEMORY_DISABLED = 'Memory access is disabled. Use /memory on to enable it.';

function formatToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return 'Tool completed successfully.';
  return JSON.stringify(result) ?? String(result);
}

export function createToolbox(options: ToolboxOptions): Toolbox {
  const {
    tools = toolRegistry,
    audience = {},
    directory,
    memoryEnabled = isMemoryAccessEnabled,
    permissions,
    beforeMutation,
    subagents,
  } = options;

  const errorResult = (call: ToolCallBlock, result: string): ToolResultBlock =>
    ({ type: 'tool_result', callId: call.id, result, isError: true });

  return {
    get tools(): readonly Tool[] {
      return visibleTools(tools, audience, memoryEnabled);
    },

    async run(call: ToolCallBlock, signal?: AbortSignal): Promise<ToolResultBlock> {
      throwIfAborted(signal);
      const tool = tools.find(candidate => candidate.name === call.name);
      // A switched-off capability is named as such, so the model is told how
      // to get it back rather than that the tool does not exist.
      if (tool?.requires === 'memory' && !memoryEnabled()) {
        return errorResult(call, MEMORY_DISABLED);
      }
      // Otherwise a tool this caller was never offered does not exist for it:
      // a subagent asking for SpawnAgent is refused here by the same
      // predicate that hid it from the listing, not by the listing alone.
      if (!tool || !isVisible(tool, audience, memoryEnabled)) {
        return errorResult(call, `Unknown tool: ${call.name}`);
      }

      const effect = typeof tool.effect === 'function'
        ? tool.effect(call.arguments, directory)
        : tool.effect;
      if (effect !== 'read' && beforeMutation) {
        await beforeMutation();
        throwIfAborted(signal);
      }

      if (permissions) {
        const declined = await authorizeToolCall(tool, call, directory, permissions, signal);
        if (declined) return errorResult(call, declined);
      }

      try {
        const result = await tool.run(call.arguments, {
          directory,
          callId: call.id,
          ...(signal ? { signal } : {}),
          ...(subagents ? { subagents } : {}),
        });
        return {
          type: 'tool_result',
          callId: call.id,
          result: formatToolResult(result),
          isError: false,
        };
      } catch (error) {
        // Cancellation belongs to the turn, not to the model-visible result.
        if (signal?.aborted) throw abortReason(signal);
        return errorResult(call, errorMessage(error));
      }
    },
  };
}
