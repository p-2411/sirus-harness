import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { TurnCancelledError } from '../../src/abort';
import { providerFor, servableModelIds, servesModel } from '../../src/agent_runtime/providers';
import { modelIds, modelsOf, modelInfo, rememberListedModels, VENDOR_INFO } from '../../src/agent_runtime/providers/catalog';
import { browserCommand } from '../../src/agent_runtime/providers/login';
import { loginCodex, readCodexAccount, readCodexRateLimits } from '../../src/agent_runtime/providers/openai/codex-account';
import { sourceEnvironment } from '../../src/agent_runtime/providers/profiles';
import { maskApiKey, type Source } from '../../src/agent_runtime/providers/sources';
import * as acp from '../../src/agent_runtime/runtime/acp';
import { launchFor } from '../../src/agent_runtime/runtime/launch';
import { claudeSkillPlugins, codexSkillDirectories } from '../../src/agent_runtime/runtime/skills';
import { createRuntime, type RuntimeOptions } from '../../src/agent_runtime/runtime/runtime';
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
    expect(servableModelIds()).toEqual(expect.arrayContaining(modelIds()));
  } finally {
    unbindRuntime(model);
  }
});

// What a runtime is started with, less what each test is about.
function runtimeOptions(overrides: Partial<RuntimeOptions>): RuntimeOptions {
  return {
    vendor: 'gpt',
    model: 'gpt-5.6-luna',
    thinkingLevel: 'low',
    directory: os.tmpdir(),
    systemPrompt: 'Answer briefly.',
    env: {},
    mcpServer: null,
    bare: true,
    permissionMode: 'ask',
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    onUpdate: () => {},
    ...overrides,
  };
}

// A restored session, or the subagent setting, can name a model a vendor
// has since stopped listing. It has no credential, and must not be started
// on the process's own environment instead.
test('a model no vendor knows any more is refused before any adapter starts', async () => {
  const start = spyOn(acp, 'startAcpRuntime').mockRejectedValue(new Error('an adapter was started'));
  try {
    await expect(createRuntime(runtimeOptions({ model: 'gpt-retired', env: { ...process.env } })))
      .rejects.toThrow('The model gpt-retired is no longer available. Pick another with /model.');
    expect(start).not.toHaveBeenCalled();
  } finally {
    start.mockRestore();
  }
});

test('model choices come exclusively from cached vendor reports', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-listed-models-'));
  const previous = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = directory;
  try {
    expect(modelIds()).toEqual([]);
    expect(modelsOf('claude')).toEqual([]);
    rememberListedModels('claude', [{ id: 'opus[1m]', description: 'Opus' }]);
    rememberListedModels('gpt', [{ id: 'gpt-vendor-model', description: 'GPT' }]);
    expect(modelIds()).toEqual(['opus[1m]', 'gpt-vendor-model']);
    expect(modelsOf('claude')).toEqual(['opus[1m]']);
    rememberListedModels('claude', []);
    expect(modelsOf('claude')).toEqual([]);
    expect(modelIds()).toEqual(['gpt-vendor-model']);
  } finally {
    if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
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

  test('a Codex API key gets a home of its own, so the login never touches the user\'s', () => {
    const first = sourceEnvironment('gpt', { id: 'k', kind: 'api', key: 'sk-proj-run-5678' });
    expect(first.CODEX_HOME).toStartWith(path.join(directory, 'api', 'gpt') + path.sep);
    expect(existsSync(first.CODEX_HOME!)).toBe(true);
    expect(sourceEnvironment('gpt', { id: 'k', kind: 'api', key: 'sk-proj-run-5678' }).CODEX_HOME).toBe(first.CODEX_HOME);
    expect(sourceEnvironment('gpt', { id: 'j', kind: 'api', key: 'sk-proj-other-0001' }).CODEX_HOME).not.toBe(first.CODEX_HOME);
    expect(first.CODEX_HOME).not.toContain('sk-proj');
  });

  test('the launch logs Codex in with a key only inside a home Sirus made for it', () => {
    const keyed = sourceEnvironment('gpt', { id: 'k', kind: 'api', key: 'sk-proj-run-5678' });
    expect(launchFor(runtimeOptions({ env: keyed })).authenticate).toEqual({ methodId: 'api-key' });
    // The shell's own key with no home of Sirus's: a login would land in the
    // user's Codex home and replace their ChatGPT sign-in.
    const shell = { OPENAI_API_KEY: 'sk-proj-shell-0000' };
    expect(launchFor(runtimeOptions({ env: shell })).authenticate).toBeUndefined();
    expect(launchFor(runtimeOptions({ env: { ...shell, CODEX_HOME: path.join(os.homedir(), '.codex') } })).authenticate)
      .toBeUndefined();
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

test('worker launch policies disable native delegation and apply definition tool restrictions', async () => {
  const { launchFor } = await import('../../src/agent_runtime/runtime/launch');
  const options = {
    vendor: 'claude' as const, model: 'claude-sonnet-5', thinkingLevel: 'low' as const,
    directory: os.tmpdir(), systemPrompt: 'Worker', env: {}, mcpServer: null,
    permissionMode: 'bypass' as const, tools: ['Read', 'Grep'], readOnly: true,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }), onUpdate: () => {},
  };
  const claude = launchFor(options);
  const session = claude.session(options);
  const sdk = (session.meta?.claudeCode as { options: { tools: string[]; disallowedTools: string[] } }).options;
  expect(sdk.tools).toEqual(['Read', 'Grep']);
  expect(sdk.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'SendMessage', 'ListAgents', 'mcp__*']));
  const codex = launchFor({ ...options, vendor: 'gpt', model: 'gpt-5.6-luna' });
  expect(codex.env.INITIAL_AGENT_MODE).toBe('read-only');
  expect(JSON.parse(codex.env.CODEX_CONFIG!).features.multi_agent).toBe(false);
  // Sirus's own config switches on an unstable feature; Codex must not warn
  // the user about it.
  expect(JSON.parse(codex.env.CODEX_CONFIG!).suppress_unstable_features_warning).toBe(true);
  // 1.13.1 unsubscribes forks: a resume is required to receive updates.
  expect(codex.forkNeedsResume).toBe(true);
});

// Every source and generated file lives in a scratch home. The vendors still
// own discovery; these tests check only the folders Sirus hands to them.
describe('shared vendor skills', () => {
  let directory: string;
  let project: string;
  let claudeHome: string;
  let codexHome: string;
  let agentsSkills: string;
  let previous: Record<string, string | undefined>;
  let claudeInstalls: Record<string, unknown[]>;
  let claudeEnabled: Record<string, boolean>;
  let codexConfig: string[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-shared-skills-'));
    previous = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'SIRUS_DATA_DIR']
      .map(name => [name, process.env[name]]));
    process.env.HOME = path.join(directory, 'home');
    claudeHome = process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude');
    codexHome = process.env.CODEX_HOME = path.join(directory, 'codex');
    process.env.SIRUS_DATA_DIR = path.join(directory, 'data');
    agentsSkills = path.join(process.env.HOME, '.agents', 'skills');
    project = path.join(directory, 'project');
    for (const folder of [process.env.HOME, claudeHome, codexHome, agentsSkills, project]) {
      mkdirSync(folder, { recursive: true });
    }
    claudeInstalls = {};
    claudeEnabled = {};
    codexConfig = [];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  function write(file: string, value: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value);
  }

  function json(file: string, value: unknown): void {
    write(file, JSON.stringify(value));
  }

  function skill(root: string, folder: string, fields: Record<string, string | boolean | null> = {}): string {
    const target = path.join(root, folder);
    const metadata = { name: folder, description: `Use ${folder}.`, ...fields };
    const frontmatter = Object.entries(metadata).filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
    write(path.join(target, 'SKILL.md'), `---\n${frontmatter}\n---\nFollow these instructions.\n`);
    return target;
  }

  function claudePlugin(id: string, name: string, enabled = true, manifest: Record<string, unknown> = {}): string {
    const target = path.join(claudeHome, 'plugins', 'cache', 'community', id, '1.0.0');
    json(path.join(target, '.claude-plugin', 'plugin.json'), { name, ...manifest });
    claudeInstalls[`${id}@community`] = [{ scope: 'user', installPath: target, version: '1.0.0' }];
    claudeEnabled[`${id}@community`] = enabled;
    json(path.join(claudeHome, 'plugins', 'installed_plugins.json'), { version: 2, plugins: claudeInstalls });
    json(path.join(claudeHome, 'settings.json'), { enabledPlugins: claudeEnabled });
    return target;
  }

  function configureCodex(value: string): void {
    codexConfig.push(value);
    write(path.join(codexHome, 'config.toml'), codexConfig.join('\n'));
  }

  function codexPlugin(
    id: string, name: string, enabled: boolean | null = true, marketplace = 'community', manifest: Record<string, unknown> = {},
  ): string {
    const target = path.join(codexHome, 'plugins', 'cache', marketplace, id, '2.0.0');
    json(path.join(target, '.codex-plugin', 'plugin.json'), { name, ...manifest });
    configureCodex(`[plugins.${JSON.stringify(`${id}@${marketplace}`)}]\n${enabled === null ? '' : `enabled = ${enabled}\n`}`);
    return target;
  }

  // Stop at each link: descending through it would mistake the user's own
  // files for generated files and would hide accidental copied skill trees.
  function links(root: string): string[] {
    return readdirSync(root).flatMap(name => {
      const entry = path.join(root, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) return [entry];
      return stat.isDirectory() ? links(entry) : [];
    });
  }

  function pluginNames(root: string): string[] {
    return readdirSync(root).flatMap(name => {
      const entry = path.join(root, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
      if (name === '.claude-plugin') return [JSON.parse(readFileSync(path.join(entry, 'plugin.json'), 'utf8')).name];
      return pluginNames(entry);
    });
  }

  function targets(roots: string[]): string[] {
    return roots.flatMap(links).map(link => realpathSync(link)).sort();
  }

  function expectedTargets(...folders: string[]): string[] {
    return folders.map(folder => realpathSync(folder)).sort();
  }

  function claudeBridges(): string[] {
    const plugins = claudeSkillPlugins(project);
    for (const plugin of plugins) {
      expect(plugin.type).toBe('local');
      expect(plugin.skipMcpDiscovery).toBe(true);
      expect(plugin.path).toStartWith(process.env.SIRUS_DATA_DIR! + path.sep);
    }
    return plugins.map(plugin => plugin.path);
  }

  test('shares personal skills once by frontmatter name or folder and preserves the source files', () => {
    const fromClaude = skill(path.join(claudeHome, 'skills'), 'claude-only');
    const fromCodex = skill(path.join(codexHome, 'skills'), 'codex-only');
    const fromAgents = skill(agentsSkills, 'agents-only');
    skill(path.join(claudeHome, 'skills'), 'claude-copy', { name: 'shared-name' });
    skill(agentsSkills, 'codex-copy', { name: 'shared-name' });
    skill(path.join(claudeHome, 'skills'), 'fallback-name', { name: null });
    skill(agentsSkills, 'another-copy', { name: 'fallback-name' });
    skill(path.join(claudeHome, 'skills'), 'system-copy', { name: 'built-in-name' });
    skill(path.join(codexHome, 'skills', '.system'), 'system-skill', { name: 'built-in-name' });
    const before = [fromClaude, fromCodex, fromAgents]
      .map(folder => readFileSync(path.join(folder, 'SKILL.md'), 'utf8'));

    const claude = claudeBridges();
    expect(targets(claude)).toEqual(expectedTargets(fromCodex, fromAgents));
    expect(claude).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(claude[0], '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('codex');
    const codex = codexSkillDirectories(project);
    expect(codex).toHaveLength(1);
    expect(codex[0]).toStartWith(process.env.SIRUS_DATA_DIR! + path.sep);
    expect(targets(codex)).toEqual(expectedTargets(fromClaude));
    expect([fromClaude, fromCodex, fromAgents]
      .map(folder => readFileSync(path.join(folder, 'SKILL.md'), 'utf8'))).toEqual(before);
    expect([fromClaude, fromCodex, fromAgents].every(folder => !lstatSync(folder).isSymbolicLink())).toBe(true);
  });

  test('keeps third-party plugin namespaces and follows custom skill roots', () => {
    const claudePluginRoot = claudePlugin('claude-package', 'claude-tools', true, { skills: ['./special', './single'] });
    const claudeNested = skill(path.join(claudePluginRoot, 'special'), 'nested', { name: 'claude-nested' });
    const claudeSingle = skill(claudePluginRoot, 'single');
    const claudeDefault = skill(path.join(claudePluginRoot, 'skills'), 'claude-default');
    const codexPluginRoot = codexPlugin('codex-package', 'codex-tools', true, 'community', { skills: './special' });
    const codexNested = skill(path.join(codexPluginRoot, 'special'), 'nested', { name: 'codex-nested' });
    skill(path.join(codexPluginRoot, 'skills'), 'codex-replaced-default');

    const claude = claudeBridges();
    expect(targets(claude)).toEqual(expectedTargets(codexNested));
    expect(JSON.parse(readFileSync(path.join(claude[0], '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('codex-tools');
    const codex = codexSkillDirectories(project);
    expect(targets(codex)).toEqual(expectedTargets(claudeNested, claudeSingle, claudeDefault));
    expect(pluginNames(path.join(codex[0], '.agents', 'skills'))).toEqual(['claude-tools']);
  });

  test('honours disabled source plugins and reserves installed target names even when disabled', () => {
    skill(path.join(claudePlugin('disabled-claude', 'disabled-claude', false), 'skills'), 'disabled-claude-skill');
    skill(path.join(codexPlugin('disabled-codex', 'disabled-codex', false), 'skills'), 'disabled-codex-skill');
    write(path.join(project, '.codex', 'config.toml'),
      '[plugins."disabled-codex@community".mcp_servers.test]\nenabled = true\n');
    skill(path.join(claudePlugin('claude-collision', 'same-on-codex'), 'skills'), 'hidden');
    codexPlugin('other-package-id', 'same-on-codex', false);
    skill(path.join(codexPlugin('codex-collision', 'same-on-claude'), 'skills'), 'hidden');
    claudePlugin('different-package-id', 'same-on-claude', false);
    const claudeVisible = skill(path.join(claudePlugin('claude-visible', 'claude-visible'), 'skills'), 'claude-visible-skill');
    const codexVisible = skill(path.join(codexPlugin('codex-visible', 'codex-visible'), 'skills'), 'codex-visible-skill');

    expect(targets(claudeBridges())).toEqual(expectedTargets(codexVisible));
    expect(targets(codexSkillDirectories(project))).toEqual(expectedTargets(claudeVisible));
  });

  test('loads configured Codex plugins by default and prefers local then the latest cached version', () => {
    const old = codexPlugin('versioned', 'versioned', null);
    skill(path.join(old, 'skills'), 'old-skill');
    const latestRoot = path.join(path.dirname(old), '10.0.0');
    json(path.join(latestRoot, '.codex-plugin', 'plugin.json'), { name: 'versioned' });
    const latest = skill(path.join(latestRoot, 'skills'), 'latest-skill');
    const orphanRoot = path.join(codexHome, 'plugins', 'cache', 'community', 'uninstalled', '20.0.0');
    json(path.join(orphanRoot, '.codex-plugin', 'plugin.json'), { name: 'uninstalled' });
    skill(path.join(orphanRoot, 'skills'), 'orphan-skill');
    write(path.join(codexHome, 'plugins', 'cache', 'cache-index'), 'stray cache file');
    write(path.join(codexHome, 'plugins', 'cache', 'community', 'market-index'), 'stray market file');

    expect(targets(claudeBridges())).toEqual(expectedTargets(latest));
    const localRoot = path.join(path.dirname(old), 'local');
    json(path.join(localRoot, '.codex-plugin', 'plugin.json'), { name: 'versioned' });
    const local = skill(path.join(localRoot, 'skills'), 'local-skill');
    expect(targets(claudeBridges())).toEqual(expectedTargets(local));
    rmSync(path.join(localRoot, '.codex-plugin', 'plugin.json'));
    expect(claudeBridges()).toEqual([]);
  });

  test('excludes vendor skill collections and OpenAI marketplaces', () => {
    skill(path.join(codexHome, 'skills', '.system'), 'codex-system');
    skill(path.join(claudeHome, 'skills', 'synced'), 'claude-synced');
    for (const source of ['anthropic', 'anthropic-example']) {
      skill(path.join(claudePlugin(source, source, true, { source }), 'skills'), `${source}-skill`);
    }
    for (const marketplace of ['openai-bundled', 'openai-primary-runtime', 'openai-curated', 'openai-curated-remote']) {
      skill(path.join(codexPlugin(`vendor-${marketplace}`, `vendor-${marketplace}`, true, marketplace), 'skills'), 'hidden');
    }
    const personalCodex = skill(agentsSkills, 'personal-codex');
    const personalClaude = skill(path.join(claudeHome, 'skills'), 'personal-claude');

    expect(targets(claudeBridges())).toEqual(expectedTargets(personalCodex));
    expect(targets(codexSkillDirectories(project))).toEqual(expectedTargets(personalClaude));
  });

  test('honours disabled Codex skill paths and names including plugin skills', () => {
    const disabledPath = skill(path.join(codexHome, 'skills'), 'path-disabled');
    skill(agentsSkills, 'name-disabled-folder', { name: 'name-disabled' });
    skill(agentsSkills, 'metadata-disabled', { enabled: false });
    const pluginRoot = codexPlugin('source-tools', 'source-tools', false);
    skill(path.join(pluginRoot, 'skills'), 'plugin-disabled');
    const pluginEnabled = skill(path.join(pluginRoot, 'skills'), 'plugin-enabled');
    const personalEnabled = skill(agentsSkills, 'personal-enabled');
    configureCodex(`[[skills.config]]\npath = ${JSON.stringify(path.join(disabledPath, 'SKILL.md'))}\nenabled = false\n`);
    configureCodex('[[skills.config]]\nname = "name-disabled"\nenabled = false\n');
    configureCodex('[[skills.config]]\nname = "source-tools:plugin-disabled"\nenabled = false\n');
    write(path.join(project, '.codex', 'config.toml'), [
      '[plugins."source-tools@community"]', 'enabled = true',
      '[[skills.config]]', 'name = "name-disabled"', 'enabled = true',
    ].join('\n'));

    expect(targets(claudeBridges())).toEqual(expectedTargets(pluginEnabled, personalEnabled));
    configureCodex(`[[skills.config]]\npath = ${JSON.stringify(path.join(disabledPath, 'SKILL.md'))}\nenabled = true\n`);
    expect(targets(claudeBridges())).toEqual(expectedTargets(disabledPath, pluginEnabled, personalEnabled));
  });

  test('leaves Claude skills requiring manual invocation and invalid Codex metadata out', () => {
    const source = path.join(claudeHome, 'skills');
    skill(source, 'manual-only', { 'disable-model-invocation': true });
    skill(source, 'no-description', { description: null });
    skill(source, 'empty-description', { description: '' });
    skill(source, 'long-name', { name: 'x'.repeat(65) });
    const accepted = skill(source, 'valid-name', { name: 'x'.repeat(64), 'disable-model-invocation': false });
    const pluginRoot = claudePlugin('manual-tools', 'manual-tools');
    skill(path.join(pluginRoot, 'skills'), 'manual-plugin', { 'disable-model-invocation': true });

    expect(targets(codexSkillDirectories(project))).toEqual(expectedTargets(accepted));
  });

  test('reuses an unchanged inventory and builds a fresh bridge when skills change', () => {
    const first = skill(path.join(claudeHome, 'skills'), 'first');
    const original = codexSkillDirectories(project);
    expect(codexSkillDirectories(project)).toEqual(original);
    const replacement = skill(path.join(claudeHome, 'skills'), 'replacement');
    rmSync(first, { recursive: true });
    const refreshed = codexSkillDirectories(project);
    expect(refreshed).not.toEqual(original);
    expect(targets(refreshed)).toEqual(expectedTargets(replacement));

    const codexFirst = skill(agentsSkills, 'codex-first');
    const originalPlugins = claudeBridges();
    expect(claudeBridges()).toEqual(originalPlugins);
    const codexReplacement = skill(agentsSkills, 'codex-replacement');
    rmSync(codexFirst, { recursive: true });
    const refreshedPlugins = claudeBridges();
    expect(refreshedPlugins).not.toEqual(originalPlugins);
    expect(targets(refreshedPlugins)).toEqual(expectedTargets(codexReplacement));
  });

  test('walks project skill roots up to the repository and deduplicates native project skills', () => {
    write(path.join(project, '.git'), 'gitdir: /unused-worktree-metadata\n');
    const nested = path.join(project, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    const claudeRoot = skill(path.join(project, '.claude', 'skills'), 'claude-root');
    const claudeNested = skill(path.join(nested, '.claude', 'skills'), 'claude-nested');
    const codexRoot = skill(path.join(project, '.codex', 'skills'), 'codex-root');
    const codexNested = skill(path.join(nested, '.agents', 'skills'), 'codex-nested');
    skill(path.join(project, '.claude', 'skills'), 'duplicate-one', { name: 'project-shared' });
    skill(path.join(nested, '.agents', 'skills'), 'duplicate-two', { name: 'project-shared' });
    skill(path.join(directory, '.claude', 'skills'), 'outside-repository');

    expect(targets(claudeSkillPlugins(nested).map(plugin => plugin.path))).toEqual(expectedTargets(codexRoot, codexNested));
    expect(targets(codexSkillDirectories(nested))).toEqual(expectedTargets(claudeRoot, claudeNested));
  });

  test('keeps one Codex bridge per process across forks and reads default homes under credential profiles', () => {
    const claudeSource = skill(path.join(claudeHome, 'skills'), 'claude-personal');
    const codexSource = skill(agentsSkills, 'codex-personal');
    const nativeSource = skill(path.join(codexHome, 'skills'), 'native-personal');
    skill(path.join(codexHome, 'skills'), 'disabled-profile');
    configureCodex('[[skills.config]]\nname = "disabled-profile"\nenabled = false\n');
    const options: RuntimeOptions = {
      vendor: 'gpt', model: 'gpt-5.6-luna', thinkingLevel: 'medium', directory: project,
      systemPrompt: 'Test prompt.', permissionMode: 'ask', mcpServer: null,
      env: sourceEnvironment('gpt', { id: 'work', kind: 'subscription', profile: 'work' }),
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onUpdate: () => {},
    };
    const launch = launchFor(options);
    const spec = { directory: project, systemPrompt: 'Test prompt.', mcpServer: null };
    const parent = launch.session(spec);
    expect(parent.additionalDirectories).toHaveLength(1);
    expect(targets(parent.additionalDirectories!)).toEqual(expectedTargets(claudeSource));
    skill(path.join(claudeHome, 'skills'), 'added-after-launch');
    const fork = launch.session({ ...spec, directory: path.join(directory, 'worker') });
    expect(fork.additionalDirectories).toEqual(parent.additionalDirectories);
    expect(launch.env.CODEX_HOME).toBe(options.env.CODEX_HOME);
    const profileSkills = path.join(launch.env.CODEX_HOME!, 'skills');
    expect(targets([profileSkills])).toEqual(expectedTargets(nativeSource));
    expect(existsSync(path.join(profileSkills, 'disabled-profile'))).toBe(false);
    expect(launchFor({ ...options, bare: true }).session(spec).additionalDirectories).toBeUndefined();

    const claude = launchFor({
      ...options, vendor: 'claude', model: 'claude-sonnet-5',
      env: sourceEnvironment('claude', { id: 'work', kind: 'subscription', profile: 'work' }),
    });
    const meta = claude.session(spec).meta as { claudeCode: { options: { plugins: { path: string }[] } } };
    expect(targets(meta.claudeCode.options.plugins.map(plugin => plugin.path))).toEqual(expectedTargets(codexSource, nativeSource));
    const bare = launchFor({ ...options, vendor: 'claude', bare: true }).session(spec).meta;
    expect(bare).toMatchObject({ claudeCode: { options: { tools: [], settingSources: [] } } });
    expect((bare?.claudeCode as { options: Record<string, unknown> }).options.plugins).toBeUndefined();
  });
});

// `codex app-server`, which the account helper starts for one request at a
// time: a child that answers each request as the test says, or not at all.
type AppServerAnswer = { result: unknown } | { error: { message: string } } | null;

function fakeAppServer(answer: (method: string) => AppServerAnswer) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    },
  });
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, newline)) as { id?: number; method: string };
      buffer = buffer.slice(newline + 1);
      const reply = message.id === undefined ? null : answer(message.method);
      if (reply) child.stdout.write(`${JSON.stringify({ id: message.id, ...reply })}\n`);
    }
  });
  spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as childProcess.ChildProcess);
  return child;
}

test('a sign-in link opens whole on every platform', () => {
  const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&state=abc';
  // Through cmd, everything after the first `&` would be read as another command.
  expect(browserCommand(url, 'win32')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
  expect(browserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
  expect(browserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
});

describe('the Codex app-server behind an account request', () => {
  afterEach(() => {
    mock.restore();
  });

  test('a read cancelled while the app-server starts closes it', async () => {
    const child = fakeAppServer(() => null);
    const controller = new AbortController();
    const read = readCodexRateLimits('default', controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new TurnCancelledError());
    await expect(read).rejects.toThrow('Cancelled');
    expect(child.killed).toBe(true);
  });

  test('an app-server that refuses to initialize is closed', async () => {
    const child = fakeAppServer(method => method === 'initialize' ? { error: { message: 'unsupported client' } } : null);
    await expect(readCodexAccount('default')).rejects.toThrow('unsupported client');
    expect(child.killed).toBe(true);
  });

  test('a login waiting on the browser fails with the reason the app-server went', async () => {
    const child = fakeAppServer(method => {
      if (method === 'initialize') return { result: {} };
      if (method === 'account/read') return { result: { account: null } };
      if (method === 'account/login/start') return { result: { loginId: 'login-1', authUrl: 'https://auth.example/' } };
      return null;
    });
    const login = loginCodex('default', () => {
      child.stderr.write('token exchange failed\n');
      setImmediate(() => child.emit('exit', 1, null));
    }, 2_000);
    await expect(login).rejects.toThrow('codex app-server exited (1): token exchange failed');
  });
});
