import { isAbortError, TurnCancelledError } from '../../abort';
import type { SessionAgent, TurnInput } from '../agent';
import { vendorOf } from '../providers/catalog';
import { nativePrompt } from '../runtime/commands';
import { textOf, type ImageBlock, type Message } from '../types';
import { keyOf, type ParticipantRoster } from './roster';
import type { Timeline } from './timeline';

// One agent to run in a round, and what woke it: the user's prompt entry on
// the first round, the peers' entries that mentioned it on later ones.
export interface Invocation {
  participant: SessionAgent;
  // The entries this turn's prompt carries. They are already in the
  // participant's transcript; the runtime hears them through the prompt.
  entries: Message[];
}

export interface TurnRunnerOptions {
  timeline: Timeline;
  roster: ParticipantRoster;
  onPause(): void;
}

// What a participant is prompted with: the user's own words on the first
// round, with a `/command` the user typed put in the participant's vendor's
// words, and the whole message of each peer that mentioned it afterwards,
// attributed. Only the mentioning paragraph would save tokens but drop
// context the sender assumed was shared.
function promptFor(invocation: Invocation): TurnInput {
  const [first] = invocation.entries;
  if (first?.role === 'user' && invocation.entries.length === 1) {
    const { participant } = invocation;
    const vendor = vendorOf(participant.model);
    const text = textOf(first);
    return {
      text: vendor ? nativePrompt(text, vendor, participant.directory) : text,
      images: first.content.filter((block): block is ImageBlock => block.type === 'image'),
    };
  }
  return {
    text: invocation.entries
      .map(entry => `${entry.role === 'user' ? 'The user' : `@${entry.participant ?? 'sirus'}`} wrote:\n${textOf(entry)}`)
      .join('\n\n'),
    images: invocation.entries.flatMap(entry => entry.role === 'user'
      ? entry.content.filter((block): block is ImageBlock => block.type === 'image') : []),
  };
}

// The round loop: run every invocation of a round in parallel, deliver what
// they produced to whoever they mentioned, then run those in the next round.
export class TurnRunner {
  private rounds = 0;
  private generation = 0;
  private paused: Invocation[] = [];
  private readonly running = new Map<SessionAgent, Promise<void>>();

  constructor(private readonly options: TurnRunnerOptions) {}

  // A user message gives the participants another eight rounds. Handoffs
  // paused at the limit are delivered with the next prompt, not lost.
  userMessage(): Invocation[] {
    this.rounds = 0;
    return this.paused.splice(0);
  }

  cancel(): void {
    this.generation++;
    this.paused = [];
    this.rounds = 0;
  }

  private async respond(invocation: Invocation, options: Parameters<SessionAgent['respond']>[1], generation: number): Promise<void> {
    const previous = this.running.get(invocation.participant);
    const current = (async () => {
      if (previous) await previous.catch(() => {});
      if (generation !== this.generation) throw new TurnCancelledError();
      await invocation.participant.respond(promptFor(invocation), options);
    })();
    this.running.set(invocation.participant, current);
    try {
      await current;
    } finally {
      if (this.running.get(invocation.participant) === current) this.running.delete(invocation.participant);
    }
  }

  async run(initial: readonly Invocation[], signal?: AbortSignal): Promise<void> {
    const { timeline, roster } = this.options;
    const generation = this.generation;
    const combined = new Map<SessionAgent, Invocation>();
    for (const invocation of initial) {
      const existing = combined.get(invocation.participant);
      if (existing) existing.entries.push(...invocation.entries);
      else combined.set(invocation.participant, { ...invocation, entries: [...invocation.entries] });
    }
    let pending = [...combined.values()];
    let firstFailure: unknown;
    let hasFailure = false;

    // Several agents mentioning the same peer in one round are coalesced into
    // one invocation carrying all their messages. Participants remain free to
    // invoke one another again in later rounds for a back-and-forth exchange.
    while (pending.length > 0) {
      if (generation !== this.generation) throw new TurnCancelledError();
      if (this.rounds >= 8) {
        this.paused.push(...pending);
        this.options.onPause();
        break;
      }
      this.rounds++;
      const round = timeline.openRound(pending.map(({ participant }) => ({
        name: participant.name,
        model: participant.model,
        transcript: participant.transcript,
      })));

      const settled = await Promise.allSettled(pending.map(async (invocation, index) => {
        const entry = round.entries[index];
        try {
          await this.respond(invocation, {
            entry,
            carried: invocation.entries,
            onUpdate: () => round.update(index),
            ...(signal ? { signal } : {}),
          }, generation);
          round.settle(index);
          return entry;
        } catch (error) {
          round.discardIfEmpty(index);
          throw error;
        } finally {
          // Repaint as each participant finishes, even if a peer is still
          // streaming, so its transient thought disappears immediately.
          round.flush();
        }
      }));

      // A cancelled round is the end of the turn: a peer that finished first
      // must not start the next round of mentions.
      const cancelled = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected' && isAbortError(result.reason),
      );
      if (cancelled) throw cancelled.reason;

      const next = new Map<string, Invocation>();
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        const source = pending[index].participant;
        if (result.status === 'rejected') {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = result.reason;
          }
          continue;
        }
        const recipients = roster.routeAgentMessage(result.value, source);
        timeline.deliver(result.value, recipients.map(participant => ({ name: participant.name, transcript: participant.transcript })));
        for (const participant of recipients) {
          const key = keyOf(participant.name);
          const invocation = next.get(key);
          if (invocation) invocation.entries.push(result.value);
          else next.set(key, { participant, entries: [result.value] });
        }
      }
      pending = [...next.values()];
    }

    if (hasFailure) throw firstFailure;
  }
}
