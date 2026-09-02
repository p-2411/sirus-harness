import {
  changeModel,
  clearSession,
  infoCommand,
  loginCommand,
  loginMenuItems,
  logoutCommand,
  memoryCommand,
  permissionsCommand,
  permissionsMenuItems,
  thinkingCommand,
  thinkingMenuItems,
  type CommandMenuItem,
} from './commands';
import { Session } from '../runtime/session';
import type { Feedback } from '../feedback';

export type CommandResult = void | Feedback | Promise<void | Feedback>;

export { loginMenuItems, type CommandMenuItem };

export interface CommandSpec {
  name: string;
  args?: string;
  description: string;
  // Returned feedback is shown after completion; `notify` shows interim info
  // while a long command (like a browser login) is still running.
  run: (
    args: string[],
    session: Session,
    notify: (text: string) => void,
    signal?: AbortSignal,
    context?: CommandContext,
  ) => CommandResult;
  // When this returns choices for the typed args, the input bar shows them
  // instead of running the command; picking one sends its `command` text
  // (plus any secret entered). Null means run the command directly.
  menu?: (args: readonly string[]) => CommandMenuItem[] | null;
}

export interface CommandContext {
  changeSirusModel?: (model: string) => void;
}

// Single source of truth for commands: the input-bar menu and the executor
// both read from here, so a new command only needs a new entry.
export const commandRegistry: CommandSpec[] = [
  {
    name: 'model',
    args: '[agent] <model>',
    description: 'set the model for an agent in the session',
    run: (args, session, _notify, _signal, context) => {
      if (args.length === 1) {
        return changeModel('sirus', args[0], session, context?.changeSirusModel);
      } else if (args.length === 2) {
        return changeModel(args[0], args[1], session, context?.changeSirusModel);
      } else {
        throw new Error('Usage: /model [name] <model>');
      }
    },
  },
  {
    name: 'clear',
    description: 'clear this session history',
    run: (_args, session) => clearSession(session),
  },
  {
    name: 'thinking',
    args: '[agent] [low|medium|high|xhigh|max]',
    description: 'show or set reasoning depth for a participant',
    run: (args, session) => thinkingCommand(args, session),
    menu: thinkingMenuItems,
  },
  {
    name: 'login',
    args: '[claude|gpt] [subscription|api <key>]',
    description: 'sign in with a subscription or an API key',
    run: (args, _session, notify, signal) => loginCommand(args, notify, signal),
    menu: loginMenuItems,
  },
  {
    name: 'logout',
    args: '<claude|gpt>',
    description: 'sign out of the subscription or stored API key for a provider',
    run: args => logoutCommand(args[0]),
  },
  {
    name: 'info',
    description: 'show how each provider is signed in',
    run: (_args, _session, _notify, signal) => infoCommand(signal),
  },
  {
    name: 'memory',
    args: '[on|off]',
    description: 'show or toggle agent access to persistent memory',
    run: args => memoryCommand(args[0]),
  },
  {
    name: 'permissions',
    args: '[ask|auto|bypass]',
    description: 'show or set how this session approves tool calls',
    run: (args, session) => permissionsCommand(args[0], session),
    menu: args => args.length === 0 ? permissionsMenuItems() : null,
  },
];

// Prefix matches while a command name is being typed ('/' alone matches
// everything); none once args have begun or the text isn't a command at all.
export function matchCommands(input: string): CommandSpec[] {
  if (!input.startsWith('/')) return [];
  const typed = input.slice(1);
  if (typed.includes(' ')) return [];
  return commandRegistry.filter(spec => spec.name.startsWith(typed));
}

// The choices a command offers for these args, or null when it runs directly.
export function commandMenu(command: string, args: readonly string[]): CommandMenuItem[] | null {
  const spec = commandRegistry.find(spec => spec.name === command);
  return spec?.menu ? spec.menu(args) : null;
}

export function executeCommand(
  command: string,
  args: string[],
  session: Session,
  notify: (text: string) => void = () => void 0,
  signal?: AbortSignal,
  context?: CommandContext,
): CommandResult {
  const spec = commandRegistry.find(spec => spec.name === command);
  if (!spec) {
    throw new Error(`Unknown command: /${command}`);
  }
  return spec.run(args, session, notify, signal, context);
}
