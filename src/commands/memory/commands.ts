import { isMemoryAccessEnabled, setMemoryAccessEnabled } from '../../agent_runtime/memory-access';
import { invalidateAllRuntimes } from '../../agent_runtime/runtime/runtime';
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
  // The system prompt changed under every runtime; each starts afresh.
  if (changed) invalidateAllRuntimes();
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
