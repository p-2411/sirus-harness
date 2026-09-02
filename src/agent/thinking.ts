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

const LEGACY_CLAUDE_THINKING_BUDGET: Record<ThinkingLevel, number> = {
  low: 1_024,
  medium: 2_048,
  high: 4_096,
  xhigh: 8_192,
  max: 12_288,
};

// Haiku 4.5 predates adaptive thinking and effort levels. It uses the legacy
// manual-thinking budget while the Claude 5 models use adaptive thinking.
export function usesLegacyClaudeThinking(model: string): boolean {
  return /claude-haiku-4(?:[.-])5/.test(model);
}

export function legacyClaudeThinkingBudget(level: ThinkingLevel): number {
  return LEGACY_CLAUDE_THINKING_BUDGET[level];
}
