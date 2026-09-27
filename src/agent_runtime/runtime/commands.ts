import path from 'path';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { cachedJsonFile } from '../../persistence/atomicJson';
import { VENDORS, type Vendor } from '../providers/catalog';

// Slash commands are the vendors' own. Each runtime reports what its harness
// offers in `available_commands_update` — Claude Code's built-ins, the user's
// and the project's skills and commands, the enabled plugins'; Codex's
// built-ins and its skills — and the `/` menu lists that after Sirus's own
// commands. A command the user picks goes to the participant as prompt text,
// the way the vendor's own terminal would send it.
//
// A runtime reports its list only once its session is open, so the last list
// seen for a vendor in a directory is kept, on disk too: the menu has
// something to offer before the first turn of the day.

export interface NativeCommand {
  // What the user types after the slash.
  name: string;
  description: string;
  // What the command takes after its name, when the vendor says.
  argumentHint?: string;
  // What the participant is sent in place of `/name`: the command itself, or
  // for a Codex skill its `$name` mention.
  invocation: string;
}

// Listed by a vendor, but not for the user of this client: Claude's
// internal session commands, and `/effort`, which would change the thinking
// level behind `/thinking`'s back.
const HIDDEN = new Set(['effort', 'heapdump', 'workflow-launch-exec', 'design-consent', 'design-revoke']);

// A vendor's command as the menu offers it; null for one the user cannot
// usefully run here. Codex lists its skills as `$name`, which is also how a
// prompt mentions one.
export function nativeCommandFrom(command: AvailableCommand): NativeCommand | null {
  const skill = command.name.startsWith('$');
  const name = skill ? command.name.slice(1) : command.name;
  if (!name || name.startsWith('_') || HIDDEN.has(name)) return null;
  const hint = command.input?.hint;
  return {
    name,
    description: command.description,
    ...(hint ? { argumentHint: hint } : {}),
    invocation: skill ? command.name : `/${name}`,
  };
}

// How many directories' lists are kept, most recently reported first.
const KEPT_LISTS = 24;
const FILE_VERSION = 1;

interface StoredLists {
  version: typeof FILE_VERSION;
  // By vendor and directory, most recent first.
  lists: { vendor: Vendor; directory: string; commands: NativeCommand[] }[];
}

function isNativeCommand(value: unknown): value is NativeCommand {
  if (typeof value !== 'object' || value === null) return false;
  const command = value as Record<string, unknown>;
  return typeof command.name === 'string' && typeof command.description === 'string'
    && typeof command.invocation === 'string'
    && (command.argumentHint === undefined || typeof command.argumentHint === 'string');
}

const listsFile = cachedJsonFile<StoredLists>('native-commands.json', stored => {
  const read = stored as Partial<StoredLists> | null;
  const lists = read?.version === FILE_VERSION && Array.isArray(read.lists) ? read.lists : [];
  return {
    version: FILE_VERSION,
    lists: lists.filter(list => VENDORS.includes(list.vendor)
      && typeof list.directory === 'string'
      && Array.isArray(list.commands) && list.commands.every(isNativeCommand)),
  };
});

// Keeps what a runtime in the directory just reported.
export function rememberNativeCommands(vendor: Vendor, directory: string, commands: readonly NativeCommand[]): void {
  const resolved = path.resolve(directory);
  const lists = listsFile.read().lists.filter(list => !(list.vendor === vendor && list.directory === resolved));
  lists.unshift({ vendor, directory: resolved, commands: [...commands] });
  listsFile.write({ version: FILE_VERSION, lists: lists.slice(0, KEPT_LISTS) });
}

// The commands a participant of the vendor, running in the directory, last
// said it offers; empty before any runtime there has reported.
export function nativeCommands(vendor: Vendor, directory: string): NativeCommand[] {
  const resolved = path.resolve(directory);
  return listsFile.read().lists.find(list => list.vendor === vendor && list.directory === resolved)?.commands ?? [];
}

// A prompt that opens with `/name` for one of the vendor's commands, in the
// vendor's own words; any other prompt as it is. Only a Codex skill reads
// differently: `$name`.
export function nativePrompt(text: string, vendor: Vendor, directory: string): string {
  const match = /^\/(\S+)/.exec(text);
  if (!match) return text;
  const command = nativeCommands(vendor, directory).find(candidate => candidate.name === match[1]);
  return command ? command.invocation + text.slice(match[0].length) : text;
}
