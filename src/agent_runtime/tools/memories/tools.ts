import {
  deleteMemory,
  getMemory,
  saveMemory,
  searchMemories,
} from '../memories';
import type { Tool } from '../types';

export const memoryTools: Tool[] = [
  {
    name: 'SaveMemory',
    description: 'Create or update a durable global or current-project memory and index it for semantic search.',
    args: {
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'Use global for cross-project user context or project for facts tied to this session directory.',
      },
      name: { type: 'string', description: 'A stable name unique within the selected scope.' },
      content: { type: 'string', description: 'The durable fact, preference, decision, or context to remember.' },
      links: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['global', 'project'] },
            name: { type: 'string' },
          },
          required: ['scope', 'name'],
          additionalProperties: false,
        },
        description: 'Scoped references to related memories. Global memories may only link to global memories.',
      },
    },
    func: saveMemory,
  },
  {
    name: 'GetMemory',
    description: 'Retrieve one global or current-project memory by exact scope and name.',
    args: {
      scope: { type: 'string', enum: ['global', 'project'], description: 'The scope containing the memory.' },
      name: { type: 'string', description: 'The exact memory name.' },
    },
    func: getMemory,
  },
  {
    name: 'SearchMemories',
    description: 'Semantically search global memories, current-project memories, or both available scopes.',
    args: {
      scope: {
        type: 'string',
        enum: ['available', 'global', 'project'],
        description: 'Use available to search global plus this session directory; no other project is accessible.',
      },
      query: { type: 'string', description: 'A natural-language description of the memory to recall.' },
      limit: { type: 'integer', description: 'Maximum number of matches to return, from 1 to 50.' },
    },
    func: searchMemories,
  },
  {
    name: 'DeleteMemory',
    description: 'Permanently delete a global or current-project memory by exact scope and name.',
    args: {
      scope: { type: 'string', enum: ['global', 'project'], description: 'The scope containing the memory.' },
      name: { type: 'string', description: 'The exact memory name to delete.' },
    },
    func: deleteMemory,
  },
];
