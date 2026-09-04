import { randomUUID } from 'crypto';
import { isAbortError, throwIfAborted } from '../../abort';
import type { ModelStrategy, Response } from '../chat';
import type { Message } from '../types';
import type { TurnContext } from '../turn';
import {
  dataDirectory,
  clearSubscriptionLimitCache,
  loadApiKeys,
  loadSubscriptionPreferences,
  loadProviderSources,
  saveProviderSources,
  type StoredProviderSource,
  saveSubscriptionPreferences,
  type SubscriptionPreferences,
} from '../../persistence';

export type Vendor = 'claude' | 'gpt';

export const VENDORS: readonly Vendor[] = ['claude', 'gpt'];

export function parseVendor(name: string | undefined): Vendor {
  if (name === 'claude' || name === 'gpt') return name;
  throw new Error(`Unknown provider "${name ?? ''}". Try: ${VENDORS.join(', ')}`);
}

// Where a provider sends its requests: the vendor's API with the user's key,
// or the user's subscription through the vendor's own runtime. Same models,
// same behaviour; only the source of the request differs.
export type RequestSource = 'api' | 'subscription';

// A request transport bound to one source's credentials.
export interface Transport {
  getResponse: (messages: readonly Message[], turn: TurnContext) => Promise<Response>;
  // Transports that keep state per agent runtime drop it here.
  resetRuntime?: (runtimeId: string) => void;
  resetAllRuntimes?: () => void;
  dispose?: () => void;
}

// An API key and where it came from: pasted into Sirus (`settings`) or the
// environment variable the app has always read (`env`).
export type ApiKeySource = 'settings' | 'env';

export interface ApiKey {
  key: string;
  source: ApiKeySource;
  // Enough to recognise the key in status lines and logs, and no more.
  masked: string;
}

// What the provider is signed in with, for /info.
export type AuthStatus =
  | { mode: 'subscription' }
  | { mode: 'api'; source: ApiKeySource; masked: string }
  | { mode: 'none' };

// A vendor's models as the agent runtime sees them, plus everything about
// how the vendor is reached: which transport is in use and the key for the
// API one.
export interface Provider extends ModelStrategy {
  readonly vendor: Vendor;
  readonly source: RequestSource;
  setSource: (source: RequestSource) => void;
  // The vendor's name as it appears on the key, for messages to the user.
  readonly apiKeyOwner: string;
  // Stored keys win over the environment, so a user who pastes one is not
  // surprised by a stale shell variable.
  apiKey: () => ApiKey | null;
  requireApiKey: () => string;
  // Saves the key and makes the API the source: a pasted key is an explicit
  // choice that takes over from the subscription.
  setApiKey: (key: string) => ApiKey;
  clearApiKey: () => boolean;
  sources: () => ProviderSource[];
  // Most recently used source, or the preferred source before the first request.
  currentSource: () => ProviderSource | null;
  addSubscription: (profile: string, label?: string) => void;
  removeSource: (id: string) => boolean;
  authStatus: () => AuthStatus;
}

export interface ProviderOptions {
  vendor: Vendor;
  judgeModel: string;
  apiKey: {
    // The environment variable the key may come from.
    env: string;
    owner: string;
  };
  // The API transport is handed the key lookup rather than finding the key
  // itself, so it knows nothing about vendors or storage.
  api: (requireApiKey: () => string) => Transport;
  subscription: Transport;
  subscriptionFor?: (profile: string) => Transport;
}

export type ProviderSource = StoredProviderSource | { id: 'env'; type: 'api'; key: string; environment: true };

const listeners = new Set<() => void>();
export function subscribeProviderChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function changed(): void { for (const listener of listeners) listener(); }

export function sourceOf(vendor: Vendor): RequestSource {
  return loadSubscriptionPreferences()[vendor] ? 'subscription' : 'api';
}

export function setSourceOf(vendor: Vendor, source: RequestSource): void {
  const preferences = loadSubscriptionPreferences();
  preferences[vendor] = source === 'subscription';
  if (!saveSubscriptionPreferences(preferences as SubscriptionPreferences)) throw new Error('Could not save provider preference');
  changed();
}

// The prefix and last four characters of a key, or nothing recognisable for
// a short one.
export function maskApiKey(key: string): string {
  const tail = key.length > 8 ? key.slice(-4) : '';
  const prefix = /^(sk-[a-z]+-|sk-)/i.exec(key)?.[1] ?? '';
  return `${key.length > 8 ? prefix : ''}…${tail}`;
}

export function createProvider(options: ProviderOptions): Provider {
  const { vendor, judgeModel, subscription } = options;
  const { env, owner } = options.apiKey;
  const transports = new Map<string, Transport>();
  // A successful fallback remains first for the rest of this agent's runtime.
  const selected = new Map<string, string>();
  let current: { directory: string; runtimeId: string; sourceId: string } | null = null;
  const storedSources = (): StoredProviderSource[] => {
    const saved = loadProviderSources()[vendor];
    if (saved) return saved;
    const legacy: StoredProviderSource[] = [];
    if (sourceOf(vendor) === 'subscription') legacy.push({ id: 'default', type: 'subscription', profile: 'default' });
    const key = loadApiKeys()[vendor];
    if (key) legacy.push({ id: 'legacy-api', type: 'api', key });
    return legacy;
  };
  const sources = (): ProviderSource[] => {
    const saved: ProviderSource[] = [...storedSources()];
    const key = process.env[env]?.trim();
    if (key && !saved.some(source => source.type === 'api' && source.key === key)) {
      saved.push({ id: 'env', type: 'api', key, environment: true });
    }
    return saved;
  };
  const persist = (next: StoredProviderSource[]) => {
    if (!saveProviderSources({ ...loadProviderSources(), [vendor]: next })) throw new Error('Could not save provider sources');
    selected.clear();
    current = null;
  };
  const currentSource = (): ProviderSource | null => {
    const available = sources();
    const active = current;
    const latest = active?.directory === dataDirectory()
      ? available.find(source => source.id === active.sourceId) : undefined;
    const preference = sourceOf(vendor);
    return latest ?? available.find(source => source.type === preference) ?? available[0] ?? null;
  };
  const apiKey = (): ApiKey | null => {
    const found = sources().find(source => source.type === 'api');
    return found?.type === 'api'
      ? { key: found.key, source: 'environment' in found ? 'env' : 'settings', masked: maskApiKey(found.key) } : null;
  };
  const requireApiKey = (): string => {
    const found = apiKey();
    if (found) return found.key;
    throw new Error(`No ${owner} API key. Run /login to sign in or paste a key.`);
  };
  const transportFor = (source: ProviderSource): Transport => {
    // Capture the key in this transport; concurrent turns cannot swap credentials.
    const cacheKey = JSON.stringify([dataDirectory(), source]);
    let transport = transports.get(cacheKey);
    if (!transport) {
      transport = source.type === 'api' ? options.api(() => source.key)
        : options.subscriptionFor?.(source.profile) ?? subscription;
      transports.set(cacheKey, transport);
    }
    return transport;
  };
  const removeSource = (id: string): boolean => {
    const saved = storedSources();
    const removed = saved.find(source => source.id === id);
    if (!removed) return false;
    const next = saved.filter(source => source.id !== id);
    persist(next);
    if (removed.type === 'subscription') clearSubscriptionLimitCache(vendor, removed.profile);
    const removedTransport = transportFor(removed);
    if (removedTransport.dispose) removedTransport.dispose();
    else removedTransport.resetAllRuntimes?.();
    setSourceOf(vendor, next[0]?.type ?? 'api');
    return true;
  };

  return {
    vendor, judgeModel, apiKeyOwner: owner, apiKey, requireApiKey, sources, currentSource, removeSource,
    get source() { return sourceOf(vendor); },
    setSource: source => {
      // Preserve the legacy programmatic subscription toggle as well as /login.
      const saved = storedSources();
      if (source === 'subscription' && !saved.some(item => item.type === 'subscription')) {
        persist([{ id: 'default', type: 'subscription', profile: 'default' }, ...saved]);
      }
      selected.clear();
      current = null;
      setSourceOf(vendor, source);
    },
    setApiKey: key => {
      const trimmed = key.trim();
      if (!trimmed) throw new Error('The API key is empty.');
      const saved = storedSources();
      const existing = saved.find(source => source.type === 'api' && source.key === trimmed);
      persist([existing ?? { id: randomUUID(), type: 'api', key: trimmed },
        ...saved.filter(source => source !== existing)]);
      setSourceOf(vendor, 'api');
      return { key: trimmed, source: 'settings', masked: maskApiKey(trimmed) };
    },
    addSubscription: (profile, label) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid subscription profile');
      const saved = storedSources();
      const existing = saved.find(source => source.type === 'subscription' && source.profile === profile);
      persist([{ id: existing?.id ?? profile, type: 'subscription', profile, ...(label ? { label } : {}) },
        ...saved.filter(source => source !== existing)]);
      clearSubscriptionLimitCache(vendor, profile);
      setSourceOf(vendor, 'subscription');
    },
    clearApiKey: () => {
      const first = storedSources().find(source => source.type === 'api');
      return first ? removeSource(first.id) : false;
    },
    authStatus: () => {
      if (sourceOf(vendor) === 'subscription' && sources().some(source => source.type === 'subscription')) return { mode: 'subscription' };
      const found = apiKey();
      return found ? { mode: 'api', source: found.source, masked: found.masked } : { mode: 'none' };
    },
    getResponse: async (messages, turn) => {
      throwIfAborted(turn.signal);
      const failed = new Set<string>();
      const failures: string[] = [];
      const execute = async (input: readonly Message[], resumeSource?: string, resume?: () => Promise<Response>): Promise<Response> => {
        const candidates = sources().filter(source => !failed.has(source.id));
        // Preference groups keep explicit API/subscription choices first.
        const preference = sourceOf(vendor);
        candidates.sort((a, b) => Number(b.type === preference) - Number(a.type === preference));
        const previous = resumeSource ?? selected.get(turn.agent.runtimeId);
        candidates.sort((a, b) => Number(b.id === previous) - Number(a.id === previous));
        if (!candidates.length && !failures.length) { requireApiKey(); throw new Error('No provider sources'); }
        let history = input;
        for (const source of candidates) {
          throwIfAborted(turn.signal);
          const before = turn.content.length;
          const transport = transportFor(source);
          try {
            const sourceChanged = current?.directory !== dataDirectory() || current.sourceId !== source.id;
            current = { directory: dataDirectory(), runtimeId: turn.agent.runtimeId, sourceId: source.id };
            if (sourceChanged) changed();
            const response = await (source.id === resumeSource && resume ? resume() : transport.getResponse(history, turn));
            selected.set(turn.agent.runtimeId, source.id);
            const continuation = response.continueWithToolResults;
            const responseHistory = history;
            return continuation ? {
              ...response,
              continueWithToolResults: results => execute([
                ...responseHistory,
                { role: 'assistant', content: [...response.content, ...results] },
                { role: 'user', content: [{ type: 'text', text: 'Continue using the tool results above. Do not repeat completed work.' }] },
              ], source.id, () => continuation(results)),
            } : response;
          } catch (error) {
            throwIfAborted(turn.signal);
            if (isAbortError(error)) throw error;
            failed.add(source.id);
            transport.resetRuntime?.(turn.agent.runtimeId);
            const partial = turn.content.slice(before);
            // Completed tool work must travel with the retry so it isn't repeated.
            // An unresolved call has an unknown outcome: don't execute it again.
            const calls = partial.filter(block => block.type === 'tool_call');
            if (source.type === 'subscription' && calls.some(call => !partial.some(block => block.type === 'tool_result' && block.callId === call.id))) throw error;
            turn.updateStream([]);
            if (source.type === 'subscription' && calls.length) {
              turn.commit(partial);
              history = [...history, { role: 'assistant', content: partial }, { role: 'user', content: [{
                type: 'text', text: 'The previous source failed. Continue from the completed work above without repeating those tools.',
              }] }];
            }
            const detail = error instanceof Error ? error.message : String(error);
            const safe = sources().reduce((text, item) => item.type === 'api' ? text.replaceAll(item.key, maskApiKey(item.key)) : text, detail);
            failures.push(`${source.type === 'api' ? `API ${maskApiKey(source.key)}` : `subscription ${source.label ?? source.id}`}: ${safe}`);
          }
        }
        throw new Error(`All ${owner} sources failed (${failures.length}): ${failures.join('; ')}`);
      };
      return execute(messages);
    },
    resetRuntime: runtimeId => {
      selected.delete(runtimeId);
      if (current?.runtimeId === runtimeId) { current = null; changed(); }
      for (const transport of new Set([subscription, ...transports.values()])) transport.resetRuntime?.(runtimeId);
    },
    resetAllRuntimes: () => {
      selected.clear();
      current = null;
      changed();
      for (const transport of new Set([subscription, ...transports.values()])) transport.resetAllRuntimes?.();
      transports.clear();
    },
  };
}
