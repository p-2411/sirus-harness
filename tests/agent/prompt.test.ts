import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSystemPrompt, systemPrompt } from '../../src/agent/prompt';
import { saveMemoryAccessPreference } from '../../src/data/persistence';

describe('system prompt', () => {
  test('defines the Sirus coding-agent contract and runtime context', () => {
    expect(systemPrompt).toContain('You are Sirus');
    expect(systemPrompt).toContain(process.cwd());
    expect(systemPrompt).toContain('Scope and autonomy');
    expect(systemPrompt).toContain('Verification');
  });

  test('uses the owning session directory in generated prompts', () => {
    expect(getSystemPrompt('/projects/owned-session')).toContain('/projects/owned-session');
    expect(getSystemPrompt('/projects/owned-session')).not.toContain(`Working directory: ${JSON.stringify(process.cwd())}`);
  });

  test('gives named participants their own identity in the shared session', () => {
    const prompt = getSystemPrompt('/projects/owned-session', 'reviewer');
    expect(prompt).toContain('You are @reviewer');
    expect(prompt).toContain('shared Sirus session');
    expect(prompt).toContain('do not impersonate another participant');
    expect(prompt).toContain('mention an existing participant');
    expect(prompt).toContain('cannot create participants');
  });

  test('describes exactly the tools exposed by the harness', () => {
    for (const tool of ['ReadFile', 'WriteFile', 'EditFile', 'RunShell']) {
      expect(systemPrompt).toContain(tool);
    }
    for (const unavailableTool of ['TodoWrite', 'Glob', 'Grep', 'apply_patch']) {
      expect(systemPrompt).not.toContain(unavailableTool);
    }
  });

  test('is provider and model neutral', () => {
    for (const providerIdentity of ['Anthropic', 'Claude Code', 'OpenAI', 'ChatGPT', 'Codex', 'GPT-']) {
      expect(systemPrompt).not.toContain(providerIdentity);
    }
  });

  test('adds proactive memory maintenance guidance when memory access is on', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-memory-prompt-'));
    const previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    try {
      expect(saveMemoryAccessPreference(true, directory)).toBe(true);
      const prompt = getSystemPrompt();
      for (const tool of ['SaveMemory', 'GetMemory', 'SearchMemories', 'DeleteMemory']) {
        expect(prompt).toContain(tool);
      }
      expect(prompt).toContain('two scopes');
      expect(prompt).toContain('Global memories are shared across every project');
      expect(prompt).toContain('Project memories are visible only to sessions owned by the current working directory');
      expect(prompt).toContain('preferences and dislikes');
      expect(prompt).toContain('architecture, paths, dependencies, commands');
      expect(prompt).toContain('Do not infer a global preference from a one-off request');
      expect(prompt).toContain('scope available');
      expect(prompt).toContain('exposes no way to select another project');
      expect(prompt).toContain('Global memories may link only to other global memories');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('omits memory guidance when memory access is off', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-memory-prompt-'));
    const previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    try {
      expect(saveMemoryAccessPreference(false, directory)).toBe(true);
      const prompt = getSystemPrompt();
      expect(prompt.toLowerCase()).not.toContain('memory');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
