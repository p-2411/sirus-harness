import { getDefaultMemoryStore, type MemoryLink } from './store';
export type { Memory, MemoryLink, MemoryScope, MemorySearchResult, MemorySearchScope } from './store';

// Compatibility functions for callers of the original graph module. These
// preserve its original global-only behavior while the scoped store powers
// the agent tools.
export function addMemory(name: string, content: string, links: string[] = []) {
  return getDefaultMemoryStore().addMemory('global', process.cwd(), name, content, globalLinks(links));
}

export function deleteMemory(name: string) {
  return getDefaultMemoryStore().deleteMemory('global', process.cwd(), name);
}

export function updateMemory(name: string, content: string, links: string[] = []) {
  return getDefaultMemoryStore().updateMemory('global', process.cwd(), name, content, globalLinks(links));
}

export function getMemory(name: string) {
  return getDefaultMemoryStore().getMemory('global', process.cwd(), name);
}

export function searchMemories(query: string, limit = 5) {
  return getDefaultMemoryStore().searchMemories('global', process.cwd(), query, limit);
}

function globalLinks(names: string[]): MemoryLink[] {
  return names.map(name => ({ scope: 'global', name }));
}
