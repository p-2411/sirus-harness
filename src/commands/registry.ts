import { modelCommand, thinkingCommandSpec } from './agents/commands';
import {
  loginCommandSpec,
  logoutCommandSpec,
  usageCommandSpec,
} from './authentication/commands';
import { helpCommand } from './help/commands';
import { memoryCommandSpec } from './memory/commands';
import { clearCommand, exitCommand, permissionsCommandSpec, renameCommand } from './session/commands';
import { updateCommandSpec, versionCommandSpec } from './update/commands';
import { rewindCommandSpec, undoCommandSpec } from './checkpoints/commands';
import { imageCommandSpec } from './images/commands';
import { notifyCommandSpec } from './notifications/commands';
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
  thinkingCommandSpec,
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
  helpCommand(() => commandRegistry),
  exitCommand,
];

// Typed (or menu-composed) command text into its name and arguments:
// '/login gpt api' → { name: 'login', args: ['gpt', 'api'] }. The one place
// that splits command text, so the input bar and the secret-menu path can't
// drift apart in how they parse it.
export function parseCommandLine(text: string): { name: string; args: string[] } {
  const words = text.split(' ');
  return { name: words[0].slice(1), args: words.slice(1).filter(Boolean) };
}

// Prefix matches while a command name is being typed ('/' alone matches
// everything); none once args have begun or the text isn't a command at all.
export function matchCommands(input: string): CommandSpec[] {
  if (!input.startsWith('/')) return [];
  const typed = input.slice(1);
  if (typed.includes(' ')) return [];
  return commandRegistry.filter(spec => spec.name.startsWith(typed));
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
