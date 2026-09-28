import crypto from 'crypto';
import { abortable, errorMessage, isAbortError, TurnCancelledError } from '../../../abort';
import type { SessionAgent } from '../../agent';
import { FORKED_WORKER_HANDOVER } from '../../prompt';
import { requireKnownModel } from '../../providers';
import { transcriptText } from '../../session/transcript';
import type { Message, ThinkingLevel } from '../../types';
import type { SpawnOptions } from '../types';
import type { AgentDefinition } from './definitions';
import { notifySubagentProgress, touchSubagent, registerSubagent, type SubagentRun } from './index';
import { describeRun, finalMessageOf, summarizeChanges } from './report';
import { createWorktree, removeUnchangedWorktree, worktreeChanges } from './worktree';

export interface SubagentSpawnOptions extends SpawnOptions {
  model: string;
  thinkingLevel?: ThinkingLevel;
  callId?: string;
  definition?: AgentDefinition;
}

const WORKER_IDLE_MS = 15 * 60_000;
const IDLE_CHECK_MS = 30_000;

// What each working run is still doing, so cancelling one can wait for it to
// wind down. A run leaves it as it ends, and its status says so from then on.
const completions = new Map<string, Promise<void>>();
// Messages to the same worker are ordered, including two simultaneous resumes.
const messages = new Map<string, Promise<unknown>>();
const interrupted = new Set<string>();

export async function startSubagent(owner: SessionAgent, prompt: string, options: SubagentSpawnOptions): Promise<SubagentRun> {
  requireKnownModel(options.model);
  const id = `sub-${crypto.randomUUID().slice(0, 8)}`;
  const baseDirectory = options.cwd ?? owner.directory;
  const worktree = options.isolation === 'worktree' ? await createWorktree(baseDirectory, owner.sessionId, id) : null;
  const directory = worktree?.directory ?? baseDirectory;
  const worker = owner.createSubagent(id, options.model, options.thinkingLevel, directory, options.definition);
  let text = prompt;
  let recordedTask = prompt;
  if (options.context === 'owner') {
    const history = transcriptText(owner.transcript.entries());
    if (history) recordedTask = ['Earlier conversation of the agent that spawned you, for context:', history, '', prompt].join('\n');
    text = await worker.forkFrom(owner)
      ? [FORKED_WORKER_HANDOVER, options.definition?.prompt ?? '', 'Your task:', prompt].filter(Boolean).join('\n')
      : recordedTask;
  }
  const run: SubagentRun = {
    id,
    name: options.name,
    description: options.description,
    callId: options.callId ?? null,
    sessionId: owner.sessionId,
    owner: owner.name,
    worker,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    context: options.context ?? 'fresh',
    prompt,
    directory,
    baseDirectory,
    branch: worktree?.branch ?? null,
    startHead: worktree?.startHead,
    isolation: options.isolation ?? 'none',
    runInBackground: options.runInBackground ?? true,
    definition: options.definition,
    status: 'working',
    startedAt: Date.now(),
    finishedAt: null,
    updatedAt: Date.now(),
    transcript: worker.transcript.entries() as Message[],
    content: [],
    finalMessage: null,
    changes: [],
    error: null,
    reported: false,
    dismissed: false,
  };
  registerSubagent(run);
  startTurn(run, owner, text, recordedTask);
  return run;
}

export function checkSubagent(run: SubagentRun): Record<string, unknown> {
  return describeRun(run);
}

export function subagentDone(run: SubagentRun): Promise<void> {
  return completions.get(run.id) ?? Promise.resolve();
}

// The longest one tool call waits on workers, whatever it asked for. Both
// vendors give up on an MCP call that has been silent for five minutes, Codex
// at its tool_timeout_sec and Claude Code at its idle timeout for an HTTP
// server, and the answer of a call they gave up on reaches nobody.
export const TOOL_WAIT_LIMIT_MS = 270_000;

export async function waitSubagents(runs: SubagentRun[], timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(Promise.race([
      Promise.all(runs.map(subagentDone)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(timeoutMs, TOOL_WAIT_LIMIT_MS)); }),
    ]), signal);
    return runs.map(describeRun);
  } finally {
    clearTimeout(timer);
  }
}

// The owner of a foreground run waits for it in its SpawnAgent call. A wait
// that ends first, cancelled with the owner's turn or out of time, leaves the
// run working as a background one, so its report still reaches the owner when
// it ends rather than going to a call nobody is waiting on.
export async function awaitForeground(run: SubagentRun, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  try {
    await waitSubagents([run], timeoutMs, signal);
  } finally {
    if (run.status === 'working') run.runInBackground = true;
  }
}

export async function cancelSubagent(run: SubagentRun, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (run.status === 'working') run.worker?.cancel(new TurnCancelledError('Cancelled by CancelAgent'));
  await abortable(subagentDone(run), signal);
  return describeRun(run);
}

export async function messageSubagent(run: SubagentRun, owner: SessionAgent, text: string, interrupt = false): Promise<Record<string, unknown>> {
  const pending = (messages.get(run.id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (run.status === 'working' && !interrupt) {
      try {
        await run.worker!.steer(text);
        run.worker!.transcript.append({ seq: run.transcript.length, role: 'user', content: [{ type: 'text', text }] });
        touchSubagent(run);
        return { id: run.id, name: run.name, status: run.status, delivered: text };
      } catch (error) {
        // A completion can race steering. Only resume after the old turn has
        // ended; an actual steering failure on a live turn belongs to the caller.
        if (run.worker?.busy) throw error;
      }
    }
    interrupted.add(run.id);
    try {
      if (run.status === 'working') run.worker?.cancel(new TurnCancelledError('Interrupted by SendMessage'));
      await subagentDone(run);
    } finally {
      interrupted.delete(run.id);
    }
    if (run.isolation === 'worktree' && !run.branch) {
      const worktree = await createWorktree(run.baseDirectory ?? owner.directory, run.sessionId, run.id);
      run.worker?.resetRuntime();
      run.worker = null;
      run.nativeSession = undefined;
      run.directory = worktree?.directory ?? run.baseDirectory ?? owner.directory;
      run.branch = worktree?.branch ?? null;
      run.startHead = worktree?.startHead;
    }
    if (!run.worker) {
      run.worker = owner.createSubagent(run.id, run.model, run.thinkingLevel, run.directory, run.definition);
      if (run.nativeSession) run.worker.restoreNativeSession(run.nativeSession);
      for (const entry of run.transcript) run.worker.transcript.append(entry);
      run.transcript = run.worker.transcript.entries() as Message[];
    }
    run.runInBackground = true;
    startTurn(run, owner, text);
    touchSubagent(run);
    return { id: run.id, name: run.name, status: run.status, resumed: true };
  });
  messages.set(run.id, pending);
  try {
    return await pending;
  } finally {
    if (messages.get(run.id) === pending) messages.delete(run.id);
  }
}

function startTurn(run: SubagentRun, owner: SessionAgent, text: string, recordedTask = text): void {
  const task: Message = { seq: run.transcript.length, role: 'user', content: [{ type: 'text', text: recordedTask }] };
  const entry: Message = { seq: task.seq + 1, role: 'assistant', participant: run.id, model: run.model, content: [] };
  run.worker!.transcript.append(task);
  run.worker!.transcript.append(entry);
  run.content = entry.content;
  run.status = 'working';
  run.startedAt = Date.now();
  run.finishedAt = null;
  run.finalMessage = null;
  run.error = null;
  run.tokens = undefined;
  run.reported = false;
  run.dismissed = false;
  const completion = execute(run, owner, { text, task, entry });
  completions.set(run.id, completion);
  void completion.finally(() => {
    if (completions.get(run.id) === completion) completions.delete(run.id);
  });
}

async function execute(run: SubagentRun, owner: SessionAgent, turn: { text: string; task: Message; entry: Message }): Promise<void> {
  const worker = run.worker!;
  const watchdog = setInterval(() => {
    if (worker.quietFor >= WORKER_IDLE_MS) worker.cancel(new TurnCancelledError(`no activity for ${WORKER_IDLE_MS / 60_000} minutes`));
  }, IDLE_CHECK_MS);
  watchdog.unref?.();
  let status: SubagentRun['status'] = 'done';
  try {
    await worker.respond({ text: turn.text }, {
      entry: turn.entry, carried: [turn.task],
      onUpdate: () => { run.updatedAt = Date.now(); notifySubagentProgress(); },
    });
    run.finalMessage = finalMessageOf(turn.entry.content);
  } catch (error) {
    run.error = errorMessage(error);
    status = isAbortError(error) ? 'cancelled' : 'failed';
  } finally {
    clearInterval(watchdog);
    // Before an unchanged worktree's removal resets the runtime and its gauge.
    run.tokens = worker.context?.tokens;
    run.changes = summarizeChanges(run.transcript.flatMap(entry => entry.content), run.directory);
    if (run.branch && run.startHead) {
      const worktree = { directory: run.directory, branch: run.branch, startHead: run.startHead };
      const files = await worktreeChanges(worktree);
      for (const file of files) if (!run.changes.some(change => change.endsWith(` ${file}`))) run.changes.push(`Changed ${file}`);
      if (await removeUnchangedWorktree(run.baseDirectory ?? owner.directory, worktree)) {
        worker.resetRuntime();
        run.branch = null;
        run.directory = run.baseDirectory ?? owner.directory;
      }
    }
    run.status = status;
    run.finishedAt = Date.now();
    touchSubagent(run);
    if (!interrupted.has(run.id)) owner.workerFinished(run);
  }
}
