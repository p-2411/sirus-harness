import type { Session } from '../agent_runtime/session';
import type { Feedback } from './feedback';

export type CommandResult = void | Feedback | Promise<void | Feedback>;

export interface CommandMenuHeading {
  type: 'heading';
  key: string;
  label: string;
}

export interface CommandMenuItem {
  type: 'item';
  key: string;
  label: string;
  description?: string;
  command: string;
  secret?: { prompt: string };
}

export type CommandMenuEntry = CommandMenuHeading | CommandMenuItem;

// Everything a command may act on during one invocation. Callers provide the
// complete boundary, so commands never silently fall back when a dependency is
// missing.
export interface CommandExecution {
  session: Session;
  setSirusModel: (model: string) => void;
  notify: (text: string) => void;
  signal: AbortSignal;
}

export interface CommandSpec {
  name: string;
  args?: string;
  description: string;
  // Returned feedback is shown after completion; notify shows interim info
  // while a long command such as browser login is still running.
  run: (args: string[], execution: CommandExecution) => CommandResult;
  // Picking a menu item sends its command text, plus any secret entered.
  // Null means the command should run directly.
  menu?: (args: readonly string[]) => CommandMenuEntry[] | null;
}
