import crypto from 'crypto';

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
}

// Normal prompts keep running even when this session's Chat is unmounted.
// Commands can open pickers or secret entry, so leave them (and anything
// following them) queued for the visible Chat to handle in order.
export function isAutoSendable(text: string): boolean {
  return !text.startsWith('/');
}

// Prompts typed while a turn is active. They belong to the session, so
// switching away and back does not discard them, and they are intentionally
// not persisted.
export class MessageQueue {
  private items: QueuedMessage[] = [];

  get length(): number {
    return this.items.length;
  }

  all(): readonly QueuedMessage[] {
    return this.items;
  }

  push(text: string): void {
    this.items.push({ id: crypto.randomUUID(), text });
  }

  shift(): string | undefined {
    return this.items.shift()?.text;
  }

  // The next prompt when nothing about it needs a mounted Chat, removed from
  // the queue; undefined when the queue is empty or paused at a command.
  shiftAutoSendable(): string | undefined {
    const next = this.items[0];
    if (next === undefined || !isAutoSendable(next.text)) return undefined;
    this.items.shift();
    return next.text;
  }

  // Rewrites a queued prompt, or drops it when the new text is empty.
  // False when the id is unknown or the text is unchanged.
  update(id: string, text: string): boolean {
    const index = this.items.findIndex(message => message.id === id);
    if (index === -1 || this.items[index].text === text) return false;
    if (text.length === 0) this.items.splice(index, 1);
    else this.items[index] = { id, text };
    return true;
  }
}
