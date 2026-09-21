import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EmbeddingProvider } from '../../src/memory/embeddings';

// The local embedding model is a download the memory tools do not need for
// these tests: the store only asks for a vector of the declared size.
class TestEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-embedding-v1';
  readonly dimensions = 3;

  async embed(text: string): Promise<Float32Array> {
    const length = Math.max(1, text.length);
    return new Float32Array([1 / length, 1 - 1 / length, 0.5]);
  }
}

const embeddings = await import('../../src/memory/embeddings');
mock.module('../../src/memory/embeddings', () => ({ ...embeddings, LocalEmbeddingProvider: TestEmbeddingProvider }));

const { availableTools, toolRegistry } = await import('../../src/agent_runtime/tools');
const {
  registerToolSession,
  sirusMcpServerEntry,
  stopSirusMcpServer,
  unregisterToolSession,
} = await import('../../src/agent_runtime/tools/server');
const { closeAllMemoryStores } = await import('../../src/memory/store');
const { saveMemoryAccessPreference } = await import('../../src/persistence');

type SubagentHost = import('../../src/agent_runtime/tools').SubagentHost;
type SubagentSpawnCall = import('../../src/agent_runtime/tools').SubagentSpawnCall;
type WorkerContext = import('../../src/agent_runtime/tools').WorkerContext;

const MEMORY_TOOLS = ['SaveMemory', 'GetMemory', 'SearchMemories', 'DeleteMemory'];
const AGENT_TOOLS = ['SpawnAgent', 'CheckAgent', 'MessageAgent', 'CancelAgent', 'ListAgents'];
const SESSION = 'tools-test-session';

let testDirectory: string;
let previousDataDirectory: string | undefined;
let memoryOn: boolean;
let spawned: { prompt: string; context: WorkerContext; call: SubagentSpawnCall }[];
let messaged: { id: string; text: string }[];

const findTool = (name: string) => toolRegistry.find(tool => tool.name === name) ?? null;

const stubHost: SubagentHost = {
  async spawn(prompt, context, call) {
    spawned.push({ prompt, context, call });
    return {
      id: 'run-1',
      model: 'stub-model',
      thinkingLevel: 'high',
      status: 'working',
      branch: 'sirus/run-1',
      context,
    };
  },
  check(id) { return { id, status: 'done' }; },
  async cancel(id) { return { id, status: 'cancelled' }; },
  async message(id, text) {
    messaged.push({ id, text });
    return { id, status: 'working', delivered: text };
  },
  list() { return spawned.map((run, index) => ({ id: `run-${index + 1}`, task: run.prompt })); },
};

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'sirus-tools-'));
  previousDataDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = testDirectory;
  memoryOn = true;
  spawned = [];
  messaged = [];
  registerToolSession(SESSION, {
    directory: testDirectory,
    memoryEnabled: () => memoryOn,
    // Only sirus may delegate here; any other participant has no host.
    hostFor: participant => participant === 'sirus' ? stubHost : null,
  });
});

afterEach(() => {
  unregisterToolSession(SESSION);
  closeAllMemoryStores();
  if (previousDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = previousDataDirectory;
  rmSync(testDirectory, { recursive: true, force: true });
});

afterAll(() => {
  stopSirusMcpServer();
  // Idempotent: the app's shutdown may run it after a test already has.
  stopSirusMcpServer();
});

// The MCP client as a runtime would be configured: the entry's URL and
// headers, with the token or the requester header overridden to test refusal.
async function connect(
  requester: string,
  override: { token?: string; requester?: string | null } = {},
): Promise<Client> {
  const entry = await sirusMcpServerEntry(SESSION, requester);
  expect(entry.name).toBe('sirus');
  const headers = Object.fromEntries(entry.headers.map(header => [header.name, header.value]));
  if (override.token !== undefined) headers.Authorization = `Bearer ${override.token}`;
  if (override.requester === null) delete headers['X-Sirus-Requester'];
  const client = new Client({ name: 'tools-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } }));
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map(tool => tool.name);
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const [block] = result.content as { type: string; text: string }[];
  expect(block.type).toBe('text');
  return { text: block.text, isError: result.isError === true };
}

describe('tool registry', () => {
  test('registers the memory tools then the agent tools', () => {
    expect(toolRegistry.map(tool => tool.name)).toEqual([...MEMORY_TOOLS, ...AGENT_TOOLS]);
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
    for (const name of MEMORY_TOOLS) {
      expect(findTool(name)?.args).not.toHaveProperty('directory');
    }
  });

  test('SpawnAgent takes the prompt and an optional context; the model is a session setting', () => {
    const spawn = findTool('SpawnAgent');
    expect(Object.keys(spawn?.args ?? {})).toEqual(['prompt', 'context']);
    expect(spawn?.args.prompt).toEqual(expect.objectContaining({ type: 'string' }));
    expect(spawn?.args.context).toEqual(expect.objectContaining({ type: 'string', enum: ['fresh', 'owner'], default: 'fresh' }));
    expect(spawn?.description).toContain('/model subagent');
    // The owner is told what it gets back: an id, not a finished result.
    expect(spawn?.description).toContain('return immediately');
    expect(spawn?.description).toContain('starts your next turn');
    for (const name of AGENT_TOOLS) {
      expect(findTool(name)?.audience).toEqual({ subagent: false });
    }
  });

  test('CheckAgent no longer waits and MessageAgent carries an id and a message', () => {
    expect(Object.keys(findTool('CheckAgent')?.args ?? {})).toEqual(['id']);
    expect(findTool('CheckAgent')?.description).toContain('never waits');
    expect(Object.keys(findTool('MessageAgent')?.args ?? {})).toEqual(['id', 'message']);
    expect(Object.keys(findTool('CancelAgent')?.args ?? {})).toEqual(['id']);
    expect(Object.keys(findTool('ListAgents')?.args ?? {})).toEqual([]);
  });

  test('a subagent audience sees no agent tools and disabled memory hides the memory tools', () => {
    expect(availableTools().map(tool => tool.name)).toEqual([...MEMORY_TOOLS, ...AGENT_TOOLS]);
    expect(availableTools({ subagent: true }).map(tool => tool.name)).toEqual(MEMORY_TOOLS);

    expect(saveMemoryAccessPreference(false)).toBe(true);
    expect(availableTools().map(tool => tool.name)).toEqual(AGENT_TOOLS);
    expect(availableTools({ subagent: true })).toEqual([]);
  });
});

describe('Sirus MCP server', () => {
  test('lists every tool to a participant and only the memory tools to a worker', async () => {
    const participant = await connect('sirus');
    const worker = await connect('subagent:run-1');
    try {
      expect(await toolNames(participant)).toEqual([...MEMORY_TOOLS, ...AGENT_TOOLS]);
      expect(await toolNames(worker)).toEqual(MEMORY_TOOLS);

      // An argument with a default is the one kind a caller may leave out.
      const spawn = (await participant.listTools()).tools.find(tool => tool.name === 'SpawnAgent');
      expect(spawn?.inputSchema).toEqual({
        type: 'object',
        properties: {
          prompt: expect.objectContaining({ type: 'string' }),
          context: expect.objectContaining({ enum: ['fresh', 'owner'], default: 'fresh' }),
        },
        required: ['prompt'],
      });
    } finally {
      await participant.close();
      await worker.close();
    }
  });

  test('SaveMemory then GetMemory round-trips through the store in the data directory', async () => {
    const client = await connect('sirus');
    try {
      const saved = await call(client, 'SaveMemory', {
        scope: 'project',
        name: 'preferred-database',
        content: 'The project uses SQLite for local storage.',
      });
      expect(saved.isError).toBe(false);
      expect(JSON.parse(saved.text)).toMatchObject({ name: 'preferred-database', scope: 'project' });

      const fetched = await call(client, 'GetMemory', { scope: 'project', name: 'preferred-database' });
      expect(fetched.isError).toBe(false);
      expect(JSON.parse(fetched.text)).toMatchObject({
        scope: 'project',
        name: 'preferred-database',
        content: 'The project uses SQLite for local storage.',
        embeddingModel: 'test-embedding-v1',
      });

      const missing = await call(client, 'GetMemory', { scope: 'global', name: 'nothing' });
      expect(missing.isError).toBe(false);
      expect(JSON.parse(missing.text)).toEqual({ found: false, scope: 'global', name: 'nothing' });
    } finally {
      await client.close();
    }
  });

  test("a tool's own failure comes back as an error result", async () => {
    const client = await connect('sirus');
    try {
      const result = await call(client, 'GetMemory', { scope: 'another-project', name: 'private' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('global or project');
    } finally {
      await client.close();
    }
  });

  test("SpawnAgent reaches the participant's own host with the prompt, the context and a call id", async () => {
    const client = await connect('sirus');
    try {
      const result = await call(client, 'SpawnAgent', { prompt: 'Do the work' });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({
        id: 'run-1',
        model: 'stub-model',
        thinkingLevel: 'high',
        status: 'working',
        branch: 'sirus/run-1',
        context: 'fresh',
        note: expect.stringContaining('sirus/run-1'),
      });
      expect(spawned).toHaveLength(1);
      expect(spawned[0].prompt).toBe('Do the work');
      expect(spawned[0].context).toBe('fresh');
      expect(typeof spawned[0].call.callId).toBe('string');

      const forked = await call(client, 'SpawnAgent', { prompt: 'Carry on', context: 'owner' });
      expect(forked.isError).toBe(false);
      expect(spawned[1].context).toBe('owner');

      const wrong = await call(client, 'SpawnAgent', { prompt: 'Do the work', context: 'sideways' });
      expect(wrong).toEqual({ isError: true, text: 'SpawnAgent requires context to be one of fresh, owner' });
      expect(spawned).toHaveLength(2);

      const listed = await call(client, 'ListAgents', {});
      expect(JSON.parse(listed.text)).toEqual({
        subagents: [{ id: 'run-1', task: 'Do the work' }, { id: 'run-2', task: 'Carry on' }],
      });
    } finally {
      await client.close();
    }
  });

  test('MessageAgent sends text into a run and CheckAgent answers without waiting', async () => {
    const client = await connect('sirus');
    try {
      await call(client, 'SpawnAgent', { prompt: 'Do the work' });
      const sent = await call(client, 'MessageAgent', { id: 'run-1', message: 'Use the new API instead' });
      expect(sent.isError).toBe(false);
      expect(JSON.parse(sent.text)).toEqual({ id: 'run-1', status: 'working', delivered: 'Use the new API instead' });
      expect(messaged).toEqual([{ id: 'run-1', text: 'Use the new API instead' }]);

      const blank = await call(client, 'MessageAgent', { id: 'run-1' });
      expect(blank.isError).toBe(true);
      expect(blank.text).toContain('message to be a non-empty string');

      const checked = await call(client, 'CheckAgent', { id: 'run-1' });
      expect(JSON.parse(checked.text)).toEqual({ id: 'run-1', status: 'done' });
    } finally {
      await client.close();
    }
  });

  test('a worker is refused SpawnAgent by name and a participant without a host by the tool', async () => {
    const worker = await connect('subagent:run-1');
    const reviewer = await connect('reviewer');
    try {
      const refused = await call(worker, 'SpawnAgent', { prompt: 'Do the work' });
      expect(refused).toEqual({ isError: true, text: 'Unknown tool: SpawnAgent' });

      const noHost = await call(reviewer, 'SpawnAgent', { prompt: 'Do the work' });
      expect(noHost.isError).toBe(true);
      expect(noHost.text).toContain('SpawnAgent needs the calling agent');
      expect(spawned).toEqual([]);
    } finally {
      await worker.close();
      await reviewer.close();
    }
  });

  test('a wrong token or a missing requester is refused before any tool runs', async () => {
    // The client surfaces the status as the error's code and the body as
    // its message.
    await expect(connect('sirus', { token: 'not-the-token' })).rejects.toMatchObject({ code: 401 });
    await expect(connect('sirus', { token: 'not-the-token' })).rejects.toThrow('Unauthorized');
    await expect(connect('sirus', { requester: null })).rejects.toMatchObject({ code: 400 });
    await expect(connect('sirus', { requester: null })).rejects.toThrow('X-Sirus-Requester');
  });

  test('memory off hides the memory tools and refuses a call with the way to switch it on', async () => {
    const client = await connect('sirus');
    try {
      memoryOn = false;
      expect(await toolNames(client)).toEqual(AGENT_TOOLS);
      const result = await call(client, 'GetMemory', { scope: 'global', name: 'anything' });
      expect(result).toEqual({ isError: true, text: 'Memory access is disabled. Use /memory on to enable it.' });

      memoryOn = true;
      expect(await toolNames(client)).toEqual([...MEMORY_TOOLS, ...AGENT_TOOLS]);
    } finally {
      await client.close();
    }
  });

  test('the token is stable while a session stays registered and new after it is re-registered', async () => {
    const first = await sirusMcpServerEntry(SESSION, 'sirus');
    registerToolSession(SESSION, { directory: testDirectory, memoryEnabled: () => true, hostFor: () => null });
    const second = await sirusMcpServerEntry(SESSION, 'reviewer');
    expect(second.url).toBe(first.url);
    expect(second.headers).toEqual([
      first.headers[0],
      { name: 'X-Sirus-Requester', value: 'reviewer' },
    ]);
    expect(first.headers[0].value).toMatch(/^Bearer .{40,}$/);

    unregisterToolSession(SESSION);
    await expect(sirusMcpServerEntry(SESSION, 'sirus')).rejects.toThrow('not registered');
    registerToolSession(SESSION, { directory: testDirectory, memoryEnabled: () => true, hostFor: () => null });
    expect((await sirusMcpServerEntry(SESSION, 'sirus')).headers[0]).not.toEqual(first.headers[0]);
  });
});
