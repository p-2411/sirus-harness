// How full an agent's context window is, for the status row and /usage.
export interface ContextUsage {
  tokens: number;
  // Absent when neither the provider nor Sirus knows the model's window.
  window?: number;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`;
}

export function contextPercent(usage: ContextUsage): number | null {
  if (!usage.window) return null;
  return Math.min(100, Math.round((usage.tokens / usage.window) * 100));
}
