import { commandUsage, type CommandSpec } from '../types';

// Every key the app answers to, in the words the status hints use.
const KEY_BINDINGS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ['enter', 'send · queues while the agents are busy'],
  ['shift+enter · \\ + enter', 'new line'],
  ['↑ / ↓', 'previous / next prompt · select a queued message'],
  ['↓ · ↑ / ↓ · enter', 'reach the worker strip · walk it · open a worker'],
  ['option+↑ / ↓', 'switch session'],
  ['ctrl+n', 'new session'],
  ['ctrl+k', 'collapse the sidebar'],
  ['ctrl+v', 'attach a clipboard image'],
  ['tab', 'complete the highlighted command'],
  ['@ · ↑ / ↓ · tab / enter', 'find and mention a project file'],
  ['backspace over an image', 'remove it'],
  ['shift+tab', 'cycle the permission mode'],
  ['esc', 'close menus · cancel the turn'],
  ['pgup / pgdn · home / end', 'scroll the history'],
  ['a choice\'s key', 'answer an approval with the key beside a choice'],
  ['ctrl+u · ctrl+w', 'clear the line · delete the previous word'],
];

function helpText(commands: readonly CommandSpec[]): string {
  const labels = commands.map(commandUsage);
  const column = Math.max(
    ...labels.map(label => label.length),
    ...KEY_BINDINGS.map(([keys]) => keys.length),
  ) + 2;
  return [
    'commands',
    ...commands.map((command, index) => `  ${labels[index].padEnd(column)}${command.description}`),
    '',
    'keys',
    ...KEY_BINDINGS.map(([keys, action]) => `  ${keys.padEnd(column)}${action}`),
  ].join('\n');
}

// The registry hands itself in lazily, so the list includes this command too.
export function helpCommand(commands: () => readonly CommandSpec[]): CommandSpec {
  return {
    name: 'help',
    description: 'list commands and keys',
    run: () => ({ kind: 'info', text: helpText(commands()), showIcon: false, panel: true }),
  };
}
