import {
  loadMemoryAccessPreference,
  saveMemoryAccessPreference,
} from '../data/persistence';

export function isMemoryAccessEnabled(): boolean {
  return loadMemoryAccessPreference();
}

export function setMemoryAccessEnabled(enabled: boolean): void {
  if (!saveMemoryAccessPreference(enabled)) {
    throw new Error('Could not save the memory access setting');
  }
}
