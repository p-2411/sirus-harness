import { modelIds } from '../providers/catalog';
import { requiredBoolean, requiredString } from './arguments';
// Straight from the report module rather than the subagents barrel: the
// lifecycle there builds toolboxes, and the registry must not depend on one.
import { CHECK_WAIT_LIMIT_MS } from './subagents/report';
import type { SubagentHost, Tool, ToolContext } from './types';

// Delegation: starting, watching and stopping subagents. Only an agent that
// owns a subagent host can use these, which is why a toolbox built for a
// subagent leaves them out — a worker cannot spawn a worker of its own.

function host(ctx: ToolContext, toolName: string): SubagentHost {
  if (!ctx.subagents) throw new Error(`${toolName} needs the calling agent`);
  return ctx.subagents;
}

export const agentTools: Tool[] = [
  {
    name: 'SpawnAgent',
    description: 'Start an autonomous subagent that works on one task in the current working directory with the same file, shell, and memory tools, and return immediately without waiting for it. Delegate self-contained work that does not need step-by-step supervision. The subagent sees only its prompt, cannot ask questions, and cannot spawn agents of its own. The result gives its id and the path of a temporary file where its output streams while it works; read that file or use CheckAgent to follow progress, and use CheckAgent with wait true to collect its final message and a summary of the changes it made.',
    args: {
      prompt: {
        type: 'string',
        description: 'The complete, self-contained task for the subagent, including every detail it needs, because it does not see this conversation.',
      },
      model: {
        type: 'string',
        enum: modelIds(),
        description: 'The model that runs the subagent.',
      },
    },
    effect: 'mutates',
    audience: { subagent: false },
    async run(args, ctx) {
      const run = host(ctx, 'SpawnAgent').spawn(
        requiredString(args, 'prompt', 'SpawnAgent'),
        requiredString(args, 'model', 'SpawnAgent'),
        { callId: ctx.callId, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      return {
        id: run.id,
        model: run.model,
        status: run.status,
        streamFile: run.streamFile,
        note: 'Running in the background. Follow progress by reading streamFile or calling CheckAgent; call CheckAgent with wait true to collect the final message and change summary.',
      };
    },
  },
  {
    name: 'CheckAgent',
    description: 'Report on a subagent started with SpawnAgent. While it is working the result includes its status and the tail of its output so far; once it has finished the result includes its final message and a summary of the changes it made, or the error if it failed.',
    args: {
      id: { type: 'string', description: 'The subagent id returned by SpawnAgent.' },
      wait: {
        type: 'boolean',
        description: `true blocks until the subagent finishes, for up to ${CHECK_WAIT_LIMIT_MS / 1000} seconds before reporting it as still working; false returns its current state immediately.`,
      },
    },
    effect: 'read',
    audience: { subagent: false },
    run(args, ctx) {
      return host(ctx, 'CheckAgent').check(
        requiredString(args, 'id', 'CheckAgent'),
        requiredBoolean(args, 'wait', 'CheckAgent'),
        ctx.signal,
      );
    },
  },
  {
    name: 'CancelAgent',
    description: 'Stop a working subagent started with SpawnAgent. Waits for it to stop and returns its status with a summary of the changes it had already made. A subagent that has already finished is reported as it is.',
    args: {
      id: { type: 'string', description: 'The subagent id returned by SpawnAgent.' },
    },
    effect: 'read',
    audience: { subagent: false },
    run(args, ctx) {
      return host(ctx, 'CancelAgent').cancel(requiredString(args, 'id', 'CancelAgent'), ctx.signal);
    },
  },
  {
    name: 'ListAgents',
    description: 'List every subagent you have spawned with its id, model, status, elapsed time, and task, to find one to check, wait for, or cancel.',
    args: {},
    effect: 'read',
    audience: { subagent: false },
    async run(_args, ctx) {
      const subagents = host(ctx, 'ListAgents').list();
      return subagents.length > 0
        ? { subagents }
        : { subagents, note: 'You have not spawned any subagent yet.' };
    },
  },
];
