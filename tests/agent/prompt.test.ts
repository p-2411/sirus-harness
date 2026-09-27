import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FORKED_WORKER_HANDOVER, sirusPrompt } from '../../src/agent_runtime/prompt';
import { openSettings } from '../../src/persistence/settings';

describe('system prompt', () => {
  test('adds only what the vendor cannot know to its own prompt', () => {
    const prompt = sirusPrompt();
    expect(prompt).toContain('You are running inside Sirus');
    expect(prompt).toContain('the default participant, @sirus');
    // The vendor's own prompt and instruction files cover the rest.
    for (const restated of ['Scope and autonomy', 'Verification', 'Working directory', 'AGENTS.md', 'SIRUS.md']) {
      expect(prompt).not.toContain(restated);
    }
  });

  test('tells the owner a subagent is a background task that reports back on its own', () => {
    const owner = sirusPrompt('sirus');
    expect(owner).toContain('as soon as the subagent is on its way');
    expect(owner).toContain('reaches you as a message from @<id> and starts your next turn');
    expect(owner).toContain('branch sirus/<id> in its own worktree');
    expect(owner).toContain('Merge it yourself');
    expect(owner).toContain('MessageAgent with an id and a message');
    expect(owner).toContain('context "owner"');
    // Nothing tells it to wait, poll or read a stream file any more.
    expect(owner).not.toContain('streamFile');
    expect(owner).not.toContain('wait true');
  });

  test('tells the worker it may be steered and that its changes land on a branch', () => {
    const worker = sirusPrompt('sirus', true);
    expect(worker).toContain('may send further instructions while you work');
    expect(worker).toContain('worktree of the project on a branch of your own');
    expect(worker).toContain('final message addressed to the agent that spawned you');
  });

  test('the forked handover says the same thing, since a fork keeps the owner’s system prompt', () => {
    expect(FORKED_WORKER_HANDOVER).toStartWith('You are now a Sirus subagent, forked from the conversation above');
    for (const obligation of [
      'never ask one',
      'may send further instructions while you work',
      'cannot spawn or contact other agents',
      'worktree of the project on a branch of your own',
      'final message addressed to the agent that spawned you',
    ]) {
      expect(FORKED_WORKER_HANDOVER).toContain(obligation);
      expect(sirusPrompt('sirus', true)).toContain(obligation);
    }
  });

  test('gives named participants their own identity in the shared session', () => {
    const prompt = sirusPrompt('reviewer');
    expect(prompt).toContain('the participant @reviewer');
    expect(prompt).toContain('one shared session');
    expect(prompt).toContain('do not impersonate another participant');
    expect(prompt).toContain('mention an existing participant');
    expect(prompt).toContain('cannot create participants');
    expect(prompt).toContain('receives your whole message');
  });

  test('describes the vendor tools generically and names only the Sirus tools', () => {
    for (const tool of ['SpawnAgent', 'CheckAgent', 'MessageAgent', 'CancelAgent', 'ListAgents']) {
      expect(sirusPrompt()).toContain(tool);
    }
    for (const retiredTool of ['ReadFile', 'WriteFile', 'EditFile', 'RunShell', 'SearchFiles', 'FetchURL', 'TodoWrite', 'apply_patch']) {
      expect(sirusPrompt()).not.toContain(retiredTool);
    }
    expect(sirusPrompt('sirus', true)).not.toContain('SpawnAgent');
  });

  test('is provider and model neutral', () => {
    for (const providerIdentity of ['Anthropic', 'Claude Code', 'OpenAI', 'ChatGPT', 'Codex', 'GPT-']) {
      expect(sirusPrompt()).not.toContain(providerIdentity);
    }
  });

  test('adds proactive memory maintenance guidance when memory access is on', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-memory-prompt-'));
    const previousDirectory = process.env.SIRUS_DATA_DIR;
    process.env.SIRUS_DATA_DIR = directory;
    try {
      expect(openSettings(directory).set({ memoryEnabled: true })).toBe(true);
      const prompt = sirusPrompt();
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
      expect(openSettings(directory).set({ memoryEnabled: false })).toBe(true);
      const prompt = sirusPrompt();
      expect(prompt.toLowerCase()).not.toContain('persistent memory');
      expect(prompt).not.toContain('SaveMemory');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
