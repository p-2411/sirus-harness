import { expect, test } from 'bun:test';
import { Box, render, renderToString } from 'ink';
import { PassThrough } from 'stream';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import { boundTransports } from '../../src/agent_runtime/providers';
import { listAllSubagents, type SubagentRun } from '../../src/agent_runtime/tools/subagents';
import { checkSubagent } from '../../src/agent_runtime/tools/subagents/run';
import Chat from '../../src/frontend/chat/Chat';
import { ChatMessage } from '../../src/frontend/chat/ChatMessage';
import { pendingApprovals, resolveApproval } from '../../src/agent_runtime/permissions/approvals';
import { authorizeToolCall } from '../../src/agent_runtime/permissions/policy';
import { toolRegistry } from '../../src/agent_runtime/tools';
import type { Message, ToolCallBlock } from '../../src/agent_runtime/types';

test('the input status follows only the displayed session’s workers, including detached workers', async () => {
  const model = 'test-session-status-workers';
  const workers: SubagentRun[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  boundTransports[model] = {
    getResponse: async (_messages, turn) => {
      if (turn.agent.subagent) await gate;
      else {
        // Through the session's own toolbox, so the worker is spawned by the
        // production path: toolbox → subagent host → startSubagent → the
        // worker's own subagent toolbox.
        const spawned = await turn.toolbox!.run({
          type: 'tool_call', id: 'reused-provider-call', name: 'SpawnAgent',
          arguments: { prompt: 'Work', model },
        }, turn.signal);
        expect(spawned.isError).toBe(false);
        const { id } = JSON.parse(spawned.result) as { id: string };
        workers.push(listAllSubagents().find(run => run.id === id)!);
      }
      return { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' };
    },
  };
  const first = new Session({ id: 'status-first', name: 'First', model });
  const second = new Session({ id: 'status-second', name: 'Second', model });
  const empty = new Session({ id: 'status-empty', name: 'Empty', model });
  expect(first.getDirectory()).toBe(second.getDirectory());
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const pane = (session: Session) => <Box width={140} height={40}>
    <Chat key={session.getId()} currSession={session} />
  </Box>;
  const app = render(pane(first), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  const send = (session: Session) => session.sendMessage({
    role: 'user', content: [{ type: 'text', text: 'Start a worker' }],
  });
  try {
    await flush();
    expect(output).not.toContain('active subagent');
    await send(first);
    await send(second);
    await send(first);
    await flush();
    expect(first.getStatus()).toBe('idle');
    expect(first.getActiveSubagentCount()).toBe(2);
    expect(second.getActiveSubagentCount()).toBe(1);
    expect(empty.getActiveSubagentCount()).toBe(0);
    expect(output).toContain('2 active subagents');
    expect(output).not.toContain('3 active subagents');

    // Each worker answers to its owner's session, as itself: the session's
    // permission context, re-stamped with the run's own requester and model.
    const [worker] = workers;
    expect(worker.sessionId).toBe(first.getId());
    expect(worker.permissions).toMatchObject({
      sessionId: first.getId(),
      requester: { subagent: worker.id },
      model,
    });
    expect(worker.permissions?.mode()).toBe(first.getPermissionMode());

    app.rerender(pane(second));
    await flush();
    expect(output).toContain('1 active subagent');
    expect(output).not.toContain('2 active subagents');
    stdin.write('/login');
    await flush();
    stdin.write('\r');
    await flush();
    expect(output).toContain('ChatGPT');
    expect(output).toContain('1 active subagent');

    first.cancel();
    await Promise.all(workers.filter(run => run.sessionId === first.getId())
      .map(run => checkSubagent(run, true)));
    await flush();
    expect(first.getActiveSubagentCount()).toBe(0);
    expect(output).toContain('1 active subagent');
    const message: Message = { role: 'assistant', content: [{
      type: 'tool_call', id: 'reused-provider-call', name: 'SpawnAgent', arguments: { model },
    }] };
    const toolRow = (session: Session) => stripAnsi(renderToString(
      <ChatMessage message={message} sessionId={session.getId()} />, { columns: 140 },
    ));
    expect(toolRow(first)).toContain('cancelled');
    expect(toolRow(second)).toContain('working');
    expect(toolRow(second)).not.toContain('cancelled');

    release();
    await Promise.all(workers.map(run => checkSubagent(run, true)));
    await flush();
    expect(output).not.toContain('active subagent');
    app.rerender(pane(empty));
    await flush();
    expect(output).not.toContain('active subagent');
  } finally {
    release();
    first.cancel();
    second.cancel();
    await Promise.all(workers.map(run => checkSubagent(run, true)));
    app.unmount();
    await app.waitUntilExit();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
    delete boundTransports[model];
  }
});

test('tool approval indicators do not leak between sessions reusing a call ID', async () => {
  const first = new Session({ id: 'approval-status-first', name: 'First' });
  const second = new Session({ id: 'approval-status-second', name: 'Second' });
  const call: ToolCallBlock = {
    type: 'tool_call', id: 'reused-approval-call', name: 'WriteFile',
    arguments: { path: 'example.txt', content: 'test' },
  };
  const writeFile = toolRegistry.find(tool => tool.name === 'WriteFile');
  const pending = authorizeToolCall(writeFile, call, second.getDirectory(), {
    sessionId: second.getId(), mode: () => 'ask',
    requester: { participant: 'sirus' }, model: second.getModel(),
  });
  const row = (session: Session) => stripAnsi(renderToString(
    <ChatMessage message={{ role: 'assistant', content: [call] }} sessionId={session.getId()} />,
    { columns: 140 },
  ));
  try {
    expect(pendingApprovals(second.getId())).toHaveLength(1);
    expect(row(first)).not.toContain('waiting for approval');
    expect(row(second)).toContain('waiting for approval');
  } finally {
    for (const approval of pendingApprovals(second.getId())) resolveApproval(approval.id, 'deny');
    await pending;
  }
});
