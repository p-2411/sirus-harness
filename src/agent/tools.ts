import { existsSync, readFileSync, writeFileSync } from 'fs';
import { readdir, readFile as readFileContents, stat } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import type { ToolCallBlock, ToolResultBlock } from '../data/data';
import {
  getDefaultMemoryStore,
  type MemoryLink,
  type MemoryScope,
  type MemorySearchScope,
} from '../memory/store';
import { isMemoryAccessEnabled } from './memory-access';
import { modelStrategies } from './chat';
import {
  CHECK_WAIT_LIMIT_MS,
  cancelSubagent,
  checkSubagent,
  describeSubagents,
  spawnSubagent,
} from './subagents';
import { abortReason, throwIfAborted } from '../abort';
import { authorizeToolCall, type PermissionContext } from './permissions';

export interface ToolArgumentSchema {
  type: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  description?: string;
  [key: string]: unknown;
}

// The host-side identity of one model-requested call, for tools whose effect
// outlives the call (a spawned subagent is tied back to the call that made it).
export interface ToolCallContext {
  callId: string;
  signal?: AbortSignal;
  // The permission context of the caller, inherited by anything it spawns.
  permissions?: PermissionContext;
}

export interface Tool {
  name: string;
  description: string;
  args: Record<string, ToolArgumentSchema>;
  func: (
    args: Record<string, unknown>,
    directory: string,
    call?: ToolCallContext,
  ) => unknown | Promise<unknown>;
}

export const toolRegistry: Tool[] = [
  {
    name: 'ReadFile',
    description: 'Read the UTF-8 contents of a file at the supplied path.',
    args: {
      path: {
        type: 'string',
        description: 'The path of the file to read.',
      },
    },
    func: readFile,
  },
  {
    name: 'WriteFile',
    description: 'Write UTF-8 content to a file, creating it if missing and replacing it if it already exists.',
    args: {
      path: {
        type: 'string',
        description: 'The path of the file to create or replace.',
      },
      content: {
        type: 'string',
        description: 'The complete UTF-8 content to write to the file.',
      },
    },
    func: writeFile,
  },
  {
    name: 'EditFile',
    description: 'Replace one exact, unique text occurrence in an existing UTF-8 file.',
    args: {
      path: {
        type: 'string',
        description: 'The path of the existing file to edit.',
      },
      old_text: {
        type: 'string',
        description: 'The exact text to replace. It must occur exactly once in the file.',
      },
      new_text: {
        type: 'string',
        description: 'The replacement text. It may be empty to delete the matched text.',
      },
    },
    func: editFile,
  },
  {
    name: 'RunShell',
    description: 'Run a non-interactive shell command in the current working directory and capture its output.',
    args: {
      command: {
        type: 'string',
        description: 'The shell command to execute. It has a 30-second timeout and a 1 MiB output limit.',
      },
    },
    func: runShell,
  },
  {
    name: 'SearchFiles',
    description: 'Search file contents under a directory for a regular expression and return the matching lines as path:line: text. Skips .git, node_modules, build output, binary files, and files over 1 MiB. Use it to find where something is defined or used before reading files.',
    args: {
      pattern: {
        type: 'string',
        description: 'A JavaScript regular expression, matched case-sensitively against each line.',
      },
      path: {
        type: 'string',
        description: 'The directory to search recursively, or a single file, relative to the working directory. Use "." for the whole workspace.',
      },
    },
    func: searchFiles,
  },
  {
    name: 'SaveMemory',
    description: 'Create or update a durable global or current-project memory and index it for semantic search.',
    args: {
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'Use global for cross-project user context or project for facts tied to this session directory.',
      },
      name: {
        type: 'string',
        description: 'A stable name unique within the selected scope.',
      },
      content: {
        type: 'string',
        description: 'The durable fact, preference, decision, or context to remember.',
      },
      links: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['global', 'project'] },
            name: { type: 'string' },
          },
          required: ['scope', 'name'],
          additionalProperties: false,
        },
        description: 'Scoped references to related memories. Global memories may only link to global memories.',
      },
    },
    func: saveMemory,
  },
  {
    name: 'GetMemory',
    description: 'Retrieve one global or current-project memory by exact scope and name.',
    args: {
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'The scope containing the memory.',
      },
      name: {
        type: 'string',
        description: 'The exact memory name.',
      },
    },
    func: getMemory,
  },
  {
    name: 'SearchMemories',
    description: 'Semantically search global memories, current-project memories, or both available scopes.',
    args: {
      scope: {
        type: 'string',
        enum: ['available', 'global', 'project'],
        description: 'Use available to search global plus this session directory; no other project is accessible.',
      },
      query: {
        type: 'string',
        description: 'A natural-language description of the memory to recall.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of matches to return, from 1 to 50.',
      },
    },
    func: searchMemories,
  },
  {
    name: 'DeleteMemory',
    description: 'Permanently delete a global or current-project memory by exact scope and name.',
    args: {
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'The scope containing the memory.',
      },
      name: {
        type: 'string',
        description: 'The exact memory name to delete.',
      },
    },
    func: deleteMemory,
  },
  {
    name: 'SpawnAgent',
    description: 'Start an autonomous subagent that works on one task in the current working directory with the same file, shell, and memory tools, and return immediately without waiting for it. Delegate self-contained work that does not need step-by-step supervision. The subagent sees only its prompt, cannot ask questions, and cannot spawn agents of its own. The result gives its id and the path of a temporary file where its output streams while it works; read that file or use CheckAgent to follow progress, and use CheckAgent with wait true to collect its final message and a summary of the changes it made.',
    // Resolved on access rather than at load: the model list lives in the
    // agent loop, which imports this module.
    get args(): Record<string, ToolArgumentSchema> {
      return {
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the subagent, including every detail it needs, because it does not see this conversation.',
        },
        model: {
          type: 'string',
          enum: Object.keys(modelStrategies),
          description: 'The model that runs the subagent.',
        },
      };
    },
    func: spawnAgent,
  },
  {
    name: 'CheckAgent',
    description: 'Report on a subagent started with SpawnAgent. While it is working the result includes its status and the tail of its output so far; once it has finished the result includes its final message and a summary of the changes it made, or the error if it failed.',
    // Lazy for the same reason as SpawnAgent: the subagent module imports the
    // agent loop, which imports this registry, and its constant is not
    // initialized yet when the UI loads the subagent module first.
    get args(): Record<string, ToolArgumentSchema> {
      return {
        id: {
          type: 'string',
          description: 'The subagent id returned by SpawnAgent.',
        },
        wait: {
          type: 'boolean',
          description: `true blocks until the subagent finishes, for up to ${CHECK_WAIT_LIMIT_MS / 1000} seconds before reporting it as still working; false returns its current state immediately.`,
        },
      };
    },
    func: checkAgent,
  },
  {
    name: 'CancelAgent',
    description: 'Stop a working subagent started with SpawnAgent. Waits for it to stop and returns its status with a summary of the changes it had already made. A subagent that has already finished is reported as it is.',
    args: {
      id: {
        type: 'string',
        description: 'The subagent id returned by SpawnAgent.',
      },
    },
    func: cancelAgent,
  },
  {
    name: 'ListAgents',
    description: 'List every subagent spawned in this Sirus process with its id, model, status, elapsed time, and task, to find one to check, wait for, or cancel.',
    args: {},
    func: listAgents,
  },
];

const memoryToolNames = new Set(['SaveMemory', 'GetMemory', 'SearchMemories', 'DeleteMemory']);
// A subagent works alone: it cannot spawn or inspect other subagents.
const agentToolNames = new Set(['SpawnAgent', 'CheckAgent', 'CancelAgent', 'ListAgents']);

export interface ToolAudience {
  subagent?: boolean;
}

export function availableTools(audience: ToolAudience = {}): Tool[] {
  const memoryEnabled = isMemoryAccessEnabled();
  return toolRegistry.filter(tool =>
    (memoryEnabled || !memoryToolNames.has(tool.name))
    && (!audience.subagent || !agentToolNames.has(tool.name)));
}

export function findTool(name: string): Tool | null {
  return toolRegistry.find((t) => t.name === name) ?? null;
}
export function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  directory: string = process.cwd(),
  call?: ToolCallContext,
): unknown | Promise<unknown> {
  const tool = toolRegistry.find(candidate => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  if (memoryToolNames.has(toolName) && !isMemoryAccessEnabled()) {
    throw new Error('Memory access is disabled. Use /memory on to enable it.');
  }

  return tool.func(args, directory, call);
}

function formatToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return 'Tool completed successfully.';
  return JSON.stringify(result) ?? String(result);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The one place a model-requested tool call turns into a result block, so the
// API loop and the subscription runtimes record identical history. It is also
// the permission gate: with a context, the call is classified against the
// session's mode and may wait on the user before it runs. A caller without
// a context is a direct programmatic one, not a model, and is not gated.
export async function runTool(
  toolCall: ToolCallBlock,
  directory: string = process.cwd(),
  signal?: AbortSignal,
  permissions?: PermissionContext,
): Promise<ToolResultBlock> {
  throwIfAborted(signal);
  const tool = findTool(toolCall.name);
  if (!tool) {
    return {
      type: 'tool_result',
      callId: toolCall.id,
      result: `Unknown tool: ${toolCall.name}`,
      isError: true,
    };
  }

  if (permissions) {
    const declined = await authorizeToolCall(toolCall, directory, permissions, signal);
    if (declined) {
      return { type: 'tool_result', callId: toolCall.id, result: declined, isError: true };
    }
  }

  try {
    return {
      type: 'tool_result',
      callId: toolCall.id,
      result: formatToolResult(
        await executeTool(toolCall.name, toolCall.arguments, directory, { callId: toolCall.id, signal, permissions }),
      ),
      isError: false,
    };
  } catch (error) {
    // Cancellation belongs to the turn, not to the model-visible tool result.
    // Re-throw it so no continuation request can begin after Escape.
    if (signal?.aborted) throw abortReason(signal);
    return {
      type: 'tool_result',
      callId: toolCall.id,
      result: errorMessage(error),
      isError: true,
    };
  }
}

function readFile(args: Record<string, unknown>, directory: string): string {
  const filePath = path.resolve(directory, requiredString(args, 'path', 'ReadFile'));

  return readFileSync(filePath, 'utf8');
}

function writeFile(args: Record<string, unknown>, directory: string): Record<string, unknown> {
  const filePath = path.resolve(directory, requiredString(args, 'path', 'WriteFile'));
  const content = requiredString(args, 'content', 'WriteFile', true);
  const created = !existsSync(filePath);

  writeFileSync(filePath, content, 'utf8');

  return {
    path: filePath,
    created,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
  };
}

function editFile(args: Record<string, unknown>, directory: string): Record<string, unknown> {
  const filePath = path.resolve(directory, requiredString(args, 'path', 'EditFile'));
  const oldText = requiredString(args, 'old_text', 'EditFile');
  const newText = requiredString(args, 'new_text', 'EditFile', true);
  const content = readFileSync(filePath, 'utf8');
  const firstMatch = content.indexOf(oldText);

  if (firstMatch === -1) {
    throw new Error(`EditFile could not find old_text in ${filePath}`);
  }

  if (content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
    throw new Error(`EditFile found multiple old_text matches in ${filePath}; include more surrounding context`);
  }

  const updated = content.slice(0, firstMatch) + newText + content.slice(firstMatch + oldText.length);
  writeFileSync(filePath, updated, 'utf8');

  return {
    path: filePath,
    replacements: 1,
    bytesWritten: Buffer.byteLength(updated, 'utf8'),
  };
}

function runShell(
  args: Record<string, unknown>,
  directory: string,
  call?: ToolCallContext,
): Promise<Record<string, unknown>> {
  const command = requiredString(args, 'command', 'RunShell');
  const signal = call?.signal;
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: directory,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const terminate = () => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else {
        child.kill('SIGKILL');
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminate();
      reject(error);
    };
    const onAbort = () => fail(abortReason(signal!));
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > 1024 * 1024) {
        fail(new Error('RunShell failed: output exceeded the 1 MiB limit'));
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    const timeout = setTimeout(
      () => fail(new Error(`RunShell failed: command timed out after 30 seconds${stderr.trim() ? `: ${stderr.trim()}` : ''}`)),
      30_000,
    );
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.on('error', error => {
      fail(new Error(`RunShell failed: ${error.message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, signal: exitSignal, stdout, stderr });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function saveMemory(args: Record<string, unknown>, directory: string) {
  return getDefaultMemoryStore().saveMemory(
    requiredMemoryScope(args, 'scope', 'SaveMemory'),
    directory,
    requiredString(args, 'name', 'SaveMemory'),
    requiredString(args, 'content', 'SaveMemory'),
    requiredMemoryLinks(args, 'links', 'SaveMemory'),
  );
}

function getMemory(args: Record<string, unknown>, directory: string) {
  const scope = requiredMemoryScope(args, 'scope', 'GetMemory');
  const name = requiredString(args, 'name', 'GetMemory');
  const memory = getDefaultMemoryStore().getMemory(scope, directory, name);
  return memory ?? { found: false, scope, name };
}

async function searchMemories(args: Record<string, unknown>, directory: string) {
  return getDefaultMemoryStore().searchMemories(
    requiredMemorySearchScope(args, 'scope', 'SearchMemories'),
    directory,
    requiredString(args, 'query', 'SearchMemories'),
    requiredInteger(args, 'limit', 'SearchMemories'),
  );
}

function deleteMemory(args: Record<string, unknown>, directory: string) {
  const scope = requiredMemoryScope(args, 'scope', 'DeleteMemory');
  const name = requiredString(args, 'name', 'DeleteMemory');
  return { scope, name, deleted: getDefaultMemoryStore().deleteMemory(scope, directory, name) };
}

const SEARCH_SKIPPED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', 'coverage', '.cache', '.next',
]);
// Environment files hold secrets; a broad pattern must not echo them into
// the transcript.
const isEnvironmentFile = (name: string) => name === '.env' || name.startsWith('.env.');
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
const SEARCH_LINE_PREVIEW_CHARS = 200;

// Content search that yields between files, so Escape can stop a walk of a
// large tree the same way it stops a shell command.
async function searchFiles(
  args: Record<string, unknown>,
  directory: string,
  call?: ToolCallContext,
): Promise<string> {
  const source = requiredString(args, 'pattern', 'SearchFiles');
  let pattern: RegExp;
  try {
    pattern = new RegExp(source);
  } catch (error) {
    throw new Error(`SearchFiles pattern is not a valid regular expression: ${errorMessage(error)}`);
  }
  const root = path.resolve(directory, requiredString(args, 'path', 'SearchFiles'));
  const signal = call?.signal;
  const displayPath = (file: string) => {
    const relative = path.relative(directory, file);
    return relative === '' ? '.' : relative.startsWith('..') ? file : relative;
  };

  const matches: string[] = [];
  let searchedFiles = 0;
  let matchedFiles = 0;
  let truncated = false;

  const searchFile = async (file: string) => {
    throwIfAborted(signal);
    const info = await stat(file);
    if (!info.isFile() || info.size > SEARCH_MAX_FILE_BYTES) return;
    const buffer = await readFileContents(file);
    if (buffer.subarray(0, 8192).includes(0)) return; // binary
    searchedFiles++;
    const lines = buffer.toString('utf8').split('\n');
    let matchedHere = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/\r$/, '');
      if (!pattern.test(line)) continue;
      if (!matchedHere) {
        matchedHere = true;
        matchedFiles++;
      }
      if (matches.length >= SEARCH_MAX_MATCHES) {
        truncated = true;
        return;
      }
      const preview = line.length > SEARCH_LINE_PREVIEW_CHARS
        ? `${line.slice(0, SEARCH_LINE_PREVIEW_CHARS)}…`
        : line;
      matches.push(`${displayPath(file)}:${index + 1}: ${preview}`);
    }
  };
  const walk = async (current: string) => {
    throwIfAborted(signal);
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SEARCH_SKIPPED_DIRECTORIES.has(entry.name)) await walk(full);
      } else if (entry.isFile() && !isEnvironmentFile(entry.name)) {
        await searchFile(full);
      }
    }
  };

  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    throw new Error(`SearchFiles could not find ${root}`);
  }
  if (rootInfo.isDirectory()) await walk(root);
  else await searchFile(root);

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (matches.length === 0) {
    return `No matches for /${source}/ under ${displayPath(root)} (${plural(searchedFiles, 'file')} searched).`;
  }
  const summary = `${matches.length}${truncated ? '+' : ''} ${matches.length === 1 && !truncated ? 'match' : 'matches'} in ${
    plural(matchedFiles, 'file')} (${plural(searchedFiles, 'file')} searched)${
    truncated ? `; showing the first ${SEARCH_MAX_MATCHES}` : ''}`;
  return [summary, ...matches].join('\n');
}

function spawnAgent(
  args: Record<string, unknown>,
  directory: string,
  call?: ToolCallContext,
): Record<string, unknown> {
  const run = spawnSubagent(
    requiredString(args, 'prompt', 'SpawnAgent'),
    requiredString(args, 'model', 'SpawnAgent'),
    directory,
    call?.callId ?? null,
    call?.signal,
    call?.permissions,
  );
  return {
    id: run.id,
    model: run.model,
    status: run.status,
    streamFile: run.streamFile,
    note: 'Running in the background. Follow progress by reading streamFile or calling CheckAgent; call CheckAgent with wait true to collect the final message and change summary.',
  };
}

function checkAgent(
  args: Record<string, unknown>,
  _directory: string,
  call?: ToolCallContext,
): Promise<Record<string, unknown>> {
  return checkSubagent(
    requiredString(args, 'id', 'CheckAgent'),
    requiredBoolean(args, 'wait', 'CheckAgent'),
    call?.signal,
  );
}

function cancelAgent(
  args: Record<string, unknown>,
  _directory: string,
  call?: ToolCallContext,
): Promise<Record<string, unknown>> {
  return cancelSubagent(requiredString(args, 'id', 'CancelAgent'), call?.signal);
}

function listAgents(): Record<string, unknown> {
  const subagents = describeSubagents();
  return subagents.length > 0
    ? { subagents }
    : { subagents, note: 'No subagent has been spawned in this Sirus process.' };
}

function requiredBoolean(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): boolean {
  const value = args[name];
  if (typeof value !== 'boolean') {
    throw new TypeError(`${toolName} requires ${name} to be a boolean`);
  }
  return value;
}

function requiredString(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
  allowEmpty = false,
): string {
  const value = args[name];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    const qualifier = allowEmpty ? 'a string' : 'a non-empty string';
    throw new TypeError(`${toolName} requires ${name} to be ${qualifier}`);
  }

  return value;
}

function requiredMemoryScope(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): MemoryScope {
  const value = args[name];
  if (value !== 'global' && value !== 'project') {
    throw new TypeError(`${toolName} requires ${name} to be global or project`);
  }
  return value;
}

function requiredMemorySearchScope(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): MemorySearchScope {
  const value = args[name];
  if (value !== 'available' && value !== 'global' && value !== 'project') {
    throw new TypeError(`${toolName} requires ${name} to be available, global, or project`);
  }
  return value;
}

function requiredMemoryLinks(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): MemoryLink[] {
  const value = args[name];
  if (!Array.isArray(value)) {
    throw new TypeError(`${toolName} requires ${name} to be an array of scoped memory references`);
  }
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`${toolName} requires every ${name} item to contain scope and name`);
    }
    const link = item as Record<string, unknown>;
    return {
      scope: requiredMemoryScope(link, 'scope', toolName),
      name: requiredString(link, 'name', toolName),
    };
  });
}

function requiredInteger(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${toolName} requires ${name} to be an integer`);
  }
  return value;
}
