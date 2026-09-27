import { isMemoryAccessEnabled } from '../memory-access';
import { agentTools } from './agents';
import { memoryTools } from './memories';
import type { Tool, ToolAudience } from './types';

// The tool registry: every tool Sirus offers and the one rule for who may see
// it. The vendors run file, shell, search and web tools themselves; what is
// left here is what only Sirus can do, memory and delegation, served to every
// runtime by the MCP server in `./server`. The server reads this registry, so
// it is imported directly rather than re-exported here.

// Every tool Sirus offers, in the order the runtimes are told about them.
// Adding a tool is one entry in one family file; nothing else lists tool
// names.
export const toolRegistry: Tool[] = [
  ...memoryTools,
  ...agentTools,
];

// Whether one caller may see and run one tool. The single visibility rule:
// the listing filters with it and the server refuses a call that fails it,
// so a hidden tool cannot be reached by name. Both filters are live — the
// memory switch is read on every check, so /memory on and off take effect on
// the next request.
export function isVisible(
  tool: Tool,
  audience: ToolAudience,
  memoryEnabled: () => boolean,
): boolean {
  return (tool.requires !== 'memory' || memoryEnabled())
    && !(audience.subagent && tool.audience?.subagent === false);
}

// What one caller may see.
export function visibleTools(
  tools: readonly Tool[],
  audience: ToolAudience,
  memoryEnabled: () => boolean,
): Tool[] {
  return tools.filter(tool => isVisible(tool, audience, memoryEnabled));
}

// The registry as one audience sees it: what a runtime is told about and
// what the system prompt describes.
export function availableTools(audience: ToolAudience = {}): Tool[] {
  return visibleTools(toolRegistry, audience, isMemoryAccessEnabled);
}

export type {
  SubagentHandle,
  SubagentHost,
  SubagentSpawnCall,
  Tool,
  ToolArgumentSchema,
  ToolAudience,
  ToolContext,
} from './types';
