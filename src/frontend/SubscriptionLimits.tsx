import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { providerFor } from '../agent_runtime/providers';
import { onProviderChange } from '../agent_runtime/providers/sources';
import { VENDOR_INFO, VENDORS, type Vendor } from '../agent_runtime/providers/catalog';
import { allowanceWindow, cachedSubscriptionLimit, readSubscriptionUsage, remainingAllowance } from '../agent_runtime/providers/usage';
import { theme } from './styles/theme';

export interface SubscriptionLimitRow {
  id: string;
  vendor: Vendor;
  label: string;
  // Undefined while the first read is pending; null means no limit was reported.
  remaining: number | null | undefined;
  resetsAt: number | null;
}

function resetLabel(vendor: Vendor, resetsAt: number | null, today: Date): string | null {
  if (resetsAt === null) return null;
  const reset = new Date(resetsAt);
  if (!Number.isFinite(reset.getTime())) return null;
  if (vendor === 'claude' || reset.toDateString() === today.toDateString()) {
    return reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, '').toLowerCase();
  }
  return reset.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// The selected allowance stays at the left; its reset sits at the right.
// Claude shows a time. Codex shows a date until the local day of its reset.
export function SubscriptionLimitRows({ rows }: { rows: readonly SubscriptionLimitRow[] }) {
  const today = new Date();
  return <Box flexDirection="column" flexShrink={0}>
    {rows.map(row => {
      const reset = row.remaining == null ? null : resetLabel(row.vendor, row.resetsAt, today);
      return <Box key={row.id} justifyContent="space-between">
        <Text color={theme.textSubtle} wrap="truncate-end">
          {row.label}: {row.remaining === undefined ? 'loading…' : row.remaining === null ? 'unavailable' : `${row.remaining}%`}
        </Text>
        {reset && <Box flexShrink={0} marginLeft={1}><Text color={theme.textSubtle}>{reset}</Text></Box>}
      </Box>;
    })}
  </Box>;
}

function activeSubscriptions() {
  return VENDORS.flatMap(vendor => {
    const provider = providerFor(vendor);
    const active = provider.activeSource();
    // Usage belongs to the signed-in subscription, even when the runtime has
    // temporarily fallen back to an API key for this vendor.
    const source = active?.kind === 'subscription'
      ? active
      : provider.sources.list().find(item => item.kind === 'subscription');
    if (!source || source.kind !== 'subscription') return [];
    return [{
      vendor, source,
      id: `${vendor}:${source.id}`,
      label: VENDOR_INFO[vendor].displayName.toLowerCase(),
    }];
  });
}

function subscriptionRows(subscriptions: ReturnType<typeof activeSubscriptions>, previous: readonly SubscriptionLimitRow[] = []): SubscriptionLimitRow[] {
  return subscriptions.map(item => {
    const limit = previous.find(row => row.id === item.id)
      ?? cachedSubscriptionLimit(item.vendor, item.source.profile, VENDOR_INFO[item.vendor].limitPeriod);
    return {
      id: item.id, vendor: item.vendor, label: item.label,
      remaining: limit?.remaining, resetsAt: limit?.resetsAt ?? null,
    };
  });
}

export default function SubscriptionLimits() {
  // Include cached limits in the sidebar's first frame, before effects run.
  const [rows, setRows] = useState(() => subscriptionRows(activeSubscriptions()));
  useEffect(() => {
    // The latest read of each subscription shown, by row id.
    const reads = new Map<string, AbortController>();
    // The timer reads every subscription again. A provider change reads only
    // one that was not shown before: runtimes starting and stopping change
    // the providers all the time, and every read is a vendor process.
    const refresh = (everything: boolean) => {
      const subscriptions = activeSubscriptions();
      // Remove signed-out accounts immediately, preserving current values for
      // unchanged accounts while the provider answers the refresh.
      setRows(previous => subscriptionRows(subscriptions, previous));
      const shown = new Set(subscriptions.map(item => item.id));
      for (const [id, request] of reads) {
        if (shown.has(id)) continue;
        request.abort();
        reads.delete(id);
      }
      for (const item of subscriptions) {
        if (!everything && reads.has(item.id)) continue;
        reads.get(item.id)?.abort();
        const request = new AbortController();
        reads.set(item.id, request);
        void readSubscriptionUsage(item.vendor, request.signal, item.source.profile).then(usage => {
          if (request.signal.aborted) return;
          const period = VENDOR_INFO[item.vendor].limitPeriod;
          setRows(previous => previous.map(row => row.id === item.id
            ? { ...row, remaining: remainingAllowance(usage, period), resetsAt: allowanceWindow(usage, period)?.resetsAt ?? null } : row));
        }).catch(() => {
          if (request.signal.aborted) return;
          setRows(previous => previous.map(row => row.id === item.id ? { ...row, remaining: null, resetsAt: null } : row));
        });
      }
    };
    refresh(true);
    const unsubscribe = onProviderChange(() => refresh(false));
    const timer = setInterval(() => refresh(true), 60_000);
    return () => {
      clearInterval(timer);
      unsubscribe();
      for (const request of reads.values()) request.abort();
    };
  }, []);
  return <SubscriptionLimitRows rows={rows} />;
}
