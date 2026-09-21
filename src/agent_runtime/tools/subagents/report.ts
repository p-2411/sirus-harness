import path from 'path';
import type { MessageBlock, ToolCallBlock } from '../../types';
import type { SubagentRun } from './index';

// Everything a worker says about itself: to the model that asked after it,
// and as the report that reaches its owner when it ends.

const PROGRESS_TAIL_CHARS = 2_000;
const RESULT_PREVIEW_CHARS = 120;
const COMMAND_PREVIEW_CHARS = 100;

// What a run that was working when Sirus quit says instead of a final message.
export const INTERRUPTED_REASON = 'Sirus quit while it was working';

function elapsedSeconds(run: SubagentRun): number {
  return Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000);
}

export function describeSubagents(subagents: readonly SubagentRun[]): Record<string, unknown>[] {
  return subagents.map(run => ({
    id: run.id,
    model: run.model,
    thinkingLevel: run.thinkingLevel,
    status: run.status,
    elapsedSeconds: elapsedSeconds(run),
    task: truncate(run.prompt, COMMAND_PREVIEW_CHARS),
    branch: run.branch,
    context: run.context,
  }));
}

// The run as it stands right now. A working run shows the tail of what it has
// produced; a finished one shows what it ended with, which its owner has also
// received as a message.
export function describeRun(run: SubagentRun): Record<string, unknown> {
  const base = {
    id: run.id,
    model: run.model,
    thinkingLevel: run.thinkingLevel,
    status: run.status,
    elapsedSeconds: elapsedSeconds(run),
    ...(run.branch ? { branch: run.branch, worktree: run.directory } : {}),
  };
  if (run.status === 'working') {
    const transcript = renderTranscript(run.content);
    return {
      ...base,
      toolCalls: run.content.filter(block => block.type === 'tool_call').length,
      progress: transcript.length > PROGRESS_TAIL_CHARS
        ? `…${transcript.slice(-PROGRESS_TAIL_CHARS)}`
        : transcript,
      note: 'Still working. It reports back to you as a message when it ends; MessageAgent sends it instructions meanwhile.',
    };
  }
  if (run.status === 'failed') {
    return { ...base, error: run.error, changes: run.changes };
  }
  if (run.status === 'cancelled' || run.status === 'interrupted') {
    return { ...base, reason: run.error, changes: run.changes };
  }
  return { ...base, finalMessage: run.finalMessage, changes: run.changes };
}

// The message the owner receives when a worker ends: who it was, where its
// work is, what it touched and what it said. This is the whole of what the
// owner is told, so it names the branch rather than assuming the owner still
// remembers there was one.
export function workerReport(run: SubagentRun): string {
  const lines = [
    `Subagent ${run.id} ${run.status} after ${elapsedSeconds(run)}s on ${run.model} (${run.thinkingLevel}).`,
    `Task: ${truncate(run.prompt, COMMAND_PREVIEW_CHARS)}`,
  ];
  if (run.branch) {
    lines.push(
      `Its work is on branch ${run.branch}, in its own worktree at ${run.directory}, not in your working directory.`,
      'Merge that branch or inspect the worktree yourself, or tell the user to; nothing else will.',
    );
  }
  lines.push(run.changes.length > 0
    ? `Changes:\n${run.changes.map(change => `- ${change}`).join('\n')}`
    : 'Changes: none recorded.');
  if (run.status === 'done') lines.push(`Final message:\n${run.finalMessage ?? '(none)'}`);
  else if (run.status === 'failed') lines.push(`It failed: ${run.error ?? 'unknown error'}`);
  else lines.push(`It stopped: ${run.error ?? INTERRUPTED_REASON}`);
  return lines.join('\n');
}

// The subagent's closing words: whatever text follows its last tool call.
// A run that never used a tool, or only spoke before doing so, hands back all
// of its text instead.
export function finalMessageOf(content: readonly MessageBlock[]): string {
  let lastToolIndex = -1;
  content.forEach((block, index) => {
    if (block.type === 'tool_call') lastToolIndex = index;
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

// The paths a tool call touched: what the runtime listed, or the diffs it
// carried when it listed nothing.
function touchedPaths(call: ToolCallBlock): string[] {
  const paths = call.locations.map(location => location.path);
  if (paths.length > 0) return paths;
  return call.content.flatMap(block => block.type === 'diff' ? [block.path] : []);
}

// What the subagent did to the world, read off its completed tool calls
// rather than asked of the model, so it is complete and never invented. The
// vendor ran the tools; the kind and the locations say what they touched.
export function summarizeChanges(content: readonly MessageBlock[], directory: string): string[] {
  const files = new Map<string, Set<string>>();
  const commands: string[] = [];
  const memories: string[] = [];
  const touch = (target: string, verb: string) => {
    const key = displayPath(target, directory);
    let verbs = files.get(key);
    if (!verbs) {
      verbs = new Set();
      files.set(key, verbs);
    }
    verbs.add(verb);
  };

  for (const block of content) {
    if (block.type !== 'tool_call' || block.status !== 'completed') continue;
    switch (block.kind) {
      case 'edit':
        for (const target of touchedPaths(block)) touch(target, 'Edited');
        break;
      case 'delete':
        for (const target of touchedPaths(block)) touch(target, 'Deleted');
        break;
      case 'move':
        for (const target of touchedPaths(block)) touch(target, 'Moved');
        break;
      case 'execute':
        commands.push(block.title);
        break;
      default: {
        // Sirus's own memory tools arrive as ordinary calls named after them.
        const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
        if (/\bSaveMemory\b/.test(block.title)) memories.push(`Saved ${String(input.scope)} memory "${String(input.name)}"`);
        else if (/\bDeleteMemory\b/.test(block.title)) memories.push(`Deleted ${String(input.scope)} memory "${String(input.name)}"`);
      }
    }
  }

  const summary: string[] = [];
  for (const [file, verbs] of files) summary.push(`${[...verbs].join(' and ')} ${file}`);
  for (const command of commands) summary.push(`Ran: ${truncate(command, COMMAND_PREVIEW_CHARS)}`);
  summary.push(...memories);
  return summary;
}

function displayPath(target: string, directory: string): string {
  const absolute = path.resolve(directory, target);
  const relative = path.relative(directory, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
}

function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

// The subagent's record as plain text: what it said, what it called, and
// how each call ended.
export function renderTranscript(content: readonly MessageBlock[]): string {
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) lines.push(block.text);
    } else if (block.type === 'image') {
      lines.push(`[image ${path.basename(block.path)}]`);
    } else if (block.type === 'tool_call') {
      const mark = block.status === 'completed' ? '✓' : block.status === 'failed' ? '✗' : '…';
      lines.push(`${mark} ${block.kind} ${truncate(block.title, RESULT_PREVIEW_CHARS)}`);
    }
  }
  return lines.join('\n');
}
