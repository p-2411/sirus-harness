import { existsSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import { PERMISSION_MODES, THINKING_LEVELS, type PermissionMode, type ThinkingLevel } from '../agent_runtime/types';
import { dataDirectory } from '../dataDirectory';
import { PROFILE_NAME_PATTERN } from '../agent_runtime/types';
import { readJson, setAside, writeJson } from './atomicJson';

// One settings file for the whole app, read through on every access so a test
// (or a second window) that changes SIRUS_DATA_DIR sees the new file at once.

const providerSourceSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('api'), key: z.string().min(1) }),
  z.object({ id: z.string().min(1), type: z.literal('subscription'), profile: z.string().regex(PROFILE_NAME_PATTERN), label: z.string().optional() }),
]);
export type StoredProviderSource = z.infer<typeof providerSourceSchema>;
export type StoredProviderSources = Partial<Record<'claude' | 'gpt', StoredProviderSource[]>>;

// When to send desktop notifications.
export const NOTIFICATION_PREFERENCES = ['off', 'background', 'always'] as const;

export type NotificationPreference = typeof NOTIFICATION_PREFERENCES[number];

// The two settings that held a vendor's credentials before source lists
// did: whether it was on a subscription, and the one API key pasted for it.
// Nothing is added to them now. `providers/sources.ts` reads them to build a
// vendor's first list, and deletes the key once that list is written.
export interface SubscriptionPreferences {
  claude: boolean;
  gpt: boolean;
}

export const APNS_ENVIRONMENTS = ['sandbox', 'production'] as const;

export interface RemoteSettings {
  apns?: { keyPath: string; keyId: string; teamId: string; bundleId: string };
  devices?: { token: string; environment: typeof APNS_ENVIRONMENTS[number]; firstSeen: number }[];
  // When a phone first connected, which ends /rc's one-time setup QR code.
  firstConnection?: number;
}

export interface StoredApiKeys {
  claude?: string;
  gpt?: string;
}

// The on-disk shape, unchanged since the file was introduced. Each section is
// validated on its own, and a write carries over every key it does not
// rewrite, so an older build cannot delete a setting a newer one wrote.
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
  notifications: z.enum(NOTIFICATION_PREFERENCES).optional(),
  // What a new session starts in, from /config; absent means the built-in
  // defaults. Sessions keep their own once created.
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  // Remote control: the APNs key pushes are signed with, from the owner's
  // developer account, the phones that registered for them, and whether a
  // phone has ever connected.
  remote: z.object({
    apns: z.object({ keyPath: z.string(), keyId: z.string(), teamId: z.string(), bundleId: z.string() }).optional(),
    devices: z.array(z.object({ token: z.string(), environment: z.enum(APNS_ENVIRONMENTS), firstSeen: z.number() })).optional(),
    firstConnection: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

// The sections of the file this build could read. One that failed its schema
// is absent here, exactly like one that was never written.
type SettingsFile = Partial<z.infer<typeof settingsFileSchema>>;

type SectionName = keyof typeof settingsFileSchema.shape;

// What the rest of the app sees: flat, always present, never a partial.
export interface SettingsShape {
  subscriptions: SubscriptionPreferences;
  providerSources: StoredProviderSources;
  memoryEnabled: boolean;
  apiKeys: StoredApiKeys;
  sirusModel: string | null;
  notifications: NotificationPreference;
  // Null leaves a new session on the built-in default.
  permissionMode: PermissionMode | null;
  thinkingLevel: ThinkingLevel | null;
  remote: RemoteSettings;
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
  permissionMode: null,
  thinkingLevel: null,
  remote: {},
};

// How one setting maps onto the file. Only `memoryEnabled` is not a plain
// key of the same name, and a cleared preference is an absent key.
interface Codec<K extends keyof SettingsShape> {
  // The top-level key of the file the setting is stored under.
  section: SectionName;
  // The stored value, or undefined when the file does not carry it.
  read: (file: SettingsFile) => SettingsShape[K] | undefined;
  write: (file: Record<string, unknown>, value: SettingsShape[K]) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CODECS: { [K in keyof SettingsShape]: Codec<K> } = {
  subscriptions: {
    section: 'subscriptions',
    read: file => file.subscriptions,
    write: (file, value) => { file.subscriptions = value; },
  },
  providerSources: {
    section: 'providerSources',
    read: file => file.providerSources,
    write: (file, value) => { file.providerSources = value; },
  },
  memoryEnabled: {
    section: 'memory',
    read: file => file.memory?.enabled,
    write: (file, value) => { file.memory = { enabled: value }; },
  },
  apiKeys: {
    section: 'apiKeys',
    read: file => file.apiKeys,
    write: (file, value) => { file.apiKeys = value; },
  },
  // A cleared preference is an absent key: the schema stores a model name or
  // nothing at all.
  sirusModel: {
    section: 'sirusModel',
    read: file => file.sirusModel,
    write: (file, value) => { if (value === null) delete file.sirusModel; else file.sirusModel = value; },
  },
  notifications: {
    section: 'notifications',
    read: file => file.notifications,
    write: (file, value) => { file.notifications = value; },
  },
  permissionMode: {
    section: 'permissionMode',
    read: file => file.permissionMode,
    write: (file, value) => { if (value === null) delete file.permissionMode; else file.permissionMode = value; },
  },
  thinkingLevel: {
    section: 'thinkingLevel',
    read: file => file.thinkingLevel,
    write: (file, value) => { if (value === null) delete file.thinkingLevel; else file.thinkingLevel = value; },
  },
  remote: {
    section: 'remote',
    read: file => file.remote,
    write: (file, value) => { if (Object.keys(value).length) file.remote = value; else delete file.remote; },
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

// The file as it stands, and what this build can read of it.
interface StoredSettings {
  // Every key the file holds, as found.
  raw: Record<string, unknown>;
  sections: SettingsFile;
  // The file is there but is no settings file this build knows: the JSON is
  // broken, or it carries another version. It reads as empty.
  unreadable: boolean;
}

// Each section is validated on its own, so one this build cannot read, a
// value a newer build added or a hand edit gone wrong, falls back to its
// defaults alone while the rest of the file still counts. A missing file
// reads as empty, exactly as it does before the first save.
function readSettingsFile(directory: string): StoredSettings {
  const filePath = settingsPath(directory);
  const raw = readJson(filePath);
  if (!isObject(raw) || raw.version !== 1) {
    return { raw: {}, sections: {}, unreadable: existsSync(filePath) };
  }
  const sections: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(settingsFileSchema.shape)) {
    if (!(name in raw)) continue;
    const parsed = schema.safeParse(raw[name]);
    if (parsed.success) sections[name] = parsed.data;
  }
  return { raw, sections: sections as SettingsFile, unreadable: false };
}

function valueOf<K extends keyof SettingsShape>(file: SettingsFile, key: K): SettingsShape[K] {
  const stored = CODECS[key].read(file);
  // Defaults are handed out as copies: `providers/sources.ts` mutates the
  // object it gets back from `get('apiKeys')`, and nothing may edit the
  // table itself.
  return stored === undefined ? structuredClone(DEFAULTS[key]) : stored;
}

function carryOver<K extends keyof SettingsShape>(
  file: Record<string, unknown>,
  current: SettingsFile,
  changes: Partial<SettingsShape>,
  key: K,
): void {
  CODECS[key].write(file, key in changes ? changes[key] as SettingsShape[K] : valueOf(current, key));
}

export function openSettings(directory: string = dataDirectory()): Settings {
  return {
    get: key => valueOf(readSettingsFile(directory).sections, key),
    set(changes) {
      const { raw, sections, unreadable } = readSettingsFile(directory);
      if (unreadable && !setAside(settingsPath(directory))) return false;
      const changed = new Set((Object.keys(changes) as (keyof SettingsShape)[]).map(key => CODECS[key].section));
      // Start from the file as it stands so keys this build does not know
      // about survive the write, then rewrite every known section from its
      // current value or from the change. A section this build could not
      // read stays exactly as found, since a newer build may have written
      // it, unless the change is to one of its settings.
      const next: Record<string, unknown> = { ...raw, version: 1 };
      for (const key of SETTING_KEYS) {
        const { section } = CODECS[key];
        if (section in raw && !(section in sections) && !changed.has(section)) continue;
        carryOver(next, sections, changes, key);
      }
      return writeJson(settingsPath(directory), next);
    },
  };
}

// New sessions read defaults through the settings object.
export function loadSessionDefaults(directory?: string) {
  const settings = openSettings(directory);
  return { permissionMode: settings.get('permissionMode'), thinkingLevel: settings.get('thinkingLevel') };
}
