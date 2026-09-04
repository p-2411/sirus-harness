import { getDefaultMemoryStore } from '../../memory/store';
import {
  requiredInteger,
  requiredMemoryLinks,
  requiredMemoryScope,
  requiredMemorySearchScope,
  requiredString,
} from './arguments';

export async function saveMemory(args: Record<string, unknown>, directory: string) {
  return getDefaultMemoryStore().saveMemory(
    requiredMemoryScope(args, 'scope', 'SaveMemory'),
    directory,
    requiredString(args, 'name', 'SaveMemory'),
    requiredString(args, 'content', 'SaveMemory'),
    requiredMemoryLinks(args, 'links', 'SaveMemory'),
  );
}

export function getMemory(args: Record<string, unknown>, directory: string) {
  const scope = requiredMemoryScope(args, 'scope', 'GetMemory');
  const name = requiredString(args, 'name', 'GetMemory');
  const memory = getDefaultMemoryStore().getMemory(scope, directory, name);
  return memory ?? { found: false, scope, name };
}

export async function searchMemories(args: Record<string, unknown>, directory: string) {
  return getDefaultMemoryStore().searchMemories(
    requiredMemorySearchScope(args, 'scope', 'SearchMemories'),
    directory,
    requiredString(args, 'query', 'SearchMemories'),
    requiredInteger(args, 'limit', 'SearchMemories'),
  );
}

export function deleteMemory(args: Record<string, unknown>, directory: string) {
  const scope = requiredMemoryScope(args, 'scope', 'DeleteMemory');
  const name = requiredString(args, 'name', 'DeleteMemory');
  return { scope, name, deleted: getDefaultMemoryStore().deleteMemory(scope, directory, name) };
}
