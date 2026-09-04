import { abortable, throwIfAborted } from '../../abort';
import { readClaudeSubscriptionUsage } from './anthropic/claude-subscription';
import { getCodexRpc } from './openai/codex-subscription';
import type { Vendor } from './provider';

export interface SubscriptionWindow {
  label: string;
  usedPercent: number | null;
  // Milliseconds since the epoch, normalized from each provider's format.
  resetsAt: number | null;
}

export interface SubscriptionUsage {
  windows: SubscriptionWindow[];
  unavailable?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percent(value: unknown): number | null {
  const amount = number(value);
  return amount === null ? null : Math.max(0, Math.min(100, amount));
}

function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() : fallback;
}

function duration(minutes: unknown, fallback: string): string {
  const value = number(minutes);
  if (value === null || value <= 0) return fallback;
  if (value % 1440 === 0) return `${value / 1440}-day`;
  if (value % 60 === 0) return `${value / 60}-hour`;
  return `${value}-minute`;
}

// Prefer the multi-bucket response; the legacy view can duplicate one bucket.
export function codexSubscriptionUsage(response: unknown): SubscriptionUsage {
  const data = object(response);
  const buckets = Object.entries(object(data.rateLimitsByLimitId));
  if (buckets.length === 0 && data.rateLimits) buckets.push(['Codex', data.rateLimits]);
  const windows: SubscriptionWindow[] = [];
  for (const [id, raw] of buckets) {
    const bucket = object(raw);
    const name = label(bucket.limitName, label(bucket.limitId, id));
    for (const key of ['primary', 'secondary'] as const) {
      if (!bucket[key]) continue;
      const window = object(bucket[key]);
      const seconds = number(window.resetsAt);
      const resetsAt = seconds !== null && seconds > 0 && seconds <= 8.64e12 ? seconds * 1000 : null;
      windows.push({
        label: `${name} · ${duration(window.windowDurationMins, `${key} window`)}`,
        usedPercent: percent(window.usedPercent),
        resetsAt,
      });
    }
  }
  return windows.length ? { windows } : { windows, unavailable: 'not reported by Codex' };
}

export function claudeSubscriptionUsage(response: unknown): SubscriptionUsage {
  const data = object(response);
  const limits = object(data.rate_limits);
  const windows: SubscriptionWindow[] = [];
  const append = (name: string, value: unknown) => {
    if (!value) return;
    const window = object(value);
    const reset = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    windows.push({
      label: name,
      usedPercent: percent(window.utilization),
      resetsAt: Number.isFinite(reset) ? reset : null,
    });
  };
  if (data.rate_limits_available === true) {
    for (const [key, name] of Object.entries({
      five_hour: '5-hour',
      seven_day: '7-day',
      seven_day_oauth_apps: '7-day apps',
      seven_day_opus: '7-day Opus',
      seven_day_sonnet: '7-day Sonnet',
    })) append(name, limits[key]);
    if (Array.isArray(limits.model_scoped)) {
      for (const window of limits.model_scoped) append(`7-day ${label(object(window).display_name, 'model')}`, window);
    }
  }
  return windows.length ? { windows } : { windows, unavailable: 'not reported by Claude' };
}

// Reading allowance never sends a model prompt or consumes a reset credit.
// Bound both runtime startup and the read so /info cannot wait indefinitely.
export async function readSubscriptionUsage(vendor: Vendor, signal?: AbortSignal): Promise<SubscriptionUsage> {
  throwIfAborted(signal);
  const timeout = AbortSignal.timeout(10_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    if (vendor === 'claude') {
      return claudeSubscriptionUsage(await abortable(readClaudeSubscriptionUsage(bounded), bounded));
    }
    const rpc = await abortable(getCodexRpc(), bounded);
    const response = await abortable(rpc.request('account/rateLimits/read'), bounded);
    return codexSubscriptionUsage(response);
  } catch {
    throwIfAborted(signal);
    return { windows: [], unavailable: timeout.aborted ? 'request timed out; try /info again' : 'could not read provider limits; try /info again' };
  }
}
