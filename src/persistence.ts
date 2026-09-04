import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { Session, type SessionSnapshot } from './agent_runtime/session';
import { THINKING_LEVELS } from './agent_runtime/types';

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const toolCallBlockSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  callId: z.string(),
  result: z.string(),
  isError: z.boolean(),
});

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  contextTokens: z.number(),
  contextWindow: z.number().optional(),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(z.discriminatedUnion('type', [
    textBlockSchema,
    toolCallBlockSchema,
    toolResultBlockSchema,
  ])),
  participant: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  usage: usageSchema.optional(),
});

const participantSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

const sessionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  directory: z.string().min(1).optional(),
  // `model` is the original single-participant shape. The other two fields
  // are the multi-participant shape; accepting both keeps existing installs
  // readable without a destructive migration.
  model: z.string().min(1).optional(),
  participants: z.array(participantSchema).min(1).optional(),
  defaultModel: participantSchema.optional(),
  messages: z.array(messageSchema),
  inputContent: z.string().optional(),
  // Unknown values fail the parse of that file; an absent one means the
  // default (auto approve).
  permissionMode: z.enum(['ask', 'auto', 'bypass']).optional(),
  // When the history last changed; absent in older files.
  updatedAt: z.number().optional(),
  autoNamePending: z.boolean().optional(),
}).refine(
  session => Boolean(session.model || (session.participants && session.defaultModel)),
  { message: 'Session must contain a model or participant list' },
);

const sessionFileSchema = z.object({
  version: z.literal(1),
  selectedSessionId: z.string().nullable(),
  sessions: z.array(sessionSchema),
});

const settingsFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.object({
    claude: z.boolean(),
    gpt: z.boolean(),
  }),
  memory: z.object({
    enabled: z.boolean(),
  }).optional(),
  apiKeys: z.object({
    claude: z.string().min(1).optional(),
    gpt: z.string().min(1).optional(),
  }).optional(),
  // Default Sirus model for newly created sessions. Each session retains its
  // own model in its snapshot; changing this preference never overrides it.
  sirusModel: z.string().min(1).optional(),
});

type SettingsFile = z.infer<typeof settingsFileSchema>;

export interface PersistedSessions {
  sessions: Session[];
  selectedSessionId: string | null;
}

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

const DEFAULT_SUBSCRIPTIONS: SubscriptionPreferences = { claude: false, gpt: false };
const DEFAULT_MEMORY_ACCESS = true;

export function dataDirectory(): string {
  if (process.env.SIRUS_DATA_DIR) return process.env.SIRUS_DATA_DIR;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Sirus');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Sirus');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'sirus');
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): boolean {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, filePath);
    return true;
  } catch {
    return false;
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A failed cleanup should not turn persistence into an app failure.
      }
    }
  }
}

export function loadSessions(
  directory: string = dataDirectory(),
  fallbackSessionDirectory: string = process.cwd(),
): PersistedSessions {
  const parsed = sessionFileSchema.safeParse(readJson(path.join(directory, 'sessions.json')));
  if (!parsed.success) return { sessions: [], selectedSessionId: null };
  const sessions = parsed.data.sessions
    .map(snapshot => {
      const directory = snapshot.directory ?? fallbackSessionDirectory;
      if (snapshot.participants && snapshot.defaultModel) {
        return Session.fromSnapshot({
          id: snapshot.id,
          name: snapshot.name,
          directory,
          participants: snapshot.participants,
          defaultModel: snapshot.defaultModel,
          messages: snapshot.messages,
          inputContent: snapshot.inputContent ?? '',
          ...(snapshot.permissionMode ? { permissionMode: snapshot.permissionMode } : {}),
          ...(snapshot.updatedAt !== undefined ? { updatedAt: snapshot.updatedAt } : {}),
          ...(snapshot.autoNamePending !== undefined ? { autoNamePending: snapshot.autoNamePending } : {}),
        } satisfies SessionSnapshot);
      }
      return new Session(
        snapshot.name,
        snapshot.id,
        snapshot.model,
        snapshot.messages,
        directory,
        undefined,
        undefined,
        undefined,
        snapshot.updatedAt ?? 0,
      );
    })
    .filter(session => !session.isEmpty());
  const selectedSessionId = sessions.some(session => session.getId() === parsed.data.selectedSessionId)
    ? parsed.data.selectedSessionId
    : null;
  return {
    sessions,
    selectedSessionId,
  };
}

export function saveSessions(
  sessions: readonly Session[],
  selectedSessionId: string | null,
  directory: string = dataDirectory(),
): boolean {
  const persistedSessions = sessions.filter(session => !session.isEmpty());
  const persistedSelectedSessionId = persistedSessions.some(session => session.getId() === selectedSessionId)
    ? selectedSessionId
    : null;
  return writeJson(path.join(directory, 'sessions.json'), {
    version: 1,
    selectedSessionId: persistedSelectedSessionId,
    sessions: persistedSessions.map(session => session.toSnapshot()),
  });
}

function readSettings(directory: string): SettingsFile | null {
  const parsed = settingsFileSchema.safeParse(readJson(path.join(directory, 'settings.json')));
  return parsed.success ? parsed.data : null;
}

// Every setting lives in one file; each save rewrites it with the other
// sections carried over so they survive one another's updates.
function writeSettings(directory: string, changes: Partial<Omit<SettingsFile, 'version'>>): boolean {
  const current = readSettings(directory);
  return writeJson(path.join(directory, 'settings.json'), {
    version: 1,
    subscriptions: current?.subscriptions ?? { ...DEFAULT_SUBSCRIPTIONS },
    memory: current?.memory,
    apiKeys: current?.apiKeys,
    sirusModel: current?.sirusModel,
    ...changes,
  });
}

export function loadSubscriptionPreferences(directory: string = dataDirectory()): SubscriptionPreferences {
  return readSettings(directory)?.subscriptions ?? { ...DEFAULT_SUBSCRIPTIONS };
}

export function saveSubscriptionPreferences(
  subscriptions: SubscriptionPreferences,
  directory: string = dataDirectory(),
): boolean {
  return writeSettings(directory, { subscriptions });
}

export function loadMemoryAccessPreference(directory: string = dataDirectory()): boolean {
  return readSettings(directory)?.memory?.enabled ?? DEFAULT_MEMORY_ACCESS;
}

export function saveMemoryAccessPreference(
  enabled: boolean,
  directory: string = dataDirectory(),
): boolean {
  return writeSettings(directory, { memory: { enabled } });
}

export function loadApiKeys(directory: string = dataDirectory()): StoredApiKeys {
  return { ...(readSettings(directory)?.apiKeys ?? {}) };
}

export function saveApiKeys(apiKeys: StoredApiKeys, directory: string = dataDirectory()): boolean {
  return writeSettings(directory, { apiKeys });
}

export function loadSirusModelPreference(directory: string = dataDirectory()): string | null {
  return readSettings(directory)?.sirusModel ?? null;
}

export function saveSirusModelPreference(
  model: string,
  directory: string = dataDirectory(),
): boolean {
  return writeSettings(directory, { sirusModel: model });
}
