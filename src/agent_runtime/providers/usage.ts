import { abortable, throwIfAborted } from '../../abort';
import { readClaudeSubscriptionUsage } from './anthropic/claude-subscription';
import { getCodexRpc } from './openai/codex-subscription';
import type { Vendor } from './provider';
import { dataDirectory, loadSubscriptionLimitCache, saveSubscriptionLimitCache } from '../../persistence';

export interface SubscriptionWindow {
  label: string;
  usedPercent: number | null;
  // Milliseconds since the epoch, normalized from each provider's format.
  resetsAt: number | null;
}

export interface SubscriptionUsage {
  windows: SubscriptionWindow[];
  overall?: SubscriptionWindow[];
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
  const overall: SubscriptionWindow[] = [];
  for (const [id, raw] of buckets) {
    const bucket = object(raw);
    const name = label(bucket.limitName, label(bucket.limitId, id));
    for (const key of ['primary', 'secondary'] as const) {
      if (!bucket[key]) continue;
      const window = object(bucket[key]);
      const seconds = number(window.resetsAt);
      const resetsAt = seconds !== null && seconds > 0 && seconds <= 8.64e12 ? seconds * 1000 : null;
      const normalized = {
        label: `${name} · ${duration(window.windowDurationMins, `${key} window`)}`,
        usedPercent: percent(window.usedPercent),
        resetsAt,
      };
      windows.push(normalized);
      if (id.toLowerCase() === 'codex' || bucket.limitId === 'codex') {
        overall.push({ ...normalized, label: duration(window.windowDurationMins, `${key} window`) });
      }
    }
  }
  return windows.length ? { windows, overall } : { windows, overall, unavailable: 'not reported by Codex' };
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
export async function readSubscriptionUsage(vendor: Vendor, signal?: AbortSignal, profile = 'default'): Promise<SubscriptionUsage> {
  throwIfAborted(signal);
  const directory = dataDirectory();
  const timeout = AbortSignal.timeout(10_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    let usage: SubscriptionUsage;
    if (vendor === 'claude') {
      usage = claudeSubscriptionUsage(await abortable(readClaudeSubscriptionUsage(bounded, profile), bounded));
    } else {
      const rpc = await abortable(getCodexRpc(profile), bounded);
      const response = await abortable(rpc.request('account/rateLimits/read'), bounded);
      usage = codexSubscriptionUsage(response);
    }
    throwIfAborted(bounded);
    const checkedAt = Date.now();
    const entries = loadSubscriptionLimitCache(directory);
    let updated = false;
    for (const period of ['5-hour', '7-day'] as const) {
      const remaining = remainingAllowance(usage, period);
      if (remaining === null) continue;
      const previous = entries.findIndex(entry => entry.vendor === vendor && entry.profile === profile && entry.period === period);
      if (previous !== -1) entries.splice(previous, 1);
      entries.push({ vendor, profile, period, remaining, checkedAt, resetsAt: allowanceWindow(usage, period)?.resetsAt ?? null });
      updated = true;
    }
    if (updated) saveSubscriptionLimitCache(entries, directory);
    return usage;
  } catch {
    throwIfAborted(signal);
    return { windows: [], unavailable: timeout.aborted ? 'request timed out; try /info again' : 'could not read provider limits; try /info again' };
  }
}

// Use the overall allowance, excluding additional model-specific buckets.
function allowanceWindow(usage: SubscriptionUsage, period: '5-hour' | '7-day'): SubscriptionWindow | undefined {
  const windows = usage.overall ?? usage.windows;
  return windows.find(window => window.label === period)
    ?? windows.find(window => window.label.toLowerCase() === `codex · ${period}`);
}
export function remainingAllowance(usage: SubscriptionUsage, period: '5-hour' | '7-day'): number | null {
  const window = allowanceWindow(usage, period);
  return window?.usedPercent == null ? null : Number(Math.max(0, Math.min(100, 100 - window.usedPercent)).toFixed(1));
}

// Cached values are only a placeholder while fetching. Do not reuse an old
// window after its reset, or indefinitely when the reset wasn't reported.
export function cachedSubscriptionRemaining(vendor: Vendor, profile: string, period: '5-hour' | '7-day', now = Date.now()): number | undefined {
  const entry = loadSubscriptionLimitCache().find(entry => entry.vendor === vendor && entry.profile === profile && entry.period === period);
  if (!entry) return undefined;
  const maxAge = (period === '5-hour' ? 5 : 7 * 24) * 3600_000;
  if (now < entry.checkedAt || now - entry.checkedAt >= maxAge || (entry.resetsAt !== null && now >= entry.resetsAt)) return undefined;
  return entry.remaining;
}
export function formatRemaining(value: number | null): string {
  return value === null ? 'unavailable' : `${value}%`;
}
