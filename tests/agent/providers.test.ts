import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { providerFor, servableModelIds, servesModel } from '../../src/agent_runtime/providers';
import { MODELS, modelInfo, VENDOR_INFO, type Vendor } from '../../src/agent_runtime/providers/catalog';
import { sourceEnvironment } from '../../src/agent_runtime/providers/profiles';
import { maskApiKey, type Source } from '../../src/agent_runtime/providers/sources';
import {
  routeSessionModel,
  routeWorker,
  vendorAllowance,
  workerCandidates,
  type RoutingCandidate,
  type RoutingClient,
} from '../../src/agent_runtime/router';
import { loadSubscriptionLimitCache, saveSubscriptionLimitCache } from '../../src/persistence';
import { bindScriptedRuntime, textTurn, unbindRuntime } from '../support/runtime';

test('maps a model id to its vendor', () => {
  expect(modelInfo('claude-fable-5-1')?.vendor).toBe('claude');
});

test('serves the catalog plus whatever a scripted runtime is bound to', () => {
  const model = 'test-served-model';
  expect(servesModel(model)).toBe(false);
  bindScriptedRuntime(model, textTurn('Hello.'));
  try {
    expect(servesModel(model)).toBe(true);
    expect(servesModel('claude-opus-5')).toBe(true);
    expect(servesModel('gpt-2')).toBe(false);
    expect(servableModelIds()).toContain(model);
    expect(servableModelIds()).toContain('gpt-5.6-luna');
  } finally {
    unbindRuntime(model);
  }
});

describe('provider credentials', () => {
  let directory: string;
  let previousDataDirectory: string | undefined;
  let previousEnvKey: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-credentials-test-'));
    previousDataDirectory = process.env.SIRUS_DATA_DIR;
    previousEnvKey = process.env.ANTHROPIC_API;
    process.env.SIRUS_DATA_DIR = directory;
    delete process.env.ANTHROPIC_API;
  });

  afterEach(() => {
    if (previousDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDataDirectory;
    if (previousEnvKey === undefined) delete process.env.ANTHROPIC_API;
    else process.env.ANTHROPIC_API = previousEnvKey;
    rmSync(directory, { recursive: true, force: true });
  });

  const claudeSources = (): Source[] => providerFor('claude').sources.list();
  const storedClaudeKey = () => claudeSources().find(source => source.kind === 'api' && !source.fromEnv);

  test('reports no credentials when neither a stored key nor the env var exists', () => {
    expect(claudeSources()).toEqual([]);
    expect(providerFor('claude').activeSource()).toBeNull();
  });

  test('falls back to the environment variable', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    expect(claudeSources()).toEqual([{ id: 'env', kind: 'api', key: 'sk-ant-from-env-1234', fromEnv: true }]);
    expect(providerFor('claude').activeSource()).toMatchObject({ kind: 'api', fromEnv: true });
  });

  test('prefers a stored key over the environment variable', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    providerFor('claude').sources.addApiKey('  sk-ant-stored-abcd  ');
    expect(providerFor('claude').activeSource()).toMatchObject({ kind: 'api', key: 'sk-ant-stored-abcd' });
  });

  test('storing a key switches the provider off its subscription', () => {
    providerFor('claude').sources.addSubscription('default');
    expect(providerFor('claude').activeSource()).toMatchObject({ kind: 'subscription' });
    providerFor('claude').sources.addApiKey('sk-ant-stored-abcd');
    expect(providerFor('claude').activeSource()).toMatchObject({ kind: 'api' });
  });

  test('rejects an empty key and never stores it', () => {
    expect(() => providerFor('claude').sources.addApiKey('   ')).toThrow(/empty/i);
    expect(claudeSources()).toEqual([]);
  });

  test('clearing a stored key reports whether one existed and restores the env fallback', () => {
    process.env.ANTHROPIC_API = 'sk-ant-from-env-1234';
    providerFor('claude').sources.addApiKey('sk-ant-stored-abcd');
    expect(providerFor('claude').sources.remove(storedClaudeKey()!.id)).toBe(true);
    expect(storedClaudeKey()).toBeUndefined();
    expect(providerFor('claude').sources.remove('nothing')).toBe(false);
    expect(claudeSources()).toEqual([{ id: 'env', kind: 'api', key: 'sk-ant-from-env-1234', fromEnv: true }]);
  });

  test('masks short keys without revealing them', () => {
    expect(maskApiKey('sk-ant-api03-verylongkeyvalue9876')).toBe('sk-ant-…9876');
    expect(maskApiKey('sk-proj-openai-key-value-5555')).toBe('sk-proj-…5555');
    expect(maskApiKey('abc')).toBe('…');
  });

  // The sidebar row: the source a runtime is on, then the one the most recent
  // runtime started on, and the preferred one once the runtimes are gone.
  test('reports the source each runtime is on until the list changes', () => {
    const provider = providerFor('claude');
    const stored = provider.sources.addApiKey('sk-ant-stored-abcd');
    provider.sources.addSubscription('work');
    const subscription = provider.sources.list()[0];
    expect(provider.activeSource()).toMatchObject({ kind: 'subscription', profile: 'work' });

    provider.markActive('sirus', stored);
    expect(provider.activeSource()).toMatchObject({ id: stored.id });
    expect(provider.activeSource('sirus')).toMatchObject({ id: stored.id });
    // A runtime nothing was recorded for falls back to the preferred source.
    expect(provider.activeSource('reviewer')).toMatchObject({ id: subscription.id });

    provider.markActive('reviewer', subscription);
    expect(provider.activeSource('sirus')).toMatchObject({ id: stored.id });
    provider.clearActive('sirus');
    expect(provider.activeSource('sirus')).toMatchObject({ id: subscription.id });

    // Any change to the list invalidates every per-runtime choice.
    provider.markActive('sirus', stored);
    provider.sources.addApiKey('sk-ant-another-9999');
    expect(provider.activeSource('sirus')).toMatchObject({ key: 'sk-ant-another-9999' });
  });

  test('a runtime started under another data directory is not the active source', () => {
    const provider = providerFor('claude');
    const stored = provider.sources.addApiKey('sk-ant-stored-abcd');
    provider.sources.addSubscription('work');
    provider.markActive('sirus', stored);
    const other = mkdtempSync(path.join(os.tmpdir(), 'sirus-credentials-other-'));
    try {
      process.env.SIRUS_DATA_DIR = other;
      expect(providerFor('claude').activeSource('sirus')).toBeNull();
    } finally {
      process.env.SIRUS_DATA_DIR = directory;
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// The credential is nothing but the environment the agent process is started
// with, so this is where an API key and a profile become one.
describe('credential environments', () => {
  let directory: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-credential-env-'));
    previous = {
      SIRUS_DATA_DIR: process.env.SIRUS_DATA_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    process.env.SIRUS_DATA_DIR = directory;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-token';
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test('an API key goes in under the name the vendor harness reads', () => {
    const env = sourceEnvironment('claude', { id: 'k', kind: 'api', key: 'sk-ant-run-1234' });
    expect(env[VENDOR_INFO.claude.credentialEnv]).toBe('sk-ant-run-1234');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(sourceEnvironment('gpt', { id: 'k', kind: 'api', key: 'sk-proj-run-5678' }).OPENAI_API_KEY)
      .toBe('sk-proj-run-5678');
  });

  test('a subscription points the process at its own profile and inherits no key', () => {
    const shared = sourceEnvironment('claude', { id: 'default', kind: 'subscription', profile: 'default' });
    expect(shared.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(shared.ANTHROPIC_API_KEY).toBeUndefined();
    expect(shared.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const isolated = sourceEnvironment('claude', { id: 'work', kind: 'subscription', profile: 'work' });
    expect(isolated.CLAUDE_CONFIG_DIR).toBe(path.join(directory, 'subscriptions', 'claude', 'work'));
    expect(isolated.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sourceEnvironment('gpt', { id: 'work', kind: 'subscription', profile: 'work' }).CODEX_HOME)
      .toBe(path.join(directory, 'subscriptions', 'gpt', 'work'));
  });

  test('rejects a profile name that could escape the profile directory', () => {
    expect(() => sourceEnvironment('claude', { id: 'bad', kind: 'subscription', profile: '../escape' }))
      .toThrow(/profile/i);
  });
});

// What Jev may give a worker, and what each vendor has left to spend on it.
describe('worker candidates and allowance', () => {
  let directory: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-worker-routing-'));
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
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  // A signed-in subscription whose window the sidebar has already read.
  const subscribe = (vendor: Vendor, profile: string, remaining: number): void => {
    providerFor(vendor).sources.addSubscription(profile);
    saveSubscriptionLimitCache([...loadSubscriptionLimitCache(), {
      vendor, profile, period: VENDOR_INFO[vendor].limitPeriod, remaining, checkedAt: Date.now(), resetsAt: null,
    }]);
  };
  const candidateIds = (): string[] => workerCandidates().map(candidate => candidate.model).sort();

  test('offers every model of a vendor with allowance except the ones kept off the list', () => {
    subscribe('claude', 'default', 80);
    subscribe('gpt', 'default', 60);
    expect(candidateIds()).toEqual(MODELS.filter(model => model.worker !== false).map(model => model.id).sort());
    expect(candidateIds()).not.toContain('claude-haiku-4-5');
    // Every candidate arrives with a whole profile and the vendor whose
    // allowance is rendered alongside it.
    expect(workerCandidates().every(candidate => candidate.vendor === modelInfo(candidate.model)?.vendor
      && candidate.profile.strengths.length > 0
      && candidate.profile.benchmarks.length > 0
      && candidate.profile.reviews.length > 0
      && candidate.profile.cost.input > 0 && candidate.profile.cost.output > 0)).toBe(true);
  });

  test('drops a vendor whose window is spent and keeps one holding an API key', () => {
    subscribe('claude', 'default', 0);
    process.env.OPENAI_SECRET = 'sk-proj-worker-1234';
    expect(candidateIds()).not.toContain('claude-opus-5');
    expect(candidateIds()).toContain('gpt-5.6-terra');
    providerFor('claude').sources.addApiKey('sk-ant-worker-abcd');
    expect(candidateIds()).toContain('claude-opus-5');
  });

  test('a subscription the sidebar has not read yet is available, and no credential offers nothing', () => {
    expect(workerCandidates()).toEqual([]);
    expect(vendorAllowance()).toEqual([]);
    providerFor('gpt').sources.addSubscription('default');
    expect(candidateIds()).toContain('gpt-5.6-sol');
    expect(vendorAllowance()).toEqual([{ vendor: 'gpt', remaining: null }]);
  });

  test('reports the most generous window per vendor, and nothing for an API key', () => {
    subscribe('claude', 'default', 12);
    subscribe('claude', 'work', 63);
    process.env.OPENAI_SECRET = 'sk-proj-worker-1234';
    expect(vendorAllowance()).toEqual([
      { vendor: 'claude', remaining: 63 },
      { vendor: 'gpt', remaining: null },
    ]);
  });
});

describe('routing a worker', () => {
  const project = path.resolve(import.meta.dir, '../..');
  const input = { task: 'Rename `count` to `total` in @src/agent_runtime/router.ts', directory: project };
  const candidates: RoutingCandidate[] = [
    {
      model: 'claude-sonnet-5',
      vendor: 'claude',
      profile: {
        strengths: 'Speed and intelligence in balance.',
        benchmarks: ['SWE-bench Pro 63.2 (June 2026)', 'Arena creative writing Elo 1437 (Sept 2026)'],
        reviews: 'Over-thinks a small edit.',
        cost: { input: 3, output: 15 },
      },
    },
    {
      model: 'claude-fable-5-1',
      vendor: 'claude',
      profile: {
        strengths: 'The most demanding reasoning.',
        benchmarks: ['SWE-bench Pro 81.2 (Sept 2026)'],
        reviews: 'Asks before it decides.',
        cost: { input: 10, output: 50, note: 'cache reads $0.25' },
      },
    },
    {
      model: 'gpt-5.6-luna',
      vendor: 'gpt',
      profile: {
        strengths: 'Cheap and fast for routine work.',
        benchmarks: ['MRCR v2 long-context recall 41.3% (July 2026)'],
        reviews: 'Comes apart on open-ended reasoning.',
        cost: { input: 0.2, output: 1.2 },
      },
    },
  ];
  const allowance = [
    { vendor: 'claude' as const, remaining: 47 },
    { vendor: 'gpt' as const, remaining: null },
  ];

  type Ask = Parameters<RoutingClient['systemOne']>[0];
  const fakeClient = (answers: Record<string, { choice: string; confidence: number }>) => {
    const asked: Ask[] = [];
    const client: RoutingClient = {
      systemOne: async request => {
        asked.push(request);
        return { answers };
      },
    };
    return { client, asked };
  };

  test('asks for a model and a level, and states the task and the project', async () => {
    const { client, asked } = fakeClient({
      model: { choice: 'gpt-5.6-luna', confidence: 0.83 },
      thinkingLevel: { choice: 'low', confidence: 0.71 },
    });
    expect(await routeWorker(input, candidates, allowance, { client }))
      .toEqual({ model: 'gpt-5.6-luna', thinkingLevel: 'low' });
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0].questions)).toEqual(['model', 'thinkingLevel']);
    expect(Object.keys(asked[0].questions.model.criteria)).toEqual(candidates.map(candidate => candidate.model));
    expect(Object.keys(asked[0].questions.thinkingLevel.criteria)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(asked[0].state.task).toBe(input.task);
    expect(asked[0].state.mentionedFiles).toEqual(['src/agent_runtime/router.ts']);
    expect(asked[0].state.project).toBe(path.basename(project));
    // The allowance is part of each candidate's criteria now, not a list of
    // its own for Jev to match up with the models itself.
    expect(asked[0].state.allowance).toBeUndefined();
  });

  test('renders each candidate as its profile plus the allowance its vendor has left', async () => {
    const { client, asked } = fakeClient({
      model: { choice: 'claude-fable-5-1', confidence: 0.9 },
      thinkingLevel: { choice: 'high', confidence: 0.9 },
    });
    await routeWorker(input, candidates, allowance, { client });
    const criteria = asked[0].questions.model.criteria;
    expect(criteria['claude-fable-5-1']).toBe([
      'Strengths: The most demanding reasoning.',
      'Benchmarks: SWE-bench Pro 81.2 (Sept 2026).',
      'In practice: Asks before it decides.',
      'Cost: $10 per million input tokens, $50 per million output (cache reads $0.25).',
      'Allowance: Anthropic has 47% of the 5-hour window remaining.',
    ].join('\n'));
    // Several benchmarks run together on one line, and sub-dollar prices keep
    // their cents.
    expect(criteria['claude-sonnet-5']).toContain(
      'Benchmarks: SWE-bench Pro 63.2 (June 2026); Arena creative writing Elo 1437 (Sept 2026).',
    );
    expect(criteria['gpt-5.6-luna']).toContain('Cost: $0.20 per million input tokens, $1.20 per million output.');
    expect(criteria['gpt-5.6-luna']).toContain('Allowance: OpenAI has API key, no window.');
  });

  test('a vendor the allowance says nothing about is unread rather than spent', async () => {
    const { client, asked } = fakeClient({ model: { choice: 'gpt-5.6-luna', confidence: 0.9 } });
    await routeWorker(input, candidates, [{ vendor: 'claude', remaining: 12 }], { client });
    expect(asked[0].questions.model.criteria['gpt-5.6-luna']).toContain('Allowance: OpenAI has not read yet.');
    expect(asked[0].questions.model.criteria['claude-sonnet-5'])
      .toContain('Allowance: Anthropic has 12% of the 5-hour window remaining.');
  });

  test('routes nothing when Jev is unsure of the model or names one that was not offered', async () => {
    const unsure = fakeClient({
      model: { choice: 'claude-fable-5-1', confidence: 0.42 },
      thinkingLevel: { choice: 'high', confidence: 0.9 },
    });
    expect(await routeWorker(input, candidates, allowance, { client: unsure.client })).toBeNull();
    const stranger = fakeClient({
      model: { choice: 'claude-opus-5', confidence: 0.95 },
      thinkingLevel: { choice: 'high', confidence: 0.9 },
    });
    expect(await routeWorker(input, candidates, allowance, { client: stranger.client })).toBeNull();
  });

  test('an unsure or unoffered level leaves the model pick standing on the owner level', async () => {
    for (const thinkingLevel of [
      { choice: 'xhigh', confidence: 0.31 },
      { choice: 'max', confidence: 0.9 },
      { choice: 'ludicrous', confidence: 0.9 },
    ]) {
      const { client } = fakeClient({ model: { choice: 'claude-fable-5-1', confidence: 0.9 }, thinkingLevel });
      expect(await routeWorker(input, candidates, allowance, { client, fallbackLevel: 'medium' }))
        .toEqual({ model: 'claude-fable-5-1', thinkingLevel: 'medium' });
    }
    const { client } = fakeClient({ model: { choice: 'claude-sonnet-5', confidence: 0.9 } });
    expect(await routeWorker(input, candidates, allowance, { client }))
      .toEqual({ model: 'claude-sonnet-5', thinkingLevel: 'high' });
  });

  test('a call that fails or times out, and a missing key, route nothing', async () => {
    const failing: RoutingClient = { systemOne: async () => { throw new Error('request timed out'); } };
    expect(await routeWorker(input, candidates, allowance, { client: failing })).toBeNull();
    expect(await routeWorker(input, candidates, allowance, { client: null })).toBeNull();
  });

  test('one candidate is taken on the owner level without asking, and none routes nothing', async () => {
    const { client, asked } = fakeClient({ model: { choice: 'claude-sonnet-5', confidence: 1 } });
    expect(await routeWorker(input, candidates.slice(0, 1), allowance, { client, fallbackLevel: 'xhigh' }))
      .toEqual({ model: 'claude-sonnet-5', thinkingLevel: 'xhigh' });
    expect(await routeWorker(input, [], allowance, { client })).toBeNull();
    expect(asked).toHaveLength(0);
  });

  // A session's model is chosen from the same profiles, so only the question
  // and where the allowance comes from differ.
  test('the session router asks one question over the same rendered profiles', async () => {
    const { client, asked } = fakeClient({ model: { choice: 'claude-fable-5-1', confidence: 0.77 } });
    const prompt = 'Work out why @src/agent_runtime/router.ts drops the pick';
    expect(await routeSessionModel({ prompt, directory: project }, candidates, { client, allowance }))
      .toEqual({ model: 'claude-fable-5-1', confidence: 0.77 });
    expect(Object.keys(asked[0].questions)).toEqual(['model']);
    expect(asked[0].state).toEqual({
      request: prompt,
      mentionedFiles: ['src/agent_runtime/router.ts'],
      project: path.basename(project),
    });
    expect(asked[0].questions.model.criteria['claude-fable-5-1']).toBe([
      'Strengths: The most demanding reasoning.',
      'Benchmarks: SWE-bench Pro 81.2 (Sept 2026).',
      'In practice: Asks before it decides.',
      'Cost: $10 per million input tokens, $50 per million output (cache reads $0.25).',
      'Allowance: Anthropic has 47% of the 5-hour window remaining.',
    ].join('\n'));
  });
});
