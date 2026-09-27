import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { onProviderChange, providerFor } from '../agent_runtime/providers';
import { VENDOR_INFO, VENDORS } from '../agent_runtime/providers/catalog';
import { cachedSubscriptionRemaining, formatRemaining, readSubscriptionUsage, remainingAllowance } from '../agent_runtime/providers/usage';
import { theme } from './styles/theme';

export interface SubscriptionLimitRow {
  id: string;
  label: string;
  // Undefined while the first read is pending; null means no limit was reported.
  remaining: number | null | undefined;
}

export function SubscriptionLimitRows({ rows }: { rows: readonly SubscriptionLimitRow[] }) {
  return <Box flexDirection="column" flexShrink={0}>
    {rows.map(row => <Text key={row.id} color={theme.textSubtle}>
      {row.label}: {row.remaining === undefined ? 'loading…' : formatRemaining(row.remaining)}
    </Text>)}
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
      label: VENDOR_INFO[vendor].sidebarLabel,
    }];
  });
}

function subscriptionRows(subscriptions: ReturnType<typeof activeSubscriptions>, previous: readonly SubscriptionLimitRow[] = []): SubscriptionLimitRow[] {
  return subscriptions.map(item => ({
    id: item.id, label: item.label,
    remaining: previous.find(row => row.id === item.id)?.remaining
      ?? cachedSubscriptionRemaining(item.vendor, item.source.profile, VENDOR_INFO[item.vendor].limitPeriod),
  }));
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
          setRows(previous => previous.map(row => row.id === item.id
            ? { ...row, remaining: remainingAllowance(usage, VENDOR_INFO[item.vendor].limitPeriod) } : row));
        }).catch(() => {
          if (request.signal.aborted) return;
          setRows(previous => previous.map(row => row.id === item.id ? { ...row, remaining: null } : row));
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
