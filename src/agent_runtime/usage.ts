import type { TurnUsage } from './types';

// How full an agent's context window is, for the status row and /usage. The
// runtime reports both figures with every usage update; there is nothing
// until its first.
export interface ContextUsage {
  tokens: number;
  window: number;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  const thousands = count / 1000;
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`;
}

export function contextPercent(usage: ContextUsage): number | null {
  if (!usage.window) return null;
  return Math.min(100, Math.round((usage.tokens / usage.window) * 100));
}

// From this share of the window on, the gauge warns: both vendors compact on
// their own a little further on, and a long answer may not fit.
export const CONTEXT_LOW_PERCENT = 80;

// A participant's turns added up. A figure of the breakdown is kept only
// when every turn reported it, so a Codex turn that made several calls, whose
// breakdown is unknown, leaves the sum its total alone rather than
// understating the rest. A cost is what the turns that had one came to.
export function addTurnUsage(total: TurnUsage | undefined, turn: TurnUsage): TurnUsage {
  if (!total) return { ...turn };
  const summed: TurnUsage = { totalTokens: total.totalTokens + turn.totalTokens };
  for (const key of ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens'] as const) {
    const left = total[key];
    const right = turn[key];
    if (left !== undefined && right !== undefined) summed[key] = left + right;
  }
  if (total.costUsd !== undefined || turn.costUsd !== undefined) summed.costUsd = (total.costUsd ?? 0) + (turn.costUsd ?? 0);
  return summed;
}

// "21.6k tokens (9.4k in, 12.2k cached, 42 out) · $0.12", saying only what
// the vendor said.
export function formatTurnUsage(usage: TurnUsage): string {
  const parts = [
    usage.inputTokens !== undefined ? `${formatTokens(usage.inputTokens)} in` : null,
    usage.cachedReadTokens ? `${formatTokens(usage.cachedReadTokens)} cached` : null,
    usage.cachedWriteTokens ? `${formatTokens(usage.cachedWriteTokens)} written to cache` : null,
    usage.outputTokens !== undefined ? `${formatTokens(usage.outputTokens)} out` : null,
  ].filter(Boolean);
  const cost = usage.costUsd !== undefined
    ? ` · $${usage.costUsd < 0.01 && usage.costUsd > 0 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}`
    : '';
  return `${formatTokens(usage.totalTokens)} tokens${parts.length ? ` (${parts.join(', ')})` : ''}${cost}`;
}
