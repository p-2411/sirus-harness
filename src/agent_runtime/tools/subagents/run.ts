import crypto from 'crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { abortable, isAbortError, TurnCancelledError } from '../../../abort';
import type { SessionAgent } from '../../agent';
import type { PermissionContext } from '../../permissions/policy';
import { servableModelIds, servesModel } from '../../providers';
import type { Message } from '../../types';
import { createToolbox } from '../toolbox';
import { allSubagents, notifySubagents, registerSubagent, type SubagentRun } from './index';
import { CHECK_WAIT_LIMIT_MS, describeRun, finalMessageOf, renderTranscript, summarizeChanges } from './report';

// A subagent is one detached run of the agent loop, owned by the agent that
// spawned it: it receives a single task, works with the ordinary tools in the
// owner's directory, and hands back a final message plus a summary of what it
// changed. Only the owner can see or steer a run.

export interface SubagentSpawnOptions {
  // Where the run works: the owner's turn directory.
  directory: string;
  callId?: string;
  // The owner's turn: when it is cancelled, so is the run.
  signal?: AbortSignal;
  permissions?: PermissionContext;
  // The owner's pre-turn checkpoint. A worker's writes wait for it too, so a
  // delegated write cannot beat the snapshot either.
  beforeMutation?: () => Promise<void>;
}

// While a run works its transcript streams into a temporary file, so the
// owner can look in on it with the ordinary file tools. The stream file is a
// convenience: losing it must never fail the run itself.

let exitCleanupInstalled = false;

function streamContents(run: SubagentRun): string {
  return [
    `Sirus subagent ${run.id}`,
    `model: ${run.model}`,
    `status: ${run.status}`,
    `started: ${new Date(run.startedAt).toISOString()}`,
    'task:',
    run.prompt,
    '',
    '--- output ---',
    renderTranscript(run.content),
    '',
  ].join('\n');
}

function streamDirectory(): string {
  return path.join(os.tmpdir(), 'sirus-subagents');
}

export function createStreamFile(run: SubagentRun): string | null {
  const file = path.join(streamDirectory(), `${run.id}.log`);
  try {
    mkdirSync(streamDirectory(), { recursive: true, mode: 0o700 });
    writeFileSync(file, streamContents(run), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

export function writeStreamFile(run: SubagentRun): void {
  if (!run.streamFile) return;
  try {
    writeFileSync(run.streamFile, streamContents(run), 'utf8');
  } catch {
    // ignore: the transcript stays available through CheckAgent
  }
}

export function removeStreamFile(run: SubagentRun): void {
  if (!run.streamFile) return;
  try {
    unlinkSync(run.streamFile);
  } catch {
    // already gone
  }
  run.streamFile = null;
}

// Subagents die with the process; do not leave their half-written streams
// behind in the temporary directory.
export function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.on('exit', () => {
    for (const run of allSubagents()) removeStreamFile(run);
  });
}

const completions = new Map<string, Promise<void>>();

export function startSubagent(
  owner: SessionAgent,
  prompt: string,
  model: string,
  options: SubagentSpawnOptions,
): SubagentRun {
  if (!servesModel(model)) {
    throw new Error(`Unknown model "${model}". Try: ${servableModelIds().join(', ')}`);
  }
  const id = `sub-${crypto.randomUUID().slice(0, 8)}`;
  const run: SubagentRun = {
    id,
    callId: options.callId ?? null,
    sessionId: options.permissions?.sessionId ?? null,
    owner,
    worker: owner.createSubagent(id, model),
    model,
    prompt,
    directory: options.directory,
    status: 'working',
    streamFile: null,
    startedAt: Date.now(),
    finishedAt: null,
    content: [],
    finalMessage: null,
    changes: [],
    error: null,
    // The worker answers to the owner's session and mode, as itself.
    permissions: options.permissions
      ? { ...options.permissions, requester: { subagent: id }, model }
      : null,
  };
  registerSubagent(run);
  run.streamFile = createStreamFile(run);
  installExitCleanup();
  completions.set(run.id, execute(run, options.signal, options.beforeMutation));
  notifySubagents();
  return run;
}

export async function checkSubagent(
  run: SubagentRun,
  wait: boolean,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (wait && run.status === 'working') {
    await abortable(Promise.race([
      completions.get(run.id),
      new Promise<void>(resolve => setTimeout(resolve, CHECK_WAIT_LIMIT_MS)),
    ]), signal);
  }
  return describeRun(run, wait);
}

// Stops one working subagent and waits for it to wind down, so the caller
// gets an accurate account of what it had changed before being stopped.
export async function cancelSubagent(run: SubagentRun, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (run.status === 'working') {
    run.worker.cancel(new TurnCancelledError('Cancelled by CancelAgent'));
    await abortable(completions.get(run.id) ?? Promise.resolve(), signal);
  }
  return describeRun(run, false);
}

async function execute(
  run: SubagentRun,
  parentSignal?: AbortSignal,
  beforeMutation?: () => Promise<void>,
): Promise<void> {
  const task: Message = { role: 'user', content: [{ type: 'text', text: run.prompt }] };
  try {
    const turn = run.worker.respond([task], {
      directory: run.directory,
      ...(parentSignal ? { signal: parentSignal } : {}),
      // A worker's own toolbox: the same tools minus delegation, so it cannot
      // spawn a worker of its own, under the owner's gate and barrier.
      toolbox: createToolbox({
        audience: { subagent: true },
        directory: run.directory,
        ...(run.permissions ? { permissions: run.permissions } : {}),
        ...(beforeMutation ? { beforeMutation } : {}),
      }),
    });
    for await (const snapshot of turn.changes()) {
      run.content = snapshot.content;
      writeStreamFile(run);
    }
    const response = await turn.result;
    run.content = response.content;
    run.finalMessage = finalMessageOf(response.content);
    run.status = 'done';
  } catch (error) {
    if (isAbortError(error)) {
      run.error = error instanceof Error ? error.message : 'Cancelled';
      run.status = 'cancelled';
    } else {
      run.error = error instanceof Error ? error.message : String(error);
      run.status = 'failed';
    }
  } finally {
    // Whatever happened, the changes made so far are what the caller must know about.
    run.changes = summarizeChanges(run.content, run.directory);
    run.finishedAt = Date.now();
    removeStreamFile(run);
    run.worker.resetRuntime();
    notifySubagents();
  }
}
