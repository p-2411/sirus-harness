import path from 'path';
import { textOf, type Message, type ToolCallBlock } from '../types';

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
  // last compaction the runtime reported a summary for, since that is all
  // the vendor's own context held from then on; the whole record otherwise.
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

function compactionCut(entries: readonly Message[]): { from: number; summary: string | null } {
  for (let index = entries.length - 1; index >= 0; index--) {
    for (const block of entries[index].content) {
      if (block.type === 'compaction' && block.summary) return { from: index, summary: block.summary };
    }
  }
  return { from: 0, summary: null };
}

export function transcriptText(entries: readonly Message[]): string {
  const { from, summary } = compactionCut(entries);
  const lines: string[] = [];
  if (summary) lines.push('Summary of the earlier conversation:', summary, '');
  for (const entry of entries.slice(from)) {
    const speaker = entry.role === 'user' ? 'User' : `@${entry.participant ?? 'sirus'}`;
    for (const block of entry.content) {
      if (block.type === 'text') {
        if (block.text) lines.push(`${speaker}: ${block.text}`);
      } else if (block.type === 'image') {
        lines.push(`${speaker}: [attached image ${path.basename(block.path)}]`);
      } else if (block.type === 'tool_call') {
        const outcome = block.status === 'failed' ? ' (failed)' : block.status === 'completed' ? '' : ` (${block.status})`;
        lines.push(`${speaker} ${VERBS[block.kind]}: ${block.title}${outcome}`);
      }
      // Thoughts are the runtime's own; a compaction without a summary changes nothing.
    }
  }
  return lines.join('\n');
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
