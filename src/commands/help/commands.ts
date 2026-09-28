import { commandUsage, type CommandSpec } from '../types';

// Every key the app answers to, in the words the status hints use.
export const KEY_BINDINGS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ['enter', 'send · while working, queue for the next tool boundary or turn end'],
  ['ctrl+enter · ctrl+x ctrl+s', 'send queued messages and the draft now'],
  ['tab', 'complete the highlighted command or mention'],
  ['shift+enter · alt+enter · \\ + enter', 'new line'],
  ['/ · ↑ / ↓ · tab / enter', 'command menu: choose · complete · run'],
  ['↑ / ↓', 'visual rows, then directory history'],
  ['↑ while messages are queued', 'take them back into the draft to edit, one per line'],
  ['↓ past the last line', 'worker strip: ↑ / ↓ choose · enter opens · esc returns'],
  ['option+↑ / ↓', 'switch session'],
  ['← / →', 'switch agent when a task has multiple agents'],
  ['ctrl+n', 'focus the empty draft'],
  ['ctrl+f', 'manage sessions'],
  ['sidebar: search · ctrl+a', 'find sessions · archive selected session'],
  ['resume: tab', 'toggle this project / all projects'],
  ['ctrl+b', 'collapse the sidebar'],
  ['ctrl+t', 'show / hide the pinned task list'],
  ['? on empty input', 'shortcuts · ↑/↓ scroll · esc closes'],
  ['ctrl+r', 'search directory history · ctrl+r/s older/newer'],
  ['enter / esc in history search', 'select match / restore draft'],
  ['ctrl+g · ctrl+x ctrl+e', 'edit draft in $VISUAL or $EDITOR'],
  ['paste', 'insert text or attach an image'],
  ['@ · ↑ / ↓ · tab / enter', 'find and mention a project file'],
  ['backspace over an image', 'remove it'],
  ['shift+tab', 'cycle ask / auto / bypass'],
  ['esc', 'close menu/panel · decline card · interrupt and send queued messages'],
  ['esc twice', 'clear draft (↑ recalls) · empty draft opens /rewind'],
  ['ctrl+c', 'interrupt · clear draft · press again within 1s to exit'],
  ['pgup / pgdn · ctrl+home / end · wheel', 'scroll the history or a panel'],
  ['y / a / n / d', 'answer approval options · tab adds rejection feedback'],
  ['question: 1–9 · space · tab · shift+tab / ←', 'choose · toggle a choice · submit choices · previous question'],
  ['home / end · ctrl+a / e', 'move to start / end of line'],
  ['alt+b / f · alt+← / →', 'move one word'],
  ['delete · ctrl+d', 'delete the next character'],
  ['ctrl+k / u', 'kill to end / start of line'],
  ['ctrl+w · alt+backspace / d', 'kill previous / next word'],
  ['ctrl+y · ctrl+_', 'yank killed text / undo an edit'],
];

// What the mouse does, what the strip is, and how the vendors' own commands
// are reached: one note per line, wrapped by the panel.
export const HELP_NOTES: readonly string[] = [
  'Click a tool call, a "Ran N commands" group, a plan, a thought or a "context compacted" rule to open or close it.',
  'Click a session in the sidebar to open it; drag across any text to copy it.',
  'The worker strip above the status row shows the background workers; /agents lists and steers them.',
  'The status row describes the selected agent: its context, model and thinking level.',
  'The / menu also lists the agents\' own commands, tagged (claude) or (codex).',
  'One that shares a Sirus command\'s name is reached with the vendor\'s prefix: /claude:agents, /codex:status.',
  'Those that only report, such as /context, run beside the conversation: no turn, checkpoint or history.',
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
    '',
    'mouse and vendor commands',
    ...HELP_NOTES.map(note => `  ${note}`),
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
