import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { Box, render } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import { rememberListedModels } from '../../src/agent_runtime/providers/catalog';
import { openSettings } from '../../src/persistence/settings';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planCall, type Message, type PlanEntry, type ToolCallBlock } from '../../src/agent_runtime/types';
import Chat, { currentPlans, promptHistory, turnPhase } from '../../src/frontend/chat/Chat';
import { formatElapsed } from '../../src/frontend/chat/ChatMessage';
import { usageCommandSpec } from '../../src/commands/authentication/commands';
import { pendingApprovals, requestPermission, resolveApproval } from '../../src/agent_runtime/permissions/approvals';
import {
  beginSelection, clearSelection, extendSelection, getSelectedText, hasSelection,
} from '../../src/frontend/interaction/selection';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';
import * as updater from '../../src/updater';

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
    expect(output).toContain('Codex');
    await type('\u001b');
    expect(output).not.toContain('› Claude');
    // With no credentials the empty chat keeps its tagline and adds the hint.
    expect(output).toContain('What shall we build?');
    expect(output).toContain('Use /login to sign in to Claude or Codex, or add an API key.');

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
    expect(output).toContain('API key for Claude');
    await type('not-a-real-key');
    await type('\u001b');
    expect(output).not.toContain('API key for Claude');
    expect(session.getMessages()).toEqual([]);
  } finally {
    app.unmount();
    stdin.destroy();
    stdout.destroy();
  }
});

test('the status row shows the default model immediately and updates when changed', async () => {
  const session = new Session({ model: 'gpt-5.6-luna' });
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
    expect(output).toContain('gpt-5.6-luna');
    expect(output).not.toContain('TypeSafe AI API key');
    session.changeParticipantModel('sirus', 'gpt-5.6-terra');
    await flush();
    // No level was chosen, so none is claimed until the model's default is known.
    expect(output).toContain('gpt-5.6-terra');
    expect(output).not.toContain('gpt-5.6-terra · high');
  } finally {
    app.unmount();
    await app.waitUntilExit();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
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
    await type('\u001b[1;5H');
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
    await type('\u001b[1;5F');
    // The end of /help is its notes on the mouse and the vendors' commands.
    expect(output).toContain('checkpoint');
    expect(output).toContain('history.');
    expectEditor();
    await type('\u001b[1;5H');
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
    await type('\u001b[1;5F');
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

// A full chat with its real input handler, so pinned rows and their shortcuts
// are exercised together with the draft and transcript.
function renderChat(session: Session) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 48 });
  let output = '';
  stdout.on('data', chunk => {
    const frame = stripAnsi(chunk.toString());
    if (frame.trim()) output = frame;
  });
  const app = render(createElement(Box, { height: 48, width: 140 }, createElement(Chat, { currSession: session })), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  return {
    output: () => output,
    flush,
    async type(input: string) {
      stdin.write(input);
      if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
      await flush();
    },
    async waitFor(text: string) {
      const deadline = Date.now() + 2000;
      while (!output.includes(text) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
        await flush();
      }
      expect(output).toContain(text);
    },
    async close() {
      app.unmount();
      await app.waitUntilExit();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

test('/update shows its own progress and reserves thinking for an actual agent turn', async () => {
  let finishUpdate!: () => void;
  const updating = new Promise<void>(resolve => { finishUpdate = resolve; });
  let notify!: (text: string) => void;
  const update = spyOn(updater, 'updateSirus').mockImplementation(async onProgress => {
    notify = onProgress!;
    notify('Checking npm for a newer Sirus release…');
    await updating;
    return { updated: true, currentVersion: '1.0.0', latestVersion: '1.0.1' };
  });
  const model = 'test-update-progress';
  let finishTurn!: () => void;
  const working = new Promise<void>(resolve => { finishTurn = resolve; });
  bindScriptedRuntime(model, async (_input, emit) => { await working; emit({ type: 'text', text: 'Done.' }); });
  const session = new Session({ model });
  const chat = renderChat(session);
  try {
    await chat.flush();
    await chat.type('/update');
    await chat.type('\r');
    await chat.waitFor('Checking npm for a newer Sirus release…');
    expect(chat.output()).not.toContain('thinking');
    notify('Updating Sirus 1.0.0 → 1.0.1…');
    await chat.flush();
    expect(chat.output()).toContain('Updating Sirus 1.0.0 → 1.0.1…');
    expect(chat.output()).not.toContain('thinking');
    expect(session.getStatus()).toBe('idle');
    finishUpdate();
    await chat.waitFor('Updated 1.0.0 → 1.0.1.');
    await chat.type('Work');
    await chat.type('\r');
    await chat.waitFor('thinking');
    finishTurn();
    await chat.waitFor('Done.');
  } finally {
    finishUpdate();
    finishTurn();
    update.mockRestore();
    await chat.close();
    await session.dispose();
    unbindRuntime(model);
  }
});

test('thinking runs immediately while other commands queue and can be taken back', async () => {
  const model = 'test-chat-command-queue';
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  bindScriptedRuntime(model, async (_input, emit) => {
    started();
    await gate;
    emit({ type: 'text', text: 'Finished.' });
  });
  const session = new Session({ model });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] });
  const chat = renderChat(session);
  try {
    await ready;
    await chat.flush();
    await chat.type('/thinking high');
    await chat.type('\r');
    expect(chat.output()).toContain('@sirus thinking set to high.');
    expect(session.getStatus()).toBe('working');
    await chat.type('/help');
    await chat.type('\r');
    expect(session.getQueuedMessages().map(message => message.text)).toEqual(['/help']);
    await chat.flush();
    await chat.type('\u001b[A');
    expect(session.getQueuedMessageCount()).toBe(0);
    expect(session.getInputContent()).toBe('/help');
    release();
    await turn;
    await chat.flush();
    // The draft's command menu names /help; its panel has not opened.
    expect(chat.output()).not.toContain('pgup / pgdn · ctrl+home / end · esc closes');
    await chat.type('\r');
    await chat.flush();
    expect(session.getQueuedMessageCount()).toBe(0);
    expect(chat.output()).toContain('list commands and keys');
  } finally {
    release();
    await turn;
    await chat.close();
    await session.dispose();
    unbindRuntime(model);
  }
});

test('/review keeps its selected recipient when instructions mention another agent', async () => {
  bindScriptedRuntime('test-reviewer', async () => {});
  const session = new Session();
  session.addParticipant('reviewer', 'test-reviewer');
  let addressed: readonly string[] | undefined;
  const send = spyOn(session, 'sendMessage').mockImplementation(async draft => {
    addressed = draft.to;
    return [];
  });
  const chat = renderChat(session);
  try {
    await chat.flush();
    await chat.type('/review Check @reviewer');
    await chat.type('\r');
    await chat.flush();
    expect(addressed).toEqual(['sirus']);
  } finally {
    send.mockRestore();
    await chat.close();
    await session.dispose();
    unbindRuntime('test-reviewer');
  }
});

test.each(['\u001b[13;5u', '\u0018\u0013'])('Enter queues, Tab completes only, %j sends now, and Escape sends the remaining queue', async shortcut => {
  const model = 'test-chat-claude-input';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const binding = bindScriptedRuntime(model, async (input, emit) => {
    if (input.text === 'Work') await gate;
    emit({ type: 'text', text: 'Finished.' });
  });
  const session = new Session({ model });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] }).catch(() => {});
  const chat = renderChat(session);
  try {
    await chat.waitFor('Work');
    await chat.type('First follow-up');
    await chat.type('\t');
    expect(session.getInputContent()).toBe('First follow-up');
    expect(session.getQueuedMessageCount()).toBe(0);
    await chat.type('\r');
    expect(session.getInputContent()).toBe('');
    expect(session.getQueuedMessages().map(message => message.text)).toEqual(['First follow-up']);
    await chat.type('Second follow-up');
    await chat.type('\r');
    // ↑ takes both back as one draft, and Enter queues it again as one entry.
    await chat.type('\u001b[A');
    expect(session.getQueuedMessageCount()).toBe(0);
    expect(session.getInputContent()).toBe('First follow-up\nSecond follow-up');
    await chat.type('\r');
    expect(session.getQueuedMessages().map(message => message.text)).toEqual(['First follow-up\nSecond follow-up']);
    expect(binding.runtimes[0].steers).toEqual([]);
    await chat.type('Draft sent now');
    // The alternate chord must work across separate keyboard events.
    if (shortcut === '\u0018\u0013') {
      await chat.type('\u0018');
      await chat.type('\u0013');
    } else await chat.type(shortcut);
    expect(binding.runtimes[0].steers).toEqual(['First follow-up\nSecond follow-up', 'Draft sent now']);
    expect(session.getQueuedMessageCount()).toBe(0);
    await chat.type('After interrupt');
    await chat.type('\r');
    await chat.type('\u001b');
    await turn;
    await chat.waitFor('Finished.');
    expect(binding.runtimes[0].prompts.map(prompt => prompt.text)).toEqual(['Work', 'After interrupt']);
    expect(session.getInputContent()).toBe('');
    expect(session.getQueuedMessageCount()).toBe(0);
  } finally {
    release();
    await turn;
    await chat.close();
    await session.dispose();
    unbindRuntime(model);
  }
});

describe('pinned plans', () => {
  const entries: PlanEntry[] = [
    { content: 'Read the source', status: 'completed' },
    { content: 'Update the source', status: 'in_progress' },
    { content: 'Check the result', status: 'pending' },
  ];

  test('reads the latest plan per current participant, in roster order', () => {
    const reviewer: PlanEntry[] = [{ content: 'Review the change', status: 'pending' }];
    const messages: Message[] = [
      { seq: 0, role: 'assistant', content: [planCall([{ content: 'Old task', status: 'pending' }])] },
      { seq: 1, role: 'assistant', participant: 'reviewer', content: [planCall(reviewer)] },
      { seq: 2, role: 'assistant', participant: 'Sirus', content: [planCall([]), planCall(entries)] },
      { seq: 3, role: 'assistant', participant: 'sirus', content: [{ type: 'text', text: 'Continuing.' }] },
      { seq: 4, role: 'user', content: [planCall([])] },
      { seq: 5, role: 'assistant', participant: 'removed', content: [planCall(entries)] },
    ];
    expect(currentPlans(messages, [{ name: 'sirus' }, { name: 'Reviewer' }])).toEqual([
      { participant: 'sirus', entries },
      { participant: 'Reviewer', entries: reviewer },
    ]);
  });

  test('an empty or completed replacement clears a participant’s previous plan', () => {
    const messages: Message[] = [
      { seq: 0, role: 'assistant', content: [planCall(entries)] },
      { seq: 1, role: 'assistant', participant: 'reviewer', content: [planCall(entries)] },
      { seq: 2, role: 'assistant', content: [planCall([])] },
      { seq: 3, role: 'assistant', participant: 'reviewer', content: [
        planCall(entries.map(entry => ({ ...entry, status: 'completed' }))),
      ] },
    ];
    expect(currentPlans(messages, [{ name: 'sirus' }, { name: 'reviewer' }])).toEqual([]);
    // Rewinding to before the replacements makes those earlier lists current.
    expect(currentPlans(messages.slice(0, 2), [{ name: 'sirus' }, { name: 'reviewer' }])).toHaveLength(2);
  });

  test('shows only the selected participant’s restored plan', async () => {
    const original = new Session({ name: 'Restored plans' });
    original.addParticipant('reviewer', 'gpt-5.6-luna');
    original.append({ role: 'assistant', participant: 'sirus', content: [planCall(entries)] });
    original.append({ role: 'assistant', participant: 'reviewer', content: [
      planCall([{ content: 'Review the change', status: 'pending' }]),
    ] });
    const session = Session.fromSnapshot(original.toSnapshot());
    const chat = renderChat(session);
    try {
      await chat.flush();
      expect(chat.output()).toContain('▸ Update the source');
      expect(chat.output()).not.toContain('○ Review the change');
      session.selectParticipant('reviewer');
      await chat.flush();
      expect(chat.output()).toContain('○ Review the change');
      expect(chat.output()).not.toContain('Update the source');
      session.selectParticipant('sirus');
      await chat.flush();
      expect(chat.output()).toContain('ctrl+t to hide tasks');

      session.append({ role: 'assistant', participant: 'reviewer', content: [planCall([])] });
      await chat.flush();
      expect(chat.output()).toContain('▸ Update the source');
      expect(chat.output()).not.toContain('Review the change');
      expect(chat.output()).not.toContain('○ Review the change');

      session.append({ role: 'assistant', participant: 'sirus', content: [planCall([])] });
      await chat.flush();
      expect(chat.output()).not.toContain('Update the source');
      expect(chat.output()).not.toContain('ctrl+t');
    } finally {
      await chat.close();
      await session.dispose();
      await original.dispose();
    }
  });

  test('toggles without changing the draft, keeps unfinished tasks at idle, and hides completed tasks during a turn', async () => {
    const model = 'test-chat-pinned-plan';
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    let turnNumber = 0;
    bindScriptedRuntime(model, async (_input, emit) => {
      turnNumber++;
      if (turnNumber === 1) {
        emit({ type: 'plan', entries });
        await firstGate;
      } else {
        emit({ type: 'plan', entries: entries.map(entry => ({ ...entry, status: 'completed' })) });
        await secondGate;
      }
    });
    const session = new Session({ name: 'Live plan', model });
    const chat = renderChat(session);
    let turn = Promise.resolve<Message[]>([]);
    try {
      turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
      await chat.waitFor('▸ Update the source');
      expect(session.getStatus()).toBe('working');
      expect(chat.output()).toContain('Updated plan · 1 of 3 done');
      expect(chat.output()).toContain('ctrl+t to hide tasks');
      expect(chat.output()).not.toContain('@sirus');
      await chat.type('Continue after checking');
      await chat.type('\u0014');
      expect(chat.output()).not.toContain('Update the source');
      expect(chat.output()).toContain('ctrl+t to show tasks');
      expect(session.getInputContent()).toBe('Continue after checking');
      await chat.type('\u0014');
      expect(chat.output()).toContain('▸ Update the source');
      expect(chat.output()).toContain('ctrl+t to hide tasks');
      expect(session.getInputContent()).toBe('Continue after checking');

      releaseFirst();
      await turn;
      await chat.flush();
      expect(session.getStatus()).not.toBe('working');
      expect(chat.output()).toContain('▸ Update the source');
      expect(chat.output()).toContain('ctrl+t to hide tasks');

      turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Finish' }] });
      await chat.waitFor('Updated plan · 3 of 3 done');
      expect(session.getStatus()).toBe('working');
      expect(chat.output()).not.toContain('Update the source');
      expect(chat.output()).not.toContain('ctrl+t');
      await chat.type('\u0014');
      expect(chat.output()).not.toContain('Update the source');
      releaseSecond();
      await turn;
      await chat.flush();
      expect(chat.output()).not.toContain('Update the source');
      expect(chat.output()).not.toContain('ctrl+t');
    } finally {
      releaseFirst();
      releaseSecond();
      await turn.catch(() => {});
      await chat.close();
      await session.dispose();
      unbindRuntime(model);
    }
  });
});

test('notices between turns appear as input feedback without adding transcript entries', async () => {
  const model = 'test-chat-idle-notice';
  const binding = bindScriptedRuntime(model, (_input, emit) => { emit({ type: 'text', text: 'Ready.' }); });
  const session = new Session({ name: 'Idle notice', model });
  await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Inspect' }] });
  const before = structuredClone(session.getMessages());
  const chat = renderChat(session);
  try {
    await chat.flush();
    for (const severity of ['warning', 'error', 'vendor-info']) {
      binding.starts[0].onUpdate({
        type: 'notice', severity, title: 'Configuration\nchanged', description: 'A vendor\tdetail.',
      });
      await chat.flush();
      expect(chat.output()).toContain(`${severity === 'vendor-info' ? '' : '! '}@sirus: Configuration changed · A vendor detail.`);
      expect(session.getMessages()).toEqual(before);
      await chat.type('\u001b');
      expect(chat.output()).not.toContain('Configuration changed');
    }
    await chat.type('A draft after the notice');
    expect(chat.output()).not.toContain('Configuration changed');
    expect(session.getMessages()).toEqual(before);
  } finally {
    await chat.close();
    await session.dispose();
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
  // The model menu opens only for a signed-in vendor, and offers only the
  // models it has listed; both live in a data directory of the test's own.
  const previousDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'sirus-chat-escape-'));
  openSettings().set({ providerSources: { gpt: [{ id: 'escape-test', type: 'api', key: 'sk-test-escape' }] } });
  rememberListedModels('gpt', [{ id: 'gpt-5.6-luna', description: 'Luna' }]);
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

    // A message queued behind the turn has nothing open to close: ↑ takes
    // it back into the draft, and clearing the draft drops it, so no turn
    // follows the cancel below.
    await chat.press('later');
    await chat.press('\r');
    expect(session.getQueuedMessageCount()).toBe(1);
    await chat.press('\u001b[A');
    expect(session.getQueuedMessageCount()).toBe(0);
    expect(session.getStatus()).toBe('working');
    await chat.press('\u0015');

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
    // Past the window in which a second escape is the double press.
    await new Promise(resolve => setTimeout(resolve, 600));
    await cancelsTurn();
  } finally {
    clearSelection();
    session.cancel();
    await Promise.all(turns);
    await chat.unmount();
    session.dispose();
    unbindRuntime(model);
    rmSync(process.env.SIRUS_DATA_DIR!, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
  }
});

test('Chat leaves a queued prompt visible after its attachment fails before acceptance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sirus-chat-queued-failure-'));
  const model = 'test-chat-queued-failure';
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  bindScriptedRuntime(model, async input => { if (input.text === 'Work') await gate; });
  const session = new Session({ model, directory });
  const chat = mountChat(session);
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] });
  try {
    await chat.flush();
    session.queueMessage('Read @"missing.txt"');
    const queuedId = session.getQueuedMessages()[0]!.id;
    finish();
    await turn;
    await chat.flush();
    expect(session.getQueuedMessages().map(item => item.id)).toEqual([queuedId]);
    expect(chat.frame()).toContain('Read @"missing.txt"');
  } finally {
    finish();
    await turn;
    await chat.unmount();
    await session.dispose();
    unbindRuntime(model);
    rmSync(directory, { recursive: true, force: true });
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
    // A finished edit stays closed; a click opens it, and the lines below
    // move down by the diff's height.
    expect(chat.frame()).not.toContain('+ new line');
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

test('a message steered into a reply leaves the rows opened in it alone', async () => {
  const model = 'test-chat-steered-row';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edit = (id: string, name: string) => ({
    type: 'tool_call' as const, id, kind: 'edit' as const, title: `${name}.md`, status: 'completed' as const,
    locations: [], content: [{ type: 'diff' as const, path: `${name}.md`, oldText: null, newText: `${name} line` }],
  });
  // The reply edits one file, is steered, and then edits another, so the
  // steered message lands between the two and splits the reply around it.
  bindScriptedRuntime(model, async (_input, emit) => {
    emit({ type: 'tool_call', call: edit('first-edit', 'first') });
    await gate;
    emit({ type: 'tool_call', call: edit('second-edit', 'second') });
  });
  const session = new Session({ model });
  const chat = mountChat(session);
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'edit' }] });
  try {
    for (let tries = 0; tries < 50 && !chat.frame().includes('● Edit first.md'); tries++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await chat.flush();
    }
    // A finished edit stays closed; the user opens the first one.
    expect(chat.frame()).not.toContain('+ first line');
    const lines = chat.frame().split('\n');
    const line = lines.findIndex(text => text.includes('● Edit first.md'));
    const row = { line, col: lines[line]!.indexOf('● Edit first.md') };
    expect(pressAt(row)).toBe(true);
    expect(releaseAt(row)).toBe(true);
    await chat.flush();
    expect(chat.frame()).toContain('+ first line');

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Also the second file.' }] });
    release();
    await turn;
    await new Promise(resolve => setTimeout(resolve, 60));
    await chat.flush();
    const frame = chat.frame();
    expect(frame.indexOf('● Edit first.md')).toBeLessThan(frame.indexOf('Also the second file.'));
    expect(frame.indexOf('Also the second file.')).toBeLessThan(frame.indexOf('● Edit second.md'));
    // The first stays as the user left it, and the second stays closed.
    expect(frame).toContain('+ first line');
    expect(frame).not.toContain('+ second line');
  } finally {
    release();
    await turn.catch(() => undefined);
    await chat.unmount();
    session.dispose();
    unbindRuntime(model);
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
    expect(turnPhase([{ seq: 0, role: 'assistant', content: [running] }])).toBe('running bun test');
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
      .toBe(`running ${title.slice(0, 39)}…`);
  });

  test('describes running calls from their row labels', () => {
    const reading: Message = { seq: 3, role: 'assistant', content: [{ ...running, kind: 'read', title: "Read file '/project/notes.txt'" }] };
    expect(turnPhase([reading], '/project')).toBe("reading file 'notes.txt'");
    const phase = (kind: ToolCallBlock['kind'], title: string) => turnPhase([
      { seq: 3, role: 'assistant', content: [{ ...running, kind, title }] },
    ]);
    expect(phase('other', 'Start subagent opt-3: Sirus')).toBe('starting subagent opt-3: Sirus');
    expect(turnPhase([{ seq: 3, role: 'assistant', content: [{
      ...running, kind: 'other', title: 'mcp__sirus__SpawnAgent',
      input: { name: 'opt-3', description: 'Sirus' },
    }] }])).toBe('starting subagent opt-3: Sirus');
    expect(phase('edit', 'Write notes.txt')).toBe('writing notes.txt');
    expect(phase('search', 'Search for todo')).toBe('searching for todo');
    expect(phase('search', 'Web search: Sirus')).toBe('searching the web: Sirus');
    expect(phase('other', 'Docker build')).toBe('running Docker build');
  });

  test('formats elapsed seconds and minutes', () => {
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
  });
});


test('slash paths and unknown commands are sent as messages', async () => {
  const model = 'test-slash-input';
  const received: string[] = [];
  bindScriptedRuntime(model, (input, emit) => { received.push(input.text); emit({ type: 'text', text: 'Received.' }); });
  const session = new Session({ model });
  const chat = renderChat(session);
  try {
    await chat.flush();
    await chat.type('/tmp/foo.txt what is in this file');
    await chat.type('\r');
    await chat.waitFor('Received.');
    expect(received[0]).toContain('/tmp/foo.txt what is in this file');
    await chat.type('/not-a-command hello');
    await chat.type('\r');
    for (let attempt = 0; attempt < 200 && received.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(chat.output()).not.toContain('Unknown command');
    expect(received[1]).toBe('/not-a-command hello');
    expect(session.getInputContent()).toBe('');
  } finally {
    await chat.close();
    await session.dispose();
    unbindRuntime(model);
  }
});


test('/exit clears the command draft before the app exits', async () => {
  const session = new Session();
  session.append({ role: 'user', content: [{ type: 'text', text: 'Saved conversation' }] });
  const chat = renderChat(session);
  try {
    await chat.flush();
    await chat.type('/exit');
    expect(session.getInputContent()).toBe('/exit');
    await chat.type('\r');
    expect(session.toSnapshot().inputContent).toBe('');
    expect(session.getMessages()).toHaveLength(1);
  } finally { await chat.close(); await session.dispose(); }
});
