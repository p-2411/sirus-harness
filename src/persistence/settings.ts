import { existsSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import { dataDirectory } from '../dataDirectory';
import { readJson, setAside, writeJson } from './atomicJson';

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
  notifications: z.enum(['off', 'background', 'always']).optional(),
  // The TypeSafe AI key Jev routes with, and whether Sirus has already asked
  // for one once; absent means neither.
  jev: z.object({
    apiKey: z.string().min(1).optional(),
    keyRequested: z.boolean().optional(),
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
  // The Jev key the user pasted, or null to leave routing to the environment.
  jevApiKey: string | null;
  // The one-time request for a Jev key has been made, answered or declined.
  jevKeyRequested: boolean;
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
  jevApiKey: null,
  jevKeyRequested: false,
};

// How one setting maps onto the file. Only `memoryEnabled` and the cleared
// Sirus model are not a plain key of the same name.
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

// Both Jev settings share one section, so each write keeps the other's field
// as the file already carries it. A section that is not an object has nothing
// worth keeping.
function jevSection(file: Record<string, unknown>): Record<string, unknown> {
  return isObject(file.jev) ? { ...file.jev } : {};
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
  jevApiKey: {
    section: 'jev',
    read: file => file.jev?.apiKey ?? (file.jev ? null : undefined),
    write: (file, value) => {
      const jev = jevSection(file);
      if (value === null) delete jev.apiKey; else jev.apiKey = value;
      file.jev = jev;
    },
  },
  jevKeyRequested: {
    section: 'jev',
    read: file => file.jev?.keyRequested,
    write: (file, value) => { file.jev = { ...jevSection(file), keyRequested: value }; },
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
