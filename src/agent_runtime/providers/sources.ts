import { randomUUID } from 'crypto';
import {
  clearSubscriptionLimitCache,
  openSettings,
  type StoredProviderSource,
  type StoredProviderSources,
} from '../../persistence';
import type { VendorInfo } from './catalog';

// The single source of truth for one vendor's credentials: an ordered list of
// the ways Sirus can reach it. The head of the list is the preferred way, so
// promoting a source is all "make this the one I use" means, and the fallback
// loop simply walks the list.

export interface ApiSource { id: string; kind: 'api'; key: string; fromEnv?: true }
export interface SubscriptionSource { id: string; kind: 'subscription'; profile: string; label?: string }
export type Source = ApiSource | SubscriptionSource;

export interface SourceStore {
  list: () => Source[];
  addApiKey: (key: string) => ApiSource;
  addSubscription: (profile: string, label?: string) => SubscriptionSource;
  remove: (id: string) => boolean;
  // Moves a source to the front: what /login and a pasted key do.
  promote: (id: string) => void;
  // Fires after this vendor's list changes.
  onChange: (listener: () => void) => () => void;
}

// The prefix and last four characters of a key, or nothing recognisable for
// a short one.
export function maskApiKey(key: string): string {
  const tail = key.length > 8 ? key.slice(-4) : '';
  const prefix = /^(sk-[a-z]+-|sk-)/i.exec(key)?.[1] ?? '';
  return `${key.length > 8 ? prefix : ''}…${tail}`;
}

// Anything that changes what the sidebar should show: a credential added or
// removed for any vendor, or a request settling on a different source.
const listeners = new Set<() => void>();

export function onProviderSourceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyProviderSourceChange(): void {
  for (const listener of listeners) listener();
}

function toSource(stored: StoredProviderSource): Source {
  return stored.type === 'api'
    ? { id: stored.id, kind: 'api', key: stored.key }
    : { id: stored.id, kind: 'subscription', profile: stored.profile, ...(stored.label ? { label: stored.label } : {}) };
}

function toStored(source: Source): StoredProviderSource {
  return source.kind === 'api'
    ? { id: source.id, type: 'api', key: source.key }
    : { id: source.id, type: 'subscription', profile: source.profile, ...(source.label ? { label: source.label } : {}) };
}

export function createSourceStore(vendor: VendorInfo): SourceStore {
  const own = new Set<() => void>();

  // Settings written before source lists existed: a subscription boolean and
  // one API key. Read once, to reconstruct the list; the first write below
  // replaces them and this branch is never taken again.
  const stored = (): Source[] => {
    const settings = openSettings();
    const saved = settings.get('providerSources')[vendor.id];
    if (saved) return saved.map(toSource);
    const legacy: Source[] = [];
    if (settings.get('subscriptions')[vendor.id]) legacy.push({ id: 'default', kind: 'subscription', profile: 'default' });
    const key = settings.get('apiKeys')[vendor.id];
    if (key) legacy.push({ id: 'legacy-api', kind: 'api', key });
    return legacy;
  };

  const list = (): Source[] => {
    const sources = stored();
    // The environment key the app has always read is a real fallback source,
    // but it belongs to the shell: stored keys win and it is never persisted.
    const key = process.env[vendor.apiKeyEnv]?.trim();
    if (key && !sources.some(source => source.kind === 'api' && source.key === key)) {
      sources.push({ id: 'env', kind: 'api', key, fromEnv: true });
    }
    return sources;
  };

  const persist = (next: readonly Source[]): void => {
    const settings = openSettings();
    const providerSources: StoredProviderSources = {
      ...settings.get('providerSources'),
      [vendor.id]: next.map(toStored),
    };
    // Once migrated, credentials live only in the source list. Removing a
    // source must also remove the key instead of leaving a legacy copy behind.
    const apiKeys = settings.get('apiKeys');
    for (const migrated of Object.keys(providerSources) as (keyof StoredProviderSources)[]) {
      if (providerSources[migrated]) delete apiKeys[migrated];
    }
    if (!settings.set({ providerSources, apiKeys })) {
      throw new Error('Could not save provider sources');
    }
    // Owners first: they drop cached transports and per-runtime state before
    // any observer asks what the active source now is.
    for (const listener of own) listener();
    notifyProviderSourceChange();
  };

  return {
    list,
    onChange: listener => {
      own.add(listener);
      return () => { own.delete(listener); };
    },
    addApiKey: key => {
      const trimmed = key.trim();
      if (!trimmed) throw new Error('The API key is empty.');
      const current = stored();
      const existing = current.find(source => source.kind === 'api' && source.key === trimmed);
      const source = (existing ?? { id: randomUUID(), kind: 'api', key: trimmed }) as ApiSource;
      persist([source, ...current.filter(item => item !== existing)]);
      return source;
    },
    addSubscription: (profile, label) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid subscription profile');
      const current = stored();
      const existing = current.find(source => source.kind === 'subscription' && source.profile === profile);
      const source: SubscriptionSource = {
        id: existing?.id ?? profile, kind: 'subscription', profile, ...(label ? { label } : {}),
      };
      persist([source, ...current.filter(item => item !== existing)]);
      // A fresh sign-in says nothing about the previous account's allowance.
      clearSubscriptionLimitCache(vendor.id, profile);
      return source;
    },
    remove: id => {
      const current = stored();
      const removed = current.find(source => source.id === id);
      if (!removed) return false;
      persist(current.filter(source => source.id !== id));
      if (removed.kind === 'subscription') clearSubscriptionLimitCache(vendor.id, removed.profile);
      return true;
    },
    promote: id => {
      const current = stored();
      const target = current.find(source => source.id === id);
      if (!target) return;
      persist([target, ...current.filter(source => source !== target)]);
    },
  };
}
