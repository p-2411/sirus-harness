import type { MemoryLink, MemoryScope, MemorySearchScope } from '../../memory/store';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requiredBoolean(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): boolean {
  const value = args[name];
  if (typeof value !== 'boolean') {
    throw new TypeError(`${toolName} requires ${name} to be a boolean`);
  }
  return value;
}

export function requiredString(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
  allowEmpty = false,
): string {
  const value = args[name];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    const qualifier = allowEmpty ? 'a string' : 'a non-empty string';
    throw new TypeError(`${toolName} requires ${name} to be ${qualifier}`);
  }
  return value;
}

export function requiredMemoryScope(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): MemoryScope {
  const value = args[name];
  if (value !== 'global' && value !== 'project') {
    throw new TypeError(`${toolName} requires ${name} to be global or project`);
  }
  return value;
}

export function requiredMemorySearchScope(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): MemorySearchScope {
  const value = args[name];
  if (value !== 'available' && value !== 'global' && value !== 'project') {
    throw new TypeError(`${toolName} requires ${name} to be available, global, or project`);
  }
  return value;
}

export function requiredMemoryLinks(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): MemoryLink[] {
  const value = args[name];
  if (!Array.isArray(value)) {
    throw new TypeError(`${toolName} requires ${name} to be an array of scoped memory references`);
  }
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`${toolName} requires every ${name} item to contain scope and name`);
    }
    const link = item as Record<string, unknown>;
    return {
      scope: requiredMemoryScope(link, 'scope', toolName),
      name: requiredString(link, 'name', toolName),
    };
  });
}

export function requiredInteger(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${toolName} requires ${name} to be an integer`);
  }
  return value;
}
