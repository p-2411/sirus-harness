#!/usr/bin/env bun

import { realpathSync, statSync } from 'fs';
import path from 'path';

export const USAGE = `Usage: sirus [directory]

Open Sirus with new sessions owned by directory.
When directory is omitted, Sirus uses the current directory.`;

export interface CliOptions {
  directory: string | null;
  help: boolean;
}

export function parseCliArguments(args: readonly string[], currentDirectory: string = process.cwd()): CliOptions {
  const positional = args[0] === '--' ? args.slice(1) : [...args];
  if (positional.length === 1 && (positional[0] === '--help' || positional[0] === '-h')) {
    return { directory: null, help: true };
  }
  if (positional.length > 1) {
    throw new Error('Sirus accepts at most one directory.');
  }
  if (positional[0]?.startsWith('-')) {
    throw new Error(`Unknown option: ${positional[0]}`);
  }

  const requested = path.resolve(currentDirectory, positional[0] ?? '.');
  let stats;
  try {
    stats = statSync(requested);
  } catch {
    throw new Error(`Directory does not exist: ${requested}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${requested}`);
  }
  return { directory: realpathSync(requested), help: false };
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  process.chdir(options.directory!);
  await import('./frontend/index');
}

if (import.meta.main) {
  runCli().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`sirus: ${message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  });
}
