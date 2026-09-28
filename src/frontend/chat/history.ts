import type { Message, MessageBlock } from '../../agent_runtime/types';

interface Position { block: number; offset: number }
export interface HistoryPart { key: string; message: Message; final: boolean }

function position(content: readonly MessageBlock[], point: Position): Position {
  const block = Math.min(content.length, point.block);
  const value = content[block];
  const length = value?.type === 'text' || value?.type === 'thought' ? value.text.length : 0;
  const offset = Math.min(length, point.offset);
  return length > 0 && offset === length ? { block: block + 1, offset: 0 } : { block, offset };
}

function sliceContent(content: readonly MessageBlock[], from: Position, to: Position): MessageBlock[] {
  const result: MessageBlock[] = [];
  for (let index = from.block; index <= to.block && index < content.length; index++) {
    if (index === to.block && to.offset === 0) break;
    const block = content[index]!;
    if (block.type === 'text' || block.type === 'thought') {
      const text = block.text.slice(index === from.block ? from.offset : 0, index === to.block ? to.offset : undefined);
      if (text) result.push({ ...block, text });
    } else result.push(block);
  }
  return result;
}

// Split only the display. The vendor transcript and checkpoints still own
// whole messages, while each continuation follows the user's injection.
export function historyParts(messages: readonly Message[]): HistoryPart[] {
  const replies = new Set(messages.filter(message => message.role === 'assistant').map(message => message.seq));
  const injected = new Map<number, Message[]>();
  const moved = new Set<number>();
  for (const message of messages) {
    const at = message.injectedAt;
    if (message.role !== 'user' || !at || at.seq >= message.seq || !replies.has(at.seq)) continue;
    const entries = injected.get(at.seq) ?? [];
    entries.push(message);
    injected.set(at.seq, entries);
    moved.add(message.seq);
  }
  const parts: HistoryPart[] = [];
  for (const message of messages) {
    if (moved.has(message.seq)) continue;
    const insertions = injected.get(message.seq);
    if (!insertions) { parts.push({ key: String(message.seq), message, final: true }); continue; }
    insertions.sort((left, right) => left.injectedAt!.block - right.injectedAt!.block
      || left.injectedAt!.offset - right.injectedAt!.offset || left.seq - right.seq);
    let start = { block: 0, offset: 0 };
    let key = String(message.seq);
    for (const insertion of insertions) {
      const end = position(message.content, insertion.injectedAt!);
      const content = sliceContent(message.content, start, end);
      if (content.length) parts.push({ key, message: { ...message, content }, final: false });
      parts.push({ key: String(insertion.seq), message: insertion, final: true });
      start = end;
      key = `${message.seq}:after:${insertion.seq}`;
    }
    const content = sliceContent(message.content, start, { block: message.content.length, offset: 0 });
    if (content.length) parts.push({ key, message: { ...message, content }, final: true });
  }
  return parts;
}
