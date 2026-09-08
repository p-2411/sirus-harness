import { isMemoryAccessEnabled } from '../memory-access';
import { agentTools } from './agents';
import { fileTools } from './files';
import { memoryTools } from './memories';
import { searchTools } from './search';
import { shellTools } from './shell';
import type { Tool, ToolAudience } from './types';

// The tool registry: every tool the host offers and the one rule for who may
// see it. A turn is handed a `Toolbox` (`./toolbox`) and nothing else, so the
// permission gate and the checkpoint barrier stay behind that; `createToolbox`
// is imported from `./toolbox` directly, because the toolbox reads this
// registry and a re-export here would close the loop.

// Every tool the host offers, in provider-visible order. Adding a tool is one
// entry in one family file; nothing else in the runtime lists tool names.
export const toolRegistry: Tool[] = [
  ...fileTools,
  ...shellTools,
  ...searchTools,
  ...memoryTools,
  ...agentTools,
];

// Whether one caller may see and run one tool. The single visibility rule:
// the listing filters with it and the toolbox refuses a call that fails it,
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

// The registry as one audience sees it: what a provider is told about and
// what the system prompt describes.
export function availableTools(audience: ToolAudience = {}): Tool[] {
  return visibleTools(toolRegistry, audience, isMemoryAccessEnabled);
}

// Type-only: erased at runtime, so naming the toolbox here costs no import
// edge back into it.
export type { Toolbox, ToolboxOptions } from './toolbox';
export type {
  SubagentHandle,
  SubagentHost,
  SubagentSpawnCall,
  Tool,
  ToolArgumentSchema,
  ToolAudience,
  ToolContext,
  ToolEffect,
} from './types';
