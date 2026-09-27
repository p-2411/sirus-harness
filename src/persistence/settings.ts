import path from 'path';
import { z } from 'zod';
import { dataDirectory } from '../dataDirectory';
import { readJson, writeJson } from './atomicJson';

// One settings file for the whole app, read through on every access so a test
// (or a second window) that changes SIRUS_DATA_DIR sees the new file at once.

const providerSourceSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('api'), key: z.string().min(1) }),
  z.object({ id: z.string().min(1), type: z.literal('subscription'), profile: z.string().regex(/^(default|[a-zA-Z0-9_-]+)$/), label: z.string().optional() }),
]);
export type StoredProviderSource = z.infer<typeof providerSourceSchema>;
export type StoredProviderSources = Partial<Record<'claude' | 'gpt', StoredProviderSource[]>>;

export type NotificationPreference = 'off' | 'background' | 'always';

export interface SubscriptionPreferences {
  claude: boolean;
  gpt: boolean;
}

// API keys the user pasted into Sirus; absent providers fall back to the
// environment. Stored beside the other settings, which are written 0600.
export interface StoredApiKeys {
  claude?: string;
  gpt?: string;
}

// The on-disk shape, unchanged since the file was introduced. Unknown keys are
// kept through a parse so an older build cannot delete a setting a newer one
// wrote.
const settingsFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.object({
    claude: z.boolean(),
    gpt: z.boolean(),
  }).passthrough(),
  providerSources: z.object({
    claude: z.array(providerSourceSchema).optional(),
    gpt: z.array(providerSourceSchema).optional(),
  }).passthrough().optional(),
  memory: z.object({
    enabled: z.boolean(),
  }).optional(),
  apiKeys: z.object({
    claude: z.string().min(1).optional(),
    gpt: z.string().min(1).optional(),
  }).passthrough().optional(),
  // Default Sirus model for newly created sessions. Each session retains its
  // own model in its snapshot; changing this preference never overrides it.
  sirusModel: z.string().min(1).optional(),
  // When to send desktop notifications; absent means background only.
  notifications: z.enum(['off', 'background', 'always']).optional(),
}).passthrough();

type SettingsFile = z.infer<typeof settingsFileSchema>;

// What the rest of the app sees: flat, always present, never a partial.
export interface SettingsShape {
  subscriptions: SubscriptionPreferences;
  providerSources: StoredProviderSources;
  memoryEnabled: boolean;
  apiKeys: StoredApiKeys;
  sirusModel: string | null;
  notifications: NotificationPreference;
}

// The single list of settings: its keys drive both the fallbacks a read uses
// and the sections a write carries over, so nothing else enumerates them.
const DEFAULTS: SettingsShape = {
  subscriptions: { claude: false, gpt: false },
  providerSources: {},
  memoryEnabled: true,
  apiKeys: {},
  sirusModel: null,
  notifications: 'background',
};

// How one setting maps onto the file. Only `memoryEnabled` and the cleared
// Sirus model are not a plain key of the same name.
interface Codec<K extends keyof SettingsShape> {
  // The stored value, or undefined when the file does not carry it.
  read: (file: SettingsFile) => SettingsShape[K] | undefined;
  write: (file: Record<string, unknown>, value: SettingsShape[K]) => void;
}

const CODECS: { [K in keyof SettingsShape]: Codec<K> } = {
  subscriptions: {
    read: file => file.subscriptions,
    write: (file, value) => { file.subscriptions = value; },
  },
  providerSources: {
    read: file => file.providerSources,
    write: (file, value) => { file.providerSources = value; },
  },
  memoryEnabled: {
    read: file => file.memory?.enabled,
    write: (file, value) => { file.memory = { enabled: value }; },
  },
  apiKeys: {
    read: file => file.apiKeys,
    write: (file, value) => { file.apiKeys = value; },
  },
  // A cleared preference is an absent key: the schema stores a model name or
  // nothing at all.
  sirusModel: {
    read: file => file.sirusModel,
    write: (file, value) => { if (value === null) delete file.sirusModel; else file.sirusModel = value; },
  },
  notifications: {
    read: file => file.notifications,
    write: (file, value) => { file.notifications = value; },
  },
};

const SETTING_KEYS = Object.keys(DEFAULTS) as (keyof SettingsShape)[];

export interface Settings {
  get<K extends keyof SettingsShape>(key: K): SettingsShape[K];
  set(changes: Partial<SettingsShape>): boolean;
}

function settingsPath(directory: string): string {
  return path.join(directory, 'settings.json');
}

// A file that fails the schema is treated as absent: every value falls back to
// its default, exactly as it does before the first save.
function readSettingsFile(directory: string): SettingsFile | null {
  const parsed = settingsFileSchema.safeParse(readJson(settingsPath(directory)));
  return parsed.success ? parsed.data : null;
}

function valueOf<K extends keyof SettingsShape>(file: SettingsFile | null, key: K): SettingsShape[K] {
  const stored = file === null ? undefined : CODECS[key].read(file);
  // Defaults are handed out as copies: `providers/sources.ts` mutates the
  // object it gets back from `get('apiKeys')`, and nothing may edit the
  // table itself.
  return stored === undefined ? structuredClone(DEFAULTS[key]) : stored;
}

function carryOver<K extends keyof SettingsShape>(
  file: Record<string, unknown>,
  current: SettingsFile | null,
  changes: Partial<SettingsShape>,
  key: K,
): void {
  CODECS[key].write(file, key in changes ? changes[key] as SettingsShape[K] : valueOf(current, key));
}

export function openSettings(directory: string = dataDirectory()): Settings {
  return {
    get: key => valueOf(readSettingsFile(directory), key),
    set(changes) {
      const current = readSettingsFile(directory);
      // Start from the file as it stands so keys this build does not know
      // about survive the write, then rewrite every known section from its
      // current value or from the change.
      const next: Record<string, unknown> = { ...(current ?? {}), version: 1 };
      for (const key of SETTING_KEYS) carryOver(next, current, changes, key);
      return writeJson(settingsPath(directory), next);
    },
  };
}
