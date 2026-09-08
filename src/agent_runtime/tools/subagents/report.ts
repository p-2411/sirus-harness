import path from 'path';
import type { MessageBlock, ToolCallBlock, ToolResultBlock } from '../../types';
import type { SubagentRun } from './index';

// Everything a subagent run says about itself: to the model that asked, and
// as plain text in the stream file the owner can read while it works.

// Long enough that a caller rarely has to poll, short enough to stay under the
// tool-call timeouts of the provider runtimes a subscription model goes through.
export const CHECK_WAIT_LIMIT_MS = 60_000;
const PROGRESS_TAIL_CHARS = 2_000;
const RESULT_PREVIEW_CHARS = 120;
const COMMAND_PREVIEW_CHARS = 100;

export function describeSubagents(subagents: readonly SubagentRun[]): Record<string, unknown>[] {
  return subagents.map(run => ({
    id: run.id,
    model: run.model,
    status: run.status,
    elapsedSeconds: Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
    task: truncate(run.prompt, COMMAND_PREVIEW_CHARS),
    ...(run.streamFile ? { streamFile: run.streamFile } : {}),
  }));
}

export function describeRun(run: SubagentRun, waited: boolean): Record<string, unknown> {
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
    } else if (block.type === 'image') {
      lines.push(`[image ${path.basename(block.path)}]`);
    } else if (block.type === 'tool_call') {
      lines.push(`▸ ${block.name} ${previewArguments(block)}`);
    } else {
      const firstLine = block.result.split('\n').find(line => line.trim()) ?? '';
      lines.push(`  ${block.isError ? '✗' : '✓'} ${truncate(firstLine, RESULT_PREVIEW_CHARS)}`);
    }
  }
  return lines.join('\n');
}
