import { requiredString } from './arguments';
import type { SubagentHost, Tool, ToolContext, WorkerContext } from './types';

// Delegation: starting, watching, steering and stopping subagents. Only a
// participant with a subagent host can use these, which is why the server
// hides them from a worker — a subagent cannot spawn a subagent of its own.

function host(ctx: ToolContext, toolName: string): SubagentHost {
  if (!ctx.subagents) throw new Error(`${toolName} needs the calling agent`);
  return ctx.subagents;
}

const WORKER_CONTEXTS: readonly WorkerContext[] = ['fresh', 'owner'];

function workerContext(args: Record<string, unknown>): WorkerContext {
  const value = args.context;
  if (value === undefined || value === null) return 'fresh';
  if (typeof value !== 'string' || !WORKER_CONTEXTS.includes(value as WorkerContext)) {
    throw new TypeError(`SpawnAgent requires context to be one of ${WORKER_CONTEXTS.join(', ')}`);
  }
  return value as WorkerContext;
}

export const agentTools: Tool[] = [
  {
    name: 'SpawnAgent',
    description: 'Start a subagent that works on one task on its own, with its own file, shell, search and web tools plus the memory tools, and return immediately. In a git project it works on its own branch in its own worktree, cut from the project\'s HEAD, so its edits do not collide with yours. It runs on the session\'s subagent model: /model subagent <model> sets it, and while unset the host picks the model and thinking level that fit the task. Delegate self-contained work that does not need step-by-step supervision. The subagent cannot ask questions and cannot spawn agents of its own. When it ends, its report arrives as a message from @<id> and starts your next turn; until then use CheckAgent for its state and MessageAgent to send it further instructions.',
    args: {
      prompt: {
        type: 'string',
        description: 'The complete, self-contained task for the subagent, including every detail it needs, because it does not see this conversation unless you pass context "owner".',
      },
      context: {
        type: 'string',
        enum: WORKER_CONTEXTS,
        default: 'fresh',
        description: '"fresh" starts the subagent from nothing but the task. "owner" starts it from your conversation so far, for work that depends on what you and the user have already established; the task is still its first instruction.',
      },
    },
    audience: { subagent: false },
    async run(args, ctx) {
      const handle = await host(ctx, 'SpawnAgent').spawn(
        requiredString(args, 'prompt', 'SpawnAgent'),
        workerContext(args),
        { callId: ctx.callId },
      );
      return {
        ...handle,
        note: handle.branch
          ? `Working in the background on branch ${handle.branch}. It reports back to you as a message from @${handle.id} when it ends, which starts your turn; that report names the branch to merge or inspect. CheckAgent gives its state now, MessageAgent sends it instructions meanwhile.`
          : `Working in the background in your working directory. It reports back to you as a message from @${handle.id} when it ends, which starts your turn. CheckAgent gives its state now, MessageAgent sends it instructions meanwhile.`,
      };
    },
  },
  {
    name: 'CheckAgent',
    description: 'Report on a subagent started with SpawnAgent, as it stands right now. While it is working the result includes its status and the tail of its output so far; once it has finished the result includes its final message and a summary of the changes it made, or the error if it failed. It never waits: a finished subagent reports back to you on its own.',
    args: {
      id: { type: 'string', description: 'The subagent id returned by SpawnAgent.' },
    },
    audience: { subagent: false },
    async run(args, ctx) {
      return host(ctx, 'CheckAgent').check(requiredString(args, 'id', 'CheckAgent'));
    },
  },
  {
    name: 'MessageAgent',
    description: 'Send text into the turn a working subagent is running: a correction, a constraint you forgot, or an answer it needs. It folds the message into the work in flight. A subagent that has already finished refuses with its status; there is nothing to send it to.',
    args: {
      id: { type: 'string', description: 'The subagent id returned by SpawnAgent.' },
      message: { type: 'string', description: 'What to tell it, complete in itself: it sees this message and its own task, not this conversation.' },
    },
    audience: { subagent: false },
    run(args, ctx) {
      return host(ctx, 'MessageAgent').message(
        requiredString(args, 'id', 'MessageAgent'),
        requiredString(args, 'message', 'MessageAgent'),
      );
    },
  },
  {
    name: 'CancelAgent',
    description: 'Stop a working subagent started with SpawnAgent. Waits for it to stop and returns its status with a summary of the changes it had already made. A subagent that has already finished is reported as it is.',
    args: {
      id: { type: 'string', description: 'The subagent id returned by SpawnAgent.' },
    },
    audience: { subagent: false },
    run(args, ctx) {
      return host(ctx, 'CancelAgent').cancel(requiredString(args, 'id', 'CancelAgent'), ctx.signal);
    },
  },
  {
    name: 'ListAgents',
    description: 'List every subagent you have spawned with its id, model, thinking level, status, elapsed time, task, branch and context, to find one to check, message, or cancel.',
    args: {},
    audience: { subagent: false },
    async run(_args, ctx) {
      const subagents = host(ctx, 'ListAgents').list();
      return subagents.length > 0
        ? { subagents }
        : { subagents, note: 'You have not spawned any subagent yet.' };
    },
  },
];
