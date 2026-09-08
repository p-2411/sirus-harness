import path from 'path';
import { z } from 'zod';
import { dataDirectory } from '../dataDirectory';
import { readJson, writeJson } from './atomicJson';

// What each subscription had left the last time a provider told us, so the
// sidebar can show an allowance without asking on every render.

const subscriptionLimitCacheSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    vendor: z.enum(['claude', 'gpt']),
    profile: z.string(),
    period: z.enum(['5-hour', '7-day']),
    remaining: z.number().min(0).max(100),
    checkedAt: z.number().finite(),
    resetsAt: z.number().finite().nullable(),
  })),
});

export type CachedSubscriptionLimit = z.infer<typeof subscriptionLimitCacheSchema>['entries'][number];

function cachePath(directory: string): string {
  return path.join(directory, 'subscription-limits.json');
}

export function loadSubscriptionLimitCache(directory: string = dataDirectory()): CachedSubscriptionLimit[] {
  const parsed = subscriptionLimitCacheSchema.safeParse(readJson(cachePath(directory)));
  return parsed.success ? parsed.data.entries : [];
}

export function saveSubscriptionLimitCache(
  entries: CachedSubscriptionLimit[],
  directory: string = dataDirectory(),
): boolean {
  return writeJson(cachePath(directory), { version: 1, entries });
}

export function clearSubscriptionLimitCache(
  vendor: CachedSubscriptionLimit['vendor'],
  profile: string,
  directory: string = dataDirectory(),
): void {
  const entries = loadSubscriptionLimitCache(directory);
  const remaining = entries.filter(entry => entry.vendor !== vendor || entry.profile !== profile);
  if (remaining.length !== entries.length) saveSubscriptionLimitCache(remaining, directory);
}
