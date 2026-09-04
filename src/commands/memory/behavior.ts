import { isMemoryAccessEnabled, setMemoryAccessEnabled } from '../../agent_runtime/memory-access';
import { resetAllRuntimes } from '../../agent_runtime/providers/providers';
import type { Feedback } from '../feedback';

export function memoryCommand(mode: string | undefined): Feedback {
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
    text: `Memory access ${enabled ? 'enabled' : 'disabled'}. Stored memories were not changed.`,
  };
}
