import crypto from 'crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import { isCheckpointId } from '../checkpoints';
import { dataDirectory } from '../dataDirectory';
import {
  DEFAULT_PARTICIPANT,
  failOpenToolCalls,
  IMAGE_MEDIA_TYPES,
  PERMISSION_MODES,
  SUBAGENT_STATUSES,
  THINKING_LEVELS,
  TOOL_CALL_OUTCOMES,
  TOOL_CALL_STATUSES,
  TOOL_KINDS,
  WORKER_CONTEXTS,
  WORKER_ISOLATIONS,
  type Message,
  type MessageBlock,
  type ToolCallBlock,
} from '../agent_runtime/types';
import type { Session, SessionSnapshot } from '../agent_runtime/session';
import type { WorkerRecord } from '../agent_runtime/tools/subagents';
import { readJson, writeJson } from './atomicJson';

// Each session file holds one conversation graph, validated on the way in and
// normalised to one shape. Storage knows the snapshot record, never the
// `Session` class — the type imports above are erased at build time.

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
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});

const compactionBlockSchema = z.object({
  type: z.literal('compaction'),
  summary: z.string().optional(),
});

const noticeBlockSchema = z.object({
  type: z.literal('notice'),
  severity: z.string(),
  title: z.string(),
  description: z.string().optional(),
});

// Future block kinds can be left out without losing the rest of a record.
// Known kinds still go through their schemas so malformed data is rejected.
function knownBlocks(value: unknown, types: ReadonlySet<string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter(block => !block || typeof block !== 'object'
    || typeof block.type !== 'string' || types.has(block.type));
}

const toolCallContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('diff'), path: z.string(), oldText: z.string().nullable(), newText: z.string(),
    line: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('text'), text: z.string() }),
]);
const toolCallContentTypes = new Set(toolCallContentSchema.options.map(schema => schema.shape.type.value));

const toolCallBlockSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  title: z.string(),
  kind: z.enum(TOOL_KINDS),
  status: z.enum(TOOL_CALL_STATUSES),
  locations: z.array(z.object({ path: z.string(), line: z.number().int().optional() })),
  content: z.preprocess(value => knownBlocks(value, toolCallContentTypes), z.array(toolCallContentSchema)),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  outcome: z.enum(TOOL_CALL_OUTCOMES).optional(),
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
  noticeBlockSchema,
  toolCallBlockSchema,
  legacyToolCallBlockSchema,
  legacyToolResultBlockSchema,
]);
const blockTypes = new Set(blockSchema.options.map(schema => schema.shape.type.value));

type StoredBlock = z.infer<typeof blockSchema>;

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.preprocess(value => knownBlocks(value, blockTypes), z.array(blockSchema)),
  // Absent in files written before per-participant transcripts: the entry's
  // position stands in for its seq.
  seq: z.number().int().nonnegative().optional(),
  participant: z.string().min(1).optional(),
  to: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  hidden: z.literal(true).optional(),
  injectedAt: z.object({
    seq: z.number().int().nonnegative(),
    block: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  }).optional(),
  creationModels: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })).optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  // A compaction summary written by Sirus itself, before the runtimes
  // compacted their own conversations. It becomes a boundary with the
  // summary text; the token figures it carried are gone with the gauge.
  compaction: z.object({}).passthrough().optional(),
  // What the turn used. The old transports wrote another shape under the
  // same name, per message and without a total; that one is not kept.
  usage: z.unknown().optional(),
});

// A Codex turn of several model calls has a total and no breakdown.
const turnUsageSchema = z.object({
  totalTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cachedReadTokens: z.number().nonnegative().optional(),
  cachedWriteTokens: z.number().nonnegative().optional(),
  thoughtTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

const nativeSessionSchema = z.object({
  vendor: z.enum(['claude', 'gpt']),
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
  profileHome: z.string().min(1),
  systemPromptHash: z.string().optional(),
});

const participantSchema = z.object({
  nativeSession: nativeSessionSchema.optional(),
  name: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

// One delegated run of the session, kept so its record survives a restart:
// where it worked, what it produced, and whether its owner ever heard about
// it. `content` is not stored — it is the content array of the transcript's
// assistant entry, and restoring points at that.
const workerSchema = z.object({
  nativeSession: nativeSessionSchema.optional(),
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  runInBackground: z.boolean().optional(),
  isolation: z.enum(WORKER_ISOLATIONS).optional(),
  baseDirectory: z.string().optional(),
  startHead: z.string().optional(),
  definition: z.object({
    name: z.string(), description: z.string(), prompt: z.string(), model: z.string().optional(),
    thinkingLevel: z.enum(THINKING_LEVELS).optional(), tools: z.array(z.string()).optional(),
  }).optional(),
  callId: z.string().min(1).nullable(),
  owner: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  context: z.enum(WORKER_CONTEXTS),
  prompt: z.string(),
  directory: z.string().min(1),
  branch: z.string().min(1).nullable(),
  status: z.enum(SUBAGENT_STATUSES),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  // Absent in files written before the strip ordered runs by freshness.
  updatedAt: z.number().optional(),
  transcript: z.array(messageSchema),
  finalMessage: z.string().nullable(),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  tokens: z.number().optional(),
  reported: z.boolean(),
  dismissed: z.boolean(),
});

const checkpointSchema = z.object({
  id: z.string().refine(isCheckpointId),
  // `messageIndex` is the name files carried before entries had seqs; the
  // two numbers meant the same thing then.
  seq: z.number().int().nonnegative().optional(),
  messageIndex: z.number().int().nonnegative().optional(),
  summary: z.string(),
  createdAt: z.number(),
  changes: z.array(z.object({
    path: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    conflict: z.string().optional(),
  })).optional(),
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
  selectedParticipant: z.string().optional(),
  participantDrafts: z.record(z.string(), z.string()).optional(),
  // Unknown values fail the parse of that session; an absent one means the
  // default (auto approve).
  permissionMode: z.enum(PERMISSION_MODES).optional(),
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
  archived: z.boolean().optional(),
  remote: z.boolean().optional(),
}).refine(
  session => Boolean(session.model || (session.participants && session.defaultModel)),
  { message: 'Session must contain a model or participant list' },
);

// The single file every session was kept in before each had its own, read
// only to migrate it. Each session in it is validated on its own, so one this
// build cannot read, say one a newer build wrote with a status this one does
// not know, costs that session alone.
const sessionFileSchema = z.object({
  version: z.literal(1),
  selectedSessionId: z.string().nullable(),
  sessions: z.array(z.unknown()),
});

type StoredSession = z.infer<typeof sessionSchema>;
type StoredMessage = z.infer<typeof messageSchema>;

// The name the single participant of a pre-multi-agent session has always
// had: the default participant's.
const LEGACY_PARTICIPANT_NAME = DEFAULT_PARTICIPANT;

export interface PersistedSessionSnapshots {
  snapshots: SessionSnapshot[];
  selectedSessionId: string | null;
  notices?: string[];
}

// The same workspace once `app.tsx` has rebuilt each snapshot into a
// `Session`. Type-only, like the import it rests on: storage never
// constructs one.
export interface PersistedSessions {
  sessions: Session[];
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
    // Builds of 2026-09-28 marked a cut-short turn with an "Interrupted" row,
    // which is no longer shown.
    if (block.type === 'notice' && block.severity === 'interrupted') continue;
    if (block.type === 'tool_call' && 'name' in block) {
      blocks.push(legacyToolCall(block, results));
      continue;
    }
    blocks.push(block as MessageBlock);
  }
  // Nothing is running after a restart: a call saved mid-turn ended with the
  // process that ran it.
  failOpenToolCalls(blocks, 'cancelled');
  return blocks;
}

function toMessage(stored: StoredMessage, index: number, defaultParticipant: string): Message {
  const content = stored.compaction
    // Sirus's own summary stood in for the messages before it; now it is the
    // boundary the default participant's record starts from.
    ? [{ type: 'compaction' as const, summary: stored.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }]
    : toBlocks(stored.content);
  const role = stored.compaction ? 'assistant' : stored.role;
  const usage = turnUsageSchema.safeParse(stored.usage);
  return {
    seq: stored.seq ?? index,
    role,
    content,
    ...(role === 'assistant' ? { participant: stored.participant ?? defaultParticipant } : {}),
    ...(stored.to ? { to: stored.to } : {}),
    ...(stored.model ? { model: stored.model } : {}),
    ...(stored.hidden ? { hidden: true as const } : {}),
    ...(stored.injectedAt ? { injectedAt: stored.injectedAt } : {}),
    ...(stored.creationModels?.length ? { creationModels: stored.creationModels } : {}),
    ...(stored.startedAt !== undefined ? { startedAt: stored.startedAt } : {}),
    ...(stored.finishedAt !== undefined ? { finishedAt: stored.finishedAt } : {}),
    ...(usage.success ? { usage: usage.data } : {}),
  };
}

// A worker's own record reads back like a small transcript of its own: its
// entries are stamped as they were written, and the assistant one among them
// is the response the session hands the UI.
function toWorkerRecord(stored: z.infer<typeof workerSchema>): WorkerRecord {
  return {
    ...stored,
    updatedAt: stored.updatedAt ?? stored.finishedAt ?? stored.startedAt,
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
    selectedParticipant: stored.selectedParticipant,
    participantDrafts: stored.participantDrafts,
    checkpoints: (stored.checkpoints ?? []).map(({ messageIndex, seq, ...checkpoint }) => ({
      ...checkpoint,
      seq: seq ?? messageIndex ?? 0,
    })),
    autoNamePending: stored.autoNamePending ?? false,
    ...(stored.archived !== undefined ? { archived: stored.archived } : {}),
    ...(stored.remote !== undefined ? { remote: stored.remote } : {}),
    updatedAt: stored.updatedAt ?? 0,
    ...(stored.workers ? { workers: stored.workers.map(toWorkerRecord) } : {}),
    ...(stored.permissionMode ? { permissionMode: stored.permissionMode } : {}),
    ...(stored.subagentModel ? { subagentModel: stored.subagentModel } : {}),
    ...(stored.conversationStartedAt !== undefined ? { conversationStartedAt: stored.conversationStartedAt } : {}),
    ...(stored.lastResponseFinishedAt !== undefined ? { lastResponseFinishedAt: stored.lastResponseFinishedAt } : {}),
  };
}

const metadataSchema = z.object({
  version: z.literal(1),
  sessionIds: z.array(z.string()),
  selectedSessionId: z.string().nullable(),
});

// Refuse later writes through this process after a failed read, including
// when moving the damaged file aside failed (for example a read-only disk).
const unreadablePaths = new Set<string>();

function sessionPath(id: string, directory: string): string {
  return path.join(directory, 'sessions', `session-${encodeURIComponent(id)}.json`);
}

// A deletion survives other windows' stale snapshots and legacy migration.
// Publish it before unlinking the record; saves check it on both sides of
// their atomic rename, so either ordering leaves the session deleted.
function deletedPath(id: string, directory: string): string {
  return `${sessionPath(id, directory)}.deleted`;
}

function isDeleted(id: string, directory: string): boolean {
  return existsSync(deletedPath(id, directory));
}

function quarantine(file: string, directory: string, notices: string[]): void {
  unreadablePaths.add(file);
  const destination = path.join(directory, 'invalid', `${path.basename(file)}.${crypto.randomUUID()}`);
  try {
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(file, destination);
    notices.push(`Could not load ${path.basename(file)}. The original was preserved at ${destination}.`);
  } catch {
    notices.push(`Could not load ${file}. It was left untouched and will not be overwritten.`);
  }
}

function readSnapshot(file: string, directory: string, fallback: string, notices: string[]): SessionSnapshot | null {
  if (!existsSync(file) || existsSync(`${file}.deleted`)) return null;
  const parsed = sessionSchema.safeParse(readJson(file));
  if (!parsed.success || sessionPath(parsed.data.id, directory) !== file) {
    quarantine(file, directory, notices);
    return null;
  }
  if (isDeleted(parsed.data.id, directory)) return null;
  return toSnapshot(parsed.data, fallback);
}

// Migration publishes complete files without replacing any session another
// window has already saved. A hard link is the atomic create-if-absent step.
function writeMigratedSnapshot(snapshot: SessionSnapshot, directory: string): boolean {
  if (isDeleted(snapshot.id, directory)) return true;
  const file = sessionPath(snapshot.id, directory);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (isDeleted(snapshot.id, directory)) {
      try { unlinkSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(temporary); } catch { /* Nothing to clean up after a failed create. */ }
  }
}

function migrateSessions(directory: string, fallback: string, notices: string[]): void {
  const legacy = path.join(directory, 'sessions.json');
  if (!existsSync(legacy)) return;
  const parsed = sessionFileSchema.safeParse(readJson(legacy));
  if (!parsed.success) {
    quarantine(legacy, directory, notices);
    return;
  }
  const ids: string[] = [];
  let complete = true;
  for (const [index, value] of parsed.data.sessions.entries()) {
    const session = sessionSchema.safeParse(value);
    if (!session.success) {
      const id = value && typeof value === 'object' && 'id' in value ? String(value.id) : String(index);
      const file = path.join(directory, 'invalid', `session-${encodeURIComponent(id)}.${crypto.randomUUID()}.json`);
      if (writeJson(file, value)) notices.push(`Could not load session ${id}. Its original record was preserved at ${file}.`);
      else {
        complete = false;
        notices.push(`Could not set aside session ${id}; ${legacy} was left untouched.`);
      }
      continue;
    }
    const snapshot = toSnapshot(session.data, fallback);
    if (!writeMigratedSnapshot(snapshot, directory)) complete = false;
    if (snapshot.messages.length > 0) ids.push(snapshot.id);
  }
  if (!existsSync(path.join(directory, 'sessions', 'index.json'))) {
    complete = saveSessionMetadata(ids, parsed.data.selectedSessionId, directory) && complete;
  }
  if (!complete) {
    notices.push(`Session migration is incomplete; ${legacy} was left untouched for recovery.`);
    return;
  }
  try {
    // Keep an earlier backup too if a legacy file was restored manually.
    const backup = existsSync(`${legacy}.migrated`) ? `${legacy}.${crypto.randomUUID()}.migrated` : `${legacy}.migrated`;
    renameSync(legacy, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      notices.push(`Sessions were migrated, but ${legacy} could not be renamed and was left untouched.`);
    }
  }
}

export function loadSessionSnapshot(
  id: string,
  directory: string = dataDirectory(),
  fallbackSessionDirectory: string = process.cwd(),
  notices: string[] = [],
): SessionSnapshot | null {
  migrateSessions(directory, fallbackSessionDirectory, notices);
  const snapshot = readSnapshot(sessionPath(id, directory), directory, fallbackSessionDirectory, notices);
  return snapshot && snapshot.messages.length > 0 ? snapshot : null;
}

export function loadSessionSnapshots(
  directory: string = dataDirectory(),
  fallbackSessionDirectory: string = process.cwd(),
): PersistedSessionSnapshots {
  const notices: string[] = [];
  migrateSessions(directory, fallbackSessionDirectory, notices);
  const metadata = metadataSchema.safeParse(readJson(path.join(directory, 'sessions', 'index.json')));
  const snapshots: SessionSnapshot[] = [];
  try {
    for (const filename of readdirSync(path.join(directory, 'sessions'))) {
      if (!filename.endsWith('.json') || filename === 'index.json') continue;
      const snapshot = readSnapshot(path.join(directory, 'sessions', filename), directory, fallbackSessionDirectory, notices);
      if (snapshot && snapshot.messages.length > 0) snapshots.push(snapshot);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') notices.push(`Could not read sessions in ${directory}. Existing files were left untouched.`);
  }
  const order = new Map((metadata.success ? metadata.data.sessionIds : []).map((id, index) => [id, index]));
  snapshots.sort((left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity));
  const selected = metadata.success ? metadata.data.selectedSessionId : null;
  return {
    snapshots,
    selectedSessionId: snapshots.some(snapshot => snapshot.id === selected) ? selected : null,
    ...(notices.length ? { notices } : {}),
  };
}

export function loadSessionRevision(id: string, directory: string = dataDirectory()): string | null {
  try {
    if (isDeleted(id, directory)) return null;
    const stat = statSync(sessionPath(id, directory), { bigint: true });
    return isDeleted(id, directory) ? null : `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

export function saveSessionSnapshot(snapshot: SessionSnapshot, directory: string = dataDirectory()): boolean {
  const file = sessionPath(snapshot.id, directory);
  if (unreadablePaths.has(file) || isDeleted(snapshot.id, directory) || !sessionSchema.safeParse(snapshot).success) return false;
  if (existsSync(file) && !readSnapshot(file, directory, snapshot.directory, [])) return false;
  if (snapshot.messages.length === 0) return true;
  if (!writeJson(file, snapshot)) return false;
  if (!isDeleted(snapshot.id, directory)) return true;
  try { unlinkSync(file); } catch { /* The tombstone still hides this file. */ }
  return false;
}

export function deleteSessionSnapshot(id: string, directory: string = dataDirectory()): boolean {
  const file = sessionPath(id, directory);
  if (unreadablePaths.has(file)) return false;
  if (!isDeleted(id, directory) && existsSync(file) && !readSnapshot(file, directory, process.cwd(), [])) return false;
  if (!isDeleted(id, directory) && !writeJson(deletedPath(id, directory), { deletedAt: Date.now() })) return false;
  try {
    unlinkSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function saveSessionMetadata(
  sessionIds: readonly string[],
  selectedSessionId: string | null,
  directory: string = dataDirectory(),
): boolean {
  const file = path.join(directory, 'sessions', 'index.json');
  const previous = metadataSchema.safeParse(readJson(file));
  const ids = [...new Set([...sessionIds, ...(previous.success ? previous.data.sessionIds : [])])]
    .filter(id => !isDeleted(id, directory));
  return writeJson(file, {
    version: 1,
    sessionIds: ids,
    selectedSessionId: selectedSessionId && !isDeleted(selectedSessionId, directory)
      && existsSync(sessionPath(selectedSessionId, directory)) ? selectedSessionId : null,
  });
}

// Bulk import remains useful to callers seeding a workspace. It never removes
// sessions absent from its input; normal app subscriptions save one snapshot.
export function saveSessionSnapshots(
  snapshots: readonly SessionSnapshot[],
  selectedSessionId: string | null,
  directory: string = dataDirectory(),
): boolean {
  let saved = true;
  for (const snapshot of snapshots) saved = saveSessionSnapshot(snapshot, directory) && saved;
  return saveSessionMetadata(snapshots.map(snapshot => snapshot.id), selectedSessionId, directory) && saved;
}
