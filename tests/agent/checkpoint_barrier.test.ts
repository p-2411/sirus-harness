import { describe, expect, test } from 'bun:test';
import { createToolbox } from '../../src/agent_runtime/tools/toolbox';
import type { Tool } from '../../src/agent_runtime/tools';
import type { PermissionContext } from '../../src/agent_runtime/permissions/policy';

function fixture() {
  let release!: () => void;
  const snapshot = new Promise<void>(resolve => { release = resolve; });
  const executed: string[] = [];
  const tools: Tool[] = [
    {
      name: 'RunShell',
      description: 'RunShell',
      args: { command: { type: 'string' } },
      effect: 'mutates',
      run: async () => { executed.push('RunShell'); return 'done'; },
    },
    {
      name: 'ReadFile',
      description: 'ReadFile',
      args: { path: { type: 'string' } },
      effect: 'read',
      run: async () => { executed.push('ReadFile'); return 'done'; },
    },
  ];
  const permissions: PermissionContext = {
    sessionId: 'barrier-test', mode: () => 'bypass', requester: { participant: 'sirus' },
    model: 'test-model',
  };
  const toolbox = createToolbox({
    tools,
    directory: '/project',
    permissions,
    beforeMutation: () => snapshot,
  });
  return { release, toolbox, executed };
}

describe('tool checkpoint barrier', () => {
  test('shell write flags wait for a snapshot even when the command is classified as read', async () => {
    const { release, toolbox, executed } = fixture();
    // The tool is a stub: no shell command is actually run.
    const result = toolbox.run({
      type: 'tool_call', id: 'shell', name: 'RunShell', arguments: { command: 'find . -delete' },
    });
    await Promise.resolve();
    expect(executed).toEqual([]);
    release();
    expect((await result).isError).toBe(false);
    expect(executed).toEqual(['RunShell']);
  });

  test('read tools can finish while a snapshot is still pending', async () => {
    const { release, toolbox, executed } = fixture();
    try {
      const result = await toolbox.run({
        type: 'tool_call', id: 'read', name: 'ReadFile', arguments: { path: 'file.txt' },
      });
      expect(result.isError).toBe(false);
      expect(executed).toEqual(['ReadFile']);
    } finally {
      release();
    }
  });

  test('cancelling while the snapshot is pending prevents the shell from running', async () => {
    const { release, toolbox, executed } = fixture();
    const controller = new AbortController();
    const result = toolbox.run({
      type: 'tool_call', id: 'shell', name: 'RunShell', arguments: { command: 'sort -o data.txt data.txt' },
    }, controller.signal);
    controller.abort();
    release();
    await expect(result).rejects.toThrow();
    expect(executed).toEqual([]);
  });
});
