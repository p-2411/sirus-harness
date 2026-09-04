import { modelStrategies } from '../../chat';
import {
  cancelAgent,
  checkAgent,
  listAgents,
  spawnAgent,
} from '../agents';
import { CHECK_WAIT_LIMIT_MS } from '../subagents';
import type { Tool, ToolArgumentSchema } from '../types';

export const agentTools: Tool[] = [
  {
    name: 'SpawnAgent',
    description: 'Start an autonomous subagent that works on one task in the current working directory with the same file, shell, and memory tools, and return immediately without waiting for it. Delegate self-contained work that does not need step-by-step supervision. The subagent sees only its prompt, cannot ask questions, and cannot spawn agents of its own. The result gives its id and the path of a temporary file where its output streams while it works; read that file or use CheckAgent to follow progress, and use CheckAgent with wait true to collect its final message and a summary of the changes it made.',
    // Resolved on access because provider setup imports the tool registry.
    get args(): Record<string, ToolArgumentSchema> {
      return {
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the subagent, including every detail it needs, because it does not see this conversation.',
        },
        model: {
          type: 'string',
          enum: Object.keys(modelStrategies),
          description: 'The model that runs the subagent.',
        },
      };
    },
    func: spawnAgent,
  },
  {
    name: 'CheckAgent',
    description: 'Report on a subagent started with SpawnAgent. While it is working the result includes its status and the tail of its output so far; once it has finished the result includes its final message and a summary of the changes it made, or the error if it failed.',
    get args(): Record<string, ToolArgumentSchema> {
      return {
        id: { type: 'string', description: 'The subagent id returned by SpawnAgent.' },
        wait: {
          type: 'boolean',
          description: `true blocks until the subagent finishes, for up to ${CHECK_WAIT_LIMIT_MS / 1000} seconds before reporting it as still working; false returns its current state immediately.`,
        },
      };
    },
    func: checkAgent,
  },
  {
    name: 'CancelAgent',
    description: 'Stop a working subagent started with SpawnAgent. Waits for it to stop and returns its status with a summary of the changes it had already made. A subagent that has already finished is reported as it is.',
    args: {
      id: { type: 'string', description: 'The subagent id returned by SpawnAgent.' },
    },
    func: cancelAgent,
  },
  {
    name: 'ListAgents',
    description: 'List every subagent you have spawned with its id, model, status, elapsed time, and task, to find one to check, wait for, or cancel.',
    args: {},
    func: listAgents,
  },
];
