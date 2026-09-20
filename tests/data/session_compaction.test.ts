import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { abortable, isAbortError } from '../../src/abort';
import type { Response } from '../../src/agent_runtime/chat';
import { COMPACTION_SYSTEM_PROMPT, estimateTokens, setAutoCompactEnabled } from '../../src/agent_runtime/compaction';
import { boundTransports } from '../../src/agent_runtime/providers';
import { Session } from '../../src/agent_runtime/session';
import type { TurnContext } from '../../src/agent_runtime/turn';
import type { Message } from '../../src/agent_runtime/types';
import { enableCheckpoints } from '../../src/checkpoints';

const model = 'test-compaction-session';
const originalDataDirectory = process.env.SIRUS_DATA_DIR;
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'sirus-session-compaction-'));
  process.env.SIRUS_DATA_DIR = path.join(root, 'state');
});

afterEach(() => {
  delete boundTransports[model];
  enableCheckpoints(false);
  if (originalDataDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
  else process.env.SIRUS_DATA_DIR = originalDataDirectory;
  rmSync(root, { recursive: true, force: true });
});

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const textOf = (message: Message) => message.content
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('\n');
const shape = (message: Message) => message.compaction ? 'summary' : textOf(message);

// A window over the threshold, and one well under it.
const full = { inputTokens: 160_000, outputTokens: 500, contextTokens: 170_000, contextWindow: 200_000 };
const small = { inputTokens: 1_000, outputTokens: 50, contextTokens: 1_050, contextWindow: 200_000 };

interface Call {
  messages: Message[];
  turn: TurnContext;
}

const isSummary = (call: Call) => call.turn.systemPrompt === COMPACTION_SYSTEM_PROMPT;

const summaryResponse: Response = {
  content: [{ type: 'text', text: 'The user asked about config.ts; it exports x.' }],
  stop_reason: 'end_turn',
  usage: { inputTokens: 800, outputTokens: 30, contextTokens: 830 },
};

const answer = (text: string, usage = small): Response => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage,
});

// One transport for both jobs: it summarises when asked tool-lessly with the
// compaction prompt, and answers the turn otherwise.
function bind(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const resets: string[] = [];
  boundTransports[model] = {
    getResponse: async (messages, turn) => {
      const call = { messages: [...messages], turn };
      calls.push(call);
      return respond(call);
    },
    resetRuntime: runtimeId => { resets.push(runtimeId); },
  };
  return { calls, resets };
}

function fullSession(): Session {
  return new Session({
    id: 'compaction-session',
    name: 'Compaction',
    model,
    messages: [
      user('Read the config'),
      {
        role: 'assistant',
        model,
        content: [
          { type: 'tool_call', id: 'c1', name: 'ReadFile', arguments: { path: 'config.ts' } },
          { type: 'tool_result', callId: 'c1', result: 'export const x = 1;', isError: false },
          { type: 'text', text: 'It exports x.' },
        ],
        usage: full,
      },
    ],
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

describe('automatic compaction', () => {
  test('folds a full window into a summary before the next turn', async () => {
    const { calls, resets } = bind(call => isSummary(call) ? summaryResponse : answer('Next answer'));
    const session = fullSession();

    const history = await session.sendMessage(user('And the tests?'));

    expect(calls).toHaveLength(2);
    // The summariser: one tool-less turn over the rendered history, before
    // the prompt joined it.
    expect(calls[0].turn.toolbox).toBeNull();
    expect(calls[0].messages).toHaveLength(1);
    expect(textOf(calls[0].messages[0])).toContain('User: Read the config');
    expect(textOf(calls[0].messages[0])).toContain('Tool result: export const x = 1;');
    expect(textOf(calls[0].messages[0])).not.toContain('And the tests?');
    // The turn: the summary, then the prompt, nothing older.
    expect(calls[1].turn.toolbox).not.toBeNull();
    expect(calls[1].messages.map(shape)).toEqual(['summary', 'And the tests?']);
    // The transcript keeps everything.
    expect(history.map(message => message.compaction ? 'summary' : message.role))
      .toEqual(['user', 'assistant', 'summary', 'user', 'assistant']);
    expect(history[2]).toMatchObject({
      role: 'user',
      model,
      usage: { inputTokens: 800, outputTokens: 30, contextTokens: 30, contextWindow: 200_000 },
      compaction: { messages: 2, tokensBefore: 170_000, trigger: 'auto' },
    });
    expect(textOf(history[2])).toContain('The user asked about config.ts');
    expect(session.getContextUsage()).toEqual({ tokens: 1_050, window: 200_000 });
    expect(session.getTotalUsage()).toEqual({
      inputTokens: 160_000 + 800 + 1_000,
      outputTokens: 500 + 30 + 50,
    });
    // The participant's provider runtime starts over from the summary.
    expect(resets).toContain('compaction-session');
    expect(session.getStatus()).toBe('idle');
    expect(session.isCompacting()).toBe(false);
  });

  test('leaves a window under the threshold, and a switched-off setting, alone', async () => {
    const { calls } = bind(() => answer('ok'));
    const under = new Session({
      id: 'under',
      name: 'Under',
      model,
      messages: [user('hi'), { role: 'assistant', model, content: [{ type: 'text', text: 'hey' }], usage: { ...full, contextTokens: 159_999 } }],
    });
    await under.sendMessage(user('more'));
    expect(calls).toHaveLength(1);
    expect(calls[0].turn.toolbox).not.toBeNull();
    expect(under.getMessages().some(message => message.compaction)).toBe(false);

    setAutoCompactEnabled(false);
    const off = fullSession();
    await off.sendMessage(user('more'));
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.map(shape)).toEqual(['Read the config', 'It exports x.', 'more']);
    expect(off.getMessages().some(message => message.compaction)).toBe(false);
  });

  test('a cancelled compaction ends the turn and leaves the history untouched', async () => {
    bind(call => isSummary(call)
      ? abortable(new Promise<Response>(() => {}), call.turn.signal)
      : answer('never'));
    const session = fullSession();

    const turn = session.sendMessage(user('go'));
    await until(() => session.isCompacting());
    expect(session.getStatus()).toBe('working');
    expect(session.cancel()).toBe(true);

    const error = await turn.then(() => null, (caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(session.wasLastTurnCancelled()).toBe(true);
    // The prompt stays, as it does for any cancelled turn; no summary and
    // no response join it.
    expect(session.getMessages().map(shape)).toEqual(['Read the config', 'It exports x.', 'go']);
    expect(session.isCompacting()).toBe(false);
    expect(session.getStatus()).toBe('idle');
  });

  test('a failed summary fails the turn without sending the prompt', async () => {
    const { calls } = bind(call => isSummary(call) ? Promise.reject(new Error('summariser down')) : answer('never'));
    const session = fullSession();

    await expect(session.sendMessage(user('go'))).rejects.toThrow('summariser down');

    expect(calls).toHaveLength(1);
    expect(session.getMessages().map(shape)).toEqual(['Read the config', 'It exports x.', 'go']);
    expect(session.getStatus()).toBe('error');
    expect(session.isCompacting()).toBe(false);
  });

  test('accepts the prompt synchronously, before the summary is written', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    bind(async call => {
      if (isSummary(call)) await gate;
      return isSummary(call) ? summaryResponse : answer('done');
    });
    const session = fullSession();

    const turn = session.sendMessage(user('go'));
    expect(session.getMessages().map(shape)).toEqual(['Read the config', 'It exports x.', 'go']);
    await until(() => session.isCompacting());
    expect(session.getMessages().map(shape)).toEqual(['Read the config', 'It exports x.', 'go']);
    release();
    await turn;
    expect(session.getMessages().map(shape)).toEqual(['Read the config', 'It exports x.', 'summary', 'go', 'done']);
  });

  test('is written by the participant that is about to answer', async () => {
    const reviewerModel = 'test-compaction-reviewer';
    const seen: string[] = [];
    const respond = (call: Call) => {
      seen.push(`${call.turn.agent.model}:${isSummary(call) ? 'summary' : 'turn'}`);
      return isSummary(call) ? summaryResponse : answer('done');
    };
    bind(respond);
    boundTransports[reviewerModel] = { getResponse: async (messages, turn) => respond({ messages: [...messages], turn }) };
    try {
      const session = fullSession();
      session.addParticipant('reviewer', reviewerModel);
      await session.sendMessage(user('@reviewer check it'));
      expect(seen).toEqual([`${reviewerModel}:summary`, `${reviewerModel}:turn`]);
    } finally {
      delete boundTransports[reviewerModel];
    }
  });
});

describe('manual compaction', () => {
  test('compacts on request and refuses an already compacted or empty history', async () => {
    const { resets } = bind(call => isSummary(call) ? summaryResponse : answer('never'));
    const session = fullSession();

    const result = await session.compact();

    expect(result).toEqual({ messages: 2, tokensBefore: 170_000, tokensAfter: 30 });
    expect(session.getMessages().map(shape)).toEqual(['Read the config', 'It exports x.', 'summary']);
    expect(session.getMessages()[2].compaction).toEqual({ messages: 2, tokensBefore: 170_000, trigger: 'manual' });
    expect(session.getContextUsage()).toEqual({ tokens: 30, window: 200_000 });
    expect(resets).toContain('compaction-session');
    expect(session.getStatus()).toBe('idle');

    await expect(session.compact()).rejects.toThrow('already compacted');
    await expect(new Session({ model }).compact()).rejects.toThrow('no history');
  });

  test('waits for the running turn, and a turn waits for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    bind(async call => {
      await gate;
      return isSummary(call) ? summaryResponse : answer('later');
    });
    const session = fullSession();

    const turn = session.sendMessage(user('go'));
    await until(() => session.isCompacting());
    await expect(session.compact()).rejects.toThrow('Wait for the current operation');
    await expect(session.sendMessage(user('again'))).rejects.toThrow('Wait for the context compaction');
    release();
    await turn;
    expect(session.getMessages().map(shape)).toEqual(['Read the config', 'It exports x.', 'summary', 'go', 'later']);
  });

  test('estimates the summary size when the provider reports none, so the next turn does not compact again', async () => {
    const { calls } = bind(call => isSummary(call)
      ? { content: [{ type: 'text', text: 'Summary without usage.' }], stop_reason: 'end_turn' }
      : answer('after'));
    const session = fullSession();

    const result = await session.compact();
    const summary = session.getMessages()[2];
    expect(result.tokensAfter).toBe(estimateTokens(textOf(summary)));
    expect(result.tokensAfter).toBeGreaterThan(0);
    expect(session.getContextUsage()).toEqual({ tokens: result.tokensAfter, window: 200_000 });

    await session.sendMessage(user('next'));
    expect(calls.filter(isSummary)).toHaveLength(1);
    expect(calls.at(-1)?.messages.map(shape)).toEqual(['summary', 'next']);
  });
});

describe('compaction and rewind', () => {
  test('rewinding the chat past the summary brings the full history back', async () => {
    enableCheckpoints();
    const project = path.join(root, 'project');
    mkdirSync(project);
    writeFileSync(path.join(project, 'file.txt'), 'draft');
    let turns = 0;
    const { calls } = bind(call => isSummary(call)
      ? summaryResponse
      : answer(`Answer ${++turns}`, turns >= 2 ? full : small));
    const session = new Session({ id: 'rewind-compaction', name: 'Rewind', directory: project, model });
    session.setPermissionMode('bypass');

    await session.sendMessage(user('one'));
    await session.sendMessage(user('two'));
    await session.sendMessage(user('three'));
    expect(session.getMessages().map(shape))
      .toEqual(['one', 'Answer 1', 'two', 'Answer 2', 'summary', 'three', 'Answer 3']);
    const checkpoints = session.getCheckpoints();
    expect(checkpoints.map(checkpoint => checkpoint.messageIndex)).toEqual([0, 2, 5]);

    // Before "three": the summary stays, and is the whole context.
    await session.rewind(checkpoints[2].id, { chat: true, files: false });
    expect(session.getMessages().map(shape)).toEqual(['one', 'Answer 1', 'two', 'Answer 2', 'summary']);
    expect(session.getContextUsage()).toEqual({ tokens: 30, window: 200_000 });

    // Before "two": the summary goes, and the conversation it stood for is
    // the context again.
    await session.rewind(checkpoints[1].id, { chat: true, files: false });
    expect(session.getMessages().map(shape)).toEqual(['one', 'Answer 1']);
    expect(session.getContextUsage()).toEqual({ tokens: 1_050, window: 200_000 });
    const before = calls.length;
    await session.sendMessage(user('again'));
    expect(calls[before].messages.map(shape)).toEqual(['one', 'Answer 1', 'again']);
  });
});
