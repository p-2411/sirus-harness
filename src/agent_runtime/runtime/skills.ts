import crypto from 'crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

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
      const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      const written = writePlugin(user, 'user', [
        path.join(claudeHome, 'skills'),
        path.join(os.homedir(), '.agents', 'skills'),
      ]);
      if (written) plugins.push(written);
    }
    const key = crypto.createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);
    const project = path.join(launchDirectory, 'projects', key);
    if (existsSync(project)) plugins.push(project);
    else {
      const folders = projectDirectories(directory)
        .flatMap(dir => [path.join(dir, '.claude', 'skills'), path.join(dir, '.agents', 'skills')]);
      const written = writePlugin(project, 'project', folders);
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
export function linkCodexSkills(codexHome: string | undefined): void {
  const userHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!codexHome || path.resolve(codexHome) === path.resolve(userHome)) return;
  const source = path.join(userHome, 'skills');
  const target = path.join(codexHome, 'skills');
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
