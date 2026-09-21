import { afterAll, expect, test } from 'bun:test';
import { Box, render, renderToString } from 'ink';
import { PassThrough } from 'stream';
import stripAnsi from 'strip-ansi';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Session } from '../../src/agent_runtime/session';
import { findSubagent, findSubagentByCall, type SubagentRun } from '../../src/agent_runtime/tools/subagents';
import { subagentDone } from '../../src/agent_runtime/tools/subagents/run';
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
    const result = await client.callTool({
      name: 'SpawnAgent',
      arguments: { prompt: 'Work', context: 'fresh' },
    });
    const [block] = result.content as { text: string }[];
    const { id } = JSON.parse(block.text) as { id: string };
    return findSubagent(id)!;
  } finally {
    await client.close();
  }
}

test('the worker strip follows only the displayed session’s workers', async () => {
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
  // The strip is what sits between the input box and the status row, told
  // apart from a worker's report in the history above it.
  const strip = () => {
    const lines = output.replace(/\n+$/, '').split('\n');
    const box = lines.map(line => line.includes('╰')).lastIndexOf(true);
    return lines.slice(box + 1, -1).join('\n');
  };
  try {
    await flush();
    expect(output).not.toContain('sub-');
    workers.push(await spawnWorker(first));
    workers.push(await spawnWorker(second));
    workers.push(await spawnWorker(first));
    const [mine, theirs, alsoMine] = workers;
    await flush();
    expect(first.getStatus()).toBe('idle');
    expect(first.getWorkers().map(run => run.id)).toEqual([mine.id, alsoMine.id]);
    expect(second.getWorkers().map(run => run.id)).toEqual([theirs.id]);
    expect(empty.getWorkers()).toEqual([]);
    // One line per worker, saying which run it is and what it runs on.
    expect(strip()).toContain(`${mine.id} · ${model}`);
    expect(strip()).toContain(`${alsoMine.id} · ${model}`);
    expect(strip()).not.toContain(theirs.id);

    // Each worker belongs to its owner's session and runs on the session's
    // subagent model, which while unset is the spawner's own.
    expect(mine.sessionId).toBe(first.getId());
    expect(mine.model).toBe(model);
    expect(findSubagentByCall(mine.callId!, first.getId())).toBe(mine);
    expect(findSubagentByCall(mine.callId!, second.getId())).toBeUndefined();

    // Escape is the turn's cancel and nothing more: the workers carry on.
    stdin.write('\x1b');
    await flush();
    expect(workers.map(run => run.status)).toEqual(['working', 'working', 'working']);

    // Stopping one leaves its line on the strip, saying how it ended, until
    // the user clears it.
    await first.cancelWorker(mine.id);
    await flush();
    expect(mine.status).toBe('cancelled');
    expect(strip()).toContain(`${mine.id} · ${model}`);
    expect(strip()).toContain('cancelled');
    // Its report reaches the owner all the same, as a message from the run.
    expect(output).toContain(`${mine.id} · worker`);
    first.dismissWorker(mine.id);
    await flush();
    expect(strip()).not.toContain(mine.id);
    expect(strip()).toContain(alsoMine.id);

    app.rerender(pane(second));
    await flush();
    expect(strip()).toContain(`${theirs.id} · ${model}`);
    expect(strip()).not.toContain(alsoMine.id);
    // The strip stays up while the bar is busy asking something else.
    stdin.write('/login');
    await flush();
    stdin.write('\r');
    await flush();
    expect(output).toContain('ChatGPT');
    expect(strip()).toContain(theirs.id);

    // The same call id in two sessions decorates only the row of the session
    // whose run it is.
    const call: ToolCallBlock = {
      type: 'tool_call', id: mine.callId!, kind: 'other', title: 'sirus - SpawnAgent',
      status: 'completed', locations: [], content: [],
    };
    const toolRow = (session: Session) => stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'assistant', content: [call] }} sessionId={session.getId()} />,
      { columns: 140 },
    ));
    expect(toolRow(first)).toContain(`${mine.id} · cancelled`);
    expect(toolRow(second)).not.toContain('cancelled');

    release();
    await Promise.all(workers.map(subagentDone));
    await flush();
    expect(strip()).toContain(`${theirs.id} · ${model}`);
    expect(strip()).toContain('done');
    app.rerender(pane(empty));
    await flush();
    expect(output).not.toContain('sub-');
  } finally {
    release();
    first.cancel();
    second.cancel();
    await Promise.all(workers.map(subagentDone));
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
