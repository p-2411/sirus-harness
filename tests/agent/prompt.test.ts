import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FORKED_WORKER_HANDOVER, sirusPrompt } from '../../src/agent_runtime/prompt';
import { saveMemoryAccessPreference } from '../../src/persistence';
import { RECAP_MAX_BYTES, transcriptText } from '../../src/agent_runtime/session/transcript';
import type { Message } from '../../src/agent_runtime/types';

describe('runtime recap', () => {
  test('keeps recent conversation and the latest compaction summary within a byte budget', () => {
    const entries: Message[] = [
      { seq: 0, role: 'user', content: [{ type: 'text', text: 'Discarded before compaction' }] },
      { seq: 1, role: 'assistant', content: [
        { type: 'compaction', summary: 'Superseded summary' },
        { type: 'text', text: 'Already represented in the summary' },
        { type: 'compaction', summary: 'Latest summary: preserve the migration plan.' },
      ] },
      ...Array.from({ length: 200 }, (_, index): Message => ({
        seq: index + 2, role: 'user', content: [{ type: 'text', text: `message-${index}: ${'界🌍'.repeat(80)}` }],
      })),
      { seq: 202, role: 'assistant', participant: 'reviewer', content: [{ type: 'text', text: 'Latest answer' }] },
    ];
    const recap = transcriptText(entries);
    expect(Buffer.byteLength(recap)).toBeLessThanOrEqual(RECAP_MAX_BYTES);
    expect(recap).toContain('Latest summary: preserve the migration plan.');
    expect(recap).toContain('message-199:');
    expect(recap).toEndWith('@reviewer: Latest answer');
    expect(recap).toContain('older conversation text omitted');
    for (const omitted of ['Discarded before compaction', 'Superseded summary', 'Already represented in the summary', 'message-0:', '\uFFFD']) {
      expect(recap).not.toContain(omitted);
    }
  });

  test('bounds an oversized summary and message without losing the newest text', () => {
    const recap = transcriptText([
      { seq: 0, role: 'assistant', content: [{ type: 'compaction', summary: `Summary starts here. ${'🌍'.repeat(RECAP_MAX_BYTES)}` }] },
      { seq: 1, role: 'user', content: [{ type: 'text', text: `${'界'.repeat(RECAP_MAX_BYTES)} Latest request.` }] },
    ]);
    expect(Buffer.byteLength(recap)).toBeLessThanOrEqual(RECAP_MAX_BYTES);
    expect(recap).toContain('Summary starts here.');
    expect(recap).toContain('compaction summary was also shortened');
    expect(recap).toEndWith('Latest request.');
    expect(recap).not.toContain('\uFFFD');
  });

  test('leaves short recaps intact and excludes notices and private thoughts', () => {
    expect(transcriptText([
      { seq: 0, role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { seq: 1, role: 'assistant', participant: 'reviewer', content: [
        { type: 'thought', text: 'Private thought' },
        { type: 'notice', severity: 'error', title: 'Adapter stopped' },
        { type: 'compaction' },
        { type: 'text', text: 'Hi' },
      ] },
    ])).toBe('User: Hello\n@reviewer: Hi');
    expect(transcriptText([])).toBe('');
  });
});

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
    expect(owner).toContain('runs in the background by default');
    expect(owner).toContain('notification in your current turn');
    expect(owner).toContain('branch sirus/<id> in its own worktree');
    expect(owner).toContain('Inspect or merge the branch yourself');
    expect(owner).toContain('SendMessage with to (id or name) and message');
    expect(owner).toContain('context "owner"');
    // Nothing tells it to wait, poll or read a stream file any more.
    expect(owner).not.toContain('streamFile');
    expect(owner).not.toContain('wait true');
  });

  test('tells the worker it may be steered and that its changes land on a branch', () => {
    const worker = sirusPrompt('sirus', true);
    expect(worker).toContain('send further instructions while you work');
    expect(worker).toContain('worktree of the project on a branch of your own');
    expect(worker).toContain('final message addressed to the agent that spawned you');
  });

  test('the forked handover says the same thing, since a fork keeps the owner’s system prompt', () => {
    expect(FORKED_WORKER_HANDOVER).toStartWith('You are now a Sirus subagent, forked from the conversation above');
    for (const obligation of [
      'never ask one',
      'send further instructions while you work',
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
    expect(prompt).toContain('Mention an existing participant');
    expect(prompt).toContain('Both you and the user can add a participant');
    expect(prompt).toContain('@name <supported-model> <task>');
    expect(prompt).toContain('receives your whole message');
  });

  test('describes the vendor tools generically and names only the Sirus tools', () => {
    for (const tool of ['SpawnAgent', 'CheckAgent', 'SendMessage', 'CancelAgent', 'ListAgents']) {
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
      expect(saveMemoryAccessPreference(true, directory)).toBe(true);
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
      expect(saveMemoryAccessPreference(false, directory)).toBe(true);
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
