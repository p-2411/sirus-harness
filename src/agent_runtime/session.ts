import crypto from 'crypto';
import { modelStrategies } from './chat';
import { SessionAgent, type Participant } from './agent';
import type { Message, ThinkingLevel } from './types';
import { rootTextRanges } from '../mentions';
import { isAbortError } from '../abort';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionContext,
  type PermissionMode,
} from './permissions/permissions';
import {
  captureCheckpoint,
  checkpointSummary,
  restoreCheckpoint,
  type Checkpoint,
  type RestoredFiles,
} from '../checkpoints';

export type { Participant };
export type { Checkpoint };

// What a rewind is asked to put back.
export interface RewindOptions {
  files: boolean;
  chat: boolean;
}

export interface RewindResult {
  checkpoint: Checkpoint;
  // Null when files were not restored.
  files: RestoredFiles | null;
  // How many messages the chat lost; zero when the chat was kept.
  droppedMessages: number;
}

export type SessionStatus = 'idle' | 'working' | 'error';

export interface SessionSnapshot {
  id: string;
  name: string;
  directory: string;
  participants: Participant[];
  defaultModel: Participant;
  messages: Message[];
  // How tool calls are approved in this session; absent in older snapshots.
  permissionMode?: PermissionMode;
  // Directory snapshots taken before turns, oldest first; absent when none.
  checkpoints?: Checkpoint[];
}

interface Mention {
  name: string;
  model?: string;
  modelSpan?: { start: number; end: number };
}

interface Invocation {
  participant: SessionAgent;
  mentionedBy: string[];
}

interface LegacySessionSnapshot {
  id: string;
  name: string;
  directory: string;
  model: string;
  messages: Message[];
}

const DEFAULT_PARTICIPANT_NAME = 'sirus';
export const DEFAULT_MODEL = 'gpt-5.6-luna';
// The trailing guard leaves scoped package names such as @scope/package as
// ordinary prompt text rather than treating them as participant mentions.
const mentionPattern = /(?<![\w@])@([A-Za-z][A-Za-z0-9_-]*)(?![A-Za-z0-9_\/-])/g;

function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function textOf(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

// A provider publishes a partial for every streamed chunk and each one
// re-renders the transcript, so partials reach listeners at most this often
// (the first one immediately) to keep the event loop free for input.
const STREAM_NOTIFY_MS = 50;

export class Session {
  private id: string;
  private messages: Message[] = [];
  private participants: SessionAgent[] = [];
  private defaultAgent: SessionAgent;
  private name: string;
  private directory: string;
  private listeners: Set<() => void> = new Set();
  private version: number = 0;
  private assistantVersion: number = 0;
  private activeSends = 0;
  private status: SessionStatus = 'idle';
  private turnFailed: boolean = false;
  private streamNotify: ReturnType<typeof setTimeout> | null = null;
  private lastStreamNotify = 0;
  private permissionMode: PermissionMode;
  private checkpoints: Checkpoint[];

  constructor(
    name: string = 'Session 1',
    id: string = crypto.randomUUID(),
    model: string = DEFAULT_MODEL,
    messages: readonly Message[] = [],
    directory: string = process.cwd(),
    participants: readonly Participant[] = [],
    defaultParticipantName: string = DEFAULT_PARTICIPANT_NAME,
    permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
    checkpoints: readonly Checkpoint[] = [],
  ) {
    this.name = name;
    this.id = id;
    this.directory = directory;
    this.permissionMode = permissionMode;
    this.checkpoints = [...checkpoints];
    const restored = participants.map(participant => this.createAgent(participant, defaultParticipantName));
    this.defaultAgent = restored.find(agent => sameName(agent.name, defaultParticipantName))
      ?? this.createAgent({ name: defaultParticipantName, model }, defaultParticipantName);
    this.participants = restored.length > 0 ? restored : [this.defaultAgent];
    if (!this.participants.includes(this.defaultAgent)) this.participants.unshift(this.defaultAgent);
    this.messages = [...messages];
  }

  static create(
    name: string = 'Session 1',
    directory: string = process.cwd(),
    model: string = DEFAULT_MODEL,
  ): Session {
    return new Session(name, undefined, model, undefined, directory);
  }

  static fromSnapshot(snapshot: SessionSnapshot | LegacySessionSnapshot): Session {
    if ('participants' in snapshot) {
      return new Session(
        snapshot.name,
        snapshot.id,
        snapshot.defaultModel.model,
        snapshot.messages,
        snapshot.directory,
        snapshot.participants,
        snapshot.defaultModel.name,
        snapshot.permissionMode ?? DEFAULT_PERMISSION_MODE,
        snapshot.checkpoints ?? [],
      );
    }
    return new Session(snapshot.name, snapshot.id, snapshot.model, snapshot.messages, snapshot.directory);
  }

  append(message: Message) {
    this.messages.push(message);
    this.notifyListeners();
  }

  addParticipant(name: string, model: string): void {
    const normalizedName = name.replace(/^@/, '');
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(normalizedName)) {
      throw new Error(`Invalid participant name: @${normalizedName}`);
    }
    if (this.findParticipant(normalizedName)) {
      throw new Error(`Participant @${normalizedName} already exists`);
    }
    if (!modelStrategies[model]) {
      throw new Error(`Unknown model "${model}". Try: ${Object.keys(modelStrategies).join(', ')}`);
    }
    this.participants.push(this.createAgent({ name: normalizedName, model }, this.defaultAgent.name));
    this.notifyListeners();
  }

  async sendMessage(message: Message): Promise<Message[]> {
    if (message.role !== 'user') throw new Error('Only user messages can start a session turn');

    if (this.activeSends === 0) this.turnFailed = false;
    this.activeSends++;
    this.setStatus('working');
    try {
      const messageText = textOf(message);
      const mentions = this.parseMentions(messageText);
      const targets = mentions.length > 0
        ? this.resolveMentions(mentions)
        : [this.defaultAgent];

      // A model following a newly introduced @name is host routing metadata,
      // not part of the conversation. Strip it before either the UI history or
      // any provider sees the turn.
      this.append(this.withoutCreationModels(message, mentions));
      // The directory as it stands before any agent touches it, so the turn
      // can be undone. The message is already on screen while git works.
      await this.checkpoint(this.messages.length - 1, messageText || '[image]');
      await this.runInvocations(targets.map(participant => ({ participant, mentionedBy: [] })));
      return this.messages;
    } catch (error) {
      if (!isAbortError(error)) this.turnFailed = true;
      throw error;
    } finally {
      this.activeSends--;
      this.setStatus(this.activeSends > 0
        ? 'working'
        : this.turnFailed ? 'error' : 'idle');
    }
  }

  // Stops every participant's running turn. True if any was running.
  cancel(): boolean {
    let cancelled = false;
    for (const agent of this.participants) {
      if (agent.cancel()) cancelled = true;
    }
    return cancelled;
  }

  // A provider-side conversation must not outlive the history it mirrors.
  // Checkpoints go with it: they point into the history that was cleared.
  clear(): void {
    if (this.messages.length === 0) return;
    this.messages = [];
    this.checkpoints = [];
    for (const agent of this.participants) agent.resetRuntime();
    this.notifyListeners();
  }

  getCheckpoints(): Checkpoint[] {
    return [...this.checkpoints];
  }

  // Puts the directory, the chat, or both back to a checkpoint. Restoring
  // the chat drops that checkpoint and every later one, since the messages
  // they belong to are gone; restoring only files keeps them all.
  async rewind(checkpointId: string, options: RewindOptions): Promise<RewindResult> {
    if (!options.files && !options.chat) throw new Error('Nothing to restore: choose files, chat, or both.');
    if (this.activeSends > 0) throw new Error('Wait for the current turn to finish before rewinding.');
    const index = this.checkpoints.findIndex(candidate => candidate.id === checkpointId);
    if (index === -1) throw new Error('That checkpoint no longer exists in this session.');
    const checkpoint = this.checkpoints[index];

    const files = options.files ? await restoreCheckpoint(this.directory, checkpoint.id) : null;
    let droppedMessages = 0;
    if (options.chat) {
      droppedMessages = Math.max(0, this.messages.length - checkpoint.messageIndex);
      this.messages = this.messages.slice(0, checkpoint.messageIndex);
      this.checkpoints = this.checkpoints.slice(0, index);
      for (const agent of this.participants) agent.resetRuntime();
    }
    this.notifyListeners();
    return { checkpoint, files, droppedMessages };
  }

  private async checkpoint(messageIndex: number, text: string): Promise<void> {
    const captured = await captureCheckpoint(this.directory, checkpointSummary(text));
    if (!captured) return;
    this.checkpoints.push({ ...captured, messageIndex, summary: checkpointSummary(text) });
    this.notifyListeners();
  }

  getMessages(): Message[] {
    return this.messages;
  }

  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getDirectory(): string {
    return this.directory;
  }

  getDefaultParticipant(): Participant {
    return this.defaultAgent.toParticipant();
  }

  getParticipants(): Participant[] {
    return this.participants.map(agent => agent.toParticipant());
  }

  getModel(): string {
    return this.defaultAgent.model;
  }

  getThinkingLevel(participantName: string = this.defaultAgent.name): ThinkingLevel {
    const participant = this.findParticipant(participantName.replace(/^@/, ''));
    if (!participant) throw new Error(`Participant ${participantName} not found`);
    return participant.thinkingLevel;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getAssistantVersion(): number {
    return this.assistantVersion;
  }

  setModel(model: string): void {
    this.changeParticipantModel(this.defaultAgent.name, model);
  }

  setThinkingLevel(level: ThinkingLevel, participantName: string = this.defaultAgent.name): void {
    const participant = this.findParticipant(participantName.replace(/^@/, ''));
    if (!participant) throw new Error(`Participant ${participantName} not found`);
    if (this.getThinkingLevel(participant.name) === level) return;
    participant.thinkingLevel = level;
    // Subscription transports keep provider-owned sessions whose thinking
    // options are fixed at creation. Recreate just this participant's runtime;
    // its complete shared history is replayed on the next turn.
    participant.resetRuntime();
    this.notifyListeners();
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  // Applies to the next tool call of every participant and of any subagent
  // the session has spawned; the gate reads the mode live.
  setPermissionMode(mode: PermissionMode): void {
    if (this.permissionMode === mode) return;
    this.permissionMode = mode;
    this.notifyListeners();
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      name: this.name,
      directory: this.directory,
      participants: this.getParticipants(),
      defaultModel: this.getDefaultParticipant(),
      messages: [...this.messages],
      permissionMode: this.permissionMode,
      ...(this.checkpoints.length > 0 ? { checkpoints: [...this.checkpoints] } : {}),
    };
  }

  changeParticipantModel(participantName: string, newModel: string): void {
    if (!modelStrategies[newModel]) {
      throw new Error(`Unknown model "${newModel}". Try: ${Object.keys(modelStrategies).join(', ')}`);
    }
    const participant = this.findParticipant(participantName.replace(/^@/, ''));
    if (participant) {
      participant.model = newModel;
    } else {
      throw new Error(`Participant ${participantName} not found`);
    }
    this.notifyListeners();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // monotonic mutation counter — a cheap referentially-stable snapshot for
  // useSyncExternalStore, since messages is mutated in place
  getVersion(): number {
    return this.version;
  }

  private notifyListeners(): void {
    if (this.streamNotify) {
      clearTimeout(this.streamNotify);
      this.streamNotify = null;
    }
    this.lastStreamNotify = Date.now();
    this.version++;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.notifyListeners();
  }

  private notifyAssistantActivity(): void {
    this.assistantVersion++;
    this.notifyListeners();
  }

  private notifyStreaming(): void {
    if (this.streamNotify) return;
    const wait = STREAM_NOTIFY_MS - (Date.now() - this.lastStreamNotify);
    if (wait <= 0) {
      this.notifyAssistantActivity();
      return;
    }
    this.streamNotify = setTimeout(() => {
      this.streamNotify = null;
      this.notifyAssistantActivity();
    }, wait);
    this.streamNotify.unref?.();
  }

  private findParticipant(name: string): SessionAgent | undefined {
    return this.participants.find(participant => sameName(participant.name, name));
  }

  private parseMentions(text: string): Mention[] {
    const mentions: Mention[] = [];
    const seen = new Set<string>();
    for (const range of rootTextRanges(text)) {
      for (const match of range.text.matchAll(mentionPattern)) {
        const name = match[1];
        const key = name.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const existing = this.findParticipant(name);
        if (existing) {
          mentions.push({ name: existing.name });
          continue;
        }

        const localMentionEnd = (match.index ?? 0) + match[0].length;
        const remainder = range.text.slice(localMentionEnd);
        const modelMatch = /^([ \t]+)([^\s,;]+)/.exec(remainder);
        const model = modelMatch?.[2];
        if (!model || !modelStrategies[model]) {
          throw new Error(
            `New participant @${name} requires a model. Try: @${name} ${Object.keys(modelStrategies).join('|')} your prompt`,
          );
        }
        const modelStart = range.start + localMentionEnd;
        mentions.push({
          name,
          model,
          modelSpan: { start: modelStart, end: modelStart + modelMatch![0].length },
        });
      }
    }
    return mentions;
  }

  private resolveMentions(mentions: readonly Mention[]): SessionAgent[] {
    // Parse and validate the complete turn first, then mutate the participant
    // list. This avoids partially creating agents when a later mention is bad.
    for (const mention of mentions) {
      if (!this.findParticipant(mention.name) && !mention.model) {
        throw new Error(`Model not specified for new participant @${mention.name}`);
      }
    }
    for (const mention of mentions) {
      if (!this.findParticipant(mention.name)) this.addParticipant(mention.name, mention.model!);
    }
    return mentions.map(mention => this.findParticipant(mention.name)!);
  }

  private withoutCreationModels(message: Message, mentions: readonly Mention[]): Message {
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

  private async runInvocations(initial: readonly Invocation[]): Promise<void> {
    let pending = [...initial];
    let firstFailure: unknown;
    let hasFailure = false;

    // Several agents mentioning the same peer in one round are coalesced into
    // one invocation with all mentions in history. Participants remain free to
    // invoke one another again in later rounds for a back-and-forth exchange.
    while (pending.length > 0) {
      // Every participant in a round receives the same immutable snapshot and
      // starts before any response is awaited, preserving parallel execution.
      const history = [...this.messages];
      const liveMessages: Message[] = pending.map(({ participant }) => ({
        role: 'assistant' as const,
        participant: participant.name,
        model: participant.model,
        content: [],
      }));
      let roundPublished = false;
      const publishRound = () => {
        if (roundPublished) return;
        roundPublished = true;
        this.messages.push(...liveMessages);
        this.notifyAssistantActivity();
      };
      const settled = await Promise.allSettled(pending.map(async (invocation, index) => {
        const { participant, mentionedBy } = invocation;
        const turnPrompt = mentionedBy.length > 0
          ? this.delegationPrompt(mentionedBy)
          : undefined;
        const turn = participant.respond(history, {
          directory: this.directory,
          permissions: this.permissionContextFor(participant),
          ...(turnPrompt ? { turnPrompt } : {}),
        });
        for await (const snapshot of turn.changes()) {
          publishRound();
          liveMessages[index].content = snapshot.content;
          this.notifyStreaming();
        }
        const response = await turn.result;
        return { ...response, participant: participant.name, model: participant.model };
      }));

      if (!roundPublished) {
        for (let index = 0; index < settled.length; index++) {
          const result = settled[index];
          if (result.status === 'fulfilled') this.messages.push(result.value);
        }
        if (settled.some(result => result.status === 'fulfilled')) this.notifyAssistantActivity();
      } else {
        let changed = false;
        for (let index = settled.length - 1; index >= 0; index--) {
          const result = settled[index];
          if (result.status === 'fulfilled') {
            liveMessages[index].content = result.value.content;
          } else {
            const messageIndex = this.messages.indexOf(liveMessages[index]);
            if (messageIndex !== -1) this.messages.splice(messageIndex, 1);
          }
          changed = true;
        }
        if (changed) this.notifyAssistantActivity();
      }

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
        for (const participant of this.existingMentions(result.value)) {
          // Mentions are for other participants; an agent cannot recursively
          // launch itself by including its own name in a response.
          if (sameName(participant.name, source.name)) continue;
          const key = participant.name.toLocaleLowerCase();
          const invocation = next.get(key);
          if (invocation) {
            if (!invocation.mentionedBy.some(name => sameName(name, source.name))) {
              invocation.mentionedBy.push(source.name);
            }
          } else {
            next.set(key, { participant, mentionedBy: [source.name] });
          }
        }
      }
      pending = [...next.values()];
    }

    if (hasFailure) throw firstFailure;
  }

  private existingMentions(message: Message): SessionAgent[] {
    const participants: SessionAgent[] = [];
    const seen = new Set<string>();
    for (const range of rootTextRanges(textOf(message))) {
      for (const match of range.text.matchAll(mentionPattern)) {
        const participant = this.findParticipant(match[1]);
        if (!participant) continue; // agents cannot introduce participants
        const key = participant.name.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        participants.push(participant);
      }
    }
    return participants;
  }

  private delegationPrompt(mentionedBy: readonly string[]): string {
    const sources = mentionedBy.map(name => `@${name}`).join(' and ');
    return `${sources} mentioned you in the shared session. Respond to the message${
      mentionedBy.length === 1 ? '' : 's'
    } that mentioned you.`;
  }

  // The session's default agent keeps the session id as its runtime id, so
  // a provider session created before multi-agent support carries on.
  private createAgent(participant: Participant, defaultName: string): SessionAgent {
    const isDefault = sameName(participant.name, defaultName);
    return new SessionAgent({
      ...participant,
      runtimeId: isDefault
        ? this.id
        : `${this.id}/participants/${encodeURIComponent(participant.name.toLocaleLowerCase())}`,
    });
  }

  private permissionContextFor(agent: SessionAgent): PermissionContext {
    return {
      sessionId: this.id,
      mode: () => this.permissionMode,
      requester: { participant: agent.name },
      model: agent.model,
    };
  }
}
