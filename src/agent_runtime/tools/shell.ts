import { spawn } from 'child_process';
import { abortReason, throwIfAborted } from '../../abort';
import { requiredString } from './arguments';
import type { Tool, ToolContext } from './types';

function runShell(
  args: Record<string, unknown>,
  { directory, signal }: ToolContext,
): Promise<Record<string, unknown>> {
  const command = requiredString(args, 'command', 'RunShell');
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: directory,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const terminate = () => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else {
        child.kill('SIGKILL');
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminate();
      reject(error);
    };
    const onAbort = () => fail(abortReason(signal!));
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > 1024 * 1024) {
        fail(new Error('RunShell failed: output exceeded the 1 MiB limit'));
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    const timeout = setTimeout(
      () => fail(new Error(`RunShell failed: command timed out after 30 seconds${stderr.trim() ? `: ${stderr.trim()}` : ''}`)),
      30_000,
    );
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.on('error', error => {
      fail(new Error(`RunShell failed: ${error.message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, signal: exitSignal, stdout, stderr });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export const shellTools: Tool[] = [
  {
    name: 'RunShell',
    description: 'Run a non-interactive shell command in the current working directory and capture its output.',
    args: {
      command: {
        type: 'string',
        description: 'The shell command to execute. It has a 30-second timeout and a 1 MiB output limit.',
      },
    },
    // A command classified as a read can still write through flags such as
    // find -delete or sort -o, so every shell call waits for the pre-turn
    // snapshot. The permission gate classifies the command itself separately.
    effect: 'mutates',
    run: runShell,
  },
];
