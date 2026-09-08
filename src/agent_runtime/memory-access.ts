import { openSettings } from '../persistence';

export function isMemoryAccessEnabled(): boolean {
  return openSettings().get('memoryEnabled');
}

export function setMemoryAccessEnabled(enabled: boolean): void {
  if (!openSettings().set({ memoryEnabled: enabled })) {
    throw new Error('Could not save the memory access setting');
  }
}
