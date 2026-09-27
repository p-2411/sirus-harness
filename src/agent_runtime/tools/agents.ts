import path from 'path';
import { statSync } from 'fs';
import { listedDescription, modelIds, modelInfo, vendorOf, VENDORS, VENDOR_INFO } from '../providers/catalog';
import { parseThinkingLevel, THINKING_LEVELS } from '../types';
import { requiredString } from './arguments';
import { agentDefinitions } from './subagents/definitions';
import type { SpawnOptions, SubagentHost, Tool, ToolContext } from './types';

function host(ctx: ToolContext, toolName: string): SubagentHost {
  if (!ctx.subagents) throw new Error(`${toolName} needs the calling agent`);
  return ctx.subagents;
}

// Computed when tools/list is served, so new vendor models and project agent
// definitions are available to the next caller without restarting Sirus.
export function spawnDescription(directory: string): string {
  const models = modelIds();
  const lines = VENDORS.flatMap(vendor => [
    `${VENDOR_INFO[vendor].displayName}:`,
    ...models.filter(model => vendorOf(model) === vendor).map(model => {
      const strengths = modelInfo(model)?.profile.strengths;
      const description = strengths?.split(/(?<=[.!?])\s+/)[0] || listedDescription(model) || 'Vendor-listed model.';
      return `- ${model}: ${description.replace(/\s+/g, ' ')}`;
    }),
  ]);
  const definitions = agentDefinitions(directory);
  return [agentTools[0].description, '', 'Models:', ...lines, '', 'Agent types:',
    ...definitions.map(definition => `- ${definition.name}: ${definition.description.replace(/\s+/g, ' ')}`),
    ...(definitions.length ? [] : ['No named definitions found.']),
  ].join('\n');
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  if (args[key] === undefined || args[key] === '') return undefined;
  return requiredString(args, key, 'SpawnAgent');
}

function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`);
  return value;
}

function spawnOptions(args: Record<string, unknown>): SpawnOptions {
  const context = args.context ?? 'fresh';
  if (context !== 'fresh' && context !== 'owner') throw new TypeError('SpawnAgent requires context to be fresh or owner');
  const isolation = args.isolation ?? 'none';
  if (isolation !== 'none' && isolation !== 'worktree') throw new TypeError('SpawnAgent requires isolation to be none or worktree');
  const cwd = optionalString(args, 'cwd');
  if (cwd && isolation === 'worktree') throw new TypeError('cwd and worktree isolation are exclusive');
  if (cwd && (!path.isAbsolute(cwd) || !statSync(cwd).isDirectory())) throw new TypeError('cwd must be an absolute directory');
  const thinkingLevel = args.thinkingLevel === undefined || args.thinkingLevel === '' ? undefined : parseThinkingLevel(args.thinkingLevel);
  if (thinkingLevel === null) throw new TypeError(`thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
  const name = optionalString(args, 'name');
  if (name && !/^[a-zA-Z0-9][\w-]*$/.test(name)) throw new TypeError('name must contain only letters, numbers, underscores or hyphens');
  return {
    context, isolation, cwd, name, thinkingLevel,
    description: optionalString(args, 'description'), model: optionalString(args, 'model'),
    agentType: optionalString(args, 'agentType'), runInBackground: booleanArg(args, 'runInBackground', true),
  };
}

export const agentTools: Tool[] = [
  {
    name: 'SpawnAgent',
    description: 'Start a subagent for a self-contained task. Pick a model from either vendor that fits the work; a review or second opinion is worth more on the other vendor. The user’s /model subagent pin wins, then your model argument, then the agent definition’s model, then your own model. Thinking follows your thinkingLevel, the definition, then your own level. Workers run in your directory by default; isolation "worktree" creates a branch from HEAD and keeps it only if changed. cwd chooses another absolute directory and cannot accompany worktree isolation. Background runs return immediately and notify you when done, steering your current turn or starting a turn if idle. runInBackground false waits and returns the report in this call. Workers cannot ask questions or delegate. SendMessage continues a worker, including one that has finished.',
    args: {
      prompt: { type: 'string', description: 'The complete task, context, constraints, file ownership and expected verification.' },
      description: { type: 'string', default: '', description: 'Short description for the worker strip.' },
      name: { type: 'string', default: '', description: 'Unique name to address with SendMessage, CheckAgent or WaitAgent.' },
      model: { type: 'string', default: '', description: 'Any model in the list below, from either vendor.' },
      thinkingLevel: { type: 'string', enum: THINKING_LEVELS, default: '', description: 'Reasoning depth; otherwise inherited from the definition or owner.' },
      agentType: { type: 'string', default: '', description: 'A named agent definition from the list below.' },
      isolation: { type: 'string', enum: ['none', 'worktree'], default: 'none' },
      cwd: { type: 'string', default: '', description: 'Absolute working directory, exclusive with worktree isolation.' },
      runInBackground: { type: 'boolean', default: true },
      context: { type: 'string', enum: ['fresh', 'owner'], default: 'fresh', description: 'Owner carries your conversation. A cross-vendor choice starts fresh with your record as context.' },
    },
    audience: { subagent: false },
    async run(args, ctx) {
      return host(ctx, 'SpawnAgent').spawn(requiredString(args, 'prompt', 'SpawnAgent'), spawnOptions(args),
        { callId: ctx.callId, ...(ctx.vendorCallId ? { vendorCallId: ctx.vendorCallId } : {}) }, ctx.signal);
    },
  },
  {
    name: 'CheckAgent',
    description: 'Return a worker’s status and progress now, or its completed report. Accepts an id or name. Use WaitAgent to wait for completion.',
    args: { id: { type: 'string', description: 'Worker id or name.' } },
    audience: { subagent: false },
    async run(args, ctx) { return host(ctx, 'CheckAgent').check(requiredString(args, 'id', 'CheckAgent')); },
  },
  {
    name: 'SendMessage',
    description: 'Send instructions to a worker by id or name. A running worker receives them in its current turn. interrupt true stops that turn and starts one with the message. A finished, failed or cancelled worker resumes with its conversation intact and reports again when that turn ends.',
    args: {
      to: { type: 'string', description: 'Worker id or name.' },
      message: { type: 'string', description: 'Complete instructions for the worker.' },
      interrupt: { type: 'boolean', default: false },
    },
    audience: { subagent: false },
    async run(args, ctx) {
      return host(ctx, 'SendMessage').message(requiredString(args, 'to', 'SendMessage'),
        requiredString(args, 'message', 'SendMessage'), booleanArg(args, 'interrupt', false));
    },
  },
  {
    name: 'WaitAgent',
    description: 'Wait up to timeoutMs for the workers named by ids to finish. Returns completed reports and the current status of the rest. Timing out leaves workers running.',
    args: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Worker ids or names.' },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 600000, default: 30000 },
    },
    audience: { subagent: false },
    async run(args, ctx) {
      if (!Array.isArray(args.ids) || !args.ids.length || args.ids.some(id => typeof id !== 'string' || !id.trim())) {
        throw new TypeError('WaitAgent requires a nonempty array of ids or names');
      }
      const timeout = args.timeoutMs ?? 30000;
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0 || timeout > 600000) {
        throw new TypeError('timeoutMs must be an integer from 0 to 600000');
      }
      return { subagents: await host(ctx, 'WaitAgent').wait(args.ids, timeout, ctx.signal) };
    },
  },
  {
    name: 'CancelAgent',
    description: 'Stop a worker and wait for its report. A worker that already finished is reported as it is. SendMessage can resume it later.',
    args: { id: { type: 'string', description: 'Worker id or name.' } },
    audience: { subagent: false },
    async run(args, ctx) { return host(ctx, 'CancelAgent').cancel(requiredString(args, 'id', 'CancelAgent'), ctx.signal); },
  },
  {
    name: 'ListAgents',
    description: 'List your workers with their ids, names, descriptions, models, thinking levels, statuses, elapsed times, branches and context.',
    args: {}, audience: { subagent: false },
    async run(_args, ctx) { return { subagents: host(ctx, 'ListAgents').list() }; },
  },
];
