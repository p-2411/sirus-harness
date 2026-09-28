import { requireKnownModel, servesModel, servableModelIds } from '../providers';
import { modelNamed } from '../providers/catalog';
import { SessionAgent, type Participant, type RuntimeHost } from '../agent';
import { parseThinkingLevel, textOf, type Message, type PermissionMode, type ThinkingLevel } from '../types';
import { rootTextRanges, type RootTextRange } from '../../mentions';
import type { SubagentRun } from '../tools/subagents';
import type { ChangeFeed } from './changeFeed';
import type { Transcript } from './transcript';

// A participant named in a prompt, and where the name is. A model written
// after the name, any thinking level after it, and the span of that text
// configure the participant: they create a new one, or switch an existing one
// when the user wrote them.
export interface Mention {
  name: string;
  span: { start: number; end: number };
  // The mention adds the participant to the session.
  introduces: boolean;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  modelSpan?: { start: number; end: number };
}

export interface RosterOptions {
  sessionId: string;
  model: string;
  defaultParticipant: string;
  participants: readonly Participant[];
  host: RuntimeHost;
  // The level a participant new to the session starts at: the user's
  // default from /config. Restored participants keep their own.
  thinkingLevel?: ThinkingLevel;
}

// The one @name grammar, shared by the mention scanner and by name
// validation so the character set exists in exactly one place.
const NAME_CHARS = 'A-Za-z0-9_-';
export const NAME_PATTERN_SOURCE = `[A-Za-z][${NAME_CHARS}]*`;
const NAME_PATTERN = new RegExp(`^${NAME_PATTERN_SOURCE}$`);
// The trailing guard leaves scoped package names such as @scope/package as
// ordinary prompt text rather than participant mentions.
export const mentionPattern = new RegExp(`(?<![\\w@])@(${NAME_PATTERN_SOURCE})(?![A-Za-z0-9_\\/-])`, 'g');

// `/model subagent <model>` addresses the session's subagents, so no
// participant may take the name.
const RESERVED_NAMES = new Set(['subagent']);

interface MentionMatch {
  name: string;
  start: number;
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
      const index = match.index ?? 0;
      yield { name: match[1], start: range.start + index, range, localEnd: index + match[0].length };
    }
  }
}

// The model written straight after a name, as `/model` would take it
// (`opus` for `opus[1m]`) and no looser, since this is prose, and a thinking
// level the new participant starts at after it: `@reviewer opus high`.
function configurationAfter({ range, localEnd }: MentionMatch): Pick<Mention, 'model' | 'thinkingLevel' | 'modelSpan'> | undefined {
  const word = /^[ \t]+([^\s,;]+)/;
  const after = range.text.slice(localEnd);
  const modelMatch = word.exec(after);
  const model = modelMatch ? modelNamed(modelMatch[1], servableModelIds()) : undefined;
  if (!modelMatch || !model) return undefined;
  const levelMatch = word.exec(after.slice(modelMatch[0].length));
  const thinkingLevel = parseThinkingLevel(levelMatch?.[1]);
  const start = range.start + localEnd;
  const end = start + modelMatch[0].length + (thinkingLevel && levelMatch ? levelMatch[0].length : 0);
  return { model, ...(thinkingLevel ? { thinkingLevel } : {}), modelSpan: { start, end } };
}

// Participants are the same participant whatever case they are written in.
export function keyOf(name: string): string {
  return name.toLocaleLowerCase();
}

// Callers name participants with or without the leading @.
function bareName(name: string): string {
  return name.replace(/^@/, '');
}

function requireParticipantName(name: string): void {
  if (!NAME_PATTERN.test(name) || RESERVED_NAMES.has(keyOf(name))) {
    throw new Error(`Invalid participant name: @${name}`);
  }
}

// The session's agents and all @name routing between them.
export class ParticipantRoster {
  private readonly sessionId: string;
  private readonly defaultName: string;
  private readonly host: RuntimeHost;
  private readonly agents: SessionAgent[];
  private readonly defaultAgent: SessionAgent;
  private readonly newLevel?: ThinkingLevel;

  constructor(private readonly changes: ChangeFeed, options: RosterOptions) {
    this.sessionId = options.sessionId;
    this.defaultName = options.defaultParticipant;
    this.host = options.host;
    this.newLevel = options.thinkingLevel;
    const restored = options.participants.map(participant => this.createAgent(participant));
    this.defaultAgent = restored.find(agent => keyOf(agent.name) === keyOf(this.defaultName))
      ?? this.createAgent({ name: this.defaultName, model: options.model, ...(this.newLevel ? { thinkingLevel: this.newLevel } : {}) });
    this.agents = restored.length > 0 ? restored : [this.defaultAgent];
    if (!this.agents.includes(this.defaultAgent)) this.agents.unshift(this.defaultAgent);
  }

  get default(): SessionAgent {
    return this.defaultAgent;
  }

  all(): readonly SessionAgent[] {
    return this.agents;
  }

  *transcripts(): Iterable<Transcript> {
    for (const agent of this.agents) yield agent.transcript;
  }

  toParticipants(): Participant[] {
    return this.agents.map(agent => agent.toParticipant());
  }

  add(name: string, model: string, level: ThinkingLevel | undefined = this.newLevel): void {
    const normalizedName = bareName(name);
    requireParticipantName(normalizedName);
    if (this.find(normalizedName)) {
      throw new Error(`Participant @${normalizedName} already exists`);
    }
    requireKnownModel(model);
    this.agents.push(this.createAgent({ name: normalizedName, model, ...(level ? { thinkingLevel: level } : {}) }));
    this.changes.notify();
  }

  changeModel(participantName: string, newModel: string): void {
    requireKnownModel(newModel);
    this.require(participantName).setModel(newModel);
    this.changes.notify();
  }

  thinkingLevel(participantName: string = this.defaultAgent.name): ThinkingLevel | undefined {
    return this.require(participantName).thinkingLevel;
  }

  setThinkingLevel(level: ThinkingLevel | undefined, participantName: string = this.defaultAgent.name): void {
    const participant = this.require(participantName);
    if (participant.thinkingLevel === level) return;
    participant.thinkingLevel = level;
    this.changes.notify();
  }

  // Applies to every live runtime now, the working workers' included; a
  // runtime started later starts in the session's mode anyway.
  setPermissionMode(mode: PermissionMode): void {
    for (const agent of this.agents) agent.setPermissionMode(mode);
    for (const run of this.workers()) {
      if (run.status === 'working') run.worker?.setPermissionMode(mode);
    }
  }

  // Reads known @names and explicit @name model introductions, in the order
  // written, wherever they are in the prompt's prose, with any model and
  // thinking level written after a known name. Other @words are ordinary
  // prose and leave the participant list alone.
  readMentions(text: string): Mention[] {
    const mentions: Mention[] = [];
    const seen = new Set<string>();
    for (const match of scanMentions(text)) {
      const key = keyOf(match.name);
      if (seen.has(key)) continue;
      const existing = this.find(match.name);
      const configuration = configurationAfter(match);
      if (!existing && !configuration) continue;
      seen.add(key);
      mentions.push({
        name: existing?.name ?? match.name,
        span: { start: match.start, end: match.range.start + match.localEnd },
        introduces: !existing,
        ...configuration,
      });
    }
    return mentions;
  }

  // Creates whatever participants the prompt introduced, switches the model
  // and thinking level of existing ones it configured, and returns the round's
  // targets in mention order. An unmentioned turn goes to the default.
  resolveMentions(mentions: readonly Mention[]): SessionAgent[] {
    if (mentions.length === 0) return [this.defaultAgent];
    // Validate the complete turn first, then mutate the participant list.
    // This avoids partially creating agents when a later mention is bad.
    for (const mention of mentions) {
      const existing = this.find(mention.name);
      if (!existing) {
        requireParticipantName(mention.name);
        if (!mention.model) throw new Error(`Model not specified for new participant @${mention.name}`);
      } else if (mention.model && existing.busy) {
        throw new Error(`Wait for @${existing.name} to finish before switching its model.`);
      }
      if (mention.model) requireKnownModel(mention.model);
    }
    for (const mention of mentions) {
      const existing = this.find(mention.name);
      if (!existing) this.add(mention.name, mention.model!, mention.thinkingLevel);
      else if (mention.model) {
        this.changeModel(existing.name, mention.model);
        if (mention.thinkingLevel) this.setThinkingLevel(mention.thinkingLevel, existing.name);
      }
    }
    return mentions.map(mention => this.find(mention.name)!);
  }

  // Agent replies use the same introduction syntax as user messages, but
  // never invoke the speaker, fall back to the default agent, or switch an
  // existing participant's model.
  routeAgentMessage(message: Message, speaker: SessionAgent): { recipients: SessionAgent[]; introduced: Mention[] } {
    const mentions = this.readMentions(textOf(message))
      .filter(mention => keyOf(mention.name) !== keyOf(speaker.name))
      .map(mention => mention.introduces ? mention : { name: mention.name, span: mention.span, introduces: false });
    return {
      recipients: mentions.length > 0 ? this.resolveMentions(mentions) : [],
      introduced: mentions.filter(mention => mention.introduces),
    };
  }

  // Every working worker, and every spawn still setting one up.
  activeSubagentCount(): number {
    return this.agents.reduce((count, agent) => count + agent.spawningSubagents
      + agent.listSubagents().filter(run => run.status === 'working').length, 0);
  }

  hasWorkingSubagents(): boolean {
    return this.activeSubagentCount() > 0;
  }

  // Resolves once no agent is still setting up a worker.
  async spawnsSettled(): Promise<void> {
    await Promise.all(this.agents.map(agent => agent.spawnsSettled()));
  }

  // Stops every turn in flight. Workers are background tasks of the session
  // and keep running: they stop through the /agents panel, CancelAgent, or
  // the session being deleted. True if there was a turn to stop.
  cancel(): boolean {
    let cancelled = false;
    for (const agent of this.agents) {
      if (agent.cancel()) cancelled = true;
    }
    return cancelled;
  }

  // Every worker of this session, oldest first, records restored from the
  // session file included.
  workers(): SubagentRun[] {
    return this.agents
      .flatMap(agent => agent.listSubagents())
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  // Drops every vendor runtime: a runtime's conversation must not outlive
  // the record it mirrors.
  resetRuntimes(): void {
    for (const agent of this.agents) agent.resetRuntime();
  }

  find(name: string): SessionAgent | undefined {
    const key = keyOf(bareName(name));
    return this.agents.find(agent => keyOf(agent.name) === key);
  }

  require(name: string): SessionAgent {
    const participant = this.find(name);
    if (!participant) throw new Error(`Participant ${name} not found`);
    return participant;
  }

  // The session's default agent keeps the session id as its runtime id, so
  // the sidebar row it had before multi-agent support carries on.
  private createAgent(participant: Participant): SessionAgent {
    const isDefault = keyOf(participant.name) === keyOf(this.defaultName);
    return new SessionAgent({
      ...participant,
      host: this.host,
      runtimeId: isDefault
        ? this.sessionId
        : `${this.sessionId}/participants/${encodeURIComponent(keyOf(participant.name))}`,
    });
  }
}
