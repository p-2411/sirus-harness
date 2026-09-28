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

// An argument as one line of a label: the first line of a string, the items
// of a list of strings, nothing for anything else. Labels read arguments
// before any tool has checked them.
export function labelText(args: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    const text = typeof value === 'string' ? value
      : Array.isArray(value) ? value.filter(item => typeof item === 'string').join(', ')
      : '';
    const line = text.trim().split('\n')[0]?.trim() ?? '';
    if (line) return line;
  }
  return '';
}
