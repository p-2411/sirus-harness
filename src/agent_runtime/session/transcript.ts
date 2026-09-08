import { contextWindowFor } from '../providers/catalog';
import type { Message, MessageBlock, Usage } from '../types';
import type { ContextUsage } from '../usage';
import type { ChangeFeed } from './changeFeed';

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
}

// The prose of a message: its text blocks joined with exactly one newline.
export function textOf(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

// One round of assistant bubbles. The transcript owns their identity, so the
// round loop never has to find them again.
export interface RoundHandle {
  // Streamed progress for one participant. The first call reserves every
  // bubble of the round at once.
  update(index: number, content: MessageBlock[], usage?: Usage): void;
  // That participant's finished message.
  settle(index: number, message: Message): void;
  // A participant that produced nothing leaves no bubble behind.
  discardIfEmpty(index: number): void;
  // One repaint for whatever the round's results changed.
  flush(): void;
}

export interface TranscriptOptions {
  messages?: readonly Message[];
  // When the history last changed; 0 for a restored session that predates
  // the field, so it sorts last and shows no time.
  updatedAt: number;
  conversationStartedAt: number;
  lastResponseFinishedAt: number | null;
}

// The session's message list and every fact derived from it: the activity
// clocks, the conversation-start rule, the usage folds, and the identity of
// the assistant bubbles a round is filling in.
export class Transcript {
  private messages: Message[];
  private activityAt: number;
  private startedAt: number;
  private finishedAt: number | null;

  constructor(private readonly changes: ChangeFeed, options: TranscriptOptions) {
    this.messages = [...(options.messages ?? [])];
    this.activityAt = options.updatedAt;
    this.startedAt = options.conversationStartedAt;
    this.finishedAt = options.lastResponseFinishedAt;
  }

  // The live array. The UI depends on its identity plus the version counter,
  // so this is deliberately not a copy.
  history(): Message[] {
    return this.messages;
  }

  get length(): number {
    return this.messages.length;
  }

  isEmpty(): boolean {
    return this.messages.length === 0;
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

  // A prompt that arrives more than five minutes after the last response
  // opens a new conversation, as does the first prompt of an empty session.
  startConversationIfNeeded(now: number): void {
    const finishedAt = this.finishedAt ?? this.activityAt;
    if (this.messages.length === 0 || now - finishedAt > 5 * 60_000) {
      this.startedAt = now;
    }
  }

  // Adds one message and repaints. mayStartConversation is false while a turn
  // is in flight: sendMessage places the conversation boundary itself.
  append(message: Message, mayStartConversation: boolean = true): void {
    const now = Date.now();
    if (message.role === 'user' && mayStartConversation) this.startConversationIfNeeded(now);
    if (message.role === 'assistant') this.finishedAt = now;
    this.messages.push(message);
    this.activityAt = now;
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
    this.messages = [];
    this.activityAt = Date.now();
  }

  // Cuts the history back to a checkpoint. Returns how many messages went.
  truncate(messageIndex: number): number {
    const dropped = Math.max(0, this.messages.length - messageIndex);
    this.messages = this.messages.slice(0, messageIndex);
    this.activityAt = Date.now();
    return dropped;
  }

  // The window of the latest response that reported one: what the model had
  // in front of it when it last answered.
  contextUsage(fallbackModel: string): ContextUsage | null {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message.role !== 'assistant' || !message.usage) continue;
      const window = message.usage.contextWindow
        ?? contextWindowFor(message.model ?? fallbackModel);
      return { tokens: message.usage.contextTokens, ...(window ? { window } : {}) };
    }
    return null;
  }

  // Every token the session's responses have reported, or null before any.
  totalUsage(): TokenTotals | null {
    let reported = false;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const message of this.messages) {
      if (message.role !== 'assistant' || !message.usage) continue;
      reported = true;
      inputTokens += message.usage.inputTokens;
      outputTokens += message.usage.outputTokens;
    }
    return reported ? { inputTokens, outputTokens } : null;
  }

  // Takes charge of one round's assistant bubbles: when they enter the
  // history, what fills them in, and which of them never earned a place.
  openRound(bubbles: readonly Message[]): RoundHandle {
    const live = [...bubbles];
    let published = false;
    let changed = false;
    const publish = () => {
      if (published) return;
      published = true;
      this.messages.push(...live);
      this.changes.notifyAssistantActivity();
    };
    const setContent = (index: number, content: MessageBlock[], usage: Usage | undefined) => {
      live[index].content = content;
      if (usage) live[index].usage = usage;
      else delete live[index].usage;
    };
    return {
      update: (index, content, usage) => {
        publish();
        setContent(index, content, usage);
        this.changes.notifyStreaming();
      },
      settle: (index, message) => {
        if (published) setContent(index, message.content, message.usage);
        // Nothing streamed, so no bubble was reserved: the finished message
        // is the whole of what this participant contributed.
        else this.messages.push(message);
        changed = true;
      },
      discardIfEmpty: index => {
        if (!published) return;
        // A turn that failed before producing anything should not leave an
        // empty assistant bubble. Streamed text and completed tool work,
        // however, remain useful history after cancellation or failure.
        if (live[index].content.length === 0) {
          const at = this.messages.indexOf(live[index]);
          if (at !== -1) this.messages.splice(at, 1);
        }
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
