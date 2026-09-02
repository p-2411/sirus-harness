import crypto from 'crypto';
import { getResponse, modelStrategies } from '../agent/chat';
import type { Message } from '../data/data';
import { rootTextRanges } from '../mentions';
import { isAbortError, TurnCancelledError } from '../abort';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionContext,
  type PermissionMode,
} from '../agent/permissions';

export interface Participant {
  name: string;
  model: string;
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
}

interface Mention {
  name: string;
  model?: string;
  modelSpan?: { start: number; end: number };
}

interface Invocation {
  participant: Participant;
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
  private participants: Participant[] = [];
  private defaultModel: Participant;
  private name: string;
  private directory: string;
  private listeners: Set<() => void> = new Set();
  private version: number = 0;
  private assistantVersion: number = 0;
  private activeTurns: Set<AbortController> = new Set();
  private status: SessionStatus = 'idle';
  private turnFailed: boolean = false;
  private streamNotify: ReturnType<typeof setTimeout> | null = null;
  private lastStreamNotify = 0;
  private permissionMode: PermissionMode;

  constructor(
    name: string = 'Session 1',
    id: string = crypto.randomUUID(),
    model: string = DEFAULT_MODEL,
    messages: readonly Message[] = [],
    directory: string = process.cwd(),
    participants: readonly Participant[] = [],
    defaultParticipantName: string = DEFAULT_PARTICIPANT_NAME,
    permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
  ) {
    this.name = name;
    this.id = id;
    this.permissionMode = permissionMode;
    const restoredParticipants = participants.map(participant => ({ ...participant }));
    this.defaultModel = restoredParticipants.find(participant => sameName(participant.name, defaultParticipantName))
      ?? { name: defaultParticipantName, model };
    this.participants = restoredParticipants.length > 0
      ? restoredParticipants
      : [this.defaultModel];
    if (!this.participants.includes(this.defaultModel)) this.participants.unshift(this.defaultModel);
    this.messages = [...messages];
    this.directory = directory;
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
    this.participants.push({ name: normalizedName, model });
    this.notifyListeners();
  }

  async sendMessage(message: Message): Promise<Message[]> {
    if (message.role !== 'user') throw new Error('Only user messages can start a session turn');

    const controller = new AbortController();
    if (this.activeTurns.size === 0) this.turnFailed = false;
    this.activeTurns.add(controller);
    this.setStatus('working');
    try {
      const messageText = textOf(message);
      const mentions = this.parseMentions(messageText);
      const targets = mentions.length > 0
        ? this.resolveMentions(mentions)
        : [this.defaultModel];

      // A model following a newly introduced @name is host routing metadata,
      // not part of the conversation. Strip it before either the UI history or
      // any provider sees the turn.
      this.append(this.withoutCreationModels(message, mentions));
      await this.runInvocations(
        targets.map(participant => ({ participant, mentionedBy: [] })),
        controller.signal,
      );
      return this.messages;
    } catch (error) {
      if (!isAbortError(error)) this.turnFailed = true;
      throw error;
    } finally {
      this.activeTurns.delete(controller);
      this.setStatus(this.activeTurns.size > 0
        ? 'working'
        : this.turnFailed ? 'error' : 'idle');
    }
  }

  cancel(): boolean {
    if (this.activeTurns.size === 0) return false;
    for (const controller of this.activeTurns) {
      controller.abort(new TurnCancelledError());
    }
    return true;
  }

  clear(): void {
    if (this.messages.length === 0) return;
    this.messages = [];
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
    return { ...this.defaultModel };
  }

  getParticipants(): Participant[] {
    return this.participants.map(participant => ({ ...participant }));
  }

  getModel(): string {
    return this.defaultModel.model;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getAssistantVersion(): number {
    return this.assistantVersion;
  }

  setModel(model: string): void {
    this.changeParticipantModel(this.defaultModel.name, model);
  }

  getParticipantRuntimeIds(): string[] {
    return this.participants.map(participant => this.runtimeIdFor(participant));
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

  private findParticipant(name: string): Participant | undefined {
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

  private resolveMentions(mentions: readonly Mention[]): Participant[] {
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

  private async runInvocations(initial: readonly Invocation[], signal: AbortSignal): Promise<void> {
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
        const response = await getResponse(
          history,
          participant.model,
          this.runtimeIdFor(participant),
          this.directory,
          participant === this.defaultModel ? undefined : participant.name,
          turnPrompt,
          partial => {
            publishRound();
            liveMessages[index].content = partial.content;
            this.notifyStreaming();
          },
          false,
          signal,
          this.permissionContextFor(participant),
        );
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

  private existingMentions(message: Message): Participant[] {
    const participants: Participant[] = [];
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

  private permissionContextFor(participant: Participant): PermissionContext {
    return {
      sessionId: this.id,
      mode: () => this.permissionMode,
      requester: { participant: participant.name },
      model: participant.model,
    };
  }

  private runtimeIdFor(participant: Participant): string {
    return participant === this.defaultModel
      ? this.id
      : `${this.id}/participants/${encodeURIComponent(participant.name.toLocaleLowerCase())}`;
  }
}
