import path from 'path';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { dataDirectory } from '../../dataDirectory';
import { cachedJsonFile } from '../../persistence/atomicJson';
import { VENDOR_INFO, VENDORS, type Vendor } from '../providers/catalog';

// Slash commands are the vendors' own. Each runtime reports what its harness
// offers in `available_commands_update` — Claude Code's built-ins, the user's
// and the project's skills and commands, the enabled plugins'; Codex's
// built-ins and its skills — and the `/` menu lists that after Sirus's own
// commands, tagged with the vendor. A command the user picks goes to the
// participant as prompt text, the way the vendor's own terminal would send
// it; one Sirus has a command of the same name for is reached with the
// vendor's prefix, `/claude:agents` or `/codex:status`.
//
// A command that only reports (`/context`, `/mcp`) needs no model, and run in
// the conversation it would become a turn, a checkpoint and part of the
// record every later prompt carries. Those run on a throwaway fork of the
// participant's runtime instead (`SessionAgent.runAside`), and what they
// print is shown and kept nowhere.
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
  // Whose command it is. Filled in as a list is read; never stored.
  vendor?: Vendor;
}

// Listed by a vendor, but not for the user of this client: Claude's
// internal session commands, and the ones that would change behind Sirus's
// back what Sirus keeps: `/effort` the level behind `/thinking`, `/model` the
// participant's model, `/login` and `/logout` its credentials.
const HIDDEN = new Set([
  'effort', 'heapdump', 'workflow-launch-exec', 'design-consent', 'design-revoke', 'model', 'login', 'logout',
]);

// The vendors' commands that only report and need no model, run aside when
// they take no arguments. `/mcp reconnect`, `/config key=value` and the like
// act on the session, so with arguments these go to it as a turn.
const REPORTING: Record<Vendor, ReadonlySet<string>> = {
  claude: new Set(['context', 'mcp', 'status', 'usage', 'cost', 'config', 'skill-doctor', 'list-agents', 'doctor', 'release-notes', 'stats']),
  gpt: new Set(['status', 'mcp', 'skills']),
};

export function isReportingCommand(vendor: Vendor, name: string, args: string): boolean {
  return REPORTING[vendor].has(name) && args.trim() === '';
}

const VENDOR_PREFIXES = new Map(VENDORS.map(vendor => [VENDOR_INFO[vendor].command, vendor]));

// `/claude:agents` → the vendor and the command's own name; null for a name
// with no vendor prefix. Claude's plugin commands carry colons of their own
// (`vercel:deploy`), so only a vendor's command word counts as a prefix.
export function vendorPrefixed(name: string): { vendor: Vendor; name: string } | null {
  const colon = name.indexOf(':');
  if (colon <= 0) return null;
  const vendor = VENDOR_PREFIXES.get(name.slice(0, colon).toLocaleLowerCase());
  return vendor && colon < name.length - 1 ? { vendor, name: name.slice(colon + 1) } : null;
}

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

function isWellFormedCommand(value: unknown): value is NativeCommand {
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
      && Array.isArray(list.commands) && list.commands.every(isWellFormedCommand)),
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
  const list = listsFile.read().lists.find(candidate => candidate.vendor === vendor && candidate.directory === resolved);
  return (list?.commands ?? []).filter(command => !HIDDEN.has(command.name)).map(command => ({ ...command, vendor }));
}

// What a participant is sent for a prompt that opens with a `/command`: for
// one of Sirus's own prompt commands its full prompt, for one of the
// vendor's the vendor's own words (a Codex skill reads `$name`, and a vendor
// prefix is dropped), and any other prompt as it is. `/review` is Codex's
// own where the vendor has one, since it runs Codex's dedicated review.
export function nativePrompt(text: string, vendor: Vendor, directory: string): string {
  const match = /^\/(\S+)/.exec(text);
  if (!match) return text;
  const rest = text.slice(match[0].length);
  const prefixed = vendorPrefixed(match[1]);
  const name = prefixed?.vendor === vendor ? prefixed.name : match[1];
  const command = nativeCommands(vendor, directory).find(candidate => candidate.name === name);
  if (!prefixed && match[1] === 'init') return promptWith(INIT_PROMPT, rest);
  if (!prefixed && match[1] === 'review' && !command) return promptWith(REVIEW_PROMPT, rest);
  return command ? command.invocation + rest : text;
}

function promptWith(prompt: string, instructions: string): string {
  const extra = instructions.trim();
  return extra ? `${prompt}\n\nThe user added: ${extra}` : prompt;
}

// Sirus's `/init`: one instruction file both vendors follow. Codex reads
// AGENTS.md and Claude Code reads CLAUDE.md, which can import another file
// with an `@path` line, so AGENTS.md holds the instructions and CLAUDE.md
// imports it. The command makes sure of the import once the turn is over.
const INIT_PROMPT = `Set up this repository's agent instructions so every coding agent that works here, Codex and Claude Code alike, follows one file.

Study the repository before writing anything: its README and docs, its build, lint and test configuration, its layout, and a sample of its source. Then write AGENTS.md in the current working directory as a concise guide (roughly 200 to 500 words) for an agent starting work here:
- how to build, run, lint and test, including how to run a single test;
- the architecture a newcomer needs several files to piece together, not a listing of every directory;
- the conventions the code actually follows: naming, style, error handling, commit messages;
- anything easy to get wrong here.
State only what the repository shows; do not invent commands or generic advice.

If AGENTS.md already exists, improve it rather than starting over. If a CLAUDE.md holds instructions, fold them into AGENTS.md, keeping anything that applies only to Claude Code in CLAUDE.md. Finally make sure CLAUDE.md exists beside it and its first line is \`@AGENTS.md\`, so Claude Code imports the same instructions.

End with a short summary of what you wrote.`;

// Sirus's `/review` for a vendor without one of its own: the working tree
// against HEAD, the way Codex's `/review` reviews uncommitted changes.
const REVIEW_PROMPT = `Review the current code changes in this repository: the uncommitted changes, staged and unstaged, and any untracked files, against HEAD. If there are none, review the most recent commit. Read the surrounding code as needed to judge them. Do not modify any files.

Report the problems a careful reviewer would block on, most serious first: bugs, incorrect behaviour, regressions, security issues, missed edge cases, and changes that contradict the code around them. For each finding give the file and line, what is wrong, why it matters, and a concrete fix, marking it P0 (must fix) to P3 (nit). Leave out style preferences the codebase does not itself enforce. If you find nothing worth blocking on, say so plainly, then close with an overall verdict on whether the change is correct.`;
