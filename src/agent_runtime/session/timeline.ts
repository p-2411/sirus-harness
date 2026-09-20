import type { Message } from '../types';
import type { ChangeFeed } from './changeFeed';
import { mergeTimeline, type Transcript } from './transcript';

// What the session keeps above its participants' transcripts: the sequence
// numbers every entry is stamped with, the merged view the UI and the
// snapshot read, the activity clocks, and the identity of the assistant
// entries a round is filling in.

// An entry before it has a seq: what a caller hands in.
export type Draft = Omit<Message, 'seq'>;

// One round of assistant entries. The timeline owns their identity, so the
// round loop never has to find them again.
export interface RoundHandle {
  // The entry reserved for each speaker, in the order the round was opened.
  readonly entries: readonly Message[];
  // Streamed progress for one speaker: its entry's content was replaced.
  // The first call puts the entry into the speaker's transcript.
  update(index: number): void;
  // That speaker's turn is over; the entry holds its finished content.
  settle(index: number): void;
  // A speaker that produced nothing leaves no entry behind.
  discardIfEmpty(index: number): void;
  // One repaint for whatever the round's results changed.
  flush(): void;
}

export interface TimelineOptions {
  // When the history last changed; 0 for a restored session that predates
  // the field, so it sorts last and shows no time.
  updatedAt: number;
  conversationStartedAt: number;
  lastResponseFinishedAt: number | null;
}

export class Timeline {
  private seq = 0;
  private activityAt: number;
  private startedAt: number;
  private finishedAt: number | null;
  private cache: { version: number; entries: Message[] } | null = null;

  constructor(
    private readonly transcripts: () => Iterable<Transcript>,
    private readonly changes: ChangeFeed,
    options: TimelineOptions,
  ) {
    this.activityAt = options.updatedAt;
    this.startedAt = options.conversationStartedAt;
    this.finishedAt = options.lastResponseFinishedAt;
  }

  // Every entry once, in seq order. Cached per mutation so the UI, which
  // re-reads on every version bump, gets the same array back until something
  // changed; entries themselves are mutated in place while streaming.
  entries(): Message[] {
    if (this.cache?.version !== this.changes.version) {
      this.cache = { version: this.changes.version, entries: mergeTimeline(this.transcripts()) };
    }
    return this.cache.entries;
  }

  isEmpty(): boolean {
    for (const transcript of this.transcripts()) {
      if (!transcript.isEmpty()) return false;
    }
    return true;
  }

  get lastActivity(): number {
    return this.activityAt;
  }

  get conversationStartedAt(): number {
    return this.startedAt;
  }

  get lastResponseFinishedAt(): number | null {
    return this.finishedAt;
  }

  nextSeq(): number {
    return this.seq++;
  }

  // Restored entries keep their seqs; new ones follow the highest.
  restoreSeq(entries: readonly Message[]): void {
    this.seq = entries.reduce((highest, entry) => Math.max(highest, entry.seq + 1), 0);
  }

  // A prompt that arrives more than five minutes after the last response
  // opens a new conversation, as does the first prompt of an empty session.
  startConversationIfNeeded(now: number): void {
    const finishedAt = this.finishedAt ?? this.activityAt;
    if (this.isEmpty() || now - finishedAt > 5 * 60_000) {
      this.startedAt = now;
    }
  }

  // Stamps one entry and puts it into every transcript it is directed to.
  // mayStartConversation is false while a turn is in flight: sendMessage
  // places the conversation boundary itself.
  add(draft: Draft, to: readonly Transcript[], mayStartConversation: boolean = true): Message {
    const now = Date.now();
    if (draft.role === 'user' && mayStartConversation) this.startConversationIfNeeded(now);
    if (draft.role === 'assistant') this.finishedAt = now;
    const entry: Message = { ...draft, seq: this.nextSeq() };
    for (const transcript of to) transcript.append(entry);
    this.activityAt = now;
    this.changes.notify();
    return entry;
  }

  // A response reaches the participants it mentioned: their transcripts get
  // the whole entry, attributed to its author, and nothing else.
  deliver(entry: Message, to: readonly { name: string; transcript: Transcript }[]): void {
    const names = [...(entry.to ?? [])];
    for (const recipient of to) {
      if (recipient.transcript.has(entry)) continue;
      recipient.transcript.append(entry);
      if (!names.includes(recipient.name)) names.push(recipient.name);
    }
    if (names.length > 0) entry.to = names;
    this.changes.notify();
  }

  touch(): void {
    this.activityAt = Date.now();
  }

  // Measure the reply gap from the end of model work, not streamed chunks
  // or a checkpoint that may still be finishing in the background.
  markResponseFinished(): void {
    this.finishedAt = Date.now();
  }

  // Dropping history is part of a larger operation (clearing the session, or
  // rewinding it); the caller repaints once when the whole of it is done.
  clear(): void {
    for (const transcript of this.transcripts()) transcript.clear();
    this.seq = 0;
    this.activityAt = Date.now();
  }

  // Cuts every transcript back to before a checkpoint. Returns how many
  // entries went from the timeline.
  truncateFrom(seq: number): number {
    const before = this.entries().length;
    for (const transcript of this.transcripts()) transcript.truncateFrom(seq);
    this.seq = seq;
    this.activityAt = Date.now();
    this.changes.notify();
    return before - this.entries().length;
  }

  // Takes charge of one round's assistant entries: when they enter their
  // speaker's transcript, what fills them in, and which never earned a place.
  openRound(speakers: readonly { name: string; model: string; transcript: Transcript }[]): RoundHandle {
    const entries: Message[] = speakers.map(speaker => ({
      seq: this.nextSeq(),
      role: 'assistant' as const,
      participant: speaker.name,
      model: speaker.model,
      content: [],
    }));
    const published = new Set<number>();
    let changed = false;
    const publish = (index: number) => {
      if (published.has(index)) return;
      published.add(index);
      speakers[index].transcript.append(entries[index]);
      this.finishedAt = Date.now();
      this.changes.notifyAssistantActivity();
    };
    return {
      entries,
      update: index => {
        publish(index);
        this.changes.notifyStreaming();
      },
      settle: index => {
        publish(index);
        this.finishedAt = Date.now();
        changed = true;
      },
      discardIfEmpty: index => {
        if (!published.has(index)) return;
        // A turn that failed before producing anything should not leave an
        // empty assistant entry. Streamed text and completed tool work,
        // however, remain useful history after cancellation or failure.
        if (entries[index].content.length === 0) speakers[index].transcript.remove(entries[index]);
        changed = true;
      },
      flush: () => {
        if (!changed) return;
        changed = false;
        this.changes.notifyAssistantActivity();
      },
    };
  }
}
