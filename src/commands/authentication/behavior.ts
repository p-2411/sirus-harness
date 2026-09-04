import { maskApiKey } from '../../agent_runtime/providers/provider';
import { login, type Notify } from '../../agent_runtime/providers/login';
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

function modelsOf(vendor: Vendor): string {
  return `${vendor}-* models`;
}

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
      description: modelsOf(vendor),
      command: `/login ${vendor}`,
    }));
  }
  const vendor = parseVendor(args[0]);
  return [
    {
      type: 'item',
      key: 'subscription',
      label: 'Subscription',
      description: `add a ${VENDOR_NAMES[vendor]} subscription in the browser`,
      command: `/login ${vendor} subscription`,
    },
    {
      type: 'item',
      key: 'api',
      label: 'API key',
      description: `add an ${providerFor(vendor).apiKeyOwner} API key`,
      command: `/login ${vendor} api`,
      secret: { prompt: `Paste your ${providerFor(vendor).apiKeyOwner} API key` },
    },
  ];
}

export function loginCommand(
  args: readonly string[],
  notify: Notify,
  signal?: AbortSignal,
): Promise<Feedback> | Feedback {
  const choices = loginMenuItems(args);
  if (choices) {
    return {
      kind: 'info',
      text: `Choose a sign-in: ${choices.map(item => item.command).join(', ')}. /info shows the current state.`,
    };
  }
  const vendor = parseVendor(args[0]);
  if (args[1] === 'subscription' && args.length === 2) {
    return login(vendor, notify, signal).then(text => ({ kind: 'success', text }));
  }
  if (args[1] === 'api' && args.length === 3) {
    const provider = providerFor(vendor);
    const stored = provider.setApiKey(args[2]);
    return {
      kind: 'success',
      text: `Saved your ${provider.apiKeyOwner} API key (${stored.masked}). ${modelsOf(vendor)} try it first, then your other sources.`,
    };
  }
  throw new Error(`Usage: /login ${vendor} subscription  or  /login ${vendor} api <key>`);
}

export function logoutCommand(name: string | undefined, sourceId?: string): Feedback {
  const vendor = parseVendor(name);
  const provider = providerFor(vendor);
  const sources = provider.sources();
  const target = sourceId
    ? sources.find(source => source.id === sourceId || source.id.startsWith(sourceId))
    : sources.find(source => source.type === provider.source && !('environment' in source));
  if (sourceId && sources.filter(source => source.id.startsWith(sourceId)).length > 1) {
    throw new Error('Source ID is ambiguous. Use the full ID from /info.');
  }
  if (sourceId && !target) throw new Error('Unknown source. Use an ID from /info.');
  if (!target || !provider.removeSource(target.id)) return { kind: 'info', text: `Nothing to sign out of for ${vendor}.` };
  return { kind: 'success', text: `Removed ${vendor} ${target.type} source.` };
}

async function describeVendor(vendor: Vendor, signal?: AbortSignal): Promise<string> {
  const sources = providerFor(vendor).sources();
  if (!sources.length) return `${vendor}: not configured`;
  const rows = await Promise.all(sources.map(async source => {
    const peers = sources.filter(item => item.type === source.type);
    const title = `${vendor}${peers.length > 1 ? ` ${peers.indexOf(source) + 1}` : ''}`;
    if (source.type === 'api') return `${title}: API key · ${maskApiKey(source.key)} · ${source.id}`;
    const usage = await readSubscriptionUsage(vendor, signal, source.profile);
    return `${title}: subscription · ${source.id}\n${describeSubscriptionUsage(usage)}`;
  }));
  return rows.join('\n');
}

export function describeSubscriptionUsage(usage: SubscriptionUsage, _now?: number): string {
  return `  5 hour: ${formatRemaining(remainingAllowance(usage, '5-hour'))}\n  7-day: ${formatRemaining(remainingAllowance(usage, '7-day'))}`;
}

// What the session has spent so far and how full its window is, when any
// response has reported usage.
export function describeSessionUsage(session: Session): string {
  const totals = session.getTotalUsage();
  if (!totals) return 'session: token usage unavailable · no response has reported it yet';
  const context = session.getContextUsage();
  const parts = [`${formatTokens(totals.inputTokens)} in`, `${formatTokens(totals.outputTokens)} out`];
  if (context) {
    const percent = contextPercent(context);
    parts.push(`context ${formatTokens(context.tokens)}${
      percent !== null && context.window ? ` (${percent}% of ${formatTokens(context.window)})` : ''}`);
  }
  return `session: ${parts.join(' · ')}`;
}

export async function infoCommand(signal?: AbortSignal, session?: Session): Promise<Feedback> {
  const lines = await Promise.all(VENDORS.map(vendor => describeVendor(vendor, signal)));
  const usage = session ? describeSessionUsage(session) : null;
  if (usage) lines.push(usage);
  return { kind: 'info', text: lines.join('\n'), showIcon: false };
}
