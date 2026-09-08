import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { requiredString } from './arguments';
import type { Tool } from './types';

// Reading and writing files under the turn's directory. Relative paths
// resolve against it; an absolute path is taken as given and the permission
// gate decides whether it may be touched.

export const fileTools: Tool[] = [
  {
    name: 'ReadFile',
    description: 'Read the UTF-8 contents of a file at the supplied path.',
    args: {
      path: { type: 'string', description: 'The path of the file to read.' },
    },
    effect: 'read',
    async run(args, { directory }) {
      const filePath = path.resolve(directory, requiredString(args, 'path', 'ReadFile'));
      return readFileSync(filePath, 'utf8');
    },
  },
  {
    name: 'WriteFile',
    description: 'Write UTF-8 content to a file, creating it if missing and replacing it if it already exists.',
    args: {
      path: { type: 'string', description: 'The path of the file to create or replace.' },
      content: { type: 'string', description: 'The complete UTF-8 content to write to the file.' },
    },
    effect: 'mutates',
    async run(args, { directory }) {
      const filePath = path.resolve(directory, requiredString(args, 'path', 'WriteFile'));
      const content = requiredString(args, 'content', 'WriteFile', true);
      const created = !existsSync(filePath);

      writeFileSync(filePath, content, 'utf8');
      return {
        path: filePath,
        created,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      };
    },
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
    effect: 'mutates',
    async run(args, { directory }) {
      const filePath = path.resolve(directory, requiredString(args, 'path', 'EditFile'));
      const oldText = requiredString(args, 'old_text', 'EditFile');
      const newText = requiredString(args, 'new_text', 'EditFile', true);
      const content = readFileSync(filePath, 'utf8');
      const firstMatch = content.indexOf(oldText);

      if (firstMatch === -1) {
        throw new Error(`EditFile could not find old_text in ${filePath}`);
      }
      if (content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
        throw new Error(`EditFile found multiple old_text matches in ${filePath}; include more surrounding context`);
      }

      const updated = content.slice(0, firstMatch) + newText + content.slice(firstMatch + oldText.length);
      writeFileSync(filePath, updated, 'utf8');
      return {
        path: filePath,
        replacements: 1,
        bytesWritten: Buffer.byteLength(updated, 'utf8'),
      };
    },
  },
];
