import { isAbortError } from '../../abort';
import type { SessionAgent } from '../agent';
import type { Toolbox } from '../tools';
import { keyOf, type ParticipantRoster } from './roster';
import type { Transcript } from './transcript';

// One agent to run in a round, and the peers whose messages woke it.
export interface Invocation {
  participant: SessionAgent;
  mentionedBy: string[];
}

export interface TurnRunnerOptions {
  transcript: Transcript;
  roster: ParticipantRoster;
  // Where every turn of this session runs.
  directory: string;
  // The tools each turn gets, with its gate and its barrier already bound.
  // The barrier is the session's pre-turn checkpoint, which mutating tools
  // must wait for.
  toolboxFor: (agent: SessionAgent, beforeMutation: Promise<void>) => Toolbox;
}

// A host-generated user turn telling an agent why it was woken. It is sent to
// the provider but is not persisted in chat history.
function delegationPrompt(mentionedBy: readonly string[]): string {
  const sources = mentionedBy.map(name => `@${name}`).join(' and ');
  return `${sources} mentioned you in the shared session. Respond to the message${
    mentionedBy.length === 1 ? '' : 's'
  } that mentioned you.`;
}

// The round loop: run every invocation of a round in parallel, file what they
// produced, then run whatever they mentioned in the next round.
export class TurnRunner {
  constructor(private readonly options: TurnRunnerOptions) {}

  async run(
    initial: readonly Invocation[],
    beforeMutation: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    const { transcript, roster, directory, toolboxFor } = this.options;
    let pending = [...initial];
    let firstFailure: unknown;
    let hasFailure = false;

    // Several agents mentioning the same peer in one round are coalesced into
    // one invocation with all mentions in history. Participants remain free to
    // invoke one another again in later rounds for a back-and-forth exchange.
    while (pending.length > 0) {
      // Every participant in a round receives the same immutable snapshot and
      // starts before any response is awaited, preserving parallel execution.
      const history = [...transcript.history()];
      const round = transcript.openRound(pending.map(({ participant }) => ({
        role: 'assistant' as const,
        participant: participant.name,
        model: participant.model,
        content: [],
      })));

      const settled = await Promise.allSettled(pending.map(async ({ participant, mentionedBy }, index) => {
        const turnPrompt = mentionedBy.length > 0 ? delegationPrompt(mentionedBy) : undefined;
        const turn = participant.respond(history, {
          directory,
          toolbox: toolboxFor(participant, beforeMutation),
          ...(turnPrompt ? { turnPrompt } : {}),
        });
        for await (const snapshot of turn.changes()) {
          round.update(index, snapshot.content, snapshot.usage);
        }
        const response = await turn.result;
        return { ...response, participant: participant.name, model: participant.model };
      }));

      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        if (result.status === 'fulfilled') round.settle(index, result.value);
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
        for (const participant of roster.routeAgentMessage(result.value, source)) {
          const key = keyOf(participant.name);
          const invocation = next.get(key);
          if (invocation) {
            if (!invocation.mentionedBy.includes(source.name)) invocation.mentionedBy.push(source.name);
          } else {
            next.set(key, { participant, mentionedBy: [source.name] });
          }
        }
      }
      pending = [...next.values()];
    }

    if (hasFailure) throw firstFailure;
  }
}
