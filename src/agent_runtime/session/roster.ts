import { servableModelIds, servesModel } from '../providers';
import { SessionAgent, type Participant } from '../agent';
import type { Message, ThinkingLevel } from '../types';
import { rootTextRanges, type RootTextRange } from '../../mentions';
import type { ChangeFeed } from './changeFeed';
import { textOf } from './transcript';

export type { Participant };

// A participant named in a user prompt. New participants carry the model
// that introduces them and the span of prompt text that named it.
export interface Mention {
  name: string;
  model?: string;
  modelSpan?: { start: number; end: number };
}

export interface RosterOptions {
  sessionId: string;
  model: string;
  defaultParticipant: string;
  participants: readonly Participant[];
}

// The one @name grammar, shared by the mention scanner and by name
// validation so the character set exists in exactly one place.
const NAME_CHARS = 'A-Za-z0-9_-';
export const NAME_PATTERN_SOURCE = `[A-Za-z][${NAME_CHARS}]*`;
const NAME_PATTERN = new RegExp(`^${NAME_PATTERN_SOURCE}$`);
// The trailing guard leaves scoped package names such as @scope/package as
// ordinary prompt text rather than participant mentions.
const mentionPattern = new RegExp(`(?<![\\w@])@(${NAME_PATTERN_SOURCE})(?![A-Za-z0-9_\\/-])`, 'g');

interface MentionMatch {
  name: string;
  // The prose range the mention was found in, and where the mention ends
  // inside it, so a caller can read what follows without rescanning.
  range: RootTextRange;
  localEnd: number;
}

// Mentions route only from top-level prose: not from code spans, block
// quotes or anything else rootTextRanges excludes.
function* scanMentions(text: string): Generator<MentionMatch> {
  for (const range of rootTextRanges(text)) {
    for (const match of range.text.matchAll(mentionPattern)) {
      yield { name: match[1], range, localEnd: (match.index ?? 0) + match[0].length };
    }
  }
}

// Participants are the same participant whatever case they are written in.
export function keyOf(name: string): string {
  return name.toLocaleLowerCase();
}

// Callers name participants with or without the leading @.
function bareName(name: string): string {
  return name.replace(/^@/, '');
}

function requireKnownModel(model: string): void {
  if (!servesModel(model)) {
    throw new Error(`Unknown model "${model}". Try: ${servableModelIds().join(', ')}`);
  }
}

// A model following a newly introduced @name is host routing metadata, not
// part of the conversation. Strip it before either the UI history or any
// provider sees the turn.
export function stripCreationModels(message: Message, mentions: readonly Mention[]): Message {
  const spans = mentions
    .flatMap(mention => mention.modelSpan ? [mention.modelSpan] : [])
    .sort((left, right) => right.start - left.start);
  if (spans.length === 0) return message;

  const content = [...message.content];
  const textBlocks = content
    .map((block, contentIndex) => ({ block, contentIndex }))
    .filter((entry): entry is { block: Extract<Message['content'][number], { type: 'text' }>; contentIndex: number } =>
      entry.block.type === 'text');
  let globalStart = 0;
  const ranges = textBlocks.map(entry => {
    const range = {
      ...entry,
      start: globalStart,
      end: globalStart + entry.block.text.length,
    };
    // textOf joins text blocks with exactly one newline.
    globalStart = range.end + 1;
    return range;
  });

  for (const range of ranges) {
    const localSpans = spans.filter(span => span.start >= range.start && span.end <= range.end);
    if (localSpans.length === 0) continue;
    let text = range.block.text;
    for (const span of localSpans) {
      text = text.slice(0, span.start - range.start) + text.slice(span.end - range.start);
    }
    content[range.contentIndex] = { type: 'text', text };
  }
  return { ...message, content };
}

// The session's agents and all @name routing between them.
export class ParticipantRoster {
  private readonly sessionId: string;
  private readonly defaultName: string;
  private readonly agents: SessionAgent[];
  private readonly defaultAgent: SessionAgent;

  constructor(private readonly changes: ChangeFeed, options: RosterOptions) {
    this.sessionId = options.sessionId;
    this.defaultName = options.defaultParticipant;
    const restored = options.participants.map(participant => this.createAgent(participant));
    this.defaultAgent = restored.find(agent => keyOf(agent.name) === keyOf(this.defaultName))
      ?? this.createAgent({ name: this.defaultName, model: options.model });
    this.agents = restored.length > 0 ? restored : [this.defaultAgent];
    if (!this.agents.includes(this.defaultAgent)) this.agents.unshift(this.defaultAgent);
  }

  get default(): SessionAgent {
    return this.defaultAgent;
  }

  toParticipants(): Participant[] {
    return this.agents.map(agent => agent.toParticipant());
  }

  add(name: string, model: string): void {
    const normalizedName = bareName(name);
    if (!NAME_PATTERN.test(normalizedName)) {
      throw new Error(`Invalid participant name: @${normalizedName}`);
    }
    if (this.find(normalizedName)) {
      throw new Error(`Participant @${normalizedName} already exists`);
    }
    requireKnownModel(model);
    this.agents.push(this.createAgent({ name: normalizedName, model }));
    this.changes.notify();
  }

  changeModel(participantName: string, newModel: string): void {
    requireKnownModel(newModel);
    this.require(participantName).model = newModel;
    this.changes.notify();
  }

  thinkingLevel(participantName: string = this.defaultAgent.name): ThinkingLevel {
    return this.require(participantName).thinkingLevel;
  }

  setThinkingLevel(level: ThinkingLevel, participantName: string = this.defaultAgent.name): void {
    const participant = this.require(participantName);
    if (participant.thinkingLevel === level) return;
    participant.thinkingLevel = level;
    // Subscription transports keep provider-owned sessions whose thinking
    // options are fixed at creation. Recreate just this participant's runtime;
    // its complete shared history is replayed on the next turn.
    participant.resetRuntime();
    this.changes.notify();
  }

  // Reads the @names out of a user prompt without creating anything, so a
  // turn that names a participant badly leaves the session untouched.
  readMentions(text: string): Mention[] {
    const mentions: Mention[] = [];
    const seen = new Set<string>();
    for (const { name, range, localEnd } of scanMentions(text)) {
      const key = keyOf(name);
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = this.find(name);
      if (existing) {
        mentions.push({ name: existing.name });
        continue;
      }

      const modelMatch = /^([ \t]+)([^\s,;]+)/.exec(range.text.slice(localEnd));
      if (!modelMatch || !servesModel(modelMatch[2])) {
        throw new Error(
          `New participant @${name} requires a model. Try: @${name} ${servableModelIds().join('|')} your prompt`,
        );
      }
      const modelStart = range.start + localEnd;
      mentions.push({
        name,
        model: modelMatch[2],
        modelSpan: { start: modelStart, end: modelStart + modelMatch[0].length },
      });
    }
    return mentions;
  }

  // Creates whatever participants the prompt introduced and returns the
  // round's targets in mention order. An unmentioned turn goes to the default.
  resolveMentions(mentions: readonly Mention[]): SessionAgent[] {
    if (mentions.length === 0) return [this.defaultAgent];
    // Validate the complete turn first, then mutate the participant list.
    // This avoids partially creating agents when a later mention is bad.
    for (const mention of mentions) {
      if (!this.find(mention.name) && !mention.model) {
        throw new Error(`Model not specified for new participant @${mention.name}`);
      }
    }
    for (const mention of mentions) {
      if (!this.find(mention.name)) this.add(mention.name, mention.model!);
    }
    return mentions.map(mention => this.find(mention.name)!);
  }

  // Who an agent's own response hands off to. Agents cannot introduce
  // participants, and cannot recursively launch themselves by including
  // their own name in a response.
  routeAgentMessage(message: Message, speaker: SessionAgent): SessionAgent[] {
    const mentioned: SessionAgent[] = [];
    const seen = new Set<string>();
    for (const { name } of scanMentions(textOf(message))) {
      const participant = this.find(name);
      if (!participant || participant === speaker) continue;
      const key = keyOf(participant.name);
      if (seen.has(key)) continue;
      seen.add(key);
      mentioned.push(participant);
    }
    return mentioned;
  }

  activeSubagentCount(): number {
    return this.agents.reduce((count, agent) =>
      count + agent.listSubagents().filter(run => run.status === 'working').length, 0);
  }

  hasWorkingSubagents(): boolean {
    return this.agents.some(agent => agent.listSubagents().some(run => run.status === 'working'));
  }

  // Stops every turn and subagent of every participant, including detached
  // workers. True if there was one.
  cancel(): boolean {
    let cancelled = false;
    for (const agent of this.agents) {
      if (agent.cancel()) cancelled = true;
      if (agent.cancelSubagents() > 0) cancelled = true;
    }
    return cancelled;
  }

  // Drops what every provider keeps between turns: a provider-side
  // conversation must not outlive the history it mirrors.
  resetRuntimes(): void {
    for (const agent of this.agents) agent.resetRuntime();
  }

  private find(name: string): SessionAgent | undefined {
    const key = keyOf(bareName(name));
    return this.agents.find(agent => keyOf(agent.name) === key);
  }

  private require(name: string): SessionAgent {
    const participant = this.find(name);
    if (!participant) throw new Error(`Participant ${name} not found`);
    return participant;
  }

  // The session's default agent keeps the session id as its runtime id, so
  // a provider session created before multi-agent support carries on.
  private createAgent(participant: Participant): SessionAgent {
    const isDefault = keyOf(participant.name) === keyOf(this.defaultName);
    return new SessionAgent({
      ...participant,
      runtimeId: isDefault
        ? this.sessionId
        : `${this.sessionId}/participants/${encodeURIComponent(keyOf(participant.name))}`,
    });
  }
}
