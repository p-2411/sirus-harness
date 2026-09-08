import crypto from 'crypto';
import type { SessionAgent } from '../agent';
import { isMemoryAccessEnabled } from '../memory-access';
import { DEFAULT_PERMISSION_MODE, type PermissionContext, type PermissionMode } from '../permissions/policy';
import { DEFAULT_MODEL } from '../providers/catalog';
import type { SubagentHost } from '../tools';
import { createToolbox, type Toolbox } from '../tools/toolbox';
import type { Message, ThinkingLevel } from '../types';
import type { ContextUsage } from '../usage';
import { parseFileMentions, resolveFileMentions } from '../../fileMentions';
import { isAbortError } from '../../abort';
import { ChangeFeed } from './changeFeed';
import {
  CheckpointLog,
  defaultDirectoryActivity,
  type Checkpoint,
  type DirectoryActivity,
  type RewindOptions,
  type RewindResult,
} from './checkpointLog';
import { MessageQueue, isAutoSendable, type QueuedMessage } from './messageQueue';
import { NAME_PATTERN_SOURCE, ParticipantRoster, stripCreationModels, type Participant } from './roster';
import { Transcript, textOf, type TokenTotals } from './transcript';
import { TurnRunner } from './turnRunner';

// The default model is a catalog fact, named here because that is where
// callers have always found it.
export { DEFAULT_MODEL, NAME_PATTERN_SOURCE, defaultDirectoryActivity, isAutoSendable };
export type {
  Checkpoint,
  DirectoryActivity,
  Participant,
  QueuedMessage,
  RewindOptions,
  RewindResult,
  TokenTotals,
};

export type SessionStatus = 'idle' | 'working' | 'error';

// What the constructor takes and what a snapshot holds: the session's input
// shapes, and the one function that fills in every default.

export const SESSION_NAME_LIMIT = 40;

const DEFAULT_SESSION_NAME = 'Session 1';
const DEFAULT_PARTICIPANT_NAME = 'sirus';

// The first nonblank line of the prompt, cut at a word boundary when it runs
// long. Later lines are context, not part of the sidebar label.
export function sessionNameFromPrompt(text: string): string {
  const firstLine = text.split(/\r\n?|\n/).find(line => line.trim().length > 0) ?? '';
  const line = firstLine.replace(/[ \t]+/g, ' ').trim();
  if (line.length <= SESSION_NAME_LIMIT) return line;
  const cut = line.slice(0, SESSION_NAME_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > SESSION_NAME_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The clocks a restored session brings with it. All absent for a new one.
export interface SessionTiming {
  updatedAt?: number;
  conversationStartedAt?: number;
  lastResponseFinishedAt?: number | null;
}

export interface SessionOptions {
  id?: string;
  name?: string;
  directory?: string;
  // The default participant's model. Ignored when the participant list
  // already contains the default participant.
  model?: string;
  defaultParticipant?: string;
  participants?: readonly Participant[];
  messages?: readonly Message[];
  checkpoints?: readonly Checkpoint[];
  permissionMode?: PermissionMode;
  inputContent?: string;
  // A newly-created session may still take its name from its first prompt.
  autoNamePending?: boolean;
  timing?: SessionTiming;
}

export interface SessionSnapshot {
  id: string;
  name: string;
  directory: string;
  participants: Participant[];
  defaultModel: Participant;
  messages: Message[];
  // Absent in snapshots saved before session drafts were supported.
  inputContent?: string;
  // How tool calls are approved in this session; absent in older snapshots.
  permissionMode?: PermissionMode;
  // Directory snapshots taken before turns, oldest first; absent when none.
  checkpoints?: Checkpoint[];
  // When the history last changed; absent in older snapshots.
  updatedAt?: number;
  conversationStartedAt?: number;
  lastResponseFinishedAt?: number | null;
  // A newly-created session may still take its name from its first prompt.
  autoNamePending?: boolean;
}

interface ResolvedSessionOptions {
  id: string;
  name: string;
  directory: string;
  model: string;
  defaultParticipant: string;
  participants: readonly Participant[];
  messages: readonly Message[];
  checkpoints: readonly Checkpoint[];
  permissionMode: PermissionMode;
  inputContent: string;
  autoNamePending: boolean;
  updatedAt: number;
  conversationStartedAt: number;
  lastResponseFinishedAt: number | null;
}

function resolveSessionOptions(options: SessionOptions = {}): ResolvedSessionOptions {
  const messages = options.messages ?? [];
  const timing = options.timing ?? {};
  const updatedAt = timing.updatedAt ?? Date.now();
  return {
    id: options.id ?? crypto.randomUUID(),
    name: options.name ?? DEFAULT_SESSION_NAME,
    directory: options.directory ?? process.cwd(),
    model: options.model ?? DEFAULT_MODEL,
    defaultParticipant: options.defaultParticipant ?? DEFAULT_PARTICIPANT_NAME,
    participants: options.participants ?? [],
    messages,
    checkpoints: options.checkpoints ?? [],
    permissionMode: options.permissionMode ?? DEFAULT_PERMISSION_MODE,
    inputContent: options.inputContent ?? '',
    autoNamePending: options.autoNamePending ?? false,
    updatedAt,
    conversationStartedAt: timing.conversationStartedAt ?? updatedAt,
    // A session restored with history has already had a response, even when
    // the snapshot predates the field; an empty one has not. An explicit null
    // is a real value and stands.
    lastResponseFinishedAt: timing.lastResponseFinishedAt !== undefined
      ? timing.lastResponseFinishedAt
      : messages.length > 0 ? updatedAt : null,
  };
}

// One conversation: its identity and settings, and the collaborators that own
// its history, its agents, its checkpoints and its queue. Everything the UI
// and the commands touch goes through here.
export class Session {
  private readonly changes = new ChangeFeed(() => this.transcript.touch());
  private readonly queue = new MessageQueue();
  private readonly transcript: Transcript;
  private readonly roster: ParticipantRoster;
  private readonly checkpoints: CheckpointLog;
  private readonly turns: TurnRunner;

  private readonly id: string;
  private readonly directory: string;
  private name: string;
  private permissionMode: PermissionMode;
  // Drafts typed while a turn is active belong to the session, so switching
  // away and back does not discard them.
  private inputContent: string;
  private autoNamePending: boolean;

  private activeSends = 0;
  private status: SessionStatus = 'idle';
  private turnFailed = false;
  private lastTurnCancelled = false;
  private rewinding = false;
  private activeTurnStartedAt: number | null = null;

  constructor(options: SessionOptions = {}) {
    const resolved = resolveSessionOptions(options);
    this.id = resolved.id;
    this.name = resolved.name;
    this.directory = resolved.directory;
    this.permissionMode = resolved.permissionMode;
    this.inputContent = resolved.inputContent;
    this.autoNamePending = resolved.autoNamePending;
    this.transcript = new Transcript(this.changes, {
      messages: resolved.messages,
      updatedAt: resolved.updatedAt,
      conversationStartedAt: resolved.conversationStartedAt,
      lastResponseFinishedAt: resolved.lastResponseFinishedAt,
    });
    this.roster = new ParticipantRoster(this.changes, {
      sessionId: this.id,
      model: resolved.model,
      defaultParticipant: resolved.defaultParticipant,
      participants: resolved.participants,
    });
    this.checkpoints = new CheckpointLog(this.directory, resolved.checkpoints, this.changes);
    this.turns = new TurnRunner({
      transcript: this.transcript,
      roster: this.roster,
      directory: this.directory,
      toolboxFor: (agent, beforeMutation) => this.toolboxFor(agent, beforeMutation),
    });
  }

  static fromSnapshot(snapshot: SessionSnapshot): Session {
    return new Session({
      id: snapshot.id,
      name: snapshot.name,
      directory: snapshot.directory,
      model: snapshot.defaultModel.model,
      defaultParticipant: snapshot.defaultModel.name,
      participants: snapshot.participants,
      messages: snapshot.messages,
      checkpoints: snapshot.checkpoints ?? [],
      inputContent: snapshot.inputContent ?? '',
      autoNamePending: snapshot.autoNamePending ?? false,
      ...(snapshot.permissionMode ? { permissionMode: snapshot.permissionMode } : {}),
      timing: {
        updatedAt: snapshot.updatedAt ?? 0,
        conversationStartedAt: snapshot.conversationStartedAt,
        lastResponseFinishedAt: snapshot.lastResponseFinishedAt,
      },
    });
  }

  // Seeds one message into the history without running a turn.
  append(message: Message): void {
    this.transcript.append(message, this.activeSends === 0);
  }

  addParticipant(name: string, model: string): void {
    this.roster.add(name, model);
  }

  async sendMessage(message: Message): Promise<Message[]> {
    if (message.role !== 'user') throw new Error('Only user messages can start a session turn');
    if (this.rewinding || this.checkpoints.isRestoringDirectory()) {
      throw new Error('Wait for the rewind to finish before sending a message.');
    }

    if (this.activeSends === 0) {
      this.turnFailed = false;
      this.lastTurnCancelled = false;
      this.activeTurnStartedAt = Date.now();
    }
    this.activeSends++;
    this.checkpoints.beginTurn();
    this.setStatus('working');
    let checkpointBarrier: Promise<void> = Promise.resolve();
    let accepted = false;
    try {
      const messageText = textOf(message);
      // File mentions share the @ sigil with participants. Blank them out,
      // keeping every offset, so routing sees participant mentions only.
      let routingText = messageText;
      for (const file of parseFileMentions(messageText, this.directory).reverse()) {
        routingText = routingText.slice(0, file.start) + ' '.repeat(file.end - file.start) + routingText.slice(file.end);
      }
      const mentions = this.roster.readMentions(routingText);
      // Resolve every attachment before creating participants or adding history.
      // Keep this synchronous so the input can observe acceptance immediately.
      const resolved = resolveFileMentions(message, this.directory);
      const targets = this.roster.resolveMentions(mentions);

      // A model following a newly introduced @name is host routing metadata,
      // not part of the conversation. Strip it before either the UI history or
      // any provider sees the turn.
      const stored = stripCreationModels(resolved, mentions);
      if (this.transcript.isEmpty() && this.autoNamePending) {
        const name = sessionNameFromPrompt(textOf(stored));
        if (name) this.name = name;
        this.autoNamePending = false;
      }
      if (this.activeSends === 1) this.transcript.startConversationIfNeeded(Date.now());
      accepted = true;
      this.append(stored);
      // Start the provider immediately, while the pre-turn snapshot is taken
      // in parallel. Every mutating tool call waits for this barrier, so agent
      // writes cannot race ahead of the checkpoint.
      checkpointBarrier = this.checkpoints.capture(this.transcript.length - 1, messageText || '[image]');
      await this.turns.run(
        targets.map(participant => ({ participant, mentionedBy: [] })),
        checkpointBarrier,
      );
      return this.transcript.history();
    } catch (error) {
      if (isAbortError(error)) this.lastTurnCancelled = true;
      else this.turnFailed = true;
      throw error;
    } finally {
      // Measure the reply gap from the end of model work, not streamed chunks
      // or a checkpoint that may still be finishing in the background.
      if (accepted) this.transcript.markResponseFinished();
      // Failed and cancelled providers must also finish their snapshot before
      // the session becomes available for clearing or rewinding its history.
      await checkpointBarrier;
      this.activeSends--;
      this.checkpoints.endTurn();
      if (this.activeSends === 0) this.activeTurnStartedAt = null;
      this.setStatus(this.activeSends > 0
        ? 'working'
        : this.turnFailed ? 'error' : 'idle');
      this.sendNextQueuedPrompt();
    }
  }

  getActiveSubagentCount(): number {
    return this.roster.activeSubagentCount();
  }

  // Stops this session's turns and subagents, including detached workers.
  cancel(): boolean {
    return this.roster.cancel();
  }

  // A provider-side conversation must not outlive the history it mirrors.
  // Checkpoints go with it: they point into the history that was cleared.
  clear(): void {
    if (this.activeSends > 0 || this.rewinding) throw new Error('Wait for the current operation to finish before clearing the session.');
    if (this.transcript.isEmpty()) return;
    this.transcript.clear();
    this.checkpoints.clear();
    this.roster.resetRuntimes();
    this.changes.notify();
  }

  getCheckpoints(): Checkpoint[] {
    return this.checkpoints.list();
  }

  // Puts the directory, the chat, or both back to a checkpoint. Restoring
  // the chat drops that checkpoint and every later one, since the messages
  // they belong to are gone; restoring only files keeps them all.
  async rewind(checkpointId: string, options: RewindOptions): Promise<RewindResult> {
    if (!options.files && !options.chat) throw new Error('Nothing to restore: choose files, chat, or both.');
    if (this.rewinding) throw new Error('Wait for the current rewind to finish.');
    if (this.activeSends > 0) throw new Error('Wait for the current turn to finish before rewinding.');
    if (options.chat && this.roster.hasWorkingSubagents()) {
      throw new Error('Wait for this session’s subagents to finish before rewinding its chat.');
    }
    if (options.files && this.checkpoints.directoryHasWorkingSubagents()) {
      throw new Error('Subagents are working in this directory. Wait for them to finish before restoring files.');
    }
    if (options.files && this.checkpoints.isDirectoryBusy()) {
      throw new Error('Another session is working in this directory. Wait for it to finish before restoring files.');
    }
    const found = this.checkpoints.find(checkpointId);
    if (!found) throw new Error('That checkpoint no longer exists in this session.');

    this.rewinding = true;
    if (options.files) this.checkpoints.beginRestore();
    try {
      const files = options.files ? await this.checkpoints.restoreFiles(found.checkpoint.id) : null;
      let droppedMessages = 0;
      if (options.chat) {
        droppedMessages = this.transcript.truncate(found.checkpoint.messageIndex);
        this.checkpoints.dropFrom(found.index);
        this.roster.resetRuntimes();
      }
      this.changes.notify();
      return { checkpoint: found.checkpoint, files, droppedMessages };
    } finally {
      this.rewinding = false;
      if (options.files) this.checkpoints.endRestore();
    }
  }

  setName(name: string): void {
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) throw new Error('A session name cannot be empty');
    const wasAutoNamePending = this.autoNamePending;
    this.autoNamePending = false;
    if (trimmed === this.name) {
      if (wasAutoNamePending) this.changes.notify();
      return;
    }
    this.name = trimmed;
    this.changes.notify();
  }

  queueMessage(message: string): void {
    this.queue.push(message);
    this.changes.notify();
  }

  shiftQueuedMessage(): string | undefined {
    const text = this.queue.shift();
    if (text !== undefined) this.changes.notify();
    return text;
  }

  // What is waiting behind the turn that just ended, when nothing about it
  // needs a mounted Chat.
  private sendNextQueuedPrompt(): void {
    if (this.activeSends > 0) return;
    const next = this.queue.shiftAutoSendable();
    if (next === undefined) return;
    void this.sendMessage({ role: 'user', content: [{ type: 'text', text: next }] })
      .catch(() => { /* sendMessage records the failure in the session status. */ });
  }

  getQueuedMessageCount(): number {
    return this.queue.length;
  }

  getQueuedMessages(): readonly QueuedMessage[] {
    return this.queue.all();
  }

  updateQueuedMessage(id: string, text: string): void {
    if (this.queue.update(id, text)) this.changes.notify();
  }

  getActiveTurnStartedAt(): number | null {
    return this.activeTurnStartedAt;
  }

  getLastActivity(): number {
    return this.transcript.lastActivity;
  }

  getConversationStartedAt(): number {
    return this.transcript.conversationStartedAt;
  }

  getContextUsage(): ContextUsage | null {
    return this.transcript.contextUsage(this.roster.default.model);
  }

  getTotalUsage(): TokenTotals | null {
    return this.transcript.totalUsage();
  }

  getMessages(): Message[] {
    return this.transcript.history();
  }

  isEmpty(): boolean {
    return this.transcript.isEmpty();
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

  getParticipants(): Participant[] {
    return this.roster.toParticipants();
  }

  getModel(): string {
    return this.roster.default.model;
  }

  getThinkingLevel(participantName?: string): ThinkingLevel {
    return this.roster.thinkingLevel(participantName);
  }

  setThinkingLevel(level: ThinkingLevel, participantName?: string): void {
    this.roster.setThinkingLevel(level, participantName);
  }

  changeParticipantModel(participantName: string, newModel: string): void {
    this.roster.changeModel(participantName, newModel);
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  wasLastTurnCancelled(): boolean {
    return this.lastTurnCancelled;
  }

  getAssistantVersion(): number {
    return this.changes.assistantVersion;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  // Applies to the next tool call of every participant and of any subagent
  // the session has spawned; the gate reads the mode live.
  setPermissionMode(mode: PermissionMode): void {
    if (this.permissionMode === mode) return;
    this.permissionMode = mode;
    this.changes.notify();
  }

  getInputContent(): string {
    return this.inputContent;
  }

  setInputContent(inputContent: string): void {
    if (this.inputContent === inputContent) return;
    this.inputContent = inputContent;
    this.changes.notify();
  }

  subscribe(listener: () => void): () => void {
    return this.changes.subscribe(listener);
  }

  // monotonic mutation counter — a cheap referentially-stable snapshot for
  // useSyncExternalStore, since messages is mutated in place
  getVersion(): number {
    return this.changes.version;
  }

  toSnapshot(): SessionSnapshot {
    const checkpoints = this.checkpoints.list();
    return {
      id: this.id,
      name: this.name,
      directory: this.directory,
      participants: this.getParticipants(),
      defaultModel: this.roster.default.toParticipant(),
      messages: [...this.transcript.history()],
      inputContent: this.inputContent,
      permissionMode: this.permissionMode,
      ...(checkpoints.length > 0 ? { checkpoints } : {}),
      updatedAt: this.transcript.lastActivity,
      conversationStartedAt: this.transcript.conversationStartedAt,
      lastResponseFinishedAt: this.transcript.lastResponseFinishedAt,
      autoNamePending: this.autoNamePending,
    };
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.changes.notify();
  }

  // What one participant's turn may do: the session's tools, behind this
  // session's permission gate and this turn's checkpoint barrier, with the
  // participant's own subagents attached. The mode is read live, so changing
  // it mid-turn applies to the next tool call.
  private toolboxFor(agent: SessionAgent, beforeMutation: Promise<void>): Toolbox {
    const permissions: PermissionContext = {
      sessionId: this.id,
      mode: () => this.permissionMode,
      requester: { participant: agent.name },
      model: agent.model,
    };
    return createToolbox({
      directory: this.directory,
      permissions,
      memoryEnabled: isMemoryAccessEnabled,
      beforeMutation: () => beforeMutation,
      subagents: subagentHost(agent, this.directory, permissions, () => beforeMutation),
    });
  }
}

// The agent's own delegation, as the narrow port the agent tools speak to.
// A worker inherits the owner's gate and barrier, re-stamped with its own
// requester and model by the runner.
function subagentHost(
  agent: SessionAgent,
  directory: string,
  permissions: PermissionContext,
  beforeMutation: () => Promise<void>,
): SubagentHost {
  return {
    spawn: (prompt, model, call) => agent.spawnSubagent(prompt, model, {
      directory,
      permissions,
      beforeMutation,
      callId: call.callId,
      ...(call.signal ? { signal: call.signal } : {}),
    }),
    check: (id, wait, signal) => agent.checkSubagent(id, wait, signal),
    cancel: (id, signal) => agent.cancelSubagent(id, signal),
    list: () => agent.describeSubagents(),
  };
}
