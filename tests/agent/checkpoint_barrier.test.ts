import { describe, expect, test } from 'bun:test';
import { createToolRuntime } from '../../src/agent_runtime/tools/runtime';
import type { PermissionContext } from '../../src/agent_runtime/permissions/permissions';

function fixture() {
  let release!: () => void;
  const snapshot = new Promise<void>(resolve => { release = resolve; });
  const executed: string[] = [];
  const runtime = createToolRuntime(['RunShell', 'ReadFile'].map(name => ({
    name, description: name, args: {}, func: () => { executed.push(name); return 'done'; },
  })), { memoryToolNames: new Set(), agentToolNames: new Set() });
  const permissions: PermissionContext = {
    sessionId: 'barrier-test', mode: () => 'bypass', requester: { participant: 'sirus' },
    model: 'test-model',
    beforeMutation: () => snapshot,
  };
  return { release, runtime, permissions, executed };
}

describe('tool checkpoint barrier', () => {
  test('shell write flags wait for a snapshot even when the command is classified as read', async () => {
    const { release, runtime, permissions, executed } = fixture();
    // The tool is a stub: no shell command is actually run.
    const result = runtime.runTool({
      type: 'tool_call', id: 'shell', name: 'RunShell', arguments: { command: 'find . -delete' },
    }, '/project', undefined, permissions);
    await Promise.resolve();
    expect(executed).toEqual([]);
    release();
    expect((await result).isError).toBe(false);
    expect(executed).toEqual(['RunShell']);
  });

  test('read tools can finish while a snapshot is still pending', async () => {
    const { release, runtime, permissions, executed } = fixture();
    try {
      const result = await runtime.runTool({
        type: 'tool_call', id: 'read', name: 'ReadFile', arguments: { path: 'file.txt' },
      }, '/project', undefined, permissions);
      expect(result.isError).toBe(false);
      expect(executed).toEqual(['ReadFile']);
    } finally {
      release();
    }
  });

  test('cancelling while the snapshot is pending prevents the shell from running', async () => {
    const { release, runtime, permissions, executed } = fixture();
    const controller = new AbortController();
    const result = runtime.runTool({
      type: 'tool_call', id: 'shell', name: 'RunShell', arguments: { command: 'sort -o data.txt data.txt' },
    }, '/project', controller.signal, permissions);
    controller.abort();
    release();
    await expect(result).rejects.toThrow();
    expect(executed).toEqual([]);
  });
});
