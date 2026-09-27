import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadJevApiKey } from '../../src/persistence';
import { shouldRequestJevKey } from '../../src/agent_runtime/router';
import { createElement } from 'react';
import { Box, render } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import type { Message, ToolCallBlock } from '../../src/agent_runtime/types';
import Chat, { formatElapsed, promptHistory, turnPhase } from '../../src/frontend/chat/Chat';
import { usageCommandSpec } from '../../src/commands/authentication/commands';
import { pendingApprovals, requestPermission, resolveApproval } from '../../src/agent_runtime/permissions/approvals';
import {
  beginSelection, clearSelection, extendSelection, getSelectedText, hasSelection,
} from '../../src/frontend/interaction/selection';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

// A Chat in a terminal the test types into. `frame` is the last frame drawn;
// `press` waits out Ink's pause after a lone escape, which it holds briefly
// in case a longer sequence follows.
function mountChat(session: Session, { columns = 120, rows = 40 } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns, rows });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(createElement(Box, { height: rows, width: columns }, createElement(Chat, { currSession: session })), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  return {
    frame: () => output,
    flush,
    async press(input: string) {
      stdin.write(input);
      if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
      await flush();
    },
    async unmount() {
      app.unmount();
      await app.waitUntilExit();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

test('Escape dismisses help, command suggestions, login stages and secret entry', async () => {
  const session = new Session();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 60 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(createElement(Box, { height: 60, width: 140 },
    createElement(Chat, { currSession: session })), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  const type = async (input: string) => {
    stdin.write(input);
    // Ink buffers bare Escape briefly to distinguish it from arrow sequences.
    if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
    await flush();
  };
  try {
    await flush();
    await type('/help');
    await type('\r');
    expect(output).toContain('list commands and keys');
    await type('\u001b');
    expect(output).not.toContain('list commands and keys');

    await type('/log');
    expect(output).toContain('add a subscription or API key');
    await type('\u001b');
    expect(output).not.toContain('add a subscription or API key');
    expect(session.getInputContent()).toBe('/log');
    await type('i');
    expect(output).toContain('add a subscription or API key');
    await type('\r');
    expect(output).toContain('ChatGPT');
    await type('\u001b');
    expect(output).not.toContain('ChatGPT');

    await type('/login');
    await type('\r');
    await type('\r');
    expect(output).toContain('Subscription');
    await type('\u001b');
    expect(output).not.toContain('Subscription');

    await type('/login');
    await type('\r');
    await type('\r');
    await type('\u001b[B');
    await type('\r');
    expect(output).toContain('Anthropic API key');
    await type('not-a-real-key');
    await type('\u001b');
    expect(output).not.toContain('Anthropic API key');
    expect(session.getMessages()).toEqual([]);
  } finally {
    app.unmount();
    stdin.destroy();
    stdout.destroy();
  }
});

test('the status row shows no model while Jev has yet to pick one', async () => {
  const previousKey = process.env.JEV_API;
  process.env.JEV_API = 'ts-live-key-status';
  const session = new Session({ model: 'gpt-5.6-luna', routePending: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(createElement(Box, { height: 40, width: 140 }, createElement(Chat, { currSession: session })), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  try {
    await flush();
    expect(session.isModelPending()).toBe(true);
    expect(output).not.toContain('gpt-5.6-luna');
    // The user's own pick settles the draft and shows at once.
    session.changeParticipantModel('sirus', 'gpt-5.6-terra');
    await flush();
    expect(session.isModelPending()).toBe(false);
    expect(output).toContain('gpt-5.6-terra · high');
  } finally {
    app.unmount();
    await app.waitUntilExit();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
    if (previousKey === undefined) delete process.env.JEV_API;
    else process.env.JEV_API = previousKey;
  }
});

test('the first launch without a Jev key asks for one once, and esc declines for good', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-jev-chat-'));
  const previousDirectory = process.env.SIRUS_DATA_DIR;
  const previousKey = process.env.JEV_API;
  process.env.SIRUS_DATA_DIR = directory;
  delete process.env.JEV_API;
  const session = new Session();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  let asked = 0;
  const app = render(createElement(Box, { height: 40, width: 140 },
    createElement(Chat, { currSession: session, askJevKey: true, onJevKeyAsked: () => { asked++; } })), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  try {
    await flush();
    expect(shouldRequestJevKey()).toBe(true);
    expect(asked).toBe(1);
    expect(output).toContain('TypeSafe AI API key');
    stdin.write('\u001b');
    await new Promise(resolve => setTimeout(resolve, 100));
    await flush();
    expect(output).not.toContain('TypeSafe AI API key');
    expect(output).toContain('Jev is off');
    expect(loadJevApiKey(directory)).toBeNull();
    expect(shouldRequestJevKey()).toBe(false);

    // Pasting a key through /jev later stores it without echoing it.
    stdin.write('/jev');
    await flush();
    stdin.write('\r');
    await flush();
    expect(output).toContain('Set API key');
    stdin.write('\r');
    await flush();
    stdin.write('ts-live-key-abcdef');
    await flush();
    expect(output).not.toContain('ts-live-key-abcdef');
    stdin.write('\r');
    await flush();
    expect(output).toContain('Saved TypeSafe AI key');
    expect(loadJevApiKey(directory)).toBe('ts-live-key-abcdef');
  } finally {
    app.unmount();
    await app.waitUntilExit();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
    if (previousKey === undefined) delete process.env.JEV_API;
    else process.env.JEV_API = previousKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('help and usage stay scrollable above the editor in an 80 by 24 terminal', async () => {
  // The gauge is the runtime's own report, so the history comes from a turn
  // rather than a seeded entry.
  const model = 'test-chat-scrolling';
  bindScriptedRuntime(model, (_input, emit) => {
    emit({ type: 'text', text: [
      'Conversation remains available.',
      ...Array.from({ length: 24 }, (_, i) => `Conversation row ${i}.`),
    ].join('\n\n') });
    emit({ type: 'context', usage: { tokens: 120, window: 400_000 } });
  });
  const session = new Session({ model });
  await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Go on.' }] });
  const originalMessages = [...session.getMessages()];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(createElement(Box, { width: 80, height: 24 },
    createElement(Box, { width: 26, flexShrink: 0 }),
    createElement(Chat, { currSession: session })), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  const type = async (input: string) => {
    stdin.write(input);
    if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
    await flush();
  };
  const expectEditor = () => {
    expect(output.split('\n').length).toBeLessThanOrEqual(24);
    expect(output).toContain('enter ↵');
    expect(output).toContain('ctx 120');
    expect(output).toContain('esc closes');
  };
  // The command layer has separate provider tests. Keep this rendering test
  // offline while exercising the same asynchronous /usage completion path.
  const usage = spyOn(usageCommandSpec, 'run').mockImplementation(() => Promise.resolve({
    kind: 'info' as const, showIcon: false,
    text: ['claude · you@example.com · 5h 70% · 7d 45%', 'session · 100 in · 20 out'].join('\n'),
  }));
  try {
    await flush();
    await type('\u001b[H');
    expect(output).toContain('Conversation remains available.');
    await type('/help');
    await type('\r');
    expect(output).toContain('commands');
    expect(output).not.toContain('ctrl+u');
    expectEditor();
    const firstPage = output;
    await type('\u001b[6~');
    expect(output).not.toBe(firstPage);
    expectEditor();
    await type('\u001b[5~');
    expect(output).toBe(firstPage);
    await type('\u001b[F');
    expect(output).toContain('ctrl+u');
    expect(output).toContain('delete the previous word');
    expectEditor();
    await type('\u001b[H');
    expect(output).toBe(firstPage);
    await type('\u001b');
    expect(output).toContain('Conversation remains available.');
    expect(output).not.toContain('esc closes');

    // Short output stays pinned above the editor instead of taking the panel.
    await type('/usage');
    await type('\r');
    expect(usage).toHaveBeenCalledTimes(1);
    expect(output).toContain('claude · you@example.com · 5h 70% · 7d 45%');
    expect(output).toContain('session · 100 in · 20 out');
    expect(output).toContain('enter ↵');
    expect(output).not.toContain('esc closes');
    await type('\u001b[F');
    // End scrolls the history behind the pinned output.
    expect(output).toContain('Conversation row 23.');
    expect(output).toContain('session · 100 in · 20 out');
    await type('\u001b');
    expect(output).not.toContain('session · 100 in');
    expect(session.getMessages()).toEqual(originalMessages);
  } finally {
    usage.mockRestore();
    app.unmount();
    stdin.destroy();
    stdout.destroy();
    session.dispose();
    unbindRuntime(model);
  }
});

test('the approval prompt keeps the choice the arrows moved to while the chat renders again', async () => {
  const session = new Session();
  const chat = mountChat(session);
  const answer = requestPermission(
    { sessionId: session.getId(), requester: { participant: 'sirus' } },
    {
      sessionId: 'acp-session',
      toolCall: { toolCallId: 'call-held-choice', kind: 'edit', title: 'notes.md' },
      options: [
        { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ],
    },
  );
  try {
    await chat.flush();
    expect(chat.frame()).toContain('wants to edit notes.md');
    await chat.press('\u001b[B');
    expect(chat.frame()).toContain('› No');
    // Any change to the session draws the chat again, as a streaming turn
    // or a worker's progress does many times a second.
    session.setName('Renamed');
    await chat.flush();
    expect(chat.frame()).toContain('› No');
    await chat.press('\r');
    expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
  } finally {
    for (const approval of pendingApprovals(session.getId())) resolveApproval(approval.id, 'deny');
    await chat.unmount();
    session.dispose();
  }
});

test('escape closes what is open before it cancels the turn', async () => {
  const model = 'test-chat-escape';
  // A turn that runs until it is cancelled.
  bindScriptedRuntime(model, () => new Promise<void>(() => {}));
  const session = new Session({ model });
  const chat = mountChat(session);
  const turns: Promise<unknown>[] = [];
  const startTurn = async () => {
    turns.push(session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Go on.' }] }).catch(() => undefined));
    await chat.flush();
    expect(session.getStatus()).toBe('working');
  };
  const cancelsTurn = async () => {
    await chat.press('\u001b');
    await turns[turns.length - 1];
    await chat.flush();
    expect(session.getStatus()).not.toBe('working');
  };
  try {
    await chat.flush();
    // A menu of the chat's own, open when a turn starts on its own (a
    // worker's report arriving, say).
    await chat.press('/model');
    await chat.press('\r');
    expect(chat.frame()).toContain('enter to select');
    await startTurn();
    await chat.press('\u001b');
    expect(chat.frame()).not.toContain('enter to select');
    expect(session.getStatus()).toBe('working');

    // The command menu the draft opened.
    await chat.press('/mod');
    expect(chat.frame()).toContain('set an agent\'s model');
    await chat.press('\u001b');
    expect(chat.frame()).not.toContain('set an agent\'s model');
    expect(session.getStatus()).toBe('working');
    await chat.press('\u0015');

    // The mention menu.
    await chat.press('@');
    expect(chat.frame()).toContain('@sirus');
    await chat.press('\u001b');
    expect(chat.frame()).not.toContain('@sirus');
    expect(session.getStatus()).toBe('working');
    await chat.press('\u0015');

    // A queued message being edited.
    await chat.press('later');
    await chat.press('\r');
    await chat.press('\u001b[A');
    expect(chat.frame()).toContain('later▌');
    await chat.press('\u001b');
    expect(chat.frame()).not.toContain('later▌');
    expect(session.getStatus()).toBe('working');
    // Emptied, it leaves the queue, so no turn follows the cancel below.
    await chat.press('\u001b[A');
    await chat.press('\u0015');
    expect(session.getQueuedMessageCount()).toBe(0);

    // A text selection.
    beginSelection({ line: 4, col: 2 });
    extendSelection({ line: 5, col: 12 });
    expect(hasSelection()).toBe(true);
    await chat.press('\u001b');
    expect(hasSelection()).toBe(false);
    expect(session.getStatus()).toBe('working');

    // With nothing left open, escape is the turn's cancel.
    await cancelsTurn();

    // A command's panel, open when the next turn starts.
    await chat.press('/help');
    await chat.press('\r');
    expect(chat.frame()).toContain('esc closes');
    await startTurn();
    await chat.press('\u001b');
    expect(chat.frame()).not.toContain('esc closes');
    expect(session.getStatus()).toBe('working');
    await cancelsTurn();
  } finally {
    clearSelection();
    session.cancel();
    await Promise.all(turns);
    await chat.unmount();
    session.dispose();
    unbindRuntime(model);
  }
});

test('copying from the history copies the lines on screen after a row was opened', async () => {
  const model = 'test-chat-copy';
  bindScriptedRuntime(model, (_input, emit) => {
    emit({ type: 'tool_call', call: {
      type: 'tool_call', id: 'copy-edit', kind: 'edit', title: 'notes.md', status: 'completed',
      locations: [], content: [{ type: 'diff', path: 'notes.md', oldText: 'old line', newText: 'new line' }],
    } });
    emit({ type: 'text', text: 'The edit is done.' });
  });
  const session = new Session({ model });
  await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Edit the notes.' }] });
  const chat = mountChat(session);
  // Where a marker sits in the frame, as the mouse would report it.
  const cellOf = (marker: string) => {
    const lines = chat.frame().split('\n');
    const line = lines.findIndex(text => text.includes(marker));
    expect(line).toBeGreaterThanOrEqual(0);
    return { line, col: lines[line]!.indexOf(marker) };
  };
  try {
    await chat.flush();
    const row = cellOf('● Edit notes.md');
    expect(pressAt(row)).toBe(true);
    expect(releaseAt(row)).toBe(true);
    await chat.flush();
    expect(chat.frame()).toContain('+ new line');

    const reply = cellOf('The edit is done.');
    beginSelection(reply);
    extendSelection({ line: reply.line, col: reply.col + 'The edit is done.'.length - 1 });
    expect(getSelectedText()).toBe('The edit is done.');
  } finally {
    clearSelection();
    await chat.unmount();
    session.dispose();
    unbindRuntime(model);
  }
});

test('a reply that appears ahead of a peer\'s in its round leaves the peer\'s opened row alone', async () => {
  const writerModel = 'test-chat-order-writer';
  const peerModel = 'test-chat-order-peer';
  let releaseWriter!: () => void;
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
  const edit = (id: string, name: string) => ({
    type: 'tool_call' as const, id, kind: 'edit' as const, title: `${name}.md`, status: 'completed' as const,
    locations: [], content: [{ type: 'diff' as const, path: `${name}.md`, oldText: null, newText: `${name} line` }],
  });
  // The writer speaks first in the round but answers last, so its reply
  // enters the history above the peer's after the peer's is on screen.
  bindScriptedRuntime(writerModel, async (_input, emit) => {
    await writerGate;
    emit({ type: 'tool_call', call: edit('writer-edit', 'writer') });
  });
  bindScriptedRuntime(peerModel, (_input, emit) => {
    emit({ type: 'tool_call', call: edit('peer-edit', 'peer') });
  });
  const session = new Session({ model: writerModel });
  session.addParticipant('writer', writerModel);
  session.addParticipant('peer', peerModel);
  const chat = mountChat(session);
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@writer @peer edit' }] });
  try {
    for (let tries = 0; tries < 50 && !chat.frame().includes('● Edit peer.md'); tries++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await chat.flush();
    }
    const lines = chat.frame().split('\n');
    const line = lines.findIndex(text => text.includes('● Edit peer.md'));
    const row = { line, col: lines[line]!.indexOf('● Edit peer.md') };
    expect(pressAt(row)).toBe(true);
    expect(releaseAt(row)).toBe(true);
    await chat.flush();
    expect(chat.frame()).toContain('+ peer line');

    releaseWriter();
    await turn;
    await new Promise(resolve => setTimeout(resolve, 60));
    await chat.flush();
    expect(chat.frame().indexOf('● Edit writer.md')).toBeLessThan(chat.frame().indexOf('● Edit peer.md'));
    expect(chat.frame()).toContain('+ peer line');
    expect(chat.frame()).not.toContain('+ writer line');
  } finally {
    releaseWriter();
    await turn.catch(() => undefined);
    await chat.unmount();
    session.dispose();
    unbindRuntime(writerModel);
    unbindRuntime(peerModel);
  }
});

describe('chat input history', () => {
  test('collects user prompts in order and removes immediate duplicates', () => {
    const messages: Message[] = [
      { seq: 0, role: 'user', content: [{ type: 'text', text: 'first' }] },
      { seq: 1, role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { seq: 2, role: 'user', content: [{ type: 'text', text: 'first' }] },
      { seq: 3, role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];
    expect(promptHistory(messages)).toEqual(['first', 'second']);
  });
});

describe('turn status', () => {
  const running: ToolCallBlock = {
    type: 'tool_call', id: 'call-1', kind: 'execute', title: 'bun test',
    status: 'in_progress', locations: [], content: [],
  };

  test('distinguishes thinking, tool activity, and writing', () => {
    expect(turnPhase([])).toBe('thinking');
    expect(turnPhase([{ seq: 0, role: 'assistant', content: [running] }])).toBe('running Run bun test');
    expect(turnPhase([{
      seq: 0,
      role: 'assistant',
      content: [
        { ...running, status: 'completed' },
        { type: 'text', text: 'All done' },
      ],
    }])).toBe('writing');
  });

  test('cuts a long tool title down to the status line', () => {
    const title = 'bun test --coverage --reporter junit tests/frontend';
    expect(turnPhase([{ seq: 0, role: 'assistant', content: [{ ...running, title }] }]))
      .toBe(`running Run ${title.slice(0, 39)}…`);
  });

  test('formats elapsed seconds and minutes', () => {
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
  });
});
