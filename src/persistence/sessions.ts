import path from 'path';
import { z } from 'zod';
import { dataDirectory } from '../dataDirectory';
import {
  IMAGE_MEDIA_TYPES,
  THINKING_LEVELS,
  TOOL_CALL_STATUSES,
  TOOL_KINDS,
  type Message,
  type MessageBlock,
  type ToolCallBlock,
} from '../agent_runtime/types';
import type { SessionSnapshot } from '../agent_runtime/session';
import type { WorkerRecord } from '../agent_runtime/tools/subagents';
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

const thoughtBlockSchema = z.object({
  type: z.literal('thought'),
  text: z.string(),
});

const compactionBlockSchema = z.object({
  type: z.literal('compaction'),
  summary: z.string().optional(),
});

const toolCallContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string().nullable(), newText: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
]);

const toolCallBlockSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  title: z.string(),
  kind: z.enum(TOOL_KINDS),
  status: z.enum(TOOL_CALL_STATUSES),
  locations: z.array(z.object({ path: z.string(), line: z.number().int().optional() })),
  content: z.array(toolCallContentSchema),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});

// Files written before the runtimes ran the tools: a call Sirus made and the
// result it recorded, as two blocks.
const legacyToolCallBlockSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

const legacyToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  callId: z.string(),
  result: z.string(),
  isError: z.boolean(),
});

const blockSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  thoughtBlockSchema,
  compactionBlockSchema,
  toolCallBlockSchema,
  legacyToolCallBlockSchema,
  legacyToolResultBlockSchema,
]);

type StoredBlock = z.infer<typeof blockSchema>;

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(blockSchema),
  // Absent in files written before per-participant transcripts: the entry's
  // position stands in for its seq.
  seq: z.number().int().nonnegative().optional(),
  participant: z.string().min(1).optional(),
  to: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  // A compaction summary written by Sirus itself, before the runtimes
  // compacted their own conversations. It becomes a boundary with the
  // summary text; the token figures it carried are gone with the gauge.
  compaction: z.object({}).passthrough().optional(),
  // Token usage the old transports reported per message; not kept.
  usage: z.object({}).passthrough().optional(),
});

const participantSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

// One delegated run of the session, kept so its record survives a restart:
// where it worked, what it produced, and whether its owner ever heard about
// it. `content` is not stored — it is the content array of the transcript's
// assistant entry, and restoring points at that.
const workerSchema = z.object({
  id: z.string().min(1),
  callId: z.string().min(1).nullable(),
  owner: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(THINKING_LEVELS),
  context: z.enum(['fresh', 'owner']),
  prompt: z.string(),
  directory: z.string().min(1),
  branch: z.string().min(1).nullable(),
  status: z.enum(['working', 'done', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  transcript: z.array(messageSchema),
  finalMessage: z.string().nullable(),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  reported: z.boolean(),
  dismissed: z.boolean(),
});

const checkpointSchema = z.object({
  id: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
  // `messageIndex` is the name files carried before entries had seqs; the
  // two numbers meant the same thing then.
  seq: z.number().int().nonnegative().optional(),
  messageIndex: z.number().int().nonnegative().optional(),
  summary: z.string(),
  createdAt: z.number(),
}).refine(checkpoint => checkpoint.seq !== undefined || checkpoint.messageIndex !== undefined, {
  message: 'Checkpoint must carry a seq',
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
  subagentModel: z.string().min(1).optional(),
  // Every worker the session's participants spawned; absent for a session
  // that never delegated and in files written before workers were kept.
  workers: z.array(workerSchema).optional(),
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
type StoredMessage = z.infer<typeof messageSchema>;

// The name the single participant of a pre-multi-agent session has always had.
const LEGACY_PARTICIPANT_NAME = 'sirus';

export interface PersistedSessionSnapshots {
  snapshots: SessionSnapshot[];
  selectedSessionId: string | null;
}

// Catalog ids that were renamed; a session saved under the old id must still
// restore to a model the runtimes serve.
const RENAMED_MODELS: Record<string, string> = { 'claude-haiku-4.5': 'claude-haiku-4-5' };

function currentModel<T extends { model: string }>(participant: T): T {
  const renamed = RENAMED_MODELS[participant.model];
  return renamed ? { ...participant, model: renamed } : participant;
}

// A call Sirus ran itself, paired with the result it recorded, becomes one
// finished tool call block: the name as the title, the arguments as the
// input, the result as the output.
function legacyToolCall(
  call: z.infer<typeof legacyToolCallBlockSchema>,
  results: ReadonlyMap<string, z.infer<typeof legacyToolResultBlockSchema>>,
): ToolCallBlock {
  const result = results.get(call.id);
  return {
    type: 'tool_call',
    id: call.id,
    title: call.name,
    kind: 'other',
    status: result ? (result.isError ? 'failed' : 'completed') : 'completed',
    locations: [],
    content: [],
    input: call.arguments,
    ...(result ? { output: result.result } : {}),
  };
}

function toBlocks(content: readonly StoredBlock[]): MessageBlock[] {
  const results = new Map(content.flatMap(block => block.type === 'tool_result' ? [[block.callId, block] as const] : []));
  const blocks: MessageBlock[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') continue;
    if (block.type === 'tool_call' && 'name' in block) {
      blocks.push(legacyToolCall(block, results));
      continue;
    }
    blocks.push(block as MessageBlock);
  }
  return blocks;
}

function toMessage(stored: StoredMessage, index: number, defaultParticipant: string): Message {
  const content = stored.compaction
    // Sirus's own summary stood in for the messages before it; now it is the
    // boundary the default participant's record starts from.
    ? [{ type: 'compaction' as const, summary: stored.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }]
    : toBlocks(stored.content);
  const role = stored.compaction ? 'assistant' : stored.role;
  return {
    seq: stored.seq ?? index,
    role,
    content,
    ...(role === 'assistant' ? { participant: stored.participant ?? defaultParticipant } : {}),
    ...(stored.to ? { to: stored.to } : {}),
    ...(stored.model ? { model: stored.model } : {}),
  };
}

// A worker's own record reads back like a small transcript of its own: its
// entries are stamped as they were written, and the assistant one among them
// is the response the session hands the UI.
function toWorkerRecord(stored: z.infer<typeof workerSchema>): WorkerRecord {
  return {
    ...stored,
    transcript: stored.transcript.map((message, index) => toMessage(message, index, stored.id)),
  };
}

// Both stored shapes become one modern snapshot here, so `Session` has a
// single way back in. A file written before multi-agent support carries one
// `model` and no clocks: it becomes a lone `sirus` participant whose history
// is dated to the epoch, which sorts it below anything with a real timestamp.
function toSnapshot(stored: StoredSession, fallbackSessionDirectory: string): SessionSnapshot {
  const participants = (stored.participants
    ?? [{ name: LEGACY_PARTICIPANT_NAME, model: stored.model as string }]).map(currentModel);
  const defaultModel = currentModel(stored.defaultModel
    ?? { name: LEGACY_PARTICIPANT_NAME, model: stored.model as string });
  return {
    id: stored.id,
    name: stored.name,
    directory: stored.directory ?? fallbackSessionDirectory,
    participants,
    defaultModel,
    messages: stored.messages.map((message, index) => toMessage(message, index, defaultModel.name)),
    inputContent: stored.inputContent ?? '',
    checkpoints: (stored.checkpoints ?? []).map(({ messageIndex, seq, ...checkpoint }) => ({
      ...checkpoint,
      seq: seq ?? messageIndex ?? 0,
    })),
    autoNamePending: stored.autoNamePending ?? false,
    updatedAt: stored.updatedAt ?? 0,
    ...(stored.workers ? { workers: stored.workers.map(toWorkerRecord) } : {}),
    ...(stored.permissionMode ? { permissionMode: stored.permissionMode } : {}),
    ...(stored.subagentModel ? { subagentModel: stored.subagentModel } : {}),
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
