import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { dataDirectory } from '../../dataDirectory';

// The vendors still load their own skills. These wrappers add only what the
// other vendor has and this one does not, without touching either home or
// bringing a plugin's hooks or MCP servers across with its skills.

interface Skill {
  name: string;
  folder: string;
  description: string;
  disabled: boolean;
  manual: boolean;
}

interface Plugin {
  name: string;
  folder: string;
  enabled: boolean;
  shared: boolean;
  skills: Skill[];
}

interface Inventory {
  skills: Skill[];
  plugins: Plugin[];
}

type Fields = Record<string, unknown>;
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : {};
}

function readFields(file: string): Fields {
  try {
    const text = readFileSync(file, 'utf8');
    return fields(file.endsWith('.toml') ? Bun.TOML.parse(text) : JSON.parse(text));
  } catch {
    return {};
  }
}

function children(folder: string): string[] {
  try {
    return readdirSync(folder).filter(name => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function directories(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// Read the parent's homes, before a credential gives the child a profile.
function userHome(): string {
  return process.env.HOME || os.homedir();
}

function homes(): { claude: string; codex: string } {
  return {
    claude: process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'),
    codex: process.env.CODEX_HOME || path.join(userHome(), '.codex'),
  };
}

function projects(directory: string): string[] {
  const found: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    found.push(current);
    if (existsSync(path.join(current, '.git'))) return found;
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(directory)];
    current = parent;
  }
}

function readSkill(folder: string): Skill | null {
  try {
    const text = readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const metadata = match ? fields(Bun.YAML.parse(match[1])) : {};
    return {
      name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : path.basename(folder),
      folder,
      description: typeof metadata.description === 'string' ? metadata.description.trim() : '',
      disabled: metadata.enabled === false,
      manual: metadata['disable-model-invocation'] === true,
    };
  } catch {
    return null;
  }
}

// Follow skill links, but not cycles or a skill's supporting directories.
function skillsIn(folder: string, seen = new Set<string>()): Skill[] {
  const resolved = canonical(folder);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  const skill = readSkill(folder);
  if (skill) return [skill];
  return children(folder).flatMap(name => skillsIn(path.join(folder, name), seen));
}

function pluginSkills(folder: string, manifest: Fields, includeDefault = false): Skill[] {
  const configured = typeof manifest.skills === 'string' ? [manifest.skills]
    : Array.isArray(manifest.skills) ? manifest.skills.filter((entry): entry is string => typeof entry === 'string') : [];
  const roots = includeDefault ? ['skills', ...configured] : configured.length ? configured : ['skills'];
  return roots.flatMap(relative => skillsIn(path.resolve(folder, relative)));
}

function claudeInventory(directory: string, includeSynced: boolean): Inventory {
  const home = homes().claude;
  const project = projects(directory);
  const enabled: Fields = {};
  for (const file of [path.join(home, 'settings.json'), ...[...project].reverse().flatMap(dir => [
    path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'),
  ])]) Object.assign(enabled, fields(readFields(file).enabledPlugins));
  const plugins: Plugin[] = [];
  const installed = fields(readFields(path.join(home, 'plugins', 'installed_plugins.json')).plugins);
  for (const [key, value] of Object.entries(installed)) {
    const installs = (Array.isArray(value) ? value : [value]).map(fields);
    const install = installs.find(entry => typeof entry.installPath === 'string' && existsSync(entry.installPath)
      && (entry.scope === 'user' || typeof entry.projectPath === 'string' && project.includes(path.resolve(entry.projectPath))));
    if (!install) continue;
    const folder = install.installPath as string;
    const manifest = readFields(path.join(folder, '.claude-plugin', 'plugin.json'));
    const name = typeof manifest.name === 'string' ? manifest.name : key.split('@')[0];
    plugins.push({
      name, folder, enabled: enabled[key] === true,
      shared: !['anthropic', 'anthropic-example'].includes(String(manifest.source))
        && !key.endsWith('@claude-ai') && !canonical(folder).includes(`${path.sep}synced${path.sep}`),
      skills: pluginSkills(folder, manifest, true),
    });
  }
  const personal = path.join(home, 'skills');
  const skills = children(personal).filter(name => includeSynced || name !== 'synced')
    .flatMap(name => skillsIn(path.join(personal, name)));
  skills.push(...project.flatMap(dir => skillsIn(path.join(dir, '.claude', 'skills'))));
  return { skills, plugins };
}

function codexConfig(directory: string): Fields {
  const config = readFields(path.join(homes().codex, 'config.toml'));
  // Codex reads project plugin settings, but skill enablement comes only
  // from the user's config (and the session's explicit overrides).
  for (const dir of projects(directory).reverse()) {
    const project = readFields(path.join(dir, '.codex', 'config.toml'));
    const plugins = fields(config.plugins);
    for (const [name, value] of Object.entries(fields(project.plugins))) plugins[name] = { ...fields(plugins[name]), ...fields(value) };
    config.plugins = plugins;
  }
  return config;
}

function codexEnabled(skill: Skill, config: Fields, plugin?: string): boolean {
  let enabled = !skill.disabled;
  const entries = fields(config.skills).config;
  if (!Array.isArray(entries)) return enabled;
  const file = canonical(path.join(skill.folder, 'SKILL.md'));
  const name = plugin ? `${plugin}:${skill.name}` : skill.name;
  for (const value of entries) {
    const entry = fields(value);
    const byPath = typeof entry.path === 'string';
    const byName = typeof entry.name === 'string';
    if (byPath === byName || typeof entry.enabled !== 'boolean') continue;
    if (byPath ? canonical(entry.path as string) === file : (entry.name as string).trim() === name) enabled = entry.enabled;
  }
  return enabled;
}

function codexInventory(directory: string, includeSystem = false): Inventory {
  const home = homes().codex;
  const config = codexConfig(directory);
  const configured = fields(config.plugins);
  const plugins: Plugin[] = [];
  const cache = path.join(home, 'plugins', 'cache');
  for (const market of directories(cache)) {
    for (const entry of directories(path.join(cache, market))) {
      const root = path.join(cache, market, entry);
      const versions = directories(root).filter(version => /^[A-Za-z0-9.+_-]+$/.test(version)).sort((a, b) => {
        if (a === 'local') return -1;
        if (b === 'local') return 1;
        const semver = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
        return semver.test(a) && semver.test(b) ? Bun.semver.order(b, a) : b < a ? -1 : b > a ? 1 : 0;
      });
      if (!versions.length) continue;
      const folder = path.join(root, versions[0]);
      if (!existsSync(path.join(folder, '.codex-plugin', 'plugin.json'))
        && !existsSync(path.join(folder, '.claude-plugin', 'plugin.json'))) continue;
      const manifest = readFields(path.join(folder,
        existsSync(path.join(folder, '.codex-plugin', 'plugin.json')) ? '.codex-plugin' : '.claude-plugin', 'plugin.json'));
      const name = typeof manifest.name === 'string' ? manifest.name : entry;
      plugins.push({
        name, folder, enabled: Object.hasOwn(configured, `${entry}@${market}`)
          && fields(configured[`${entry}@${market}`]).enabled !== false,
        shared: !['openai-bundled', 'openai-primary-runtime', 'openai-curated', 'openai-curated-remote'].includes(market),
        skills: pluginSkills(folder, manifest).map(skill => ({ ...skill, disabled: !codexEnabled(skill, config, name) })),
      });
    }
  }
  const roots = [
    ...projects(directory).flatMap(dir => [path.join(dir, '.agents', 'skills'), path.join(dir, '.codex', 'skills')]),
    path.join(userHome(), '.agents', 'skills'), path.join(home, 'skills'),
    ...(includeSystem ? [path.join(home, 'skills', '.system')] : []),
  ];
  const skills = roots.flatMap(root => skillsIn(root)).map(skill => ({ ...skill, disabled: !codexEnabled(skill, config) }));
  return { skills, plugins };
}

// A separate credential home loses these native skills. Keep the user's
// disabled entries out of the links there as well as out of the bridge.
export function codexPersonalSkills(directory: string): Map<string, string> {
  const root = path.join(homes().codex, 'skills');
  const config = codexConfig(directory);
  const found = new Map<string, string>();
  for (const name of children(root)) {
    const skill = readSkill(path.join(root, name));
    if (skill && codexEnabled(skill, config)) found.set(name, skill.folder);
  }
  return found;
}

interface SharedGroup {
  name: string | null;
  skills: Skill[];
}

function sharedGroups(source: Inventory, target: Inventory, forCodex: boolean): SharedGroup[] {
  const names = new Set([...target.skills, ...target.plugins.flatMap(plugin => plugin.skills)].map(skill => skill.name));
  const plugins = new Set(target.plugins.map(plugin => plugin.name));
  const take = (skills: Skill[]): Skill[] => skills.filter(skill => {
    if (skill.disabled || names.has(skill.name)) return false;
    if (forCodex && (skill.manual || !skill.description || [...skill.name].length > 64)) return false;
    names.add(skill.name);
    return true;
  });
  return [
    { name: null, skills: take(source.skills) },
    ...source.plugins.filter(plugin => plugin.enabled && plugin.shared && !plugins.has(plugin.name))
      .map(plugin => ({ name: plugin.name, skills: take(plugin.skills) })),
  ].filter(group => group.skills.length > 0);
}

// The inventory determines the directory. Old sessions keep their own links;
// a changed inventory gets a new directory, so concurrent launches never
// remove or rewrite one another's skills.
function writeBridge(groups: SharedGroup[], forCodex: boolean): string | null {
  if (!groups.length) return null;
  const digest = crypto.createHash('sha256').update(JSON.stringify({ forCodex, groups })).digest('hex').slice(0, 24);
  const parent = path.join(dataDirectory(), 'shared-skills', forCodex ? 'codex' : 'claude');
  const destination = path.join(parent, digest);
  if (existsSync(destination)) return destination;
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, '.building-'));
  try {
    for (const [index, group] of groups.entries()) {
      const root = forCodex ? path.join(temporary, '.agents', 'skills') : temporary;
      const plugin = path.join(root, forCodex && group.name === null ? 'personal' : `plugin-${index}`);
      const skills = forCodex && group.name === null ? plugin : path.join(plugin, 'skills');
      mkdirSync(skills, { recursive: true });
      if (!forCodex || group.name !== null) {
        mkdirSync(path.join(plugin, '.claude-plugin'));
        writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: group.name ?? 'codex' }));
      }
      for (const [skillIndex, skill] of group.skills.entries()) {
        // The source folder's basename is the native fallback when there is
        // no frontmatter name. An index only separates equal folder names.
        const basename = path.basename(skill.folder);
        const link = path.join(skills, existsSync(path.join(skills, basename)) ? `${skillIndex}-${basename}` : basename);
        symlinkSync(path.resolve(skill.folder), link, LINK_TYPE);
      }
    }
    try { renameSync(temporary, destination); } catch (error) {
      if (!existsSync(destination)) throw error;
    }
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function claudeSkillPlugins(directory: string): { type: 'local'; path: string; skipMcpDiscovery: true }[] {
  try {
    const groups = sharedGroups(codexInventory(directory), claudeInventory(directory, true), false);
    const bridge = writeBridge(groups, false);
    return bridge ? children(bridge).map(name => ({ type: 'local', path: path.join(bridge, name), skipMcpDiscovery: true })) : [];
  } catch {
    // An unreadable skill or a read-only data directory must not stop a turn.
    return [];
  }
}

export function codexSkillDirectories(directory: string): string[] {
  try {
    const groups = sharedGroups(claudeInventory(directory, false), codexInventory(directory, true), true);
    const bridge = writeBridge(groups, true);
    // The adapter grants this root workspace writes. Codex protects .agents
    // beneath each such root, and resolves links before sandboxing writes,
    // so this does not grant writes to the user's real skill folders.
    return bridge ? [bridge] : [];
  } catch {
    return [];
  }
}
