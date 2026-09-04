import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { providerFor, VENDORS } from '../agent_runtime/providers/providers';
import { subscribeProviderChanges } from '../agent_runtime/providers/provider';
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
    const source = providerFor(vendor).currentSource();
    if (source?.type !== 'subscription') return [];
    return [{
      vendor, source,
      id: `${vendor}:${source.id}`,
      label: vendor === 'gpt' ? 'codex' : 'claude',
    }];
  });
}

function subscriptionRows(subscriptions: ReturnType<typeof activeSubscriptions>, previous: readonly SubscriptionLimitRow[] = []): SubscriptionLimitRow[] {
  return subscriptions.map(item => ({
    id: item.id, label: item.label,
    remaining: previous.find(row => row.id === item.id)?.remaining
      ?? cachedSubscriptionRemaining(item.vendor, item.source.profile, item.vendor === 'gpt' ? '7-day' : '5-hour'),
  }));
}

export default function SubscriptionLimits() {
  // Include cached limits in the sidebar's first frame, before effects run.
  const [rows, setRows] = useState(() => subscriptionRows(activeSubscriptions()));
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      const request = controller = new AbortController();
      const subscriptions = activeSubscriptions();
      // Remove signed-out accounts immediately, preserving current values for
      // unchanged accounts while the provider answers the refresh.
      setRows(previous => subscriptionRows(subscriptions, previous));
      for (const item of subscriptions) {
        void readSubscriptionUsage(item.vendor, request.signal, item.source.profile).then(usage => {
          if (request.signal.aborted) return;
          setRows(previous => previous.map(row => row.id === item.id
            ? { ...row, remaining: remainingAllowance(usage, item.vendor === 'gpt' ? '7-day' : '5-hour') } : row));
        }).catch(() => {
          if (request.signal.aborted) return;
          setRows(previous => previous.map(row => row.id === item.id ? { ...row, remaining: null } : row));
        });
      }
    };
    refresh();
    const unsubscribe = subscribeProviderChanges(refresh);
    const timer = setInterval(refresh, 60_000);
    return () => { clearInterval(timer); unsubscribe(); controller?.abort(); };
  }, []);
  return <SubscriptionLimitRows rows={rows} />;
}
