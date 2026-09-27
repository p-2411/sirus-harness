import { agentTools } from './agents';
import { memoryTools } from './memories';
import type { Tool, ToolAudience } from './types';

// The tool registry: every tool Sirus offers and the one rule for who may see
// it. The vendors run file, shell, search and web tools themselves; what is
// left here is what only Sirus can do, memory and delegation, served to every
// runtime by the MCP server in `./server`. The server reads this registry, so
// it is imported directly rather than re-exported here.

// Every tool Sirus offers, in the order the runtimes are told about them.
// Adding a tool is one entry in one family file, and the system prompt's
// list of tools follows. Renaming one is not: the prompt's instructions name
// the tools they teach, and a vendor's call is recognised by the tool's name
// in its title (the SpawnAgent row, a worker's memory changes).
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
