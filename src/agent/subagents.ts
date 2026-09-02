import crypto from 'crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Message, MessageBlock, ToolCallBlock, ToolResultBlock } from '../data/data';
import { clearSessionRuntime, getResponse, modelStrategies } from './chat';
import type { PermissionContext } from './permissions';
import { abortable, abortReason, TurnCancelledError } from '../abort';

// A subagent is one detached run of the agent loop: it receives a single
// task, works with the ordinary tools in the caller's directory, and hands
// back a final message plus a summary of what it changed. While it runs its
// transcript streams into a temporary file so the caller can look in on it.

export type SubagentStatus = 'working' | 'done' | 'failed' | 'cancelled';

export interface SubagentRun {
  id: string;
  // The SpawnAgent tool call that started the run, so the UI can decorate it.
  callId: string | null;
  model: string;
  prompt: string;
  directory: string;
  status: SubagentStatus;
  streamFile: string | null;
  startedAt: number;
  finishedAt: number | null;
  content: MessageBlock[];
  finalMessage: string | null;
  changes: string[];
  error: string | null;
  // The spawning session's permission context: the run answers to that
  // session's mode and prompts, as itself.
  permissions: PermissionContext | null;
}

// Long enough that a caller rarely has to poll, short enough to stay under the
// tool-call timeouts of the provider runtimes a subscription model goes through.
export const CHECK_WAIT_LIMIT_MS = 60_000;
const PROGRESS_TAIL_CHARS = 2_000;
const RESULT_PREVIEW_CHARS = 120;
const COMMAND_PREVIEW_CHARS = 100;

const runs = new Map<string, SubagentRun>();
const completions = new Map<string, Promise<void>>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let version = 0;
let exitCleanupInstalled = false;

function notifyListeners(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribeSubagents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Monotonic counter for useSyncExternalStore; runs are mutated in place.
export function getSubagentsVersion(): number {
  return version;
}

export function getSubagent(id: string): SubagentRun | undefined {
  return runs.get(id);
}

export function findSubagentByCall(callId: string): SubagentRun | undefined {
  for (const run of runs.values()) {
    if (run.callId === callId) return run;
  }
  return undefined;
}

export function listSubagents(): SubagentRun[] {
  return [...runs.values()];
}

export function activeSubagentCount(): number {
  let count = 0;
  for (const run of runs.values()) {
    if (run.status === 'working') count++;
  }
  return count;
}

export function spawnSubagent(
  prompt: string,
  model: string,
  directory: string,
  callId: string | null = null,
  parentSignal?: AbortSignal,
  parentPermissions?: PermissionContext,
): SubagentRun {
  if (!modelStrategies[model]) {
    throw new Error(`Unknown model "${model}". Try: ${Object.keys(modelStrategies).join(', ')}`);
  }
  const run: SubagentRun = {
    id: `sub-${crypto.randomUUID().slice(0, 8)}`,
    callId,
    model,
    prompt,
    directory,
    status: 'working',
    streamFile: null,
    startedAt: Date.now(),
    finishedAt: null,
    content: [],
    finalMessage: null,
    changes: [],
    error: null,
    permissions: null,
  };
  if (parentPermissions) {
    run.permissions = { ...parentPermissions, requester: { subagent: run.id }, model };
  }
  runs.set(run.id, run);
  const controller = new AbortController();
  controllers.set(run.id, controller);
  if (parentSignal?.aborted) {
    controller.abort(new TurnCancelledError());
  } else {
    parentSignal?.addEventListener(
      'abort',
      () => controller.abort(new TurnCancelledError()),
      { once: true },
    );
  }
  run.streamFile = createStreamFile(run);
  installExitCleanup();
  completions.set(run.id, execute(run, controller.signal));
  notifyListeners();
  return run;
}

function requireRun(id: string): SubagentRun {
  const run = runs.get(id);
  if (run) return run;
  const known = [...runs.keys()];
  throw new Error(known.length > 0
    ? `Unknown subagent "${id}". Known subagents: ${known.join(', ')}`
    : `Unknown subagent "${id}". No subagent has been spawned yet.`);
}

export async function checkSubagent(
  id: string,
  wait: boolean,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const run = requireRun(id);
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
export async function cancelSubagent(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const run = requireRun(id);
  const controller = controllers.get(id);
  if (run.status === 'working' && controller && !controller.signal.aborted) {
    controller.abort(new TurnCancelledError('Cancelled by CancelAgent'));
  }
  if (run.status === 'working') {
    await abortable(completions.get(id) ?? Promise.resolve(), signal);
  }
  return describeRun(run, false);
}

export function describeSubagents(): Record<string, unknown>[] {
  return [...runs.values()].map(run => ({
    id: run.id,
    model: run.model,
    status: run.status,
    elapsedSeconds: Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
    task: truncate(run.prompt, COMMAND_PREVIEW_CHARS),
    ...(run.streamFile ? { streamFile: run.streamFile } : {}),
  }));
}

export function cancelAllSubagents(): number {
  let cancelled = 0;
  for (const [id, controller] of controllers) {
    if (runs.get(id)?.status !== 'working' || controller.signal.aborted) continue;
    controller.abort(new TurnCancelledError());
    cancelled++;
  }
  return cancelled;
}

async function execute(run: SubagentRun, signal: AbortSignal): Promise<void> {
  const runtimeId = `subagents/${run.id}`;
  const task: Message = { role: 'user', content: [{ type: 'text', text: run.prompt }] };
  try {
    const response = await getResponse(
      [task],
      run.model,
      runtimeId,
      run.directory,
      undefined,
      undefined,
      partial => {
        run.content = partial.content;
        writeStreamFile(run);
      },
      true,
      signal,
      run.permissions ?? undefined,
    );
    run.content = response.content;
    run.finalMessage = finalMessageOf(response.content);
    run.status = 'done';
  } catch (error) {
    if (signal.aborted) {
      run.error = abortReason(signal).message;
      run.status = 'cancelled';
    } else {
      run.error = error instanceof Error ? error.message : String(error);
      run.status = 'failed';
    }
  } finally {
    // Whatever happened, the changes made so far are what the caller must know about.
    run.changes = summarizeChanges(run.content, run.directory);
    run.finishedAt = Date.now();
    controllers.delete(run.id);
    removeStreamFile(run);
    clearSessionRuntime(runtimeId);
    notifyListeners();
  }
}

function describeRun(run: SubagentRun, waited: boolean): Record<string, unknown> {
  const finishedAt = run.finishedAt ?? Date.now();
  const base = {
    id: run.id,
    model: run.model,
    status: run.status,
    elapsedSeconds: Math.round((finishedAt - run.startedAt) / 1000),
  };
  if (run.status === 'working') {
    const transcript = renderTranscript(run.content);
    return {
      ...base,
      streamFile: run.streamFile,
      toolCalls: run.content.filter(block => block.type === 'tool_call').length,
      progress: transcript.length > PROGRESS_TAIL_CHARS
        ? `…${transcript.slice(-PROGRESS_TAIL_CHARS)}`
        : transcript,
      note: waited
        ? `Still working after waiting ${CHECK_WAIT_LIMIT_MS / 1000} seconds. Call CheckAgent again with wait true to keep waiting.`
        : 'Call CheckAgent with wait true to block until it finishes.',
    };
  }
  if (run.status === 'failed') {
    return { ...base, error: run.error, changes: run.changes };
  }
  if (run.status === 'cancelled') {
    return { ...base, reason: run.error, changes: run.changes };
  }
  return { ...base, finalMessage: run.finalMessage, changes: run.changes };
}

// The subagent's closing words: whatever text follows its last tool round.
// A run that never used a tool, or only spoke before doing so, hands back all
// of its text instead.
export function finalMessageOf(content: readonly MessageBlock[]): string {
  let lastToolIndex = -1;
  content.forEach((block, index) => {
    if (block.type !== 'text') lastToolIndex = index;
  });
  const textOf = (blocks: readonly MessageBlock[]) => blocks
    .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  return textOf(content.slice(lastToolIndex + 1))
    || textOf(content)
    || '(the subagent finished without a final message)';
}

interface FileChange {
  created: boolean;
  replaced: boolean;
  edits: number;
}

// What the subagent did to the world, read off its successful tool calls
// rather than asked of the model, so it is complete and never invented.
export function summarizeChanges(content: readonly MessageBlock[], directory: string): string[] {
  const results = new Map<string, ToolResultBlock>();
  for (const block of content) {
    if (block.type === 'tool_result') results.set(block.callId, block);
  }

  const files = new Map<string, FileChange>();
  const commands: string[] = [];
  const memories: string[] = [];
  const fileChange = (target: string): FileChange => {
    const key = displayPath(target, directory);
    let change = files.get(key);
    if (!change) {
      change = { created: false, replaced: false, edits: 0 };
      files.set(key, change);
    }
    return change;
  };

  for (const block of content) {
    if (block.type !== 'tool_call') continue;
    const result = results.get(block.id);
    if (!result || result.isError) continue;
    const args = block.arguments;
    switch (block.name) {
      case 'WriteFile': {
        if (typeof args.path !== 'string') break;
        const change = fileChange(args.path);
        if (parsedField(result.result, 'created') === true) change.created = true;
        else change.replaced = true;
        break;
      }
      case 'EditFile':
        if (typeof args.path === 'string') fileChange(args.path).edits++;
        break;
      case 'RunShell':
        if (typeof args.command === 'string') commands.push(args.command);
        break;
      case 'SaveMemory':
        memories.push(`Saved ${String(args.scope)} memory "${String(args.name)}"`);
        break;
      case 'DeleteMemory':
        if (parsedField(result.result, 'deleted') === true) {
          memories.push(`Deleted ${String(args.scope)} memory "${String(args.name)}"`);
        }
        break;
    }
  }

  const summary: string[] = [];
  for (const [file, change] of files) {
    const verb = change.created ? 'Created' : change.replaced ? 'Replaced' : 'Edited';
    const edits = change.edits > 0 && (change.created || change.replaced)
      ? `, then made ${change.edits} edit${change.edits === 1 ? '' : 's'}`
      : change.edits > 1 ? ` (${change.edits} edits)` : '';
    summary.push(`${verb} ${file}${edits}`);
  }
  for (const command of commands) summary.push(`Ran: ${truncate(command, COMMAND_PREVIEW_CHARS)}`);
  summary.push(...memories);
  return summary;
}

function displayPath(target: string, directory: string): string {
  const absolute = path.resolve(directory, target);
  const relative = path.relative(directory, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
}

function parsedField(json: string, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[field] : undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function previewArguments(toolCall: ToolCallBlock): string {
  const entries = Object.entries(toolCall.arguments).map(([name, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    return `${name}: ${truncate(text, RESULT_PREVIEW_CHARS)}`;
  });
  return entries.join(', ');
}

// The subagent's transcript as plain text: what it said, what it called, and
// the first line of what came back.
export function renderTranscript(content: readonly MessageBlock[]): string {
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) lines.push(block.text);
    } else if (block.type === 'tool_call') {
      lines.push(`▸ ${block.name} ${previewArguments(block)}`);
    } else {
      const firstLine = block.result.split('\n').find(line => line.trim()) ?? '';
      lines.push(`  ${block.isError ? '✗' : '✓'} ${truncate(firstLine, RESULT_PREVIEW_CHARS)}`);
    }
  }
  return lines.join('\n');
}

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

// The stream file is a convenience for looking in on a run; losing it must
// never fail the run itself.
function createStreamFile(run: SubagentRun): string | null {
  const file = path.join(streamDirectory(), `${run.id}.log`);
  try {
    mkdirSync(streamDirectory(), { recursive: true, mode: 0o700 });
    writeFileSync(file, streamContents(run), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

function writeStreamFile(run: SubagentRun): void {
  if (!run.streamFile) return;
  try {
    writeFileSync(run.streamFile, streamContents(run), 'utf8');
  } catch {
    // ignore: the transcript stays available through CheckAgent
  }
}

function removeStreamFile(run: SubagentRun): void {
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
function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.on('exit', () => {
    for (const run of runs.values()) removeStreamFile(run);
  });
}
