import { doctorCommandSpec } from './doctor/commands';
import { tasksCommandSpec } from './tasks/commands';
import { agentsCommandSpec, modelCommand, thinkingCommandSpec } from './agents/commands';
import {
  loginCommandSpec,
  logoutCommandSpec,
  usageCommandSpec,
} from './authentication/commands';
import { configCommandSpec } from './config/commands';
import { helpCommand } from './help/commands';
import { memoryCommandSpec } from './memory/commands';
import { initCommand, reviewCommand } from './project/commands';
import { newCommand, resumeCommand, archiveCommand, deleteCommand, forkCommand, exportCommand, copyCommand, clearCommand, compactCommandSpec, exitCommand, quitCommand, mcpCommandSpec, permissionsCommandSpec, renameCommand, statusCommandSpec } from './session/commands';
import { updateCommandSpec, versionCommandSpec } from './update/commands';
import { rewindCommandSpec, undoCommandSpec } from './checkpoints/commands';
import { imageCommandSpec } from './images/commands';
import { notifyCommandSpec } from './notifications/commands';
import { rcCommandSpec } from './remote/commands';
import { isAutoSendable } from '../agent_runtime/session/messageQueue';
import { commandUsage } from './types';
import { VENDOR_INFO, type Vendor } from '../agent_runtime/providers/catalog';
import { isReportingCommand, vendorPrefixed, type NativeCommand } from '../agent_runtime/runtime/commands';
import type { MessageBlock } from '../agent_runtime/types';
import { rootTextRanges } from '../mentions';
import type {
  CommandCapabilities,
  CommandContext,
  CommandMenuResult,
  CommandResult,
  CommandSession,
  CommandSpec,
} from './types';

export type {
  CommandContext,
  CommandMenuEntry,
  CommandMenuItem,
  CommandMenuResult,
  CommandResult,
  CommandSession,
  CommandSpec,
} from './types';

// The input menu and executor share this registry. Definitions are assembled
// explicitly to keep the user-visible order independent of domain grouping.
export const commandRegistry: readonly CommandSpec[] = [
  modelCommand,
  clearCommand,
  compactCommandSpec,
  thinkingCommandSpec,
  initCommand,
  reviewCommand,
  statusCommandSpec,
  agentsCommandSpec,
  tasksCommandSpec,
  mcpCommandSpec,
  loginCommandSpec,
  logoutCommandSpec,
  usageCommandSpec,
  configCommandSpec,
  updateCommandSpec,
  versionCommandSpec,
  doctorCommandSpec,
  memoryCommandSpec,
  permissionsCommandSpec,
  undoCommandSpec,
  rewindCommandSpec,
  imageCommandSpec,
  notifyCommandSpec,
  rcCommandSpec,
  renameCommand,
  newCommand,
  resumeCommand,
  archiveCommand,
  deleteCommand,
  forkCommand,
  exportCommand,
  copyCommand,

  helpCommand(() => commandRegistry),
  exitCommand,
  quitCommand,
];

// Typed (or menu-composed) command text into its name and arguments:
// '/login gpt api' → { name: 'login', args: ['gpt', 'api'] }. The one place
// that splits command text, so the input bar and the secret-menu path can't
// drift apart in how they parse it. Words are split on any run of
// whitespace; `rest` is everything after the name as it was typed, runs of
// spaces and all.
export function parseCommandLine(text: string): { name: string; args: string[]; rest: string } {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  const space = trimmed.search(/\s/);
  return {
    name: words[0].slice(1),
    args: words.slice(1).filter(Boolean),
    rest: space === -1 ? '' : trimmed.slice(space + 1),
  };
}

// A command of Sirus's written in a prompt, with the arguments it took.
export interface PromptCommand {
  name: string;
  args: string[];
  // What it took after its name, as typed (see CommandContext.argumentText).
  argumentText: string;
  // `/name args` as typed, and where it sits in the prompt.
  text: string;
  start: number;
  end: number;
}

export interface PromptParts {
  // Sirus's commands, in the order they were written.
  commands: PromptCommand[];
  // What goes to the agents: the prompt without those commands, and with a
  // vendor command called after its start moved to its front.
  prompt: string;
  // What was taken out of the text, in order, and the vendor command put
  // before the rest, so promptContent can make the same cut in a draft's
  // blocks.
  cuts: { start: number; end: number }[];
  lead: string;
}

// `/name` at the start of the text or after whitespace, and followed by
// whitespace or the end, so /tmp/x, and/or and `/usage.` stay prose.
const COMMAND_WORD = /(?<!\S)\/([^\s/]+)(?=\s|$)/g;

// The one reading of a prompt's commands, wherever they are written. A Sirus
// command takes the words its grammar reads (CommandSpec.takes) and is
// applied; the rest is the prompt. Past the prompt's start a command counts
// only in prose, not in code, quotes or other markdown examples, the places
// @mentions do not route from either, and a standalone command not at all.
// Claude Code and Codex read a command only at a prompt's start, so the
// prompt's first vendor command, written later, is moved there, the rest
// becoming its arguments: `tidy the parser /simplify` is sent as
// `/simplify tidy the parser`. Unknown names are prose.
export function splitPrompt(
  text: string,
  nativeCommands: readonly NativeCommand[],
  session: CommandSession,
): PromptParts {
  const ranges = rootTextRanges(text);
  const inProse = (index: number) => ranges.some(range => index >= range.start && index < range.end);
  const commands: PromptCommand[] = [];
  let vendor: { start: number; end: number } | undefined;
  let vendorSeen = false;
  let scanned = 0;
  for (const match of text.matchAll(COMMAND_WORD)) {
    const start = match.index;
    const leading = text.slice(0, start).trim() === '';
    if (start < scanned || (!leading && !inProse(start))) continue;
    const spec = commandRegistry.find(candidate => candidate.name === match[1]);
    if (!spec) {
      // Only the prompt's first vendor command is one; one at the start
      // stays where it is.
      if (!vendorSeen && vendorCommandFor(match[0], nativeCommands)) {
        vendorSeen = true;
        if (!leading) vendor = { start, end: start + match[0].length };
      }
      continue;
    }
    if (spec.standalone && !leading) continue;
    const nameEnd = start + match[0].length;
    // The words on the command's line, for its grammar to read.
    const line = text.slice(nameEnd).split('\n')[0];
    const words = [...line.matchAll(/\S+/g)].map(word => ({ text: word[0], end: nameEnd + word.index + word[0].length }));
    const taken = spec.takes ? spec.takes(words.map(word => word.text), session) : spec.args ? undefined : 0;
    const end = taken === undefined ? text.trimEnd().length : taken === 0 ? nameEnd : words[taken - 1].end;
    const { args, rest } = parseCommandLine(text.slice(start, end));
    commands.push({ name: spec.name, args, argumentText: rest, text: text.slice(start, end), start, end });
    scanned = end;
  }
  // Sirus's commands inside the vendor command's arguments are still Sirus's.
  const cuts = [...commands, ...(vendor ? [vendor] : [])]
    .map(({ start, end }) => ({ start, end }))
    .sort((left, right) => left.start - right.start);
  const parts = { commands, prompt: '', cuts, lead: vendor ? text.slice(vendor.start, vendor.end) : '' };
  const [block] = promptContent([{ type: 'text', text }], parts);
  return { ...parts, prompt: block?.type === 'text' ? block.text : '' };
}

// A draft's blocks with the cut splitPrompt made in their text, the text
// blocks read as one string: the commands go, each with the spaces after it,
// and the moved vendor command leads.
export function promptContent(content: readonly MessageBlock[], parts: Pick<PromptParts, 'cuts' | 'lead'>): MessageBlock[] {
  let offset = 0;
  const blocks = content.flatMap((block): MessageBlock[] => {
    if (block.type !== 'text') return [block];
    const start = offset;
    offset += block.text.length;
    let text = '';
    let from = 0;
    for (const cut of parts.cuts) {
      if (cut.end <= start || cut.start >= offset) continue;
      text += block.text.slice(from, Math.max(cut.start - start, from));
      from = Math.max(cut.end - start, from);
      // The spaces after a command go with it, unless it ended a word.
      if (text === '' || /\s$/.test(text)) while (block.text[from] === ' ' || block.text[from] === '\t') from++;
    }
    text += block.text.slice(from);
    return text ? [{ ...block, text }] : [];
  });
  // A cut at either end of the prompt leaves the space before or after it.
  const texts = blocks.flatMap((block, index) => block.type === 'text' ? [index] : []);
  const trimText = (index: number | undefined, trim: (text: string) => string) => {
    const block = index === undefined ? undefined : blocks[index];
    if (block?.type === 'text') blocks[index!] = { ...block, text: trim(block.text) };
  };
  trimText(texts[0], text => text.trimStart());
  trimText(texts.at(-1), text => text.trimEnd());
  const trimmed = blocks.filter(block => block.type !== 'text' || block.text);
  if (!parts.lead) return trimmed;
  const head = trimmed[0];
  return head?.type === 'text'
    ? [{ ...head, text: `${parts.lead} ${head.text}` }, ...trimmed.slice(1)]
    : [{ type: 'text', text: parts.lead }, ...trimmed];
}

// One line of the `/` menu: a Sirus command, or one of the vendors' own
// commands, tagged with the vendor.
export interface CommandMatch {
  name: string;
  args?: string;
  description: string;
  // The vendor's name as typed, for the tag: "(claude)", "(codex)".
  vendor?: string;
}

// The name `/name` reaches each vendor command by: its own, unless a Sirus
// command or an earlier vendor's command has it, in which case the vendor's
// prefix, `/claude:agents` or `/codex:status`. The session lists the vendor
// of the default participant first, so its commands keep their bare names.
export function vendorCommandNames(commands: readonly NativeCommand[]): { name: string; command: NativeCommand }[] {
  const taken = new Set(commandRegistry.map(spec => spec.name));
  return commands.flatMap(command => {
    if (!taken.has(command.name)) {
      taken.add(command.name);
      return [{ name: command.name, command }];
    }
    return command.vendor ? [{ name: `${VENDOR_INFO[command.vendor].command}:${command.name}`, command }] : [];
  });
}

// A vendor command the text calls, as `/name` or `/vendor:name`, with what
// follows it, and whether it only reports and runs aside; null for any
// other text. A prefixed name reaches any of that vendor's commands.
export function vendorCommandFor(text: string, commands: readonly NativeCommand[]): {
  command: NativeCommand;
  vendor?: Vendor;
  args: string;
  reporting: boolean;
} | null {
  const match = /^\/(\S+)/.exec(text);
  if (!match) return null;
  const args = text.slice(match[0].length).trim();
  const prefixed = vendorPrefixed(match[1]);
  const command = prefixed
    ? commands.find(candidate => candidate.vendor === prefixed.vendor && candidate.name === prefixed.name)
    : vendorCommandNames(commands).find(entry => entry.name === match[1])?.command;
  if (!command) return null;
  return {
    command,
    ...(command.vendor ? { vendor: command.vendor } : {}),
    args,
    reporting: command.vendor !== undefined && isReportingCommand(command.vendor, command.name, args),
  };
}

// Text that calls one of those commands: sent to the agent as a prompt, or
// run aside, rather than run here.
export function isNativeCommand(text: string, commands: readonly NativeCommand[]): boolean {
  return vendorCommandFor(text, commands) !== null;
}

// Text the chat runs as one of Sirus's commands: a `/name` line, as the
// queue tells one from a message (a path such as /usr/bin is a message),
// unless it calls a vendor command. The chat's send and the input bar's
// menus both go by this one test.
export function isSirusCommand(text: string, nativeCommands: readonly NativeCommand[]): boolean {
  return !isAutoSendable(text) && !isNativeCommand(text, nativeCommands);
}

// Commands that can run while another turn is active. Native /effort and
// /fast keep their existing immediate behavior without becoming Sirus specs.
const IMMEDIATE_COMMAND_NAMES = new Set([
  'model', 'thinking', 'effort', 'fast', 'status', 'usage', 'mcp',
  'config', 'permissions', 'agents', 'tasks',
]);

export function isImmediateCommand(text: string): boolean {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name !== undefined && IMMEDIATE_COMMAND_NAMES.has(name);
}

// The `/name` being typed where the cursor is: at the start of the draft or
// after whitespace, as splitPrompt reads a command, and running up to the
// cursor. Null anywhere else.
export function commandTokenAt(input: string, cursor: number = input.length): { start: number; end: number; typed: string } | null {
  if (/\S/.test(input[cursor] ?? ' ')) return null;
  const match = /(?<!\S)\/([^\s/]*)$/.exec(input.slice(0, cursor));
  return match ? { start: match.index, end: cursor, typed: match[1] } : null;
}

// Prefix matches while a command name is being typed ('/' alone matches
// everything); none once args have begun or the text isn't a command at all.
// Sirus's commands come first, then the vendors'.
export function matchCommands(input: string, commands: readonly NativeCommand[] = [], cursor: number = input.length): CommandMatch[] {
  const token = commandTokenAt(input, cursor);
  if (!token) return [];
  const typed = token.typed;
  // Past the start of a prompt a standalone command is prose.
  const offered = token.start === 0 ? commandRegistry : commandRegistry.filter(spec => !spec.standalone);
  return [
    ...offered.filter(spec => spec.name.startsWith(typed)),
    ...vendorCommandNames(commands)
      .filter(({ name, command }) => name.startsWith(typed) || command.name.startsWith(typed))
      .map(({ name, command }) => ({
        name,
        ...(command.argumentHint ? { args: command.argumentHint } : {}),
        description: command.description,
        ...(command.vendor ? { vendor: VENDOR_INFO[command.vendor].command } : {}),
      })),
  ];
}

export function commandMenu(
  command: string,
  args: readonly string[],
  session: CommandSession,
  signal?: AbortSignal,
): CommandMenuResult {
  const spec = commandRegistry.find(spec => spec.name === command);
  return spec?.menu ? spec.menu(args, session, signal) : null;
}

export function executeCommand(
  command: string,
  args: readonly string[],
  context: CommandContext & CommandCapabilities,
): CommandResult {
  const spec = commandRegistry.find(spec => spec.name === command);
  if (!spec) throw new Error(`Unknown command: /${command}`);
  // A command that declares no arguments takes none, so `/clear now` is a
  // mistake to point out rather than a /clear.
  if (!spec.args && args.length > 0) throw new Error(`Usage: ${commandUsage(spec)}`);
  return spec.run(args, context);
}
