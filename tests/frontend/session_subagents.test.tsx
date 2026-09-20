import { afterAll, expect, test } from 'bun:test';
import { Box, render, renderToString } from 'ink';
import { PassThrough } from 'stream';
import stripAnsi from 'strip-ansi';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Session } from '../../src/agent_runtime/session';
import { findSubagentByCall, listAllSubagents, type SubagentRun } from '../../src/agent_runtime/tools/subagents';
import { checkSubagent } from '../../src/agent_runtime/tools/subagents/run';
import { sirusMcpServerEntry, stopSirusMcpServer } from '../../src/agent_runtime/tools/server';
import Chat from '../../src/frontend/chat/Chat';
import { ChatMessage } from '../../src/frontend/chat/ChatMessage';
import {
  pendingApprovals,
  requestPermission,
  resolveApproval,
} from '../../src/agent_runtime/permissions/approvals';
import type { ToolCallBlock } from '../../src/agent_runtime/types';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

afterAll(() => stopSirusMcpServer());

// SpawnAgent reaches Sirus over the session's own MCP server, the way a
// vendor runtime calls it, so the runs the chat decorates are real ones.
async function spawnWorker(session: Session): Promise<SubagentRun> {
  const entry = await sirusMcpServerEntry(session.getId(), 'sirus');
  const client = new Client({ name: 'session-subagents-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: { headers: Object.fromEntries(entry.headers.map(header => [header.name, header.value])) },
  }));
  try {
    const result = await client.callTool({ name: 'SpawnAgent', arguments: { prompt: 'Work' } });
    const [block] = result.content as { text: string }[];
    const { id } = JSON.parse(block.text) as { id: string };
    return listAllSubagents().find(run => run.id === id)!;
  } finally {
    await client.close();
  }
}

test('the input status follows only the displayed session’s workers, including detached workers', async () => {
  const model = 'test-session-status-workers';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  bindScriptedRuntime(model, async () => { await gate; });
  const workers: SubagentRun[] = [];
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
  try {
    await flush();
    expect(output).not.toContain('active subagent');
    workers.push(await spawnWorker(first));
    workers.push(await spawnWorker(second));
    workers.push(await spawnWorker(first));
    await flush();
    expect(first.getStatus()).toBe('idle');
    expect(first.getActiveSubagentCount()).toBe(2);
    expect(second.getActiveSubagentCount()).toBe(1);
    expect(empty.getActiveSubagentCount()).toBe(0);
    expect(output).toContain('2 active subagents');
    expect(output).not.toContain('3 active subagents');

    // Each worker belongs to its owner's session and runs on the session's
    // subagent model, which while unset is the spawner's own.
    const [worker] = workers;
    expect(worker.sessionId).toBe(first.getId());
    expect(worker.model).toBe(model);
    expect(findSubagentByCall(worker.callId!, first.getId())).toBe(worker);
    expect(findSubagentByCall(worker.callId!, second.getId())).toBeUndefined();

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

    // The same call id in two sessions decorates only the row of the session
    // whose run it is.
    const call: ToolCallBlock = {
      type: 'tool_call', id: worker.callId!, kind: 'other', title: 'sirus - SpawnAgent',
      status: 'completed', locations: [], content: [],
    };
    const toolRow = (session: Session) => stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'assistant', content: [call] }} sessionId={session.getId()} />,
      { columns: 140 },
    ));
    expect(toolRow(first)).toContain('cancelled');
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
    for (const session of [first, second, empty]) session.dispose();
    unbindRuntime(model);
  }
});

test('tool approval indicators do not leak between sessions reusing a call ID', async () => {
  const first = new Session({ id: 'approval-status-first', name: 'First' });
  const second = new Session({ id: 'approval-status-second', name: 'Second' });
  const call: ToolCallBlock = {
    type: 'tool_call', id: 'reused-approval-call', kind: 'edit', title: 'example.txt',
    status: 'pending', locations: [{ path: 'example.txt' }], content: [],
  };
  const pending = requestPermission(
    { sessionId: second.getId(), requester: { participant: 'sirus' } },
    {
      sessionId: 'acp-session',
      toolCall: { toolCallId: call.id, kind: 'edit', title: 'example.txt' },
      options: [{ optionId: 'reject', name: 'No', kind: 'reject_once' }],
    },
  );
  const row = (session: Session) => stripAnsi(renderToString(
    <ChatMessage message={{ seq: 0, role: 'assistant', content: [call] }} sessionId={session.getId()} />,
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
  // The vendor moves on, but the transcript keeps saying what the user chose.
  expect(row(second)).toContain('declined by user');
  expect(row(first)).not.toContain('declined by user');
  for (const session of [first, second]) session.dispose();
});
