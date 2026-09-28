import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as launch from '../../src/agent_runtime/runtime/launch';
import { discoverMissingModels } from '../../src/agent_runtime/providers/discovery';
import { modelIds, rememberListedModels } from '../../src/agent_runtime/providers/catalog';

let directory: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sirus-model-discovery-'));
  previous = {
    SIRUS_DATA_DIR: process.env.SIRUS_DATA_DIR,
    ANTHROPIC_API: process.env.ANTHROPIC_API,
    OPENAI_SECRET: process.env.OPENAI_SECRET,
  };
  process.env.SIRUS_DATA_DIR = directory;
  delete process.env.ANTHROPIC_API;
  delete process.env.OPENAI_SECRET;
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

test('cold discovery reads both vendors without choosing a model or sending a prompt', async () => {
  process.env.ANTHROPIC_API = 'test-claude';
  process.env.OPENAI_SECRET = 'test-gpt';
  const requests = join(directory, 'requests.jsonl');
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath,
    args: ['-e', `
      import { createInterface } from 'node:readline';
      import { appendFileSync } from 'node:fs';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ vendor: '${options.vendor}', method: request.method }) + '\\n');
        const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
        else if (request.method === 'session/new') reply({ sessionId: 'discovery', configOptions: [{
          id: 'model', type: 'select', name: 'Model', currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: '${options.vendor === 'claude' ? 'opus[1m]' : 'gpt-vendor-new'}', name: 'Vendor model' },
          ],
        }] });
        else throw new Error('Discovery must not configure or prompt: ' + request.method);
      }
    `],
    env: options.env, mode: 'ask',
    session: () => ({ mcpServers: [] }), forkNeedsResume: false,
  }));
  try {
    expect(await discoverMissingModels(directory)).toBe(true);
    expect(modelIds()).toEqual(['opus[1m]', 'gpt-vendor-new']);
    expect(JSON.parse(readFileSync(join(directory, 'listed-models.json'), 'utf8')).vendors.claude)
      .toEqual([{ id: 'opus[1m]', description: 'Vendor model' }]);
    const calls = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    for (const vendor of ['claude', 'gpt']) {
      expect(calls.filter(call => call.vendor === vendor).map(call => call.method))
        .toEqual(['initialize', 'session/new']);
    }
    expect(await discoverMissingModels(directory)).toBe(false);
    expect(spec).toHaveBeenCalledTimes(2);
  } finally {
    spec.mockRestore();
  }
});

test('disconnected and failing vendors never contribute built-in choices', async () => {
  expect(await discoverMissingModels(directory)).toBe(false);
  expect(modelIds()).toEqual([]);
  process.env.ANTHROPIC_API = 'test-claude';
  const spec = spyOn(launch, 'launchFor').mockImplementation(() => { throw new Error('offline'); });
  try {
    expect(await discoverMissingModels(directory)).toBe(false);
    expect(await discoverMissingModels(directory)).toBe(false);
    expect(spec).toHaveBeenCalledTimes(1);
    expect(modelIds()).toEqual([]);
    rememberListedModels('claude', [{ id: 'opus[1m]', description: 'Cached' }]);
    expect(await discoverMissingModels(directory)).toBe(false);
    expect(modelIds()).toEqual(['opus[1m]']);
  } finally {
    spec.mockRestore();
  }
});
