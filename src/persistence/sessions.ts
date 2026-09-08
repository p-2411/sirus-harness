import path from 'path';
import { z } from 'zod';
import { dataDirectory } from '../dataDirectory';
import { IMAGE_MEDIA_TYPES, THINKING_LEVELS } from '../agent_runtime/types';
import type { SessionSnapshot } from '../agent_runtime/session';
import { readJson, writeJson } from './atomicJson';

// The session file: the whole conversation graph, validated on the way in and
// normalised to one shape. Storage knows the snapshot record, never the
// `Session` class — the type import above is erased at build time.

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  filePath: z.string().optional(),
});

const imageBlockSchema = z.object({
  type: z.literal('image'),
  path: z.string().min(1),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  bytes: z.number().int().nonnegative(),
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
    imageBlockSchema,
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

const checkpointSchema = z.object({
  id: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
  messageIndex: z.number().int().nonnegative(),
  summary: z.string(),
  createdAt: z.number(),
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
  // Directory snapshots taken before each turn; absent before checkpoints
  // existed and for sessions that never had one.
  checkpoints: z.array(checkpointSchema).optional(),
  // When the history last changed; absent in older files.
  updatedAt: z.number().optional(),
  conversationStartedAt: z.number().optional(),
  lastResponseFinishedAt: z.number().nullable().optional(),
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

type StoredSession = z.infer<typeof sessionSchema>;

// The name the single participant of a pre-multi-agent session has always had.
const LEGACY_PARTICIPANT_NAME = 'sirus';

export interface PersistedSessionSnapshots {
  snapshots: SessionSnapshot[];
  selectedSessionId: string | null;
}

// Both stored shapes become one modern snapshot here, so `Session` has a
// single way back in. A file written before multi-agent support carries one
// `model` and no clocks: it becomes a lone `sirus` participant whose history
// is dated to the epoch, which sorts it below anything with a real timestamp.
function toSnapshot(stored: StoredSession, fallbackSessionDirectory: string): SessionSnapshot {
  const participants = stored.participants
    ?? [{ name: LEGACY_PARTICIPANT_NAME, model: stored.model as string }];
  const defaultModel = stored.defaultModel
    ?? { name: LEGACY_PARTICIPANT_NAME, model: stored.model as string };
  return {
    id: stored.id,
    name: stored.name,
    directory: stored.directory ?? fallbackSessionDirectory,
    participants,
    defaultModel,
    messages: stored.messages,
    inputContent: stored.inputContent ?? '',
    checkpoints: stored.checkpoints ?? [],
    autoNamePending: stored.autoNamePending ?? false,
    updatedAt: stored.updatedAt ?? 0,
    ...(stored.permissionMode ? { permissionMode: stored.permissionMode } : {}),
    ...(stored.conversationStartedAt !== undefined ? { conversationStartedAt: stored.conversationStartedAt } : {}),
    ...(stored.lastResponseFinishedAt !== undefined ? { lastResponseFinishedAt: stored.lastResponseFinishedAt } : {}),
  };
}

function sessionsPath(directory: string): string {
  return path.join(directory, 'sessions.json');
}

export function loadSessionSnapshots(
  directory: string = dataDirectory(),
  fallbackSessionDirectory: string = process.cwd(),
): PersistedSessionSnapshots {
  const parsed = sessionFileSchema.safeParse(readJson(sessionsPath(directory)));
  if (!parsed.success) return { snapshots: [], selectedSessionId: null };
  // A session with no history is a draft, not something to restore; files
  // written before that rule existed still contain them.
  const snapshots = parsed.data.sessions
    .map(stored => toSnapshot(stored, fallbackSessionDirectory))
    .filter(snapshot => snapshot.messages.length > 0);
  return {
    snapshots,
    selectedSessionId: snapshots.some(snapshot => snapshot.id === parsed.data.selectedSessionId)
      ? parsed.data.selectedSessionId
      : null,
  };
}

export function saveSessionSnapshots(
  snapshots: readonly SessionSnapshot[],
  selectedSessionId: string | null,
  directory: string = dataDirectory(),
): boolean {
  return writeJson(sessionsPath(directory), {
    version: 1,
    // A selection that was not written is no selection at all.
    selectedSessionId: snapshots.some(snapshot => snapshot.id === selectedSessionId)
      ? selectedSessionId
      : null,
    sessions: snapshots,
  });
}
