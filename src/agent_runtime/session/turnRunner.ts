import { isAbortError } from '../../abort';
import type { SessionAgent, TurnInput } from '../agent';
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
}

// What a participant is prompted with: the user's own words on the first
// round, the whole message of each peer that mentioned it afterwards,
// attributed. Only the mentioning paragraph would save tokens but drop
// context the sender assumed was shared.
function promptFor(invocation: Invocation): TurnInput {
  const [first] = invocation.entries;
  if (first?.role === 'user' && invocation.entries.length === 1) {
    return {
      text: textOf(first),
      images: first.content.filter((block): block is ImageBlock => block.type === 'image'),
    };
  }
  return {
    text: invocation.entries
      .map(entry => `@${entry.participant ?? 'sirus'} wrote:\n${textOf(entry)}`)
      .join('\n\n'),
  };
}

// The round loop: run every invocation of a round in parallel, deliver what
// they produced to whoever they mentioned, then run those in the next round.
export class TurnRunner {
  constructor(private readonly options: TurnRunnerOptions) {}

  async run(initial: readonly Invocation[], signal?: AbortSignal): Promise<void> {
    const { timeline, roster } = this.options;
    let pending = [...initial];
    let firstFailure: unknown;
    let hasFailure = false;

    // Several agents mentioning the same peer in one round are coalesced into
    // one invocation carrying all their messages. Participants remain free to
    // invoke one another again in later rounds for a back-and-forth exchange.
    while (pending.length > 0) {
      const round = timeline.openRound(pending.map(({ participant }) => ({
        name: participant.name,
        model: participant.model,
        transcript: participant.transcript,
      })));

      const settled = await Promise.allSettled(pending.map(async (invocation, index) => {
        const entry = round.entries[index];
        await invocation.participant.respond(promptFor(invocation), {
          entry,
          carried: invocation.entries,
          onUpdate: () => round.update(index),
          ...(signal ? { signal } : {}),
        });
        return entry;
      }));

      for (let index = 0; index < settled.length; index++) {
        if (settled[index].status === 'fulfilled') round.settle(index);
        else round.discardIfEmpty(index);
      }
      round.flush();

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
