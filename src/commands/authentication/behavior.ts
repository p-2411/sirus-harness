import { providerFor } from '../../agent_runtime/providers';
import { parseVendor, VENDOR_INFO, VENDORS, type Vendor } from '../../agent_runtime/providers/catalog';
import { maskApiKey, type Source } from '../../agent_runtime/providers/sources';
import { contextPercent, formatTokens, formatTurnUsage } from '../../agent_runtime/usage';
import type { Feedback } from '../feedback';
import type { CommandMenuItem, CommandSession, Notify } from '../types';
import { readSubscriptionUsage, remainingAllowance, formatRemaining, type SubscriptionUsage } from '../../agent_runtime/providers/usage';

// `/login` asks which provider first; `/login <provider>` then offers that
// provider's two ways in. Picking a provider sends `/login <provider>`, which
// opens the second step through the same path.
export function loginMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 1) return null;
  if (args.length === 0) {
    return VENDORS.map(vendor => ({
      type: 'item',
      key: vendor,
      label: VENDOR_INFO[vendor].displayName,
      description: `${vendor}-* models`,
      command: `/login ${VENDOR_INFO[vendor].command}`,
    }));
  }
  const vendor = parseVendor(args[0]);
  const { command, displayName, accountName } = VENDOR_INFO[vendor];
  return [
    {
      type: 'item',
      key: 'subscription',
      label: 'Subscription',
      description: `sign in with your ${accountName} account in the browser`,
      command: `/login ${command} subscription`,
    },
    {
      type: 'item',
      key: 'api',
      label: 'API key',
      description: `paste an API key for ${displayName}`,
      command: `/login ${command} api`,
      secret: { prompt: `API key for ${displayName}` },
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
    return providerFor(vendor).login(notify, signal).then(text => ({ kind: 'success', text }));
  }
  if (args[1] === 'api' && args.length === 3) {
    const stored = providerFor(vendor).sources.addApiKey(args[2]);
    return { kind: 'success', text: `Saved ${VENDOR_INFO[vendor].displayName} API key ${maskApiKey(stored.key)}.` };
  }
  const command = VENDOR_INFO[vendor].command;
  throw new Error(`Usage: /login ${command} subscription  or  /login ${command} api <key>`);
}

function isEnvironmentKey(source: Source): boolean {
  return source.kind === 'api' && source.fromEnv === true;
}

// The account behind a source: the email a subscription was signed in with,
// or the recognisable ends of an API key.
function describeSource(vendor: Vendor, source: Source): string {
  return `${VENDOR_INFO[vendor].displayName} · ${source.kind === 'api' ? maskApiKey(source.key) : source.label ?? 'subscription'}`;
}

// `/logout` alone lists every removable source by account. Environment keys
// are not listed: they belong to the shell.
export function logoutMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 0) return null;
  const items = VENDORS.flatMap(vendor => providerFor(vendor).sources.list()
    .filter(source => !isEnvironmentKey(source))
    .map(source => ({
      type: 'item' as const,
      key: `${vendor}:${source.id}`,
      label: describeSource(vendor, source),
      description: source.kind === 'api' ? 'API key' : 'subscription',
      command: `/logout ${VENDOR_INFO[vendor].command} ${source.id}`,
    })));
  return items.length ? items : null;
}

export function logoutCommand(name: string | undefined, sourceId?: string): Feedback {
  if (name === undefined) return { kind: 'info', text: 'Nothing to sign out of.' };
  const vendor = parseVendor(name);
  const provider = providerFor(vendor);
  const sources = provider.sources.list();
  // Without an id: the source this vendor would use next, which is the head of
  // its own list. Environment keys belong to the shell and are never removed.
  const target = sourceId
    ? sources.find(source => source.id === sourceId || source.id.startsWith(sourceId))
    : sources.find(source => !isEnvironmentKey(source));
  if (sourceId && sources.filter(source => source.id.startsWith(sourceId)).length > 1) {
    throw new Error('Ambiguous source. Pick one from /logout.');
  }
  if (sourceId && !target) throw new Error('Unknown source. Pick one from /logout.');
  if (!target || !provider.sources.remove(target.id)) return { kind: 'info', text: `Nothing to sign out of for ${VENDOR_INFO[vendor].displayName}.` };
  return { kind: 'success', text: `Removed ${describeSource(vendor, target)}.` };
}

async function describeVendor(vendor: Vendor, signal?: AbortSignal): Promise<string> {
  const provider = providerFor(vendor);
  const sources = provider.sources.list();
  if (!sources.length) return `${VENDOR_INFO[vendor].displayName} · not configured`;
  const rows = await Promise.all(sources.map(async source => {
    if (source.kind === 'api') return `${describeSource(vendor, source)} · API key${isEnvironmentKey(source) ? ' (env)' : ''}`;
    // Logins before accounts were recorded have no label; ask the provider.
    const account = source.label ?? await provider.subscriptionDetail(source.profile, signal).catch(() => 'subscription');
    const usage = await readSubscriptionUsage(vendor, signal, source.profile);
    return `${VENDOR_INFO[vendor].displayName} · ${account} · ${describeSubscriptionUsage(usage)}`;
  }));
  return rows.join('\n');
}

// What is left of each allowance window, as both vendors' own terminals say
// it: "5h 58% left · 7d 90% left".
export function describeSubscriptionUsage(usage: SubscriptionUsage): string {
  return `5h ${formatRemaining(remainingAllowance(usage, '5-hour'))} · 7d ${formatRemaining(remainingAllowance(usage, '7-day'))}`;
}

// What each participant has spent in this session and how full its window
// is, from what its runtime reported. A participant with nothing reported
// yet is left out.
export function describeSessionUsage(session: CommandSession): string {
  const parts = session.getParticipants().flatMap(participant => {
    const context = session.getContextUsage(participant.name);
    const usage = session.getTurnUsage(participant.name);
    if (!context && !usage) return [];
    const percent = context ? contextPercent(context) : null;
    const figures = [
      usage ? formatTurnUsage(usage) : null,
      context ? `ctx ${formatTokens(context.tokens)}${percent !== null ? ` (${percent}% of ${formatTokens(context.window)})` : ''}` : null,
    ].filter(Boolean).join(', ');
    return [`@${participant.name} ${figures}`];
  });
  return parts.length ? `session · ${parts.join(' · ')}` : 'session · no usage reported yet';
}

export async function usageCommand(signal?: AbortSignal, session?: CommandSession): Promise<Feedback> {
  const lines = await Promise.all(VENDORS.map(vendor => describeVendor(vendor, signal)));
  if (session) lines.push(describeSessionUsage(session));
  return { kind: 'info', text: lines.join('\n'), showIcon: false };
}
