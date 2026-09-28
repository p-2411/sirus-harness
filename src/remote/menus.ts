import path from 'node:path';
import type { Session } from '../agent_runtime/session';
import { commandTokenAt, isSirusCommand, matchCommands, type CommandMenuEntry } from '../commands/registry';
import { commandUsage } from '../commands/types';
import { activeFileMention, fileSearchDirectory, listMentionFiles, matchFileSuggestions } from '../fileSearch';
import { mentionMenuItems } from '../frontend/chat/MentionMenu';

// The phone's menus, worked out by the TUI's own rules so the app only draws
// them: what the `/` or `@` being typed at the cursor offers, and the picker a
// command such as `/model` opens instead of running.

// One row of the `/` or `@` menu: choosing it puts `insert` in place of the
// input from `start` to `end`, in UTF-16 offsets as the TUI counts them.
export interface Completion {
  kind: 'command' | 'participant' | 'create' | 'file' | 'directory';
  label: string;
  description: string;
  tag?: string;
  start: number;
  end: number;
  insert: string;
}

// As the TUI's input bar: a command name being typed offers the commands,
// Sirus's first; anywhere else an @ offers participants and then files,
// the nearest match last, since the menu sits above the input.
export async function completions(session: Session, participant: string, text: string, cursor: number, signal: AbortSignal): Promise<Completion[]> {
  const native = session.getNativeCommands(participant);
  const token = commandTokenAt(text, cursor);
  if (token) {
    return matchCommands(text, native, cursor).map(match => ({
      kind: 'command', label: commandUsage(match), description: match.description,
      ...(match.vendor ? { tag: match.vendor } : {}),
      start: token.start, end: token.end, insert: `/${match.name} `,
    }));
  }
  // A Sirus command takes no @mentions.
  if (isSirusCommand(text, native)) return [];
  const mention = activeFileMention(text, cursor);
  if (!mention) return [];
  const directory = session.getDirectory();
  const files = await listMentionFiles(directory, fileSearchDirectory(directory, mention.query),
    path.isAbsolute(mention.query), signal).catch(() => []);
  const matched = matchFileSuggestions(files, mention.query, 50, directory);
  return mentionMenuItems(text.slice(0, cursor), session.getParticipants(), matched).map(item => ({
    kind: item.kind, label: item.label, description: item.description,
    start: mention.start, end: mention.end, insert: item.replacement,
  }));
}

// A command's picker as the TUI's menu lists it. An item either is a
// command to send, or asks for one more value first, which is sent after
// the command as its last argument.
export type PickerEntry =
  | { kind: 'heading' | 'info'; label: string }
  | { kind: 'item'; label: string; description?: string; command: string; current?: boolean;
      prompt?: { text: string; secret: boolean } };

export function pickerEntries(entries: readonly CommandMenuEntry[]): PickerEntry[] {
  return entries.map((entry): PickerEntry => {
    if (entry.type !== 'item') return { kind: entry.type, label: entry.label };
    const asks = entry.secret ?? entry.input;
    return {
      kind: 'item', label: entry.label, command: entry.command,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.current ? { current: true } : {}),
      ...(asks ? { prompt: { text: asks.prompt, secret: Boolean(entry.secret) } } : {}),
    };
  });
}
