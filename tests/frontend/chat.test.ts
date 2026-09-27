import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { Box, render } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import { planCall, type Message, type PlanEntry, type ToolCallBlock } from '../../src/agent_runtime/types';
import Chat, { currentPlans, formatElapsed, promptHistory, turnPhase } from '../../src/frontend/chat/Chat';
import { usageCommandSpec } from '../../src/commands/authentication/commands';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

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
    expect(output).not.toContain('› Claude');
    expect(output).toContain('Welcome to Sirus.');

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
    expect(output).toContain('gpt-5.6-terra · high');
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
    expect(output).toContain('ctrl+k / u');
    expect(output).toContain('kill previous / next word');
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

test('local commands run during a turn and a reserved command drains after editing finishes', async () => {
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
    await chat.type('/help');
    await chat.type('\r');
    expect(chat.output()).toContain('list commands and keys');
    expect(session.getStatus()).toBe('working');
    await chat.type('\u001b');
    expect(session.getStatus()).toBe('working');
    session.queueMessage('/help');
    await chat.flush();
    await chat.type('\u001b[A');
    expect(session.getQueuedMessages()[0].editing).toBe(true);
    release();
    await turn;
    await chat.flush();
    expect(session.getQueuedMessageCount()).toBe(1);
    expect(chat.output()).not.toContain('list commands and keys');
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

  test('restores each participant’s list, naming the lists only when more than one remains', async () => {
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
      expect(chat.output()).toContain('○ Review the change');
      expect(chat.output()).toContain('@sirus');
      expect(chat.output()).toContain('@reviewer');
      expect(chat.output()).toContain('ctrl+t to hide tasks');

      session.append({ role: 'assistant', participant: 'reviewer', content: [planCall([])] });
      await chat.flush();
      expect(chat.output()).toContain('▸ Update the source');
      expect(chat.output()).not.toContain('Review the change');
      expect(chat.output()).not.toContain('@sirus');
      expect(chat.output()).not.toContain('@reviewer');

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
