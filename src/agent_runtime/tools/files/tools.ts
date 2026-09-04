import { editFile, readFile, writeFile } from '../files';
import type { Tool } from '../types';

export const fileTools: Tool[] = [
  {
    name: 'ReadFile',
    description: 'Read the UTF-8 contents of a file at the supplied path.',
    args: {
      path: { type: 'string', description: 'The path of the file to read.' },
    },
    func: readFile,
  },
  {
    name: 'WriteFile',
    description: 'Write UTF-8 content to a file, creating it if missing and replacing it if it already exists.',
    args: {
      path: { type: 'string', description: 'The path of the file to create or replace.' },
      content: { type: 'string', description: 'The complete UTF-8 content to write to the file.' },
    },
    func: writeFile,
  },
  {
    name: 'EditFile',
    description: 'Replace one exact, unique text occurrence in an existing UTF-8 file.',
    args: {
      path: { type: 'string', description: 'The path of the existing file to edit.' },
      old_text: {
        type: 'string',
        description: 'The exact text to replace. It must occur exactly once in the file.',
      },
      new_text: {
        type: 'string',
        description: 'The replacement text. It may be empty to delete the matched text.',
      },
    },
    func: editFile,
  },
];
