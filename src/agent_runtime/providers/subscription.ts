import path from 'path';
import type { ImageBlock, Message } from '../types';

// What the subscription transports share. A subscription runtime (a Claude
// Code process, a Codex thread) keeps its own conversation memory and only
// ever sees this one agent's turns, so each turn has to carry whatever the
// shared Sirus history added since the runtime last heard from us.

export function latestUserText(messages: readonly Message[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    throw new Error('Subscription providers expect the latest message to come from the user');
  }
  return last.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

export interface TranscriptOptions {
  // Cut a tool result longer than this many characters, saying how much was
  // left out. Absent renders every result in full.
  resultLimit?: number;
}

function clipped(result: string, limit: number | undefined): string {
  if (limit === undefined || result.length <= limit) return result;
  return `${result.slice(0, limit)}\n[… ${result.length - limit} more characters cut]`;
}

// The provider runtime keeps its own history, so a session that already has
// turns when it first reaches that runtime hands them over as plain text.
// The compaction summariser reads the same rendering.
export function transcript(messages: readonly Message[], options: TranscriptOptions = {}): string {
  const lines: string[] = [];
  for (const message of messages) {
    // A compaction summary says what it is; it is nobody's line.
    if (message.compaction) {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) lines.push(block.text);
      }
      continue;
    }
    const speaker = message.role === 'user'
      ? 'User'
      : `@${message.participant ?? 'sirus'}`;
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text) lines.push(`${speaker}: ${block.text}`);
      } else if (block.type === 'image') {
        lines.push(`${speaker}: [attached image ${path.basename(block.path)}]`);
      } else if (block.type === 'tool_call') {
        lines.push(`${speaker} called tool ${block.name} with ${JSON.stringify(block.arguments)}`);
      } else {
        lines.push(`Tool result${block.isError ? ' (error)' : ''}: ${clipped(block.result, options.resultLimit)}`);
      }
    }
  }
  return lines.join('\n');
}

// The images the runtime has not seen: those in user messages added since
// this participant's previous turn (all of them on its first). The replayed
// transcript names each one; these go along as the pictures themselves.
export function unseenImages(
  messages: readonly Message[],
  isFirstTurn: boolean,
  seenMessageCount: number,
): ImageBlock[] {
  return (isFirstTurn ? messages : messages.slice(seenMessageCount))
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.filter((block): block is ImageBlock => block.type === 'image'));
}

// Long-lived subscription runtimes already remember their own turns. Replay
// only shared messages added since this participant's previous turn, omitting
// its own response (which the provider thread already contains).
export function promptWithSharedHistory(
  messages: readonly Message[],
  isFirstTurn: boolean,
  seenMessageCount: number,
  participantName: string,
  turnPrompt?: string,
): string {
  const text = turnPrompt ?? latestUserText(messages);
  const historyEnd = turnPrompt ? messages.length : -1;
  const earlier = (isFirstTurn
    ? messages.slice(0, historyEnd)
    : messages.slice(seenMessageCount, historyEnd))
    .filter(message => !(
      !isFirstTurn
      && message.role === 'assistant'
      && (message.participant ?? 'sirus').toLocaleLowerCase() === participantName.toLocaleLowerCase()
    ));
  if (earlier.length === 0) return text;
  return [
    isFirstTurn ? 'Earlier conversation, for context:' : 'New shared session messages, for context:',
    transcript(earlier),
    '',
    text,
  ].join('\n');
}
