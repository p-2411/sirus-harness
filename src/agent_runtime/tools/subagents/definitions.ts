import { YAML } from 'bun';
import { existsSync, readdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { modelIds, vendorOf } from '../../providers/catalog';
import { parseThinkingLevel, type ThinkingLevel } from '../../types';

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
}

// Root first, so a definition or setting nearer the working directory wins.
function projectDirectories(directory: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    directories.unshift(current);
    if (existsSync(path.join(current, '.git'))) return directories;
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(directory)];
    current = parent;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return record(value) ? value : {};
  } catch {
    return {};
  }
}

function pluginAgents(home: string, projects: string[]): { folder: string; prefix: string }[] {
  const installed = readJson(path.join(home, 'plugins', 'installed_plugins.json')).plugins;
  if (!record(installed)) return [];
  const enabled: Record<string, unknown> = {};
  for (const file of [path.join(home, 'settings.json'), ...projects.flatMap(directory => [
    path.join(directory, '.claude', 'settings.json'), path.join(directory, '.claude', 'settings.local.json'),
  ])]) {
    const settings = readJson(file);
    if (record(settings.enabledPlugins)) Object.assign(enabled, settings.enabledPlugins);
  }
  const folders: { folder: string; prefix: string }[] = [];
  for (const [key, entry] of Object.entries(installed)) {
    if (enabled[key] !== true) continue;
    const installs = (Array.isArray(entry) ? entry : [entry]).filter(record);
    const install = installs.find(candidate => typeof candidate.installPath === 'string'
      && existsSync(candidate.installPath)
      && (candidate.scope === 'user'
        || (typeof candidate.projectPath === 'string' && projects.includes(path.resolve(candidate.projectPath)))));
    if (!install) continue;
    const directory = install.installPath as string;
    const manifest = readJson(path.join(directory, '.claude-plugin', 'plugin.json'));
    const name = typeof manifest.name === 'string' ? manifest.name : key.split('@')[0];
    // The standard agents folder is always loaded. A manifest may add files
    // or folders elsewhere in the same plugin.
    folders.push({ folder: path.join(directory, 'agents'), prefix: `${name}:` });
    const extra = manifest.agents;
    for (const relative of Array.isArray(extra) ? extra : typeof extra === 'string' ? [extra] : []) {
      if (typeof relative === 'string') folders.push({ folder: path.resolve(directory, relative), prefix: `${name}:` });
    }
  }
  return folders;
}

function definitionsIn(folder: string, prefix: string): AgentDefinition[] {
  let files: string[];
  try {
    files = folder.endsWith('.md') ? [folder] : readdirSync(folder).sort()
      .filter(name => name.endsWith('.md')).map(name => path.join(folder, name));
  } catch {
    return [];
  }
  return files.flatMap(file => {
    try {
      const text = readFileSync(file, 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
      if (!match) return [];
      const meta: unknown = YAML.parse(match[1]);
      if (!record(meta) || typeof meta.name !== 'string' || !meta.name.trim()
        || typeof meta.description !== 'string') return [];
      const tools = typeof meta.tools === 'string' ? meta.tools.split(',').map(tool => tool.trim()).filter(Boolean)
        : Array.isArray(meta.tools) && meta.tools.every(tool => typeof tool === 'string') ? meta.tools : undefined;
      if (meta.tools !== undefined && !tools) return [];
      const level = parseThinkingLevel(meta.thinkingLevel ?? meta.effort);
      return [{
        name: prefix + meta.name.trim(), description: meta.description, prompt: match[2].trim(),
        ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
        ...(level ? { thinkingLevel: level } : {}), ...(tools ? { tools } : {}),
      }];
    } catch {
      return [];
    }
  });
}

export function agentDefinitions(directory: string): AgentDefinition[] {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const projects = projectDirectories(directory);
  const folders = [
    ...pluginAgents(home, projects),
    { folder: path.join(home, 'agents'), prefix: '' },
    ...projects.map(project => ({ folder: path.join(project, '.claude', 'agents'), prefix: '' })),
  ];
  const definitions = new Map<string, AgentDefinition>();
  for (const { folder, prefix } of folders) {
    for (const definition of definitionsIn(folder, prefix)) definitions.set(definition.name, definition);
  }
  return [...definitions.values()];
}

// Claude's format uses short model names even before a live catalog has
// listed those aliases. Prefer the alias when available, then its catalog id.
export function definitionModel(model: string | undefined, ownerModel: string): string {
  if (!model || model === 'inherit') return ownerModel;
  const known = modelIds();
  if (known.includes(model)) return model;
  return [...known].reverse().find(id => vendorOf(id) === 'claude' && id.startsWith(`claude-${model}-`)) ?? model;
}

export function readOnlyTools(tools: readonly string[] | undefined): boolean {
  return tools !== undefined && tools.every(tool => ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'].includes(tool));
}
