import crypto from 'crypto';
import type { Vendor } from './providers/catalog';

// The vendor's durable conversation, in the credential profile and directory
// where it was opened. A snapshot keeps this even when its process is gone.
export interface NativeSession {
  vendor: Vendor;
  sessionId: string;
  directory: string;
  sourceId: string | null;
  profileHome: string;
  systemPromptHash?: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
  // Snapshot of a mentioned file; render compactly while runtimes receive text.
  filePath?: string;
}

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = typeof IMAGE_MEDIA_TYPES[number];

// An image the user attached to a message. The bytes live in a file under
// the application-state directory, so the persisted history stays small and
// the runtime reads the file only when it builds a prompt.
export interface ImageBlock {
  type: 'image';
  path: string;
  mediaType: ImageMediaType;
  bytes: number;
}

// Reasoning the runtime streamed as thought chunks. Rendered as thinking;
// never part of what a rebuilt runtime is reseeded with. It began when the
// runtime last said anything else, or when the turn began, and ended when the
// reply moved on; both are absent in older snapshots.
export interface ThoughtBlock {
  type: 'thought';
  text: string;
  startedAt?: number;
  endedAt?: number;
}

// The runtime folded its own conversation at this point. The summary is what
// it reported, when it reported one; a rebuilt runtime is reseeded from here.
export interface CompactionBlock {
  type: 'compaction';
  summary?: string;
}

// Advisory information from the vendor, shown to the user but never sent
// back to a runtime as conversation or used to address another participant.
// Sirus records its own this way too: a turn's error, and where a turn was
// interrupted.
export interface NoticeBlock {
  type: 'notice';
  severity: string;
  title: string;
  description?: string;
}

// ACP's vocabulary for what a tool call does. The kind picks the verb and the
// icon; the title is the line.
export const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;

export type ToolKind = typeof TOOL_KINDS[number];

export const TOOL_CALL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;

export type ToolCallStatus = typeof TOOL_CALL_STATUSES[number];

export interface ToolCallDiff {
  type: 'diff';
  path: string;
  // Null for a new file.
  oldText: string | null;
  newText: string;
  // The line of the changed file the texts start at, when the vendor said:
  // Claude sends each hunk with its line, codex-acp sends whole files. Absent
  // for an excerpt with no position, such as Claude's edit before it runs.
  line?: number;
}

// Text the call produced: content blocks and terminal output alike.
export interface ToolCallText {
  type: 'text';
  text: string;
}

export type ToolCallContent = ToolCallDiff | ToolCallText;

export interface ToolCallLocation {
  path: string;
  line?: number;
}

// One tool call as the runtime reported it, with every later update folded
// in. The runtime ran it; Sirus only records what the updates carried.
export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations: ToolCallLocation[];
  content: ToolCallContent[];
  // The call's arguments and result, as the runtime chose to expose them.
  input?: unknown;
  output?: unknown;
  // Why a call that did not run to its end stopped, when that was not its own
  // failure: the user declined it at the approval prompt, or the turn it
  // belonged to was cancelled. Both vendors report either as failed.
  outcome?: ToolCallOutcome;
}

export const TOOL_CALL_OUTCOMES = ['declined', 'cancelled'] as const;

export type ToolCallOutcome = typeof TOOL_CALL_OUTCOMES[number];

export type MessageBlock = TextBlock | ImageBlock | ThoughtBlock | CompactionBlock | NoticeBlock | ToolCallBlock;

export const PLAN_ENTRY_STATUSES = ['pending', 'in_progress', 'completed'] as const;

// One step of an agent's plan: Claude's todo list and Codex's plan both
// arrive as a list of these, the whole plan each time.
export interface PlanEntry {
  content: string;
  status: typeof PLAN_ENTRY_STATUSES[number];
}

// A plan is recorded as a call of its own, the way both vendors' terminals
// show a plan update in the flow of the turn: its entries as the input, and
// a checklist as text for anything that reads calls as text. Ids are
// Sirus's, so they never meet a vendor's.
const PLAN_CALL_PREFIX = 'sirus-plan-';
const PLAN_MARKS: Record<PlanEntry['status'], string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

export function planCall(entries: readonly PlanEntry[], id: string = `${PLAN_CALL_PREFIX}${crypto.randomUUID()}`): ToolCallBlock {
  return {
    type: 'tool_call',
    id,
    title: 'Plan',
    kind: 'think',
    status: 'completed',
    locations: [],
    content: [{ type: 'text', text: entries.map(entry => `${PLAN_MARKS[entry.status]} ${entry.content}`).join('\n') }],
    input: { entries },
  };
}

export function isPlanCall(call: ToolCallBlock): boolean {
  return call.id.startsWith(PLAN_CALL_PREFIX);
}

// The entries a plan call records; empty for anything else.
export function planEntriesOf(call: ToolCallBlock): PlanEntry[] {
  if (!isPlanCall(call)) return [];
  const input = call.input as { entries?: unknown } | undefined;
  if (!Array.isArray(input?.entries)) return [];
  return input.entries.filter((entry): entry is PlanEntry => typeof entry === 'object' && entry !== null
    && typeof (entry as PlanEntry).content === 'string'
    && PLAN_ENTRY_STATUSES.includes((entry as PlanEntry).status));
}

// Marks every tool call still pending or running as failed, for a turn that
// will report nothing more about them, and says why when the turn was
// cancelled rather than failed. True if any was.
export function failOpenToolCalls(content: MessageBlock[], outcome?: 'cancelled'): boolean {
  let changed = false;
  for (const [index, block] of content.entries()) {
    if (block.type !== 'tool_call' || block.status === 'completed' || block.status === 'failed') continue;
    content[index] = { ...block, status: 'failed', ...(outcome && !block.outcome ? { outcome } : {}) };
    changed = true;
  }
  return changed;
}

// What one turn used, as the vendor reported it when the turn ended. Claude
// answers a prompt with the tally of every model call of the turn. codex-acp
// answers with its last call's alone, so a Codex turn's total is what the
// usage updates of its calls add up to, and its breakdown is known only when
// the turn made one call. The cost is Claude's alone: what this turn added to
// the running cost of its session.
export interface TurnUsage {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  costUsd?: number;
}

// One entry of a participant's transcript. The same object sits in every
// transcript it was delivered to, so the session's timeline is the union of
// the transcripts ordered by seq.
export interface Message {
  // Session-wide order, stamped when the entry enters its first transcript.
  // A checkpoint records the seq at capture; a rewind drops everything from
  // that seq on.
  seq: number;
  role: 'user' | 'assistant';
  content: MessageBlock[];
  // Assistant entries: the participant that wrote it.
  participant?: string;
  // The participants whose transcripts hold this entry besides its author: a
  // user prompt's targets, a response's mentioned peers. Absent means none.
  to?: string[];
  // Captured on assistant entries so the UI can show the model that produced
  // a historical message even if that participant changes models later.
  model?: string;
  // Kept out of the chat. The runtimes still read it in the record; the user
  // sees its content somewhere else. A worker's report is shown under the
  // SpawnAgent call that started the worker, not as a message of its own.
  hidden?: true;
  // Where a steered user message entered a reply that was still streaming.
  // Display metadata only: transcripts retain the complete vendor messages.
  injectedAt?: { seq: number; block: number; offset: number };
  // Where a user prompt or an agent's reply names the model a new participant
  // starts on, the `<model>` of `@name <model>`, in `textOf` offsets. The text
  // is kept as written; the runtimes read it without these (`withoutCreationModels`).
  creationModels?: { start: number; end: number }[];
  // User prompts routed by @name: the participant whose conversation the
  // user follows the prompt in, which shows it and its other targets'
  // replies too. Display metadata only: no runtime reads it.
  shownIn?: string;
  // Assistant entries: when the turn that wrote it started and ended, and what
  // it used. Absent while it runs and in older snapshots. A participant's
  // total, which /status and /usage show, is the sum over its entries.
  startedAt?: number;
  finishedAt?: number;
  usage?: TurnUsage;
}

// The reasoning depth a user picks per agent. Runtimes translate the shared
// level into whatever effort option the vendor exposes. An agent nobody
// picked a level for runs at its model's own default, which is the vendor's.
export const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = typeof THINKING_LEVELS[number];

export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  low: 'fastest, with lighter reasoning',
  medium: 'balanced speed and reasoning depth',
  high: 'deep reasoning for complex work',
  xhigh: 'extended reasoning for difficult, long-running work',
  max: 'maximum reasoning depth and token use',
};

export function parseThinkingLevel(value: unknown): ThinkingLevel | null {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value as ThinkingLevel
    : null;
}

// What follows is the permission policy's, the subagents' and the
// subscriptions' vocabulary. It is declared, and imported from, here because
// the files under persistence validate against it and persistence imports
// nothing else of the runtime, so a value added to one is a value the file
// can read back.

// Sirus's three permission modes, in the order the mode switch cycles them;
// `permissions/policy.ts` says what each one does.
export const PERMISSION_MODES = ['ask', 'auto', 'bypass'] as const;

export type PermissionMode = typeof PERMISSION_MODES[number];

// How a worker's conversation starts: from nothing, or as a fork of the
// conversation of the agent that spawned it.
export const WORKER_CONTEXTS = ['fresh', 'owner'] as const;

export type WorkerContext = typeof WORKER_CONTEXTS[number];

// A worker uses the owner's directory or a Git worktree cut from HEAD.
export const WORKER_ISOLATIONS = ['none', 'worktree'] as const;

export type WorkerIsolation = typeof WORKER_ISOLATIONS[number];

// Where a delegated run stands. `interrupted` is a run that was still working
// when the process it lived in ended: its record survives in the session
// file, nothing restarts it.
export const SUBAGENT_STATUSES = ['working', 'done', 'failed', 'cancelled', 'interrupted'] as const;

export type SubagentStatus = typeof SUBAGENT_STATUSES[number];

// The allowance windows a subscription's remaining share is read for: the
// one the sidebar shows for each vendor, and what the limit cache keeps.
export const LIMIT_PERIODS = ['5-hour', '7-day'] as const;

export type LimitPeriod = typeof LIMIT_PERIODS[number];

// What a subscription profile may be called. The name becomes a directory
// under the data directory, so it holds nothing that could lead out of it.
export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// The participant every session starts with, and the one a message that names
// no participant belongs to.
export const DEFAULT_PARTICIPANT = 'sirus';
// The levels a model offers, read off the efforts its runtime listed: null
// while no runtime on it has said, empty when it has no effort to set.
export function offeredThinkingLevels(efforts: readonly string[] | undefined): ThinkingLevel[] | null {
  return efforts ? THINKING_LEVELS.filter(level => efforts.includes(level)) : null;
}

// The level a model runs at when asked for this one: the level itself when
// offered, else the nearest lower one, else the lowest it offers; null when
// it offers none. The runtime applies exactly this, so the status row can
// show it rather than what was asked for.
export function fitThinkingLevel(level: ThinkingLevel, offered: readonly ThinkingLevel[]): ThinkingLevel | null {
  const lower = THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf(level) + 1).reverse();
  return lower.find(candidate => offered.includes(candidate))
    ?? THINKING_LEVELS.find(candidate => offered.includes(candidate))
    ?? null;
}

// The prose of a message: its text blocks joined with exactly one newline.
export function textOf(message: Pick<Message, 'content'>): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

// A message as the runtimes read it. The model that follows a newly
// introduced @name is routing, not conversation, so it is cut out of the text
// the message was kept with; the user still sees it as it was written.
export function withoutCreationModels<T extends Pick<Message, 'content' | 'creationModels'>>(message: T): T {
  const spans = [...(message.creationModels ?? [])].sort((left, right) => right.start - left.start);
  if (spans.length === 0) return message;
  const content = [...message.content];
  // textOf joins text blocks with exactly one newline.
  let start = 0;
  for (const [index, block] of content.entries()) {
    if (block.type !== 'text') continue;
    const end = start + block.text.length;
    let text = block.text;
    for (const span of spans) {
      if (span.start >= start && span.end <= end) text = text.slice(0, span.start - start) + text.slice(span.end - start);
    }
    if (text !== block.text) content[index] = { ...block, text };
    start = end + 1;
  }
  return { ...message, content };
}
