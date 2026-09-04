export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  callId: string;
  result: string;
  isError: boolean;
}

export type MessageBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: MessageBlock[];
  // Present on agent messages so a shared multi-participant transcript keeps
  // the identity of the agent that produced it. Legacy messages omit it and
  // are treated as coming from the default participant.
  participant?: string;
  // Captured on agent responses so the UI can show the model that produced a
  // historical message even if that participant changes models later.
  model?: string;
}

// The reasoning depth a user picks per agent. Providers translate the shared
// level into whatever their models accept.
export const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = typeof THINKING_LEVELS[number];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';

export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  low: 'fastest, with lighter reasoning',
  medium: 'balanced speed and reasoning depth',
  high: 'deep reasoning for complex work (default)',
  xhigh: 'extended reasoning for difficult, long-running work',
  max: 'maximum reasoning depth and token use',
};

export function parseThinkingLevel(value: unknown): ThinkingLevel | null {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value as ThinkingLevel
    : null;
}
