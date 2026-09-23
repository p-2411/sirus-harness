import crypto from 'crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Vendor } from '../providers/catalog';

// Skills are the vendors' own: Claude Code's Skill tool and Codex's skill
// list, each finding SKILL.md folders the way it was trained to. Sirus only
// makes sure each one can see the user's and the project's skills under the
// credential it runs on.
//
// Claude runs with no setting sources, which keeps CLAUDE.md and the user's
// settings out and its skill folders and enabled plugins with them. The
// folders reach it as two local plugins, `user` and `project`, whose skills
// and commands it lists as `user:<name>` and `project:<name>`; besides its
// own `.claude/skills`, each takes `.agents/skills`, the folder Codex reads
// too, so a skill kept there reaches both vendors. The plugins the user
// installed and enabled in Claude Code are handed to it by path, whole:
// skills, commands, MCP servers and hooks. Of the skills Claude Code ships,
// those that need tools Sirus leaves off, or that act on Claude Code's own
// settings, which Sirus does not read, are switched off by name.
//
// Codex reads the project's `.agents/skills` and `.codex/skills` and the
// user's `~/.agents/skills` as it is. The one folder it loses is the user's
// `~/.codex/skills`, when a credential points CODEX_HOME at a profile of its
// own; its skills are linked in there.
//
// The user reaches a skill the way each vendor's own terminal offers it: as
// `/name` in the command menu. Sirus lists the skills of the participant the
// prompt goes to from the same folders, and hands that participant the
// command in its vendor's words: `/user:name` or `/project:name` for Claude,
// which reads a leading slash command natively, and `$name` for Codex, which
// resolves a skill mentioned that way.

const SKILL_FILE = 'SKILL.md';
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

// The skills in one folder by name: its subfolders that hold a SKILL.md.
function skillsIn(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const skill = path.join(folder, name);
    if (existsSync(path.join(skill, SKILL_FILE))) found.set(name, skill);
  }
  return found;
}

// The directory and each parent up to the git root, nearest first, the way
// Claude Code and Codex both walk for project skills. Outside a repository
// only the directory itself.
function projectDirectories(directory: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    directories.push(current);
    // A worktree's .git is a file; either way it marks the root.
    if (existsSync(path.join(current, '.git'))) return directories;
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(directory)];
    current = parent;
  }
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Where Claude finds the user's or a project's skills and commands.
interface ClaudeFolders {
  skills: string[];
  commands: string[];
}

function claudeUserFolders(): ClaudeFolders {
  return {
    skills: [path.join(claudeHome(), 'skills'), path.join(os.homedir(), '.agents', 'skills')],
    commands: [path.join(claudeHome(), 'commands')],
  };
}

function claudeProjectFolders(directory: string): ClaudeFolders {
  const directories = projectDirectories(directory);
  return {
    skills: directories.flatMap(dir => [path.join(dir, '.claude', 'skills'), path.join(dir, '.agents', 'skills')]),
    commands: directories.map(dir => path.join(dir, '.claude', 'commands')),
  };
}

// The commands in one folder by name: its markdown files.
function commandFilesIn(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name.endsWith('.md') && !name.startsWith('.')) found.set(name.slice(0, -'.md'.length), path.join(folder, name));
  }
  return found;
}

// A local plugin named `name` whose skills and commands are those of the
// folders, the first folder winning a name they share. Null when they hold
// none.
function writePlugin(pluginDirectory: string, name: string, folders: ClaudeFolders): string | null {
  const skills = new Map<string, string>();
  for (const folder of folders.skills) {
    for (const [skill, source] of skillsIn(folder)) if (!skills.has(skill)) skills.set(skill, source);
  }
  const commands = new Map<string, string>();
  for (const folder of folders.commands) {
    for (const [command, source] of commandFilesIn(folder)) if (!commands.has(command)) commands.set(command, source);
  }
  if (skills.size === 0 && commands.size === 0) return null;
  mkdirSync(path.join(pluginDirectory, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(pluginDirectory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  if (skills.size > 0) mkdirSync(path.join(pluginDirectory, 'skills'));
  for (const [skill, source] of skills) symlinkSync(source, path.join(pluginDirectory, 'skills', skill), LINK_TYPE);
  if (commands.size > 0) mkdirSync(path.join(pluginDirectory, 'commands'));
  for (const [command, source] of commands) symlinkSync(source, path.join(pluginDirectory, 'commands', `${command}.md`));
  return pluginDirectory;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A plugin the user installed and enabled in Claude Code.
interface InstalledPlugin {
  name: string;
  path: string;
}

// The plugins Claude Code would load in the directory: those installed for
// the user, or for this project, that a settings file enables. As in Claude
// Code, the project's settings override the user's and its local settings
// override both.
function installedClaudePlugins(directory: string): InstalledPlugin[] {
  const home = claudeHome();
  const installed = readJson(path.join(home, 'plugins', 'installed_plugins.json'));
  if (!isRecord(installed) || !isRecord(installed.plugins)) return [];
  const projects = projectDirectories(directory);
  const enabled: Record<string, unknown> = {};
  const settingsFiles = [
    path.join(home, 'settings.json'),
    ...[...projects].reverse().flatMap(dir => [
      path.join(dir, '.claude', 'settings.json'),
      path.join(dir, '.claude', 'settings.local.json'),
    ]),
  ];
  for (const file of settingsFiles) {
    const settings = readJson(file);
    if (isRecord(settings) && isRecord(settings.enabledPlugins)) Object.assign(enabled, settings.enabledPlugins);
  }
  const plugins: InstalledPlugin[] = [];
  for (const [key, entry] of Object.entries(installed.plugins)) {
    if (enabled[key] !== true) continue;
    const installs = (Array.isArray(entry) ? entry : [entry]).filter(isRecord);
    const install = installs.find(candidate => typeof candidate.installPath === 'string'
      && existsSync(candidate.installPath)
      && (candidate.scope === 'user'
        || (typeof candidate.projectPath === 'string' && projects.includes(path.resolve(candidate.projectPath)))));
    if (!install) continue;
    const pluginPath = install.installPath as string;
    const manifest = readJson(path.join(pluginPath, '.claude-plugin', 'plugin.json'));
    const name = isRecord(manifest) && typeof manifest.name === 'string' ? manifest.name : key.split('@')[0];
    plugins.push({ name, path: pluginPath });
  }
  return plugins;
}

// Claude Code's bundled skills that cannot work under Sirus. `batch` and
// `code-review` start agents of their own, `loop` schedules with cron and
// wakeup tools, `deep-research` and `workflow-authoring` run workflows, and
// `design-sync` asks questions through a tool Sirus leaves off; the rest act
// on Claude Code's own settings and logs.
const CLAUDE_BUNDLED_OFF = [
  'batch', 'code-review', 'loop', 'deep-research', 'workflow-authoring', 'design-sync',
  'update-config', 'fewer-permission-prompts', 'debug',
];

// The bundled skills that stay, as the menu lists them.
const CLAUDE_BUNDLED: readonly { name: string; description: string }[] = [
  { name: 'claude-api', description: 'Reference for the Claude API and the Anthropic SDK' },
  { name: 'dataviz', description: 'Guidance for any chart, graph, plot or dashboard' },
  { name: 'run', description: "Launch and drive this project's app to see a change working" },
  { name: 'run-skill-generator', description: 'Author or improve the per-project run skill' },
  { name: 'simplify', description: 'Review the changed code for reuse, simplification and efficiency' },
  { name: 'verify', description: 'Verify a code change by exercising it end to end' },
];

// What a Claude session carries for skills and plugins: the `plugins` its
// options load, the user's and the project's written under the launch's own
// folder, which goes with the process, and the `settings` that switch
// bundled skills off. The user's are written once per launch; the project's
// once per directory, since a worker forked on the same process runs in a
// worktree of its own.
export function claudeSkillOptions(launchDirectory: string, directory: string): {
  plugins: { type: 'local'; path: string; skipMcpDiscovery?: boolean }[];
  settings: { skillOverrides: Record<string, 'off'> };
} {
  const plugins: { type: 'local'; path: string; skipMcpDiscovery?: boolean }[] = [];
  try {
    const user = path.join(launchDirectory, 'user');
    const written = existsSync(user) ? user : writePlugin(user, 'user', claudeUserFolders());
    if (written) plugins.push({ type: 'local', path: written, skipMcpDiscovery: true });
    const key = crypto.createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);
    const project = path.join(launchDirectory, 'projects', key);
    const projectWritten = existsSync(project) ? project : writePlugin(project, 'project', claudeProjectFolders(directory));
    if (projectWritten) plugins.push({ type: 'local', path: projectWritten, skipMcpDiscovery: true });
    for (const plugin of installedClaudePlugins(directory)) plugins.push({ type: 'local', path: plugin.path });
  } catch {
    // Skills are never a reason for a session not to start.
  }
  return {
    plugins,
    settings: { skillOverrides: Object.fromEntries(CLAUDE_BUNDLED_OFF.map(name => [name, 'off' as const])) },
  };
}

// Links the user's own Codex skills into the home a credential points
// CODEX_HOME at, when that is not the user's home. Each skill is linked on
// its own, since Codex writes its built-in skills into the folder; a link to
// a skill the user has since removed goes.
export function linkCodexSkills(profileHome: string | undefined): void {
  const userHome = codexHome();
  if (!profileHome || path.resolve(profileHome) === path.resolve(userHome)) return;
  const source = path.join(userHome, 'skills');
  const target = path.join(profileHome, 'skills');
  try {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(target)) {
      const link = path.join(target, name);
      if (!lstatSync(link).isSymbolicLink()) continue;
      if (readlinkSync(link).startsWith(source + path.sep) && !existsSync(link)) unlinkSync(link);
    }
    for (const [name, skill] of skillsIn(source)) {
      const link = path.join(target, name);
      try {
        lstatSync(link);
      } catch {
        symlinkSync(skill, link, LINK_TYPE);
      }
    }
  } catch {
    // Skills are never a reason for a session not to start.
  }
}

export type SkillScope = 'user' | 'project' | 'built-in' | 'plugin';

// A skill as the command menu offers it.
export interface SkillCommand {
  // What the user types after the slash: the skill's own name.
  name: string;
  description: string;
  // What the skill takes after its name, when it says (`argument-hint`).
  argumentHint?: string;
  scope: SkillScope;
  // What the participant's vendor is sent in place of `/name`.
  invocation: string;
}

interface SkillEntry {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
}

// The frontmatter fields a skill is listed by. Both vendors name a skill by
// its `name`, falling back to its folder, and Claude keeps one marked
// `user-invocable: false` out of its menu.
function readSkill(folder: string): SkillEntry | null {
  return readEntry(path.join(folder, SKILL_FILE), path.basename(folder), true);
}

// A command file is listed by its file name; Claude reads only the
// description and argument hint from its frontmatter.
function readCommand(file: string, name: string): SkillEntry | null {
  return readEntry(file, name, false);
}

function readEntry(file: string, fallbackName: string, named: boolean): SkillEntry | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const fields = frontmatter(text);
  const name = (named && fields.name) || fallbackName;
  return {
    name,
    description: fields.description ?? '',
    ...(fields['argument-hint'] ? { argumentHint: fields['argument-hint'] } : {}),
    userInvocable: fields['user-invocable'] !== 'false',
  };
}

// Top-level `key: value` pairs of a SKILL.md's YAML frontmatter, with quoted
// values unquoted and folded or literal blocks joined onto one line. Nested
// keys are skipped; nothing listed needs them.
function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (!line) continue;
    let value = line[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || lines[index + 1] === '')) {
        block.push(lines[++index].trim());
      }
      value = block.filter(Boolean).join(' ');
    } else if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields[line[1]] = value;
  }
  return fields;
}

// Adds an entry to the menu unless an earlier one took its name or the user
// cannot invoke it.
function addEntry(
  commands: SkillCommand[],
  entry: SkillEntry | null,
  scope: SkillScope,
  invocation: (name: string) => string,
  seen: Set<string>,
): void {
  if (!entry || !entry.userInvocable || seen.has(entry.name)) return;
  seen.add(entry.name);
  commands.push({
    name: entry.name,
    description: entry.description,
    ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
    scope,
    invocation: invocation(entry.name),
  });
}

// The skills of the folders as commands, the first folder winning a name
// they share and the skills a user cannot invoke left out.
function commandsIn(
  folders: readonly string[],
  scope: SkillScope,
  invocation: (name: string) => string,
  seen: Set<string>,
): SkillCommand[] {
  const commands: SkillCommand[] = [];
  for (const folder of folders) {
    for (const skillFolder of skillsIn(folder).values()) addEntry(commands, readSkill(skillFolder), scope, invocation, seen);
  }
  return commands;
}

// Claude's skills and commands from the user's or a project's folders.
function claudeFolderCommands(folders: ClaudeFolders, scope: 'user' | 'project', seen: Set<string>): SkillCommand[] {
  const invocation = (name: string) => `/${scope}:${name}`;
  const commands = commandsIn(folders.skills, scope, invocation, seen);
  for (const folder of folders.commands) {
    for (const [name, file] of commandFilesIn(folder)) addEntry(commands, readCommand(file, name), scope, invocation, seen);
  }
  return commands;
}

// A manifest path setting, as the list of paths it names.
function manifestPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// An installed plugin's skills and commands, named `plugin:name` as Claude
// Code names them. A manifest that names its own skill or command paths
// replaces the default folder for them.
function pluginCommands(plugin: InstalledPlugin, seen: Set<string>): SkillCommand[] {
  const manifest = readJson(path.join(plugin.path, '.claude-plugin', 'plugin.json'));
  const fields = isRecord(manifest) ? manifest : {};
  const commands: SkillCommand[] = [];
  const named = (name: string) => `${plugin.name}:${name}`;
  const add = (entry: SkillEntry | null) => {
    if (entry) addEntry(commands, { ...entry, name: named(entry.name) }, 'plugin', name => `/${name}`, seen);
  };
  const skillPaths = manifestPaths(fields.skills);
  for (const relative of skillPaths.length > 0 ? skillPaths : ['skills']) {
    const folder = path.resolve(plugin.path, relative);
    if (existsSync(path.join(folder, SKILL_FILE))) add(readSkill(folder));
    else for (const skillFolder of skillsIn(folder).values()) add(readSkill(skillFolder));
  }
  const commandPaths = manifestPaths(fields.commands);
  for (const relative of commandPaths.length > 0 ? commandPaths : ['commands']) {
    const target = path.resolve(plugin.path, relative);
    if (target.endsWith('.md')) add(readCommand(target, path.basename(target, '.md')));
    else for (const [name, file] of commandFilesIn(target)) add(readCommand(file, name));
  }
  return commands;
}

function listSkillCommands(vendor: Vendor, directory: string): SkillCommand[] {
  const seen = new Set<string>();
  if (vendor === 'claude') {
    // Claude Code lets a personal skill win over a project skill of the same
    // name; both stay loaded, under their plugins' names.
    const commands = [
      ...claudeFolderCommands(claudeUserFolders(), 'user', seen),
      ...claudeFolderCommands(claudeProjectFolders(directory), 'project', seen),
    ];
    for (const bundled of CLAUDE_BUNDLED) {
      addEntry(commands, { ...bundled, userInvocable: true }, 'built-in', name => `/${name}`, seen);
    }
    for (const plugin of installedClaudePlugins(directory)) commands.push(...pluginCommands(plugin, seen));
    return commands;
  }
  const project = projectDirectories(directory)
    .flatMap(dir => [path.join(dir, '.agents', 'skills'), path.join(dir, '.codex', 'skills')]);
  return [
    ...commandsIn(project, 'project', name => `$${name}`, seen),
    ...commandsIn([path.join(os.homedir(), '.agents', 'skills'), path.join(codexHome(), 'skills')], 'user', name => `$${name}`, seen),
    ...commandsIn([path.join(codexHome(), 'skills', '.system')], 'built-in', name => `$${name}`, seen),
  ];
}

// The menu reads the list on every keystroke after a slash; the folders are
// read again at most this often.
const LIST_TTL_MS = 2_000;
const listed = new Map<string, { at: number; commands: SkillCommand[] }>();

// The skills a participant of the vendor, running in the directory, can be
// asked to use by name, in the order its own menu would list them.
export function skillCommands(vendor: Vendor, directory: string): SkillCommand[] {
  const key = `${vendor}\0${path.resolve(directory)}`;
  const cached = listed.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.commands;
  let commands: SkillCommand[];
  try {
    commands = listSkillCommands(vendor, directory);
  } catch {
    commands = [];
  }
  listed.set(key, { at: Date.now(), commands });
  return commands;
}

// A prompt that opens with `/name` for one of the vendor's skills, in the
// vendor's own words; any other prompt as it is.
export function skillPrompt(text: string, vendor: Vendor, directory: string): string {
  const match = /^\/(\S+)/.exec(text);
  if (!match) return text;
  const skill = skillCommands(vendor, directory).find(command => command.name === match[1]);
  return skill ? skill.invocation + text.slice(match[0].length) : text;
}
