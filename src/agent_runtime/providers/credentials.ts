import { loadApiKeys, saveApiKeys } from '../../persistence';
import type { Vendor } from './provider';

// Storage and lookup of API keys: pasted into Sirus (`settings`) or the
// environment variable the app has always read (`env`). Stored keys win so a
// user who pastes one is not surprised by a stale shell variable. Whether the
// key is what a provider currently uses is the provider's call, not this
// module's.

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
  // Enough to recognise the key in status lines and logs, and no more.
  masked: string;
}

export function findApiKey(vendor: Vendor): ApiKey | null {
  const stored = loadApiKeys()[vendor];
  if (stored) return { key: stored, source: 'settings', masked: maskApiKey(stored) };
  const fromEnv = process.env[API_KEY_ENV[vendor]];
  if (fromEnv) return { key: fromEnv, source: 'env', masked: maskApiKey(fromEnv) };
  return null;
}

export function requireApiKey(vendor: Vendor): string {
  const found = findApiKey(vendor);
  if (found) return found.key;
  throw new Error(`No ${API_KEY_OWNER[vendor]} API key. Run /login to sign in or paste a key.`);
}

export function storeApiKey(vendor: Vendor, key: string): ApiKey {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('The API key is empty.');
  if (!saveApiKeys({ ...loadApiKeys(), [vendor]: trimmed })) {
    throw new Error('Could not save the API key');
  }
  return { key: trimmed, source: 'settings', masked: maskApiKey(trimmed) };
}

export function removeApiKey(vendor: Vendor): boolean {
  const keys = loadApiKeys();
  if (!keys[vendor]) return false;
  delete keys[vendor];
  if (!saveApiKeys(keys)) throw new Error('Could not remove the API key');
  return true;
}

// The prefix and last four characters of a key, or nothing recognisable for
// a short one.
export function maskApiKey(key: string): string {
  const tail = key.length > 8 ? key.slice(-4) : '';
  const prefix = /^(sk-[a-z]+-|sk-)/i.exec(key)?.[1] ?? '';
  return `${key.length > 8 ? prefix : ''}…${tail}`;
}
