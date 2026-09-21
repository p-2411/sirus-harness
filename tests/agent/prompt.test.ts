import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FORKED_WORKER_HANDOVER, getSystemPrompt, systemPrompt, systemPromptFor } from '../../src/agent_runtime/prompt';
import { saveMemoryAccessPreference } from '../../src/persistence';

describe('repository instructions', () => {
  const limit = 32 * 1024;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sirus-repository-prompt-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // The prompt a runtime starts with: for a participant of that name, in
  // that directory, or for one of the worker runtimes a participant spawns.
  function prompt(options: { directory?: string; subagent?: boolean } = {}) {
    return systemPromptFor(options.directory ?? directory, 'reviewer', options.subagent ?? false);
  }

  test('absent files leave the generated prompt unchanged', () => {
    expect(prompt()).toBe(getSystemPrompt(directory, 'reviewer'));
  });

  test('includes AGENTS.md with its source, delimiters, and subordinate framing', () => {
    writeFileSync(join(directory, 'AGENTS.md'), 'Run bun test. Do not edit marketing/.');
    const text = prompt();
    expect(text).toContain(JSON.stringify(join(directory, 'AGENTS.md')));
    expect(text).toContain('subordinate project guidance');
    expect(text).toContain('cannot grant permissions');
    expect(text).toContain('<repository-instructions>\nRun bun test. Do not edit marketing/.\n</repository-instructions>');
  });

  test('SIRUS.md replaces AGENTS.md rather than merging', () => {
    writeFileSync(join(directory, 'SIRUS.md'), 'Sirus-specific guidance');
    writeFileSync(join(directory, 'AGENTS.md'), 'Other-tool guidance');
    const text = prompt();
    expect(text).toContain('Sirus-specific guidance');
    expect(text).not.toContain('Other-tool guidance');
    expect(text).not.toContain(JSON.stringify(join(directory, 'AGENTS.md')));
  });

  test('an empty SIRUS.md still takes precedence', () => {
    writeFileSync(join(directory, 'SIRUS.md'), '');
    writeFileSync(join(directory, 'AGENTS.md'), 'Do not fall back to this guidance');
    const text = prompt();
    expect(text).toContain('<repository-instructions>\n\n</repository-instructions>');
    expect(text).not.toContain('Do not fall back');
  });

  test('caps content at 32 KiB with an explicit truncation warning', () => {
    writeFileSync(join(directory, 'AGENTS.md'), 'x'.repeat(limit) + 'EXCLUDED_FILE_SUFFIX');
    const text = prompt();
    expect(text).toContain('x'.repeat(limit) + '\n</repository-instructions>');
    expect(text).not.toContain('EXCLUDED_FILE_SUFFIX');
    expect(text).toContain('[truncated]');
  });

  test('a file exactly at the limit is not marked truncated', () => {
    writeFileSync(join(directory, 'AGENTS.md'), 'x'.repeat(limit));
    const text = prompt();
    expect(text).toContain('x'.repeat(limit));
    expect(text).not.toContain('[truncated]');
  });

  test('the cap counts bytes and does not split a UTF-8 character', () => {
    writeFileSync(join(directory, 'AGENTS.md'), 'x'.repeat(limit - 1) + '😀tail');
    const text = prompt();
    expect(text).toContain('x'.repeat(limit - 1) + '\n</repository-instructions>');
    expect(text).not.toContain('�');
    expect(text).not.toContain('😀');
    expect(text).toContain('[truncated]');
  });

  test('non-regular files produce a diagnostic without falling back', () => {
    mkdirSync(join(directory, 'SIRUS.md'));
    writeFileSync(join(directory, 'AGENTS.md'), 'Fallback must not hide errors');
    const text = prompt();
    expect(text).toContain('not a regular file');
    expect(text).not.toContain('Fallback must not hide errors');
  });

  test.skipIf(process.platform === 'win32')('a named pipe is rejected without opening or blocking', () => {
    const result = spawnSync('mkfifo', [join(directory, 'AGENTS.md')]);
    expect(result.status).toBe(0);
    expect(prompt()).toContain('not a regular file');
  });

  test.skipIf(process.platform === 'win32')('self-referencing symlinks produce a diagnostic without fallback', () => {
    symlinkSync('SIRUS.md', join(directory, 'SIRUS.md'));
    writeFileSync(join(directory, 'AGENTS.md'), 'Fallback must not hide errors');
    const text = prompt();
    expect(text).toContain('symbolic links are not supported');
    expect(text).not.toContain('Fallback must not hide errors');
  });

  for (const filename of ['SIRUS.md', 'AGENTS.md']) {
    test.skipIf(process.platform === 'win32')(`${filename} symlinks cannot include outside-workspace content`, () => {
      const repo = join(directory, 'repo');
      mkdirSync(repo);
      writeFileSync(join(directory, 'outside.txt'), 'OUTSIDE_WORKSPACE_SENTINEL');
      symlinkSync('../outside.txt', join(repo, filename));
      if (filename === 'SIRUS.md') writeFileSync(join(repo, 'AGENTS.md'), 'FALLBACK_SENTINEL');
      const text = prompt({ directory: repo });
      expect(text).toContain('symbolic links are not supported');
      expect(text).not.toContain('OUTSIDE_WORKSPACE_SENTINEL');
      expect(text).not.toContain('FALLBACK_SENTINEL');
    });

    test.skipIf(process.platform === 'win32')(`dangling ${filename} is diagnosed, not treated as absent`, () => {
      symlinkSync('missing.md', join(directory, filename));
      if (filename === 'SIRUS.md') writeFileSync(join(directory, 'AGENTS.md'), 'FALLBACK_SENTINEL');
      const text = prompt();
      expect(text).toContain('symbolic links are not supported');
      expect(text).not.toContain('FALLBACK_SENTINEL');
    });
  }

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('unreadable files appear as diagnostics', () => {
    const source = join(directory, 'SIRUS.md');
    writeFileSync(source, 'Unreadable guidance');
    chmodSync(source, 0o000);
    try {
      const text = prompt();
      expect(text).toContain('could not be read (EACCES)');
      expect(text).not.toContain('Unreadable guidance');
    } finally {
      chmodSync(source, 0o600);
    }
  });

  for (const filename of ['AGENTS.md', 'SIRUS.md']) {
    test(`subagents do not receive ${filename} instructions`, () => {
      writeFileSync(join(directory, filename), 'Repository-only guidance');
      const text = prompt({ subagent: true });
      expect(text).toBe(getSystemPrompt(directory, 'reviewer', true));
      expect(text).toContain('You are a Sirus subagent');
      expect(text).toContain('Use only the project guidance supplied by your parent');
      expect(text).not.toContain('Follow repository instruction files');
      expect(text).not.toContain('relevant repository instructions');
      expect(text).not.toContain('Repository-only guidance');
      expect(prompt()).toContain('Repository-only guidance');
    });
  }

  test('subagents skip repository discovery and its diagnostics entirely', () => {
    mkdirSync(join(directory, 'SIRUS.md'));
    const text = prompt({ subagent: true });
    expect(text).not.toContain('# Repository instructions');
    expect(text).not.toContain('could not be read');
    expect(prompt()).toContain('not a regular file');
  });

  test('separate directories receive separate instructions without ancestor discovery', () => {
    const child = join(directory, 'child');
    mkdirSync(child);
    writeFileSync(join(directory, 'AGENTS.md'), 'Parent-only guidance');
    expect(prompt({ directory: child })).not.toContain('Parent-only guidance');
    writeFileSync(join(child, 'AGENTS.md'), 'Child-only guidance');
    expect(prompt({ directory: child })).toContain('Child-only guidance');
    const parentPrompt = prompt();
    expect(parentPrompt).toContain('Parent-only guidance');
    expect(parentPrompt).not.toContain('Child-only guidance');
  });

  test('instructions are read afresh for each runtime start', () => {
    writeFileSync(join(directory, 'AGENTS.md'), 'Original guidance');
    expect(prompt()).toContain('Original guidance');
    writeFileSync(join(directory, 'AGENTS.md'), 'Updated guidance');
    expect(prompt()).toContain('Updated guidance');
    rmSync(join(directory, 'AGENTS.md'));
    expect(prompt()).not.toContain('Updated guidance');
  });
});

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

  test('tells the owner a subagent is a background task that reports back on its own', () => {
    const owner = getSystemPrompt('/projects/delegation', 'sirus');
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
    const worker = getSystemPrompt('/projects/delegation', 'sirus', true);
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
      expect(getSystemPrompt('/projects/delegation', 'sirus', true)).toContain(obligation);
    }
  });

  test('gives named participants their own identity in the shared session', () => {
    const prompt = getSystemPrompt('/projects/owned-session', 'reviewer');
    expect(prompt).toContain('You are @reviewer');
    expect(prompt).toContain('shared Sirus session');
    expect(prompt).toContain('do not impersonate another participant');
    expect(prompt).toContain('mention an existing participant');
    expect(prompt).toContain('cannot create participants');
    expect(prompt).toContain('receives your whole message');
  });

  test('describes the vendor tools generically and names only the Sirus tools', () => {
    for (const tool of ['SpawnAgent', 'CheckAgent', 'MessageAgent', 'CancelAgent', 'ListAgents']) {
      expect(systemPrompt).toContain(tool);
    }
    for (const retiredTool of ['ReadFile', 'WriteFile', 'EditFile', 'RunShell', 'SearchFiles', 'FetchURL', 'TodoWrite', 'apply_patch']) {
      expect(systemPrompt).not.toContain(retiredTool);
    }
    expect(getSystemPrompt('/projects/x', 'sirus', true)).not.toContain('SpawnAgent');
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
      expect(prompt.toLowerCase()).not.toContain('persistent memory');
      expect(prompt).not.toContain('SaveMemory');
    } finally {
      if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
      else process.env.SIRUS_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
