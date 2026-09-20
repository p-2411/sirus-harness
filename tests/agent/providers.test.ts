import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { providerFor, servableModelIds, servesModel } from '../../src/agent_runtime/providers';
import { modelInfo, VENDOR_INFO } from '../../src/agent_runtime/providers/catalog';
import { sourceEnvironment } from '../../src/agent_runtime/providers/profiles';
import { maskApiKey, type Source } from '../../src/agent_runtime/providers/sources';
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
