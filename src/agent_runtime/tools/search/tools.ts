import { searchFiles } from '../search';
import type { Tool } from '../types';

export const searchTools: Tool[] = [
  {
    name: 'SearchFiles',
    description: 'Search file contents under a directory for a regular expression and return the matching lines as path:line: text. Skips .git, node_modules, build output, binary files, and files over 1 MiB. Use it to find where something is defined or used before reading files.',
    args: {
      pattern: {
        type: 'string',
        description: 'A JavaScript regular expression, matched case-sensitively against each line.',
      },
      path: {
        type: 'string',
        description: 'The directory to search recursively, or a single file, relative to the working directory. Use "." for the whole workspace.',
      },
    },
    func: searchFiles,
  },
];
