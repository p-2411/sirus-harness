import { isMemoryAccessEnabled, setMemoryAccessEnabled } from '../../agent_runtime/memory-access';
import { resetAllRuntimes } from '../../agent_runtime/providers';
import type { Feedback } from '../feedback';
import type { CommandSpec } from '../types';

function memoryCommand(mode: string | undefined): Feedback {
  if (mode === undefined) {
    return {
      kind: 'info',
      text: `Memory access is ${isMemoryAccessEnabled() ? 'on' : 'off'}.`,
    };
  }
  if (mode !== 'on' && mode !== 'off') {
    throw new Error('Usage: /memory [on|off]');
  }

  const enabled = mode === 'on';
  const changed = isMemoryAccessEnabled() !== enabled;
  setMemoryAccessEnabled(enabled);
  if (changed) resetAllRuntimes();
  return {
    kind: 'success',
    text: `Memory access set to ${mode}.`,
  };
}

export const memoryCommandSpec: CommandSpec = {
  name: 'memory',
  args: '[on|off]',
  description: 'show or set agent access to memory',
  run: args => memoryCommand(args[0]),
};
