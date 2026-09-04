import { agentTools } from './tools/agents/tools';
import { fileTools } from './tools/files/tools';
import { memoryTools } from './tools/memories/tools';
import { createToolRuntime } from './tools/runtime';
import { searchTools } from './tools/search/tools';
import { shellTools } from './tools/shell/tools';
import type { Tool } from './tools/types';

export type {
  Tool,
  ToolArgumentSchema,
  ToolAudience,
  ToolCallContext,
} from './tools/types';

// This module is the public tool boundary: individual tool families construct
// their own definitions, and the registry composes them in provider-visible
// order.
export const toolRegistry: Tool[] = [
  ...fileTools,
  ...shellTools,
  ...searchTools,
  ...memoryTools,
  ...agentTools,
];

const runtime = createToolRuntime(toolRegistry, {
  memoryToolNames: new Set(memoryTools.map(tool => tool.name)),
  agentToolNames: new Set(agentTools.map(tool => tool.name)),
});

export const {
  availableTools,
  findTool,
  executeTool,
  runTool,
} = runtime;
