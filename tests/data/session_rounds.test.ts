import { afterEach, describe, expect, test } from 'bun:test';
import { textOf, type ImageBlock } from '../../src/agent_runtime/types';
import { Session } from '../../src/agent_runtime/session';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

const streamingModel = 'test-round-streaming-model';
const failingModel = 'test-round-failing-model';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  unbindRuntime(streamingModel);
  unbindRuntime(failingModel);
});

describe('Session rounds', () => {
  test('only the exact streaming reply is live, and peers finish independently', async () => {
    let releaseWriter!: () => void;
    let releasePeer!: () => void;
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const peerGate = new Promise<void>(resolve => { releasePeer = resolve; });
    bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'thought', text: 'Current writer step' });
      await writerGate;
    });
    bindScriptedRuntime(failingModel, async (_input, emit) => {
      emit({ type: 'thought', text: 'Current peer step' });
      await peerGate;
    });
    const session = new Session({ name: 'Live replies', model: streamingModel });
    session.addParticipant('writer', streamingModel);
    session.addParticipant('peer', failingModel);
    session.append({ role: 'assistant', participant: 'writer', content: [{ type: 'thought', text: 'Old writer step' }] });
    const oldReply = session.getMessages()[0]!;
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@writer @peer inspect' }] });
    let observedFinishedWriter = false;
    const unsubscribe = session.subscribe(() => {
      const replies = session.getMessages().filter(message => message.role === 'assistant');
      if (replies.length === 3 && !session.isMessageLive(replies[1]!) && session.isMessageLive(replies[2]!)) {
        observedFinishedWriter = true;
      }
    });
    try {
      await waitFor(() => session.getMessages().filter(message => session.isMessageLive(message)).length === 2);
      expect(session.isMessageLive(oldReply)).toBe(false);
      releaseWriter();
      await waitFor(() => observedFinishedWriter);
      expect(session.getStatus()).toBe('working');
      releasePeer();
      await turn;
      expect(session.getMessages().some(message => session.isMessageLive(message))).toBe(false);
      const next = session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@peer again' }] });
      expect(session.isMessageLive(oldReply)).toBe(false);
      await next;
    } finally {
      releaseWriter();
      releasePeer();
      await turn.catch(() => {});
      unsubscribe();
      await session.dispose();
    }
  });

  test.each(['cancel', 'fail'] as const)('clears the live reply when a turn ends with %s', async ending => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'thought', text: 'Interrupted step' });
      await gate;
      if (ending === 'fail') throw new Error('failed after thinking');
    });
    const session = new Session({ name: 'Interrupted reply', model: streamingModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'inspect' }] });
    const result = turn.catch(error => error);
    try {
      await waitFor(() => session.getMessages().some(message => session.isMessageLive(message)));
      if (ending === 'cancel') session.cancel();
      else release();
      expect(await result).toBeInstanceOf(Error);
      expect(session.getMessages().some(message => session.isMessageLive(message))).toBe(false);
    } finally {
      release();
      await result;
      await session.dispose();
    }
  });

  // Every failed participant keeps a readable error, including a failure
  // before the first streamed word.
  test('records an error for a participant that failed before streaming anything', async () => {
    bindScriptedRuntime(streamingModel, (_input, emit) => { emit({ type: 'text', text: 'partial answer' }); });
    bindScriptedRuntime(failingModel, () => { throw new Error('runtime failed before streaming'); });

    const session = new Session({ id: 'rounds-session', name: 'Rounds', model: streamingModel });
    session.addParticipant('writer', streamingModel);
    session.addParticipant('breaker', failingModel);

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@writer @breaker take a look' }],
    });
    await expect(turn).rejects.toThrow('refused or could not complete');

    const messages = session.getMessages();
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages[1]).toEqual({
      seq: 1,
      role: 'assistant',
      participant: 'writer',
      model: streamingModel,
      content: [{ type: 'text', text: 'partial answer' }],
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number),
    });
    expect(messages[2]).toMatchObject({ participant: 'breaker', content: [{ type: 'notice', severity: 'error' }] });
  });

  test('steers addressed busy participants and prompts idle peers without duplicating delivery', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const busy = bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'text', text: 'Working' });
      await gate;
    });
    const idle = bindScriptedRuntime(failingModel, (_input, emit) => {
      emit({ type: 'text', text: 'Idle peer replied' });
    });
    const session = new Session({ name: 'Steering', model: streamingModel });
    session.addParticipant('peer', failingModel);
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    try {
      await waitFor(() => busy.runtimes[0]?.prompts.length === 1);
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@sirus @peer focus here' }] });
      expect(busy.runtimes[0]!.steers).toEqual(['@sirus @peer focus here']);
      expect(busy.runtimes[0]!.prompts.length).toBe(1);
      expect(idle.runtimes[0]!.prompts[0]!.text).toBe('@sirus @peer focus here');
      const delivered = session.getMessages().filter(entry => textOf(entry) === '@sirus @peer focus here');
      expect(delivered.length).toBe(1);
      expect(delivered[0]!.to?.slice().sort()).toEqual(['peer', 'sirus']);
      expect(session.getStatus()).toBe('working');
      expect(session.getQueuedMessageCount()).toBe(0);
    } finally {
      release();
      await turn;
      await session.dispose();
    }
  });

  test('a prompt sent before the initial runtime starts is steered into that turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const binding = bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'text', text: 'Working' });
      await gate;
    });
    const session = new Session({ name: 'Early steering', model: streamingModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Actually focus here' }] });
      expect(binding.runtimes[0]!.prompts).toHaveLength(1);
      expect(binding.runtimes[0]!.steers).toEqual(['Actually focus here']);
      expect(session.getQueuedMessageCount()).toBe(0);
    } finally {
      release();
      await turn;
      await session.dispose();
    }
  });

  test('explicit feedback recipients override mentions and refused steering queues only for that recipient', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const binding = bindScriptedRuntime(streamingModel, async (_input, emit, _options, _signal, runtime) => {
      runtime.onSteer = () => { throw new Error('unsupported'); };
      emit({ type: 'text', text: 'Working' });
      await gate;
    });
    const session = new Session({ name: 'Refused steering', model: streamingModel });
    session.addParticipant('peer', streamingModel);
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    try {
      await waitFor(() => binding.runtimes[0]?.prompts.length === 1);
      await session.sendMessage({ role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Ask @peer later' }] });
      expect(session.getQueuedMessages()[0]!.to).toEqual(['sirus']);
      expect(session.getNotice()?.notice.title).toContain('Message queued');
      expect(session.getMessages().filter(entry => textOf(entry) === 'Ask @peer later')).toHaveLength(0);
      release();
      await turn;
      await waitFor(() => session.getStatus() === 'idle');
      expect(binding.runtimes[0]!.prompts.map(prompt => prompt.text)).toEqual(['Start', 'Ask @peer later']);
      expect(session.getMessages().filter(entry => textOf(entry) === 'Ask @peer later')).toHaveLength(1);
    } finally {
      release();
      await turn;
      await session.dispose();
    }
  });

  test('queues images and vendor commands during a turn without attempting steering', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const binding = bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'text', text: 'Working' });
      await gate;
    });
    const image: ImageBlock = { type: 'image', path: '/tmp/test-image.png', mediaType: 'image/png', bytes: 12 };
    const session = new Session({ name: 'Images', model: streamingModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    try {
      await waitFor(() => binding.runtimes[0]?.prompts.length === 1);
      await session.sendMessage({ role: 'user', content: [image, { type: 'text', text: 'Inspect this' }] });
      expect(session.getNotice()?.notice.title).toContain('Images cannot be steered');
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '/vendor-command' }] });
      expect(binding.runtimes[0]!.steers).toEqual([]);
      expect(session.getQueuedMessages().map(item => item.text)).toEqual(['Inspect this', '/vendor-command']);
      release();
      await turn;
      await waitFor(() => session.getStatus() === 'idle');
      expect(binding.runtimes[0]!.prompts[1]!.images).toEqual([image]);
      expect(session.getMessages().find(entry => textOf(entry) === 'Inspect this')!.content).toEqual([
        image, { type: 'text', text: 'Inspect this' },
      ]);
      expect(session.shiftQueuedMessage()).toBe('/vendor-command');
    } finally {
      release();
      await turn;
      await session.dispose();
    }
  });

  test('an image addressed to busy and idle participants starts the idle peer immediately', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const busy = bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'text', text: 'Working' });
      await gate;
    });
    const idle = bindScriptedRuntime(failingModel, (_input, emit) => { emit({ type: 'text', text: 'Saw image' }); });
    const image: ImageBlock = { type: 'image', path: '/tmp/test-image.png', mediaType: 'image/png', bytes: 12 };
    const session = new Session({ name: 'Mixed image recipients', model: streamingModel });
    session.addParticipant('peer', failingModel);
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    try {
      await waitFor(() => busy.runtimes[0]?.prompts.length === 1);
      await session.sendMessage({ role: 'user', to: ['sirus', 'peer'], content: [image, { type: 'text', text: 'Inspect' }] });
      expect(idle.runtimes[0]!.prompts[0]!.images).toEqual([image]);
      expect(session.getQueuedMessages()[0]!.to).toEqual(['sirus']);
      release();
      await turn;
      await waitFor(() => session.getStatus() === 'idle');
      expect(idle.runtimes[0]!.prompts).toHaveLength(1);
      expect(busy.runtimes[0]!.prompts[1]!.images).toEqual([image]);
    } finally {
      release();
      await turn;
      await session.dispose();
    }
  });

  test('messages taken back from the queue never drain; the rest go out when the turn ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const binding = bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'text', text: 'Done' });
      await gate;
    });
    const session = new Session({ name: 'Queue take-back', model: streamingModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    try {
      session.queueMessage('Taken back');
      session.queueMessage('Later slot');
      const taken = session.getQueuedMessages()[0]!;
      expect(session.takeQueuedMessages([taken.id]).map(item => item.text)).toEqual(['Taken back']);
      expect(session.getQueuedMessages().map(item => item.text)).toEqual(['Later slot']);
      release();
      await turn;
      await waitFor(() => session.getStatus() === 'idle' && session.getQueuedMessageCount() === 0);
      expect(binding.runtimes[0]!.prompts.map(prompt => prompt.text)).toEqual(['Start', 'Later slot']);
    } finally {
      release();
      await turn;
      await session.dispose();
    }
  });

  test('takes back the listed queued messages in queue order, images and all', async () => {
    const session = new Session({ name: 'Queue draft', model: streamingModel });
    const image: ImageBlock = { type: 'image', path: '/tmp/test-image.png', mediaType: 'image/png', bytes: 12 };
    session.queueMessage('First');
    session.queueMessage('Elsewhere', undefined, undefined, ['peer']);
    session.queueMessage('Image', [image], [image, { type: 'text', text: 'Image' }]);
    const [first, , withImage] = session.getQueuedMessages();
    expect(session.takeQueuedMessages([withImage!.id, first!.id])).toMatchObject([
      { text: 'First' },
      { text: 'Image', images: [image], content: [image, { type: 'text', text: 'Image' }] },
    ]);
    expect(session.getQueuedMessages().map(item => item.text)).toEqual(['Elsewhere']);
    expect(session.takeQueuedMessages([first!.id])).toEqual([]);
    await session.dispose();
  });

  test('pauses an autonomous exchange after eight rounds and resumes pending handoffs on user input', async () => {
    let calls = 0;
    bindScriptedRuntime(streamingModel, (_input, emit) => {
      calls++;
      emit({ type: 'text', text: '@peer continue' });
    });
    bindScriptedRuntime(failingModel, (_input, emit) => {
      calls++;
      emit({ type: 'text', text: '@sirus continue' });
    });
    const session = new Session({ name: 'Round limit', model: streamingModel });
    session.addParticipant('peer', failingModel);
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
      expect(calls).toBe(8);
      expect(session.getStatus()).toBe('idle');
      expect(session.getNotice()?.notice.title).toContain('paused after 8 rounds');
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue' }] });
      expect(calls).toBe(16);
      expect(session.getStatus()).toBe('idle');
      session.clear();
      calls = 0;
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Fresh start' }] });
      expect(calls).toBe(8);
    } finally {
      await session.dispose();
    }
  });

});
