import { afterAll, expect, test } from 'bun:test';
import { Box, render, renderToString } from 'ink';
import { PassThrough } from 'stream';
import stripAnsi from 'strip-ansi';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Session } from '../../src/agent_runtime/session';
import {
  findSubagent,
  findSubagentByCall,
  notifySubagents,
  type SubagentRun,
} from '../../src/agent_runtime/tools/subagents';
import { subagentDone } from '../../src/agent_runtime/tools/subagents/run';
import { workerReport } from '../../src/agent_runtime/tools/subagents/report';
import { stopSirusMcpServer } from '../../src/agent_runtime/tools/server';
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

// SpawnAgent reaches Sirus over the session's own MCP server, on the entry
// its runtimes are handed and the way a vendor runtime calls it, so the runs
// the chat decorates are real ones.
async function spawnWorker(session: Session): Promise<SubagentRun> {
  const entry = await session.mcpServerEntry('sirus');
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
  // The strip is the one line between the input box and the status row.
  const strip = () => {
    const lines = output.replace(/\n+$/, '').split('\n');
    const box = lines.map(line => line.includes('╰')).lastIndexOf(true);
    return lines.slice(box + 1, -1).join('\n');
  };
  const untilOutput = (check: () => boolean, description: string) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stdout.off('data', onData); reject(new Error(`Timed out waiting for ${description}`)); }, 3_000);
    const onData = () => {
      if (!check()) return;
      clearTimeout(timeout);
      stdout.off('data', onData);
      resolve();
    };
    stdout.on('data', onData);
    onData();
  });
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
    // One line: the run that changed last, and a counter for the one behind
    // it. Stamp the order rather than trust two spawns to land in different
    // milliseconds.
    alsoMine.updatedAt = mine.updatedAt + 1;
    notifySubagents();
    await flush();
    expect(strip().split('\n').filter(Boolean)).toHaveLength(1);
    expect(strip()).toContain(`1/2 ● ${alsoMine.id} · ${model}`);
    expect(strip()).not.toContain(mine.id);
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

    // Stopping one is the freshest change there is, so its line leads the
    // strip, saying how it ended.
    await first.cancelWorker(mine.id);
    await flush();
    expect(mine.status).toBe('cancelled');
    expect(strip()).toContain(`${mine.id} · ${model}`);
    expect(strip()).toContain('cancelled');
    // Its report reaches the owner all the same, but the chat never shows it
    // as a message: the user reads it under the SpawnAgent row instead.
    expect(output).not.toContain(`${mine.id} · worker`);
    expect(output).not.toContain('Task: Work');
    // A second on, the line is gone and the strip belongs to the run still
    // working. The record stays: `/agents` lists it until it is dismissed.
    await untilOutput(() => !strip().includes(mine.id) && strip().includes(alsoMine.id), 'finished worker to leave the strip');
    await flush();
    expect(strip()).not.toContain(mine.id);
    expect(strip()).toContain(alsoMine.id);
    expect(first.getWorkers().map(run => run.id)).toEqual([mine.id, alsoMine.id]);
    first.dismissWorker(mine.id);
    await flush();
    expect(first.getWorkers().find(run => run.id === mine.id)?.dismissed).toBe(true);

    app.rerender(pane(second));
    await flush();
    expect(strip()).toContain(`${theirs.id} · ${model}`);
    expect(strip()).not.toContain(alsoMine.id);
    // The strip stays up while the bar is busy asking something else.
    stdin.write('/login');
    await flush();
    stdin.write('\r');
    await flush();
    expect(output).toContain('Codex');
    expect(strip()).toContain(theirs.id);

    // The same call id in two sessions decorates only the row of the session
    // whose run it is.
    const call: ToolCallBlock = {
      type: 'tool_call', id: mine.callId!, kind: 'other', title: 'sirus - SpawnAgent',
      status: 'completed', locations: [], content: [],
      // What the session puts on the call when the run it started ends.
      output: workerReport(mine),
    };
    const toolRow = (session: Session) => stripAnsi(renderToString(
      <ChatMessage message={{ seq: 0, role: 'assistant', content: [call] }} sessionId={session.getId()} />,
      { columns: 140 },
    ));
    expect(toolRow(first)).toContain(`● Agent(Work) · ${model} · ${mine.id}`);
    expect(toolRow(first)).toContain('⎿ Cancelled by CancelAgent (0 tool uses');
    expect(toolRow(second)).not.toContain(`${model} · ${mine.id}`);
    expect(toolRow(second)).not.toContain('Cancelled by CancelAgent (');
    // The report waits, folded, until the user opens the row.
    expect(toolRow(first)).not.toContain(`Subagent ${mine.id} cancelled`);
    expect(toolRow(first)).not.toContain('Task: Work');

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
  // What the user chose is the call's own record from here on.
  expect(row(second)).not.toContain('waiting for approval');
  expect(row(first)).not.toContain('declined');
  for (const session of [first, second]) session.dispose();
});

test('a denial with no reject option to pick answers cancelled, never an allow', async () => {
  const sessionId = 'deny-without-reject';
  const answer = requestPermission(
    { sessionId, requester: { participant: 'sirus' } },
    {
      sessionId: 'acp-session',
      toolCall: { toolCallId: 'deny-call', kind: 'edit', title: 'example.txt' },
      options: [
        { optionId: 'once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'always', name: 'Yes, and don’t ask again', kind: 'allow_always' },
      ],
    },
  );
  const [approval] = pendingApprovals(sessionId);
  resolveApproval(approval.id, 'deny');
  expect(await answer).toEqual({ outcome: { outcome: 'cancelled' } });
});
