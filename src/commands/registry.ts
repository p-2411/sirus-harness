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
import type { Session } from '../agent_runtime/session';
import type {
  CommandExecution,
  CommandMenuEntry,
  CommandMenuItem,
  CommandResult,
  CommandSpec,
} from './types';

export { loginMenuItems } from './authentication/behavior';
export type {
  CommandExecution,
  CommandMenuEntry,
  CommandMenuItem,
  CommandResult,
  CommandSpec,
} from './types';

// The input menu and executor share this registry. Definitions are assembled
// explicitly to keep the user-visible order independent of domain grouping.
export const commandRegistry: CommandSpec[] = [
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
  session: Session,
): CommandMenuEntry[] | null {
  const spec = commandRegistry.find(spec => spec.name === command);
  return spec?.menu ? spec.menu(args, session) : null;
}

export function executeCommand(
  command: string,
  args: string[],
  execution: CommandExecution,
): CommandResult {
  const spec = commandRegistry.find(spec => spec.name === command);
  if (!spec) throw new Error(`Unknown command: /${command}`);
  return spec.run(args, execution);
}
