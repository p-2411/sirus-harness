import crypto from 'crypto';
import { abortable, isAbortError, TurnCancelledError } from '../../../abort';
import type { SessionAgent } from '../../agent';
import { FORKED_WORKER_HANDOVER } from '../../prompt';
import { servableModelIds, servesModel } from '../../providers';
import { transcriptText } from '../../session/transcript';
import type { Message, ThinkingLevel } from '../../types';
import type { WorkerContext } from '../types';
import {
  notifySubagentProgress,
  notifySubagents,
  registerSubagent,
  type SubagentRun,
} from './index';
import { describeRun, finalMessageOf, summarizeChanges } from './report';
import { createWorktree } from './worktree';

// A worker is a background task of the session: it receives one task, runs
// its vendor's own tools in its own worktree under the session's mode and
// gate, and when it ends its report is delivered to the agent that spawned
// it, which wakes that agent. Nobody waits on it here; the owner asks after
// it with CheckAgent, sends it instructions with MessageAgent, and stops it
// with CancelAgent.

export interface SubagentSpawnOptions {
  model: string;
  thinkingLevel: ThinkingLevel;
  // Fresh, or started from the owner's conversation so far.
  context: WorkerContext;
  // The SpawnAgent tool call that started the run, so the chat can decorate
  // the row that anchors it.
  callId?: string;
}

// What each run is still doing, so cancelling one can wait for it to wind
// down. A finished run's entry resolves at once.
const completions = new Map<string, Promise<void>>();

export async function startSubagent(
  owner: SessionAgent,
  prompt: string,
  options: SubagentSpawnOptions,
): Promise<SubagentRun> {
  if (!servesModel(options.model)) {
    throw new Error(`Unknown model "${options.model}". Try: ${servableModelIds().join(', ')}`);
  }
  const id = `sub-${crypto.randomUUID().slice(0, 8)}`;
  const worktree = await createWorktree(owner.directory, owner.sessionId, id);
  const worker = owner.createSubagent(id, options.model, options.thinkingLevel, worktree?.directory ?? owner.directory);

  // With `owner` context the worker's first runtime is a fork of the owner's
  // live one and inherits the conversation. A fork also inherits the owner's
  // system prompt, whatever the fork was told, so the contract it is missing
  // opens its first prompt; the conversation is already in the session it
  // was forked from and is not repeated. When there is no live runtime to
  // fork, or the vendor refuses, the worker starts fresh — its own system
  // prompt carries the contract then — and reads that conversation as text.
  let text = prompt;
  if (options.context === 'owner') {
    if (await worker.forkFrom(owner)) {
      text = [FORKED_WORKER_HANDOVER, '', 'Your task:', prompt].join('\n');
    } else {
      const history = transcriptText(owner.transcript.entries());
      if (history) {
        text = ['Earlier conversation of the agent that spawned you, for context:', history, '', prompt].join('\n');
      }
    }
  }

  // The worker's record: the task, then the one entry its turn fills in, and
  // afterwards whatever is sent into its turn. Its seqs are its own; nothing
  // of it enters the session's timeline.
  const task: Message = { seq: 0, role: 'user', content: [{ type: 'text', text: prompt }] };
  const entry: Message = { seq: 1, role: 'assistant', participant: id, model: options.model, content: [] };
  worker.transcript.append(task);
  worker.transcript.append(entry);
  const run: SubagentRun = {
    id,
    callId: options.callId ?? null,
    sessionId: owner.sessionId,
    owner: owner.name,
    worker,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    context: options.context,
    prompt,
    directory: worktree?.directory ?? owner.directory,
    branch: worktree?.branch ?? null,
    status: 'working',
    startedAt: Date.now(),
    finishedAt: null,
    transcript: worker.transcript.entries() as Message[],
    content: entry.content,
    finalMessage: null,
    changes: [],
    error: null,
    reported: false,
    dismissed: false,
  };
  registerSubagent(run);
  completions.set(run.id, execute(run, owner, { text, task, entry }));
  // The caller owns the run map the session lists workers from, so it is the
  // caller that announces the run: a listener woken here would re-read that
  // map before the run had reached it.
  return run;
}

// The run as it stands, without waiting: a worker reports back on its own.
export function checkSubagent(run: SubagentRun): Record<string, unknown> {
  return describeRun(run);
}

// Resolves when the run has reached a terminal status, at once if it already
// has. A restored record is one that already has.
export function subagentDone(run: SubagentRun): Promise<void> {
  if (run.status !== 'working') return Promise.resolve();
  return completions.get(run.id) ?? Promise.resolve();
}

// Stops one working worker and waits for it to wind down, so the caller gets
// an accurate account of what it had changed before being stopped.
export async function cancelSubagent(run: SubagentRun, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (run.status === 'working') {
    run.worker?.cancel(new TurnCancelledError('Cancelled by CancelAgent'));
    await abortable(completions.get(run.id) ?? Promise.resolve(), signal);
  }
  return describeRun(run);
}

// Sends text into the turn a worker is running, and records it in the
// worker's own record as a message it received. One that has ended refuses
// with its status: there is no turn to fold the text into.
export async function messageSubagent(run: SubagentRun, text: string): Promise<Record<string, unknown>> {
  if (run.status !== 'working' || !run.worker) {
    throw new Error(`Subagent ${run.id} is ${run.status} and cannot be sent a message.`);
  }
  await run.worker.steer(text);
  run.worker.transcript.append({
    seq: run.transcript.length,
    role: 'user',
    content: [{ type: 'text', text }],
  });
  notifySubagents();
  return { id: run.id, status: run.status, delivered: text };
}

interface WorkerTurn {
  // What the worker's runtime is prompted with: the task, carrying the
  // owner's conversation when a fork was asked for and could not be had.
  text: string;
  task: Message;
  entry: Message;
}

async function execute(run: SubagentRun, owner: SessionAgent, turn: WorkerTurn): Promise<void> {
  const worker = run.worker!;
  try {
    await worker.respond({ text: turn.text }, {
      entry: turn.entry,
      carried: [turn.task],
      onUpdate: () => notifySubagentProgress(),
    });
    run.finalMessage = finalMessageOf(turn.entry.content);
    run.status = 'done';
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    run.status = isAbortError(error) ? 'cancelled' : 'failed';
  } finally {
    // Whatever happened, the changes made so far are what the owner must know
    // about, and the owner is told: finishing a worker wakes it.
    run.changes = summarizeChanges(turn.entry.content, run.directory);
    run.finishedAt = Date.now();
    worker.resetRuntime();
    notifySubagents();
    owner.workerFinished(run);
  }
}
