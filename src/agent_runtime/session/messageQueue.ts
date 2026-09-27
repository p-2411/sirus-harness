import crypto from 'crypto';
import type { ImageBlock, MessageBlock } from '../types';

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly images?: readonly ImageBlock[];
  readonly content?: readonly MessageBlock[];
  readonly to?: readonly string[];
  readonly editing?: boolean;
}

// Commands can open pickers or secret entry, so leave them (and anything
// following them) queued for the visible Chat to handle in order.
export function isAutoSendable(text: string): boolean {
  return !/^\/[^/\s]+(?:\s|$)/.test(text);
}

// The original stays in its slot while the input bar edits a private copy.
// Draining skips reserved slots, so it can never send a half-written draft.
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
    const index = this.items.findIndex(message => !message.editing);
    return index < 0 ? undefined : this.items.splice(index, 1)[0];
  }

  take(): QueuedMessage | undefined {
    for (let index = this.items.length - 1; index >= 0; index--) {
      if (!this.items[index].editing) return this.items.splice(index, 1)[0];
    }
    return undefined;
  }

  shiftAutoSendable(): QueuedMessage | undefined {
    const next = this.items.find(message => !message.editing);
    if (!next || !isAutoSendable(next.text)) return undefined;
    return this.shift();
  }

  beginEdit(id: string): QueuedMessage | undefined {
    const index = this.items.findIndex(message => message.id === id && !message.editing);
    if (index < 0) return undefined;
    const original = this.items[index];
    this.items[index] = { ...original, editing: true };
    return original;
  }

  finishEdit(id: string, text?: string, images?: readonly ImageBlock[], content?: readonly MessageBlock[]): boolean {
    const index = this.items.findIndex(message => message.id === id && message.editing);
    if (index < 0) return false;
    const { editing: _, ...original } = this.items[index];
    if (text === undefined) this.items[index] = original;
    else {
      const attachments = images ?? original.images;
      if (text.length === 0 && !attachments?.length) this.items.splice(index, 1);
      else this.items[index] = { ...original, text, images: attachments,
        // An unchanged draft keeps positioned attachments. Edited text is
        // rebuilt with its images unless the editor supplies fresh content.
        content: content ?? (text === original.text ? original.content : undefined) };
    }
    return true;
  }

  update(id: string, text: string): boolean {
    const item = this.items.find(message => message.id === id);
    if (!item || item.editing || item.text === text) return false;
    this.beginEdit(id);
    return this.finishEdit(id, text);
  }
}
