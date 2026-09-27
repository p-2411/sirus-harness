import path from 'path';
import { INTERRUPTED_SEVERITY, isPlanCall, textOf, withoutCreationModels, type Message, type MessageBlock, type ToolCallBlock } from '../types';

export { textOf };

// One participant's record: every entry that was directed to it, in the
// order it arrived. A user prompt that mentions it, a message from another
// participant that mentions it, and its own responses, each stamped with the
// session-wide seq the timeline handed out. The same entry object sits in
// every transcript it was delivered to, so the timeline is a union.
//
// The vendor's conversation is authoritative while its runtime lives; this
// record is what the UI renders, what the snapshot saves, and what a rebuilt
// runtime is reseeded from.
export class Transcript {
  private items: Message[] = [];

  entries(): readonly Message[] {
    return this.items;
  }

  get length(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  has(entry: Message): boolean {
    return this.items.includes(entry);
  }

  append(entry: Message): void {
    this.items.push(entry);
  }

  remove(entry: Message): void {
    const at = this.items.indexOf(entry);
    if (at !== -1) this.items.splice(at, 1);
  }

  // A rewind: everything from this seq on goes.
  truncateFrom(seq: number): number {
    const kept = this.items.filter(entry => entry.seq < seq);
    const dropped = this.items.length - kept.length;
    this.items = kept;
    return dropped;
  }

  clear(): void {
    this.items = [];
  }

  // The record as plain text, for a new runtime's first prompt. From the
  // last compaction summary and the most recent entries, within the recap
  // budget so a long record cannot fill the new runtime's context.
  text(): string {
    return transcriptText(this.items);
  }
}

const VERBS: Record<ToolCallBlock['kind'], string> = {
  read: 'read',
  edit: 'edited',
  delete: 'deleted',
  move: 'moved',
  search: 'searched',
  execute: 'ran',
  think: 'thought',
  fetch: 'fetched',
  switch_mode: 'switched mode',
  other: 'used',
};

// UTF-8 bytes also bound byte-based tokens, including non-English text.
// Leave the rest of even the smallest supported context for the current
// prompt, system instructions, tools and the model's reply.
export const RECAP_MAX_BYTES = 24 * 1024;

function compactionCut(entries: readonly Message[]): { from: number; block: number; summary: string | null } {
  for (let index = entries.length - 1; index >= 0; index--) {
    const content = entries[index].content;
    for (let at = content.length - 1; at >= 0; at--) {
      const block = content[at];
      if (block.type === 'compaction' && block.summary) return { from: index, block: at + 1, summary: block.summary };
    }
  }
  return { from: 0, block: 0, summary: null };
}

function blockText(speaker: string, block: MessageBlock): string {
  if (block.type === 'text') return block.text ? `${speaker}: ${block.text}` : '';
  if (block.type === 'image') return `${speaker}: [attached image ${path.basename(block.path)}]`;
  if (block.type === 'tool_call' && isPlanCall(block)) {
    const checklist = block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
    return `${speaker} plan:\n${checklist}`;
  }
  if (block.type === 'tool_call') {
    const outcome = block.outcome ? ` (${block.outcome})`
      : block.status === 'failed' ? ' (failed)' : block.status === 'completed' ? '' : ` (${block.status})`;
    return `${speaker} ${VERBS[block.kind]}: ${block.title}${outcome}`;
  }
  // The vendors' own records say where the user cut a turn short.
  if (block.type === 'notice' && block.severity === INTERRUPTED_SEVERITY) return `${speaker}: [interrupted by the user]`;
  return '';
}

function byteSlice(text: string, budget: number, tail = false): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= budget) return text;
  if (tail) {
    let start = Math.max(0, bytes.length - budget);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString();
  }
  let end = Math.max(0, budget);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString();
}

export function transcriptText(entries: readonly Message[]): string {
  const cut = compactionCut(entries);
  const summary = cut.summary ? byteSlice(cut.summary, RECAP_MAX_BYTES / 2) : '';
  const summaryOmitted = summary !== (cut.summary ?? '');
  const prefix = summary ? `Summary of the earlier conversation:\n${summary}\n\n` : '';
  const omission = '[Recap shortened: older conversation text omitted; the earliest included message may be partial.'
    + (summaryOmitted ? ' The compaction summary was also shortened.' : '') + ']\n';
  const budget = RECAP_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(omission);
  const recent: string[] = [];
  let remaining = budget;
  let omitted = false;
  outer: for (let index = entries.length - 1; index >= cut.from; index--) {
    const entry = withoutCreationModels(entries[index]);
    const speaker = entry.role === 'user' ? 'User' : `@${entry.participant ?? 'sirus'}`;
    for (let at = entry.content.length - 1; at >= (index === cut.from ? cut.block : 0); at--) {
      const text = blockText(speaker, entry.content[at]);
      if (!text) continue;
      const length = Buffer.byteLength(text) + (recent.length ? 1 : 0);
      if (length > remaining) {
        const tail = byteSlice(text, remaining - (recent.length ? 1 : 0), true);
        if (tail) recent.push(tail);
        omitted = true;
        break outer;
      }
      recent.push(text);
      remaining -= length;
    }
  }
  return prefix + (omitted || summaryOmitted ? omission : '') + recent.reverse().join('\n');
}

// Every entry of every transcript, once, in seq order: what the UI shows and
// the snapshot saves. Not a source of truth.
export function mergeTimeline(transcripts: Iterable<Transcript>): Message[] {
  const seen = new Set<Message>();
  for (const transcript of transcripts) {
    for (const entry of transcript.entries()) seen.add(entry);
  }
  return [...seen].sort((left, right) => left.seq - right.seq);
}
