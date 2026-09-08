import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { availableTools, toolRegistry } from '../../src/agent_runtime/tools';
import { createToolbox } from '../../src/agent_runtime/tools/toolbox';
import type { ToolCallBlock, ToolResultBlock } from '../../src/agent_runtime/types';
import { saveMemoryAccessPreference } from '../../src/persistence';

let testDirectory: string;
let previousDataDirectory: string | undefined;

const findTool = (name: string) => toolRegistry.find(tool => tool.name === name) ?? null;

// The registry as a direct caller sees it: no gate, no barrier.
function executeTool(
  name: string,
  args: Record<string, unknown>,
  directory: string = process.cwd(),
  call: { callId?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args, { directory, callId: call.callId ?? 'direct', ...(call.signal ? { signal: call.signal } : {}) });
}

function runTool(call: ToolCallBlock, directory: string = process.cwd()): Promise<ToolResultBlock> {
  return createToolbox({ directory }).run(call);
}

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'sirus-tools-'));
  previousDataDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = testDirectory;
});

afterEach(() => {
  if (previousDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = previousDataDirectory;
  rmSync(testDirectory, { recursive: true, force: true });
});

describe('agent tools', () => {
  test('registers file, shell, and memory tools', () => {
    expect(toolRegistry.map(tool => tool.name)).toEqual([
      'ReadFile',
      'WriteFile',
      'EditFile',
      'RunShell',
      'SearchFiles',
      'SaveMemory',
      'GetMemory',
      'SearchMemories',
      'DeleteMemory',
      'SpawnAgent',
      'CheckAgent',
      'CancelAgent',
      'ListAgents',
    ]);
    expect(findTool('WriteFile')?.args).toEqual(expect.objectContaining({
      path: expect.objectContaining({ type: 'string' }),
      content: expect.objectContaining({ type: 'string' }),
    }));
    expect(findTool('EditFile')?.args).toEqual(expect.objectContaining({
      path: expect.objectContaining({ type: 'string' }),
      old_text: expect.objectContaining({ type: 'string' }),
      new_text: expect.objectContaining({ type: 'string' }),
    }));
    expect(findTool('RunShell')?.args).toEqual(expect.objectContaining({
      command: expect.objectContaining({ type: 'string' }),
    }));
    expect(findTool('SaveMemory')?.args).toEqual(expect.objectContaining({
      scope: expect.objectContaining({ type: 'string', enum: ['global', 'project'] }),
      name: expect.objectContaining({ type: 'string' }),
      content: expect.objectContaining({ type: 'string' }),
      links: expect.objectContaining({
        type: 'array',
        items: expect.objectContaining({ type: 'object' }),
      }),
    }));
    expect(findTool('SearchMemories')?.args).toEqual(expect.objectContaining({
      scope: expect.objectContaining({ type: 'string', enum: ['available', 'global', 'project'] }),
      query: expect.objectContaining({ type: 'string' }),
      limit: expect.objectContaining({ type: 'integer' }),
    }));
  });

  test('describes scoped memory without exposing a directory argument', () => {
    expect(findTool('SaveMemory')?.description).toContain('global');
    expect(findTool('SaveMemory')?.description).toContain('current-project');
    expect(findTool('SearchMemories')?.args.scope?.description).toContain('no other project');
    for (const name of ['SaveMemory', 'GetMemory', 'SearchMemories', 'DeleteMemory']) {
      expect(findTool(name)?.args).not.toHaveProperty('directory');
    }
  });

  test('rejects invalid memory scopes before opening the store', async () => {
    const result = await runTool({
      type: 'tool_call',
      id: 'memory_scope_1',
      name: 'GetMemory',
      arguments: { scope: 'another-project', name: 'private' },
    }, testDirectory);

    expect(result).toMatchObject({ isError: true, callId: 'memory_scope_1' });
    expect(result.result).toContain('global or project');
  });

  test('WriteFile creates and replaces UTF-8 files', async () => {
    const path = join(testDirectory, 'memory.md');

    const created = await executeTool('WriteFile', { path, content: 'first 🐎' });
    expect(created).toMatchObject({ path, created: true });
    expect(readFileSync(path, 'utf8')).toBe('first 🐎');

    const replaced = await executeTool('WriteFile', { path, content: 'second' });
    expect(replaced).toMatchObject({ path, created: false });
    expect(readFileSync(path, 'utf8')).toBe('second');
  });

  test('WriteFile permits empty content', async () => {
    const path = join(testDirectory, 'empty.txt');

    expect(await executeTool('WriteFile', { path, content: '' })).toMatchObject({ bytesWritten: 0 });
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  test('EditFile replaces one exact occurrence and supports deletion', async () => {
    const path = join(testDirectory, 'source.ts');
    writeFileSync(path, 'const first = 1;\nconst second = 2;\n', 'utf8');

    expect(await executeTool('EditFile', {
      path,
      old_text: 'const first = 1;',
      new_text: 'const first = 10;',
    })).toMatchObject({ path, replacements: 1 });

    await executeTool('EditFile', {
      path,
      old_text: 'const second = 2;\n',
      new_text: '',
    });

    expect(readFileSync(path, 'utf8')).toBe('const first = 10;\n');
  });

  test('EditFile rejects missing and ambiguous matches without changing the file', async () => {
    const path = join(testDirectory, 'repeated.txt');
    writeFileSync(path, 'same\nsame\n', 'utf8');

    await expect(executeTool('EditFile', {
      path,
      old_text: 'missing',
      new_text: 'replacement',
    })).rejects.toThrow('could not find');

    await expect(executeTool('EditFile', {
      path,
      old_text: 'same',
      new_text: 'replacement',
    })).rejects.toThrow('multiple');

    expect(readFileSync(path, 'utf8')).toBe('same\nsame\n');
  });

  test('runTool reports invalid edit arguments as a tool error', async () => {
    const result = await runTool({
      type: 'tool_call',
      id: 'edit_1',
      name: 'EditFile',
      arguments: { path: join(testDirectory, 'file.txt'), old_text: '', new_text: 'x' },
    });

    expect(result).toMatchObject({
      type: 'tool_result',
      callId: 'edit_1',
      isError: true,
    });
    expect(result.result).toContain('old_text');
  });

  test('RunShell captures stdout, stderr, and a successful exit code', async () => {
    const result = await executeTool('RunShell', {
      command: "printf 'hello'; printf 'warning' >&2",
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: 'hello',
      stderr: 'warning',
    });
  });

  test('resolves relative file and shell paths from the owning session directory', async () => {
    writeFileSync(join(testDirectory, 'owned.txt'), 'session file', 'utf8');

    expect(await executeTool('ReadFile', { path: 'owned.txt' }, testDirectory)).toBe('session file');
    expect(await executeTool('RunShell', { command: 'pwd' }, testDirectory)).toMatchObject({
      stdout: `${realpathSync(testDirectory)}\n`,
    });
  });

  test('RunShell returns non-zero command exits without losing their output', async () => {
    const result = await executeTool('RunShell', {
      command: "printf 'failed' >&2; exit 7",
    });

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: '',
      stderr: 'failed',
    });
  });

  test('RunShell terminates immediately when its turn is aborted', async () => {
    const controller = new AbortController();
    const command = executeTool('RunShell', {
      command: `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
    }, testDirectory, { callId: 'shell_abort', signal: controller.signal });

    controller.abort();

    await expect(command).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('runTool reports an empty shell command as a tool error', async () => {
    const result = await runTool({
      type: 'tool_call',
      id: 'shell_1',
      name: 'RunShell',
      arguments: { command: '' },
    });

    expect(result).toMatchObject({
      type: 'tool_result',
      callId: 'shell_1',
      isError: true,
    });
    expect(result.result).toContain('command');
  });

  test('disabled memory is hidden from providers and rejects direct calls', async () => {
    expect(saveMemoryAccessPreference(false, testDirectory)).toBe(true);
    expect(availableTools().map(tool => tool.name)).toEqual([
      'ReadFile',
      'WriteFile',
      'EditFile',
      'RunShell',
      'SearchFiles',
      'SpawnAgent',
      'CheckAgent',
      'CancelAgent',
      'ListAgents',
    ]);

    const result = await runTool({
      type: 'tool_call',
      id: 'memory_1',
      name: 'GetMemory',
      arguments: { name: 'anything' },
    });
    expect(result).toMatchObject({
      type: 'tool_result',
      callId: 'memory_1',
      isError: true,
    });
    expect(result.result).toContain('/memory on');
  });

  test('a subagent cannot delegate: SpawnAgent is hidden and refused by name', async () => {
    const call: ToolCallBlock = {
      type: 'tool_call',
      id: 'spawn_1',
      name: 'SpawnAgent',
      arguments: { prompt: 'Do the work', model: 'test-model' },
    };

    const worker = createToolbox({ directory: testDirectory, audience: { subagent: true } });
    expect(worker.tools.map(tool => tool.name)).not.toContain('SpawnAgent');
    const refused = await worker.run(call);
    expect(refused).toMatchObject({
      type: 'tool_result',
      callId: 'spawn_1',
      isError: true,
    });
    expect(refused.result).toContain('Unknown tool: SpawnAgent');

    // The same call on an ordinary toolbox reaches the tool. It still fails
    // here — this toolbox has no subagent host — but never as an unknown name.
    const owner = createToolbox({ directory: testDirectory });
    expect(owner.tools.map(tool => tool.name)).toContain('SpawnAgent');
    expect((await owner.run(call)).result).not.toContain('Unknown tool: SpawnAgent');
  });
});
