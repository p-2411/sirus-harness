import { runShell } from '../shell';
import type { Tool } from '../types';

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
    func: runShell,
  },
];
