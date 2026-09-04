import type { CommandSpec } from '../types';

// Every key the app answers to, in the words the status hints use.
export const KEY_BINDINGS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ['enter', 'send · while an agent is working the message is queued'],
  ['shift+enter · \\ + enter', 'new line (option+enter where shift+enter is not reported)'],
  ['↑ / ↓', 'previous / next prompt · move between the lines of a long one'],
  ['shift+↑ / ↓', 'switch session (ctrl or option work too)'],
  ['ctrl+n', 'new session'],
  ['shift+tab', 'cycle the permission mode'],
  ['esc', 'cancel the turn and drop queued messages'],
  ['pgup / pgdn · home / end', 'scroll the history'],
  ['y / a / n', 'approval prompt: allow once · allow for this session · deny'],
  ['ctrl+u · ctrl+w', 'clear the line · delete the previous word'],
];

export function helpText(commands: readonly CommandSpec[]): string {
  const labels = commands.map(command => `/${command.name}${command.args ? ` ${command.args}` : ''}`);
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
    description: 'list commands and keyboard shortcuts',
    run: args => {
      if (args.length > 0) throw new Error('Usage: /help');
      return { kind: 'info', text: helpText(commands()), showIcon: false };
    },
  };
}
