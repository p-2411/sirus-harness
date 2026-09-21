import { saveJevApiKey } from '../../persistence';
import { JEV_API_KEY_ENV, jevApiKey, jevKeySource } from '../../agent_runtime/router';
import { maskApiKey } from '../../agent_runtime/providers/sources';
import type { Feedback } from '../feedback';
import type { CommandMenuEntry, CommandSpec } from '../types';

// `/jev` is where the TypeSafe AI key lives: the menu shows whether Jev is
// routing and offers to paste a key or remove the stored one. A key in the
// environment is not Sirus's to remove, so the menu says where it comes from
// instead of offering that.

const KEY_PROMPT = 'TypeSafe AI API key';

function status(): string {
  const source = jevKeySource();
  if (source === 'env') return `Jev is on, with the key from ${JEV_API_KEY_ENV} in the environment.`;
  if (source === 'settings') return `Jev is on, with the key ${maskApiKey(jevApiKey()!)}.`;
  return 'Jev is off: sessions and subagents stay on their default models.';
}

export function jevMenuItems(args: readonly string[] = []): CommandMenuEntry[] | null {
  if (args.length > 0) return null;
  const source = jevKeySource();
  return [
    { type: 'heading', key: 'status', label: status() },
    {
      type: 'item',
      key: 'key',
      label: source ? 'Replace API key' : 'Set API key',
      description: 'paste a TypeSafe AI API key; Jev then picks models per task',
      command: '/jev key',
      secret: { prompt: KEY_PROMPT },
    },
    ...(source === 'settings' ? [{
      type: 'item' as const,
      key: 'off',
      label: 'Remove key',
      description: 'stop routing with Jev',
      command: '/jev off',
    }] : []),
  ];
}

export function jevCommand(args: readonly string[]): Feedback {
  if (args.length === 0) return { kind: 'info', text: status() };
  if (args[0] === 'key' && args.length === 2) {
    const key = args[1].trim();
    if (!key) throw new Error('Usage: /jev key <key>');
    if (!saveJevApiKey(key)) return { kind: 'error', text: 'The key could not be saved.' };
    return { kind: 'success', text: `Saved TypeSafe AI key ${maskApiKey(key)}. Jev now picks models per task.` };
  }
  if (args[0] === 'off' && args.length === 1) {
    if (jevKeySource() === 'env') {
      throw new Error(`The key comes from ${JEV_API_KEY_ENV} in the environment; unset it there to turn Jev off.`);
    }
    if (!saveJevApiKey(null)) return { kind: 'error', text: 'The key could not be removed.' };
    return { kind: 'success', text: 'Removed the TypeSafe AI key. Jev is off.' };
  }
  throw new Error('Usage: /jev [key <key>|off]');
}

export const jevCommandSpec: CommandSpec = {
  name: 'jev',
  args: '[key <key>|off]',
  description: 'set or remove the TypeSafe AI key Jev routes with',
  run: args => jevCommand(args),
  menu: jevMenuItems,
};
