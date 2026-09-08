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
