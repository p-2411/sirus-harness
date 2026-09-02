import { loadApiKeys, saveApiKeys } from '../data/persistence';
import { isSubscriptionEnabled, setSubscriptionEnabled, type Vendor } from './subscriptions';

// Where a provider's API key comes from: pasted into Sirus (`settings`) or the
// environment variable the app has always read (`env`). Stored keys win so a
// user who pastes one is not surprised by a stale shell variable.

export const API_KEY_ENV: Record<Vendor, string> = {
  claude: 'ANTHROPIC_API',
  gpt: 'OPENAI_SECRET',
};

export const API_KEY_OWNER: Record<Vendor, string> = {
  claude: 'Anthropic',
  gpt: 'OpenAI',
};

export type ApiKeySource = 'settings' | 'env';

export interface ApiKey {
  key: string;
  source: ApiKeySource;
}

export type AuthStatus =
  | { mode: 'subscription' }
  | { mode: 'api'; source: ApiKeySource; masked: string }
  | { mode: 'none' };

export function findApiKey(vendor: Vendor): ApiKey | null {
  const stored = loadApiKeys()[vendor];
  if (stored) return { key: stored, source: 'settings' };
  const fromEnv = process.env[API_KEY_ENV[vendor]];
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return null;
}

export function requireApiKey(vendor: Vendor): string {
  const found = findApiKey(vendor);
  if (found) return found.key;
  throw new Error(`No ${API_KEY_OWNER[vendor]} API key. Run /login to sign in or paste a key.`);
}

export function setApiKey(vendor: Vendor, key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('The API key is empty.');
  if (!saveApiKeys({ ...loadApiKeys(), [vendor]: trimmed })) {
    throw new Error('Could not save the API key');
  }
  // A pasted key is an explicit choice: it takes over from the subscription.
  if (isSubscriptionEnabled(vendor)) setSubscriptionEnabled(vendor, false);
}

export function clearApiKey(vendor: Vendor): boolean {
  const keys = loadApiKeys();
  if (!keys[vendor]) return false;
  delete keys[vendor];
  if (!saveApiKeys(keys)) throw new Error('Could not remove the API key');
  return true;
}

// Enough to recognise a key (its prefix and last four characters) and no
// more, so it can appear in status lines and logs.
export function maskApiKey(key: string): string {
  const tail = key.length > 8 ? key.slice(-4) : '';
  const prefix = /^(sk-[a-z]+-|sk-)/i.exec(key)?.[1] ?? '';
  return `${key.length > 8 ? prefix : ''}…${tail}`;
}

export function authStatus(vendor: Vendor): AuthStatus {
  if (isSubscriptionEnabled(vendor)) return { mode: 'subscription' };
  const found = findApiKey(vendor);
  if (!found) return { mode: 'none' };
  return { mode: 'api', source: found.source, masked: maskApiKey(found.key) };
}
