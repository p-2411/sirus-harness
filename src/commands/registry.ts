import { agentsCommandSpec, modelCommand, thinkingCommandSpec } from './agents/commands';
import {
  loginCommandSpec,
  logoutCommandSpec,
  usageCommandSpec,
} from './authentication/commands';
import { helpCommand } from './help/commands';
import { memoryCommandSpec } from './memory/commands';
import { jevCommandSpec } from './jev/commands';
import { clearCommand, compactCommandSpec, exitCommand, permissionsCommandSpec, renameCommand } from './session/commands';
import { updateCommandSpec, versionCommandSpec } from './update/commands';
import { rewindCommandSpec, undoCommandSpec } from './checkpoints/commands';
import { imageCommandSpec } from './images/commands';
import { notifyCommandSpec } from './notifications/commands';
import type { NativeCommand } from '../agent_runtime/runtime/commands';
import {
  commandUsage,
  type CommandCapabilities,
  type CommandContext,
  type CommandMenuEntry,
  type CommandResult,
  type CommandSession,
  type CommandSpec,
} from './types';

export type {
  CommandContext,
  CommandMenuEntry,
  CommandMenuItem,
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
  agentsCommandSpec,
  loginCommandSpec,
  logoutCommandSpec,
  usageCommandSpec,
  jevCommandSpec,
  updateCommandSpec,
  versionCommandSpec,
  memoryCommandSpec,
  permissionsCommandSpec,
  undoCommandSpec,
  rewindCommandSpec,
  imageCommandSpec,
  notifyCommandSpec,
  renameCommand,
  helpCommand(() => commandRegistry),
  exitCommand,
];

// Typed (or menu-composed) command text into its name and arguments:
// '/login gpt api' → { name: 'login', args: ['gpt', 'api'] }. The one place
// that splits command text, so the input bar and the secret-menu path can't
// drift apart in how they parse it. `rest` is everything after the name as
// it was typed, runs of spaces and all.
export function parseCommandLine(text: string): { name: string; args: string[]; rest: string } {
  const words = text.split(' ');
  const space = text.indexOf(' ');
  return {
    name: words[0].slice(1),
    args: words.slice(1).filter(Boolean),
    rest: space === -1 ? '' : text.slice(space + 1),
  };
}

// One line of the `/` menu: a Sirus command, or one of the vendor's own
// commands of the participant the prompt goes to.
export interface CommandMatch {
  name: string;
  args?: string;
  description: string;
}

// The vendor commands `/name` reaches. A Sirus command of the same name wins:
// `/model`, `/rename` and `/logout` are Sirus's in both vendors' lists.
export function invocableNativeCommands(commands: readonly NativeCommand[]): NativeCommand[] {
  return commands.filter(command => !commandRegistry.some(spec => spec.name === command.name));
}

// Text that calls one of those commands: sent to the agent as a prompt rather
// than run here.
function isNativeCommand(text: string, commands: readonly NativeCommand[]): boolean {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name !== undefined && invocableNativeCommands(commands).some(command => command.name === name);
}

// Text the chat runs as one of Sirus's commands: any `/` line but one that
// calls a vendor command. The chat's send and the input bar's menus both go
// by this one test.
export function isSirusCommand(text: string, nativeCommands: readonly NativeCommand[]): boolean {
  return text.startsWith('/') && !isNativeCommand(text, nativeCommands);
}

// Prefix matches while a command name is being typed ('/' alone matches
// everything); none once args have begun or the text isn't a command at all.
// Sirus's commands come first, then the vendor's.
export function matchCommands(input: string, commands: readonly NativeCommand[] = []): CommandMatch[] {
  if (!input.startsWith('/')) return [];
  const typed = input.slice(1);
  if (typed.includes(' ')) return [];
  return [
    ...commandRegistry.filter(spec => spec.name.startsWith(typed)),
    ...invocableNativeCommands(commands)
      .filter(command => command.name.startsWith(typed))
      .map(command => ({
        name: command.name,
        ...(command.argumentHint ? { args: command.argumentHint } : {}),
        description: command.description,
      })),
  ];
}

export function commandMenu(
  command: string,
  args: readonly string[],
  session: CommandSession,
): CommandMenuEntry[] | null {
  const spec = commandRegistry.find(spec => spec.name === command);
  return spec?.menu ? spec.menu(args, session) : null;
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
