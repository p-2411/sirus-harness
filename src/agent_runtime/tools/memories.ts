import { memorySearchScope, memoryStoreFor, memoryTarget } from '../../memory/store';
import { requiredInteger, requiredString } from './arguments';
import type { Tool } from './types';

// The durable notes the agent keeps for itself. Every one of them needs
// memory access switched on; without it they are hidden from the model and
// a direct call is refused.

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
    // Memories live in Sirus's own store, not in the working directory: they
    // are outside what a checkpoint captures and what the gate guards.
    effect: 'read',
    requires: 'memory',
    async run(args, { directory }) {
      const target = memoryTarget(args.scope, directory);
      return memoryStoreFor().save(target, {
        name: requiredString(args, 'name', 'SaveMemory'),
        content: requiredString(args, 'content', 'SaveMemory'),
        links: args.links,
      });
    },
  },
  {
    name: 'GetMemory',
    description: 'Retrieve one global or current-project memory by exact scope and name.',
    args: {
      scope: { type: 'string', enum: ['global', 'project'], description: 'The scope containing the memory.' },
      name: { type: 'string', description: 'The exact memory name.' },
    },
    effect: 'read',
    requires: 'memory',
    async run(args, { directory }) {
      const target = memoryTarget(args.scope, directory);
      const name = requiredString(args, 'name', 'GetMemory');
      const memory = memoryStoreFor().get(target, name);
      return memory ?? { found: false, scope: target.scope, name };
    },
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
    effect: 'read',
    requires: 'memory',
    async run(args, { directory }) {
      const scope = memorySearchScope(args.scope);
      const query = requiredString(args, 'query', 'SearchMemories');
      const limit = requiredInteger(args, 'limit', 'SearchMemories');
      return memoryStoreFor().search(scope, directory, query, limit);
    },
  },
  {
    name: 'DeleteMemory',
    description: 'Permanently delete a global or current-project memory by exact scope and name.',
    args: {
      scope: { type: 'string', enum: ['global', 'project'], description: 'The scope containing the memory.' },
      name: { type: 'string', description: 'The exact memory name to delete.' },
    },
    effect: 'read',
    requires: 'memory',
    async run(args, { directory }) {
      const target = memoryTarget(args.scope, directory);
      const name = requiredString(args, 'name', 'DeleteMemory');
      return { scope: target.scope, name, deleted: memoryStoreFor().delete(target, name) };
    },
  },
];
