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

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = typeof IMAGE_MEDIA_TYPES[number];

// An image the user attached to a message. The bytes live in a file under
// the application-state directory, so the persisted history stays small and
// each provider reads the file only when it builds a request.
export interface ImageBlock {
  type: 'image';
  path: string;
  mediaType: ImageMediaType;
  bytes: number;
}

export type MessageBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock;

// Token accounting for one agent turn, as the provider reported it. Totals
// cover every request of the turn; context is the size of the last request,
// which is what the model had in its window when it finished.
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  // The model's window, when the provider states it.
  contextWindow?: number;
}

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
  // Present on agent responses whose provider reported token usage.
  usage?: Usage;
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
