import { tasksCommandSpec } from './tasks/commands';
import { agentsCommandSpec, modelCommand, thinkingCommandSpec } from './agents/commands';
import {
  loginCommandSpec,
  logoutCommandSpec,
  usageCommandSpec,
} from './authentication/commands';
import { helpCommand } from './help/commands';
import { memoryCommandSpec } from './memory/commands';
import { newCommand, resumeCommand, archiveCommand, deleteCommand, forkCommand, exportCommand, copyCommand, clearCommand, compactCommandSpec, exitCommand, quitCommand, permissionsCommandSpec, renameCommand } from './session/commands';
import { updateCommandSpec, versionCommandSpec } from './update/commands';
import { rewindCommandSpec, undoCommandSpec } from './checkpoints/commands';
import { imageCommandSpec } from './images/commands';
import { notifyCommandSpec } from './notifications/commands';
import type { NativeCommand } from '../agent_runtime/runtime/commands';
import type {
  CommandCapabilities,
  CommandContext,
  CommandMenuEntry,
  CommandResult,
  CommandSession,
  CommandSpec,
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
  tasksCommandSpec,
  loginCommandSpec,
  logoutCommandSpec,
  usageCommandSpec,
  updateCommandSpec,
  versionCommandSpec,
  memoryCommandSpec,
  permissionsCommandSpec,
  undoCommandSpec,
  rewindCommandSpec,
  imageCommandSpec,
  notifyCommandSpec,
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
// drift apart in how they parse it.
export function parseCommandLine(text: string): { name: string; args: string[] } {
  const words = text.trim().split(/\s+/);
  return { name: words[0].slice(1), args: words.slice(1).filter(Boolean) };
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
export function isNativeCommand(text: string, commands: readonly NativeCommand[]): boolean {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name !== undefined && invocableNativeCommands(commands).some(command => command.name === name);
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
  return spec.run(args, context);
}
