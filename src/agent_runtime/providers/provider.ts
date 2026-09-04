import type { ModelStrategy, Response } from '../chat';
import type { Message } from '../types';
import type { TurnContext } from '../turn';
import {
  loadApiKeys,
  loadSubscriptionPreferences,
  saveApiKeys,
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

// One way of reaching a vendor's models. Each provider has two.
export interface Transport {
  getResponse: (messages: readonly Message[], turn: TurnContext) => Promise<Response>;
  // Transports that keep state per agent runtime drop it here.
  resetRuntime?: (runtimeId: string) => void;
  resetAllRuntimes?: () => void;
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
}

// The chosen source per vendor follows the user across launches.
const subscribed: Record<Vendor, boolean> = { claude: false, gpt: false };
let preferencesLoaded = false;

function ensurePreferencesLoaded(): void {
  if (preferencesLoaded) return;
  Object.assign(subscribed, loadSubscriptionPreferences());
  preferencesLoaded = true;
}

export function sourceOf(vendor: Vendor): RequestSource {
  ensurePreferencesLoaded();
  return subscribed[vendor] ? 'subscription' : 'api';
}

export function setSourceOf(vendor: Vendor, source: RequestSource): void {
  ensurePreferencesLoaded();
  subscribed[vendor] = source === 'subscription';
  saveSubscriptionPreferences(subscribed as SubscriptionPreferences);
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

  const apiKey = (): ApiKey | null => {
    const stored = loadApiKeys()[vendor];
    if (stored) return { key: stored, source: 'settings', masked: maskApiKey(stored) };
    const fromEnv = process.env[env];
    if (fromEnv) return { key: fromEnv, source: 'env', masked: maskApiKey(fromEnv) };
    return null;
  };
  const requireApiKey = (): string => {
    const found = apiKey();
    if (found) return found.key;
    throw new Error(`No ${owner} API key. Run /login to sign in or paste a key.`);
  };
  const api = options.api(requireApiKey);
  const active = (): Transport => sourceOf(vendor) === 'subscription' ? subscription : api;

  return {
    vendor,
    judgeModel,
    get source() {
      return sourceOf(vendor);
    },
    setSource: source => setSourceOf(vendor, source),
    apiKeyOwner: owner,
    apiKey,
    requireApiKey,
    setApiKey: key => {
      const trimmed = key.trim();
      if (!trimmed) throw new Error('The API key is empty.');
      if (!saveApiKeys({ ...loadApiKeys(), [vendor]: trimmed })) {
        throw new Error('Could not save the API key');
      }
      if (sourceOf(vendor) === 'subscription') setSourceOf(vendor, 'api');
      return { key: trimmed, source: 'settings', masked: maskApiKey(trimmed) };
    },
    clearApiKey: () => {
      const keys = loadApiKeys();
      if (!keys[vendor]) return false;
      delete keys[vendor];
      if (!saveApiKeys(keys)) throw new Error('Could not remove the API key');
      return true;
    },
    authStatus: () => {
      if (sourceOf(vendor) === 'subscription') return { mode: 'subscription' };
      const found = apiKey();
      return found ? { mode: 'api', source: found.source, masked: found.masked } : { mode: 'none' };
    },
    getResponse: (messages, turn) => active().getResponse(messages, turn),
    // Both transports, whichever is active: a runtime may have state on the
    // one the user switched away from.
    resetRuntime: runtimeId => {
      api.resetRuntime?.(runtimeId);
      subscription.resetRuntime?.(runtimeId);
    },
    resetAllRuntimes: () => {
      api.resetAllRuntimes?.();
      subscription.resetAllRuntimes?.();
    },
  };
}
