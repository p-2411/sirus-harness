import crypto from 'crypto';

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
// never part of what a rebuilt runtime is reseeded with.
export interface ThoughtBlock {
  type: 'thought';
  text: string;
}

// The runtime folded its own conversation at this point. The summary is what
// it reported, when it reported one; a rebuilt runtime is reseeded from here.
export interface CompactionBlock {
  type: 'compaction';
  summary?: string;
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
}

export type MessageBlock = TextBlock | ImageBlock | ThoughtBlock | CompactionBlock | ToolCallBlock;

// One step of an agent's plan: Claude's todo list and Codex's plan both
// arrive as a list of these, the whole plan each time.
export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
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
    && ['pending', 'in_progress', 'completed'].includes((entry as PlanEntry).status));
}

// Marks every tool call still pending or running as failed, for a turn that
// will report nothing more about them. True if any was.
export function failOpenToolCalls(content: MessageBlock[]): boolean {
  let changed = false;
  for (const [index, block] of content.entries()) {
    if (block.type !== 'tool_call' || block.status === 'completed' || block.status === 'failed') continue;
    content[index] = { ...block, status: 'failed' };
    changed = true;
  }
  return changed;
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
}

// The reasoning depth a user picks per agent. Runtimes translate the shared
// level into whatever effort option the vendor exposes.
export const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = typeof THINKING_LEVELS[number];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';

export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  low: 'fastest, with lighter reasoning',
  medium: 'balanced speed and reasoning depth',
  high: 'deep reasoning for complex work (default)',
  xhigh: 'extended reasoning for difficult, long-running work',
  max: 'maximum reasoning depth and token use',
};

export function parseThinkingLevel(value: unknown): ThinkingLevel | null {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value as ThinkingLevel
    : null;
}

// The lists below are the permission policy's, the subagents' and the
// subscription allowance's vocabulary. They are declared, and imported from,
// here because the files under persistence validate against them and
// persistence imports nothing else of the runtime, so a value added to one is
// a value the file can read back.

// Sirus's three permission modes, in the order the mode switch cycles them;
// `permissions/policy.ts` says what each one does.
export const PERMISSION_MODES = ['ask', 'auto', 'bypass'] as const;

export type PermissionMode = typeof PERMISSION_MODES[number];

// How a worker's conversation starts: from nothing, or as a fork of the
// conversation of the agent that spawned it.
export const WORKER_CONTEXTS = ['fresh', 'owner'] as const;

export type WorkerContext = typeof WORKER_CONTEXTS[number];

// Where a delegated run stands. `interrupted` is a run that was still working
// when the process it lived in ended: its record survives in the session
// file, nothing restarts it.
export const SUBAGENT_STATUSES = ['working', 'done', 'failed', 'cancelled', 'interrupted'] as const;

export type SubagentStatus = typeof SUBAGENT_STATUSES[number];

// The allowance windows a subscription's remaining share is read for: the
// one the sidebar shows for each vendor, and what the limit cache keeps.
export const LIMIT_PERIODS = ['5-hour', '7-day'] as const;

export type LimitPeriod = typeof LIMIT_PERIODS[number];

// The participant every session starts with, and the one a message that names
// no participant belongs to.
export const DEFAULT_PARTICIPANT = 'sirus';

// The prose of a message: its text blocks joined with exactly one newline.
export function textOf(message: Pick<Message, 'content'>): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}
