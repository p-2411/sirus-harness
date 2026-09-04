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
import { abortable, throwIfAborted } from '../../abort';
import { readSubscriptionUsage, type SubscriptionUsage } from '../../agent_runtime/providers/usage';

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
      description: `sign in with your ${VENDOR_NAMES[vendor]} account in the browser`,
      command: `/login ${vendor} subscription`,
    },
    {
      type: 'item',
      key: 'api',
      label: 'API key',
      description: `paste an ${providerFor(vendor).apiKeyOwner} API key`,
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
      text: `Saved your ${provider.apiKeyOwner} API key (${stored.masked}). ${modelsOf(vendor)} now use it.`,
    };
  }
  throw new Error(`Usage: /login ${vendor} subscription  or  /login ${vendor} api <key>`);
}

function remainingCredentials(vendor: Vendor): string {
  const provider = providerFor(vendor);
  const found = provider.apiKey();
  if (!found) return `${modelsOf(vendor)} are signed out; run /login to sign in.`;
  return found.source === 'settings'
    ? `${modelsOf(vendor)} now use your saved ${provider.apiKeyOwner} API key (${found.masked}).`
    : `${modelsOf(vendor)} now use the ${provider.apiKeyOwner} API key (${found.masked}).`;
}

export function logoutCommand(name: string | undefined): Feedback {
  const vendor = parseVendor(name);
  const provider = providerFor(vendor);
  if (provider.source === 'subscription') {
    provider.setSource('api');
    return {
      kind: 'success',
      text: `Signed out of the ${VENDOR_NAMES[vendor]} subscription. ${remainingCredentials(vendor)}`,
    };
  }
  if (provider.clearApiKey()) {
    return {
      kind: 'success',
      text: `Removed your saved ${provider.apiKeyOwner} API key. ${remainingCredentials(vendor)}`,
    };
  }
  return { kind: 'info', text: `Nothing to sign out of for ${vendor}.` };
}

async function describeVendor(vendor: Vendor, signal?: AbortSignal): Promise<string> {
  const status = providerFor(vendor).authStatus();
  switch (status.mode) {
    case 'subscription': {
      const timeout = AbortSignal.timeout(10_000);
      const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const [detail, usage] = await Promise.all([
        abortable(subscriptionDetail(vendor, bounded), bounded).catch(() => {
          throwIfAborted(signal);
          return 'account status unavailable';
        }),
        readSubscriptionUsage(vendor, signal),
      ]);
      return `${vendor}: subscription · ${detail}\n${describeSubscriptionUsage(usage)}`;
    }
    case 'api':
      return `${vendor}: API key · ${status.masked}`;
    case 'none':
      return `${vendor}: not configured`;
  }
}

const RESET_TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

export function describeSubscriptionUsage(usage: SubscriptionUsage, now: number = Date.now()): string {
  if (usage.windows.length === 0) return `  allowance unavailable · ${usage.unavailable ?? 'not reported by provider'}`;
  const lines = usage.windows.map(window => {
    const amount = window.usedPercent === null
      ? 'usage unavailable'
      : `${Number((100 - window.usedPercent).toFixed(1))}% remaining · ${Number(window.usedPercent.toFixed(1))}% used`;
    let reset = 'reset time unavailable';
    if (window.resetsAt !== null) {
      const minutes = Math.max(0, Math.ceil((window.resetsAt - now) / 60_000));
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor(minutes % 1440 / 60);
      const remaining = minutes % 60;
      const relative = minutes === 0 ? 'reset time passed; refresh /info'
        : `in ${[days ? `${days}d` : '', hours ? `${hours}h` : '', remaining ? `${remaining}m` : ''].filter(Boolean).join(' ')}`;
      reset = `resets ${RESET_TIME.format(window.resetsAt)} (${relative})`;
    }
    return `    ${window.label}: ${amount} · ${reset}`;
  });
  return ['  allowance (shared across sessions):', ...lines].join('\n');
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
