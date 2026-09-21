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

// The prose of a message: its text blocks joined with exactly one newline.
export function textOf(message: Pick<Message, 'content'>): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}
