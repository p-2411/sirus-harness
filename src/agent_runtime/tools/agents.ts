import type { SessionAgent } from '../agent';
import { requiredBoolean, requiredString } from './arguments';
import type { ToolCallContext } from './types';

export function spawnAgent(
  args: Record<string, unknown>,
  directory: string,
  call?: ToolCallContext,
): Record<string, unknown> {
  const run = requireAgent(call, 'SpawnAgent').spawnSubagent(
    requiredString(args, 'prompt', 'SpawnAgent'),
    requiredString(args, 'model', 'SpawnAgent'),
    {
      directory,
      ...(call?.callId ? { callId: call.callId } : {}),
      ...(call?.signal ? { signal: call.signal } : {}),
      ...(call?.permissions ? { permissions: call.permissions } : {}),
    },
  );
  return {
    id: run.id,
    model: run.model,
    status: run.status,
    streamFile: run.streamFile,
    note: 'Running in the background. Follow progress by reading streamFile or calling CheckAgent; call CheckAgent with wait true to collect the final message and change summary.',
  };
}

export function checkAgent(
  args: Record<string, unknown>,
  _directory: string,
  call?: ToolCallContext,
): Promise<Record<string, unknown>> {
  return requireAgent(call, 'CheckAgent').checkSubagent(
    requiredString(args, 'id', 'CheckAgent'),
    requiredBoolean(args, 'wait', 'CheckAgent'),
    call?.signal,
  );
}

export function cancelAgent(
  args: Record<string, unknown>,
  _directory: string,
  call?: ToolCallContext,
): Promise<Record<string, unknown>> {
  return requireAgent(call, 'CancelAgent').cancelSubagent(
    requiredString(args, 'id', 'CancelAgent'),
    call?.signal,
  );
}

export function listAgents(
  _args: Record<string, unknown>,
  _directory: string,
  call?: ToolCallContext,
): Record<string, unknown> {
  const subagents = requireAgent(call, 'ListAgents').describeSubagents();
  return subagents.length > 0
    ? { subagents }
    : { subagents, note: 'You have not spawned any subagent yet.' };
}

function requireAgent(call: ToolCallContext | undefined, toolName: string): SessionAgent {
  if (!call?.agent) throw new Error(`${toolName} needs the calling agent`);
  return call.agent;
}
