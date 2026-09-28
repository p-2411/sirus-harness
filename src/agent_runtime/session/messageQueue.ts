import crypto from 'crypto';
import type { ImageBlock, MessageBlock } from '../types';

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly images?: readonly ImageBlock[];
  readonly content?: readonly MessageBlock[];
  readonly to?: readonly string[];
}

// Commands can open pickers or secret entry, so leave them (and anything
// following them) queued for the visible Chat to handle in order.
export function isAutoSendable(text: string): boolean {
  return !/^(?:\/[^/\s]+(?:\s|$)|!)/.test(text);
}

// Messages typed while the agents work, oldest first.
export class MessageQueue {
  private items: QueuedMessage[] = [];

  get length(): number {
    return this.items.length;
  }

  all(): readonly QueuedMessage[] {
    return this.items;
  }

  push(text: string, images?: readonly ImageBlock[], content?: readonly MessageBlock[], to?: readonly string[]): void {
    this.items.push({ id: crypto.randomUUID(), text, ...(images?.length ? { images } : {}),
      ...(content ? { content } : {}), ...(to ? { to } : {}) });
  }

  shift(): QueuedMessage | undefined {
    return this.items.shift();
  }

  prepend(message: QueuedMessage): void {
    const index = this.items.findIndex(item => item.id === message.id);
    if (index < 0) this.items.unshift(message);
    else this.items[index] = { ...message,
      to: [...new Set([...(this.items[index].to ?? []), ...(message.to ?? [])])] };
  }

  // The input bar takes these back into its draft; the rest keep their order.
  take(ids: readonly string[]): QueuedMessage[] {
    const taken = this.items.filter(message => ids.includes(message.id));
    this.items = this.items.filter(message => !taken.includes(message));
    return taken;
  }

  firstAutoSendable(): QueuedMessage | undefined {
    const next = this.items[0];
    return next && isAutoSendable(next.text) ? next : undefined;
  }
}
