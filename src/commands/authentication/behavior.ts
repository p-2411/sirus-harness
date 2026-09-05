import { maskApiKey, type ProviderSource } from '../../agent_runtime/providers/provider';
import { login, subscriptionDetail, type Notify } from '../../agent_runtime/providers/login';
import {
  parseVendor,
  providerFor,
  VENDORS,
  type Vendor,
} from '../../agent_runtime/providers/providers';
import type { Session } from '../../agent_runtime/session';
import { contextPercent, formatTokens } from '../../agent_runtime/usage';
import type { Feedback } from '../feedback';
import type { CommandMenuItem } from '../types';
import { readSubscriptionUsage, remainingAllowance, formatRemaining, type SubscriptionUsage } from '../../agent_runtime/providers/usage';

const VENDOR_NAMES: Record<Vendor, string> = { claude: 'Claude', gpt: 'ChatGPT' };

// `/login` asks which provider first; `/login <provider>` then offers that
// provider's two ways in. Picking a provider sends `/login <provider>`, which
// opens the second step through the same path.
export function loginMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 1) return null;
  if (args.length === 0) {
    return VENDORS.map(vendor => ({
      type: 'item',
      key: vendor,
      label: VENDOR_NAMES[vendor],
      description: `${vendor}-* models`,
      command: `/login ${vendor}`,
    }));
  }
  const vendor = parseVendor(args[0]);
  return [
    {
      type: 'item',
      key: 'subscription',
      label: 'Subscription',
      description: `sign in to ${VENDOR_NAMES[vendor]} in the browser`,
      command: `/login ${vendor} subscription`,
    },
    {
      type: 'item',
      key: 'api',
      label: 'API key',
      description: `paste an ${providerFor(vendor).apiKeyOwner} API key`,
      command: `/login ${vendor} api`,
      secret: { prompt: `${providerFor(vendor).apiKeyOwner} API key` },
    },
  ];
}

export function loginCommand(
  args: readonly string[],
  notify: Notify,
  signal?: AbortSignal,
): Promise<Feedback> | Feedback {
  const choices = loginMenuItems(args);
  if (choices) return { kind: 'info', text: choices.map(item => item.command).join(' · ') };
  const vendor = parseVendor(args[0]);
  if (args[1] === 'subscription' && args.length === 2) {
    return login(vendor, notify, signal).then(text => ({ kind: 'success', text }));
  }
  if (args[1] === 'api' && args.length === 3) {
    const provider = providerFor(vendor);
    const stored = provider.setApiKey(args[2]);
    return { kind: 'success', text: `Saved ${provider.apiKeyOwner} API key ${stored.masked}.` };
  }
  throw new Error(`Usage: /login ${vendor} subscription  or  /login ${vendor} api <key>`);
}

// The account behind a source: the email a subscription was signed in with,
// or the recognisable ends of an API key.
function describeSource(vendor: Vendor, source: ProviderSource): string {
  return `${vendor} · ${source.type === 'api' ? maskApiKey(source.key) : source.label ?? 'subscription'}`;
}

// `/logout` alone lists every removable source by account. Environment keys
// are not listed: they belong to the shell.
export function logoutMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 0) return null;
  const items = VENDORS.flatMap(vendor => providerFor(vendor).sources()
    .filter(source => !('environment' in source))
    .map(source => ({
      type: 'item' as const,
      key: `${vendor}:${source.id}`,
      label: describeSource(vendor, source),
      description: source.type === 'api' ? 'API key' : 'subscription',
      command: `/logout ${vendor} ${source.id}`,
    })));
  return items.length ? items : null;
}

export function logoutCommand(name: string | undefined, sourceId?: string): Feedback {
  if (name === undefined) return { kind: 'info', text: 'Nothing to sign out of.' };
  const vendor = parseVendor(name);
  const provider = providerFor(vendor);
  const sources = provider.sources();
  const target = sourceId
    ? sources.find(source => source.id === sourceId || source.id.startsWith(sourceId))
    : sources.find(source => source.type === provider.source && !('environment' in source));
  if (sourceId && sources.filter(source => source.id.startsWith(sourceId)).length > 1) {
    throw new Error('Ambiguous source. Pick one from /logout.');
  }
  if (sourceId && !target) throw new Error('Unknown source. Pick one from /logout.');
  if (!target || !provider.removeSource(target.id)) return { kind: 'info', text: `Nothing to sign out of for ${vendor}.` };
  return { kind: 'success', text: `Removed ${describeSource(vendor, target)}.` };
}

async function describeVendor(vendor: Vendor, signal?: AbortSignal): Promise<string> {
  const sources = providerFor(vendor).sources();
  if (!sources.length) return `${vendor} · not configured`;
  const rows = await Promise.all(sources.map(async source => {
    if (source.type === 'api') return `${describeSource(vendor, source)} · API key${'environment' in source ? ' (env)' : ''}`;
    // Logins before accounts were recorded have no label; ask the provider.
    const account = source.label ?? await subscriptionDetail(vendor, signal, source.profile).catch(() => 'subscription');
    const usage = await readSubscriptionUsage(vendor, signal, source.profile);
    return `${vendor} · ${account} · ${describeSubscriptionUsage(usage)}`;
  }));
  return rows.join('\n');
}

export function describeSubscriptionUsage(usage: SubscriptionUsage): string {
  return `5h ${formatRemaining(remainingAllowance(usage, '5-hour'))} · 7d ${formatRemaining(remainingAllowance(usage, '7-day'))}`;
}

// What the session has spent so far and how full its window is, when any
// response has reported usage.
export function describeSessionUsage(session: Session): string {
  const totals = session.getTotalUsage();
  if (!totals) return 'session · no usage reported yet';
  const context = session.getContextUsage();
  const parts = [`${formatTokens(totals.inputTokens)} in`, `${formatTokens(totals.outputTokens)} out`];
  if (context) {
    const percent = contextPercent(context);
    parts.push(`ctx ${formatTokens(context.tokens)}${
      percent !== null && context.window ? ` (${percent}% of ${formatTokens(context.window)})` : ''}`);
  }
  return `session · ${parts.join(' · ')}`;
}

export async function usageCommand(signal?: AbortSignal, session?: Session): Promise<Feedback> {
  const lines = await Promise.all(VENDORS.map(vendor => describeVendor(vendor, signal)));
  if (session) lines.push(describeSessionUsage(session));
  return { kind: 'info', text: lines.join('\n'), showIcon: false };
}
