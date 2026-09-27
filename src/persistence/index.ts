import { openSettings } from './settings';
import type {
  NotificationPreference,
  StoredApiKeys,
  SubscriptionPreferences,
} from './settings';
import { dataDirectory } from '../dataDirectory';
import type { Session } from '../agent_runtime/session';

// Everything the app stores, in one import path. The modules behind it are
// the atomic file layer, the settings object, the session file and the
// subscription-limit cache; the named preference functions below are the
// long-standing spelling of `openSettings().get(...)` / `.set(...)`.

export { dataDirectory };
export { readJson, writeJson } from './atomicJson';
export { openSettings } from './settings';
export type {
  NotificationPreference,
  Settings,
  SettingsShape,
  StoredApiKeys,
  StoredProviderSource,
  StoredProviderSources,
  SubscriptionPreferences,
} from './settings';
export { loadSessionSnapshots, saveSessionSnapshots } from './sessions';
export type { PersistedSessionSnapshots } from './sessions';

// The `Session`-shaped view of a loaded workspace, for callers (`app.tsx`)
// that hold session objects rather than snapshot records. Type-only: the
// storage layer itself never constructs a `Session`.
export interface PersistedSessions {
  sessions: Session[];
  selectedSessionId: string | null;
}

export {
  clearSubscriptionLimitCache,
  loadSubscriptionLimitCache,
  saveSubscriptionLimitCache,
} from './subscriptionLimits';
export type { CachedSubscriptionLimit } from './subscriptionLimits';

export function loadNotificationPreference(directory?: string): NotificationPreference {
  return openSettings(directory).get('notifications');
}

export function saveNotificationPreference(notifications: NotificationPreference, directory?: string): boolean {
  return openSettings(directory).set({ notifications });
}

export function loadSubscriptionPreferences(directory?: string): SubscriptionPreferences {
  return openSettings(directory).get('subscriptions');
}

export function saveSubscriptionPreferences(subscriptions: SubscriptionPreferences, directory?: string): boolean {
  return openSettings(directory).set({ subscriptions });
}

export function loadMemoryAccessPreference(directory?: string): boolean {
  return openSettings(directory).get('memoryEnabled');
}

export function saveMemoryAccessPreference(enabled: boolean, directory?: string): boolean {
  return openSettings(directory).set({ memoryEnabled: enabled });
}

export function loadApiKeys(directory?: string): StoredApiKeys {
  return openSettings(directory).get('apiKeys');
}

export function saveApiKeys(apiKeys: StoredApiKeys, directory?: string): boolean {
  return openSettings(directory).set({ apiKeys });
}

export function loadSirusModelPreference(directory?: string): string | null {
  return openSettings(directory).get('sirusModel');
}

export function saveSirusModelPreference(model: string, directory?: string): boolean {
  return openSettings(directory).set({ sirusModel: model });
}
