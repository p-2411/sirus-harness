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
// settings out and its skill folders with them, so the folders reach it as
// two local plugins: `user` and `project`, whose skills it lists as
// `user:<name>` and `project:<name>`. Besides its own `.claude/skills`, each
// takes `.agents/skills`, the folder Codex reads too, so a skill kept there
// reaches both vendors.
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

function claudeUserFolders(): string[] {
  return [path.join(claudeHome(), 'skills'), path.join(os.homedir(), '.agents', 'skills')];
}

function claudeProjectFolders(directory: string): string[] {
  return projectDirectories(directory)
    .flatMap(dir => [path.join(dir, '.claude', 'skills'), path.join(dir, '.agents', 'skills')]);
}

// A local plugin named `name` whose skills are those of the folders, the
// first folder winning a name they share. Null when they hold none.
function writePlugin(pluginDirectory: string, name: string, folders: readonly string[]): string | null {
  const skills = new Map<string, string>();
  for (const folder of folders) {
    for (const [skill, source] of skillsIn(folder)) if (!skills.has(skill)) skills.set(skill, source);
  }
  if (skills.size === 0) return null;
  mkdirSync(path.join(pluginDirectory, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(pluginDirectory, 'skills'), { recursive: true });
  writeFileSync(path.join(pluginDirectory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  for (const [skill, source] of skills) symlinkSync(source, path.join(pluginDirectory, 'skills', skill), LINK_TYPE);
  return pluginDirectory;
}

// The plugins a Claude session in the directory loads its skills from,
// written under the launch's own folder, which goes with the process. The
// user's are written once per launch; the project's once per directory, since
// a worker forked on the same process runs in a worktree of its own.
export function claudeSkillPlugins(launchDirectory: string, directory: string): string[] {
  const plugins: string[] = [];
  try {
    const user = path.join(launchDirectory, 'user');
    if (existsSync(user)) plugins.push(user);
    else {
      const written = writePlugin(user, 'user', claudeUserFolders());
      if (written) plugins.push(written);
    }
    const key = crypto.createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);
    const project = path.join(launchDirectory, 'projects', key);
    if (existsSync(project)) plugins.push(project);
    else {
      const written = writePlugin(project, 'project', claudeProjectFolders(directory));
      if (written) plugins.push(written);
    }
  } catch {
    // Skills are never a reason for a session not to start.
  }
  return plugins;
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

export type SkillScope = 'user' | 'project' | 'built-in';

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

// The frontmatter fields a skill is listed by. Both vendors name a skill by
// its `name`, falling back to its folder, and Claude keeps one marked
// `user-invocable: false` out of its menu.
function readSkill(folder: string): {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
} | null {
  let text: string;
  try {
    text = readFileSync(path.join(folder, SKILL_FILE), 'utf8');
  } catch {
    return null;
  }
  const fields = frontmatter(text);
  const name = fields.name || path.basename(folder);
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
    for (const skillFolder of skillsIn(folder).values()) {
      const skill = readSkill(skillFolder);
      if (!skill || !skill.userInvocable || seen.has(skill.name)) continue;
      seen.add(skill.name);
      commands.push({
        name: skill.name,
        description: skill.description,
        ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
        scope,
        invocation: invocation(skill.name),
      });
    }
  }
  return commands;
}

function listSkillCommands(vendor: Vendor, directory: string): SkillCommand[] {
  const seen = new Set<string>();
  if (vendor === 'claude') {
    // Claude Code lets a personal skill win over a project skill of the same
    // name; both stay loaded, under their plugins' names.
    return [
      ...commandsIn(claudeUserFolders(), 'user', name => `/user:${name}`, seen),
      ...commandsIn(claudeProjectFolders(directory), 'project', name => `/project:${name}`, seen),
    ];
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
