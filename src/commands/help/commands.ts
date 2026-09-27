import type { CommandSpec } from '../types';

// Every key the app answers to, in the words the status hints use.
export const KEY_BINDINGS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ['enter / tab', 'send or steer / queue for after the turn'],
  ['shift+enter · alt+enter · \\ + enter', 'new line'],
  ['↑ / ↓', 'visual rows, then queue and directory history'],
  ['enter / esc in queue edit', 'save / restore the original'],
  ['option+↑ / ↓', 'switch session'],
  ['ctrl+n', 'focus the empty draft'],
  ['sidebar: type · ctrl+r / a / d', 'filter · rename / archive / delete'],
  ['resume: tab', 'toggle this project / all projects'],
  ['ctrl+b', 'collapse the sidebar'],
  ['ctrl+t', 'show / hide tasks'],
  ['? on empty input', 'shortcuts · ↑/↓ scroll · esc closes'],
  ['ctrl+r', 'search directory history · ctrl+r/s older/newer'],
  ['enter / esc in history search', 'select match / restore draft'],
  ['ctrl+g · ctrl+x ctrl+e', 'edit draft in $VISUAL or $EDITOR'],
  ['ctrl+v', 'attach a clipboard image'],
  ['@ · ↑ / ↓ · tab / enter', 'find and mention a project file'],
  ['backspace over an image', 'remove it'],
  ['shift+tab', 'switch ask / auto; choose bypass through /permissions'],
  ['esc', 'close menu · restore queue edit · decline card · cancel turn'],
  ['esc twice', 'clear draft (↑ recalls) · empty draft opens /rewind'],
  ['ctrl+c', 'interrupt · clear draft · press again within 1s to exit'],
  ['pgup / pgdn · ctrl+home / end', 'scroll the history'],
  ['y / a / n / d', 'answer approval options · tab adds rejection feedback'],
  ['home / end · ctrl+a / e', 'move to start / end of line'],
  ['alt+b / f · alt+← / →', 'move one word'],
  ['delete · ctrl+d', 'delete the next character'],
  ['ctrl+k / u', 'kill to end / start of line'],
  ['ctrl+w · alt+backspace / d', 'kill previous / next word'],
  ['ctrl+y · ctrl+_', 'yank killed text / undo an edit'],
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
    description: 'list commands and keys',
    run: args => {
      if (args.length > 0) throw new Error('Usage: /help');
      return { kind: 'info', text: helpText(commands()), showIcon: false, panel: true };
    },
  };
}
