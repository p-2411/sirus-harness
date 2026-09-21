import crypto from 'crypto';
import { SessionAgent, type RuntimeHost } from '../agent';
import { isMemoryAccessEnabled } from '../memory-access';
import { requestPermission } from '../permissions/approvals';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../permissions/policy';
import { getSystemPrompt, systemPromptFor } from '../prompt';
import { jevApiKey, routeSessionModel, routingCandidates } from '../router';
import { servableModelIds, servesModel } from '../providers';
import { DEFAULT_MODEL } from '../providers/catalog';
import { registerToolSession, sirusMcpServerEntry, unregisterToolSession } from '../tools/server';
import {
  notifySubagents,
  registerSubagent,
  unregisterSubagent,
  workerRecord,
  type SubagentRun,
  type WorkerRecord,
} from '../tools/subagents';
import { INTERRUPTED_REASON, workerReport } from '../tools/subagents/report';
import { cancelSubagent, messageSubagent } from '../tools/subagents/run';
import { removeWorktree } from '../tools/subagents/worktree';
import type { SubagentHost } from '../tools/types';
import { textOf, type Message, type ThinkingLevel } from '../types';
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
import { generateSessionName } from './naming';
import { keyOf, NAME_PATTERN_SOURCE, ParticipantRoster, stripCreationModels, type Participant } from './roster';
import { Timeline, type Draft } from './timeline';
import { TurnRunner } from './turnRunner';

// The default model is a catalog fact, named here because that is where
// callers have always found it.
export { DEFAULT_MODEL, NAME_PATTERN_SOURCE, defaultDirectoryActivity, isAutoSendable };
export { SESSION_NAME_LIMIT } from './naming';
export type {
  Checkpoint,
  DirectoryActivity,
  Draft,
  Participant,
  QueuedMessage,
  RewindOptions,
  RewindResult,
};

export type SessionStatus = 'idle' | 'working' | 'error';

// What the constructor takes and what a snapshot holds: the session's input
// shapes, and the one function that fills in every default.

const DEFAULT_SESSION_NAME = 'Session 1';
const DEFAULT_PARTICIPANT_NAME = 'sirus';

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
  // Entries with a seq are restored as they are; drafts are stamped in order.
  messages?: readonly (Message | Draft)[];
  checkpoints?: readonly Checkpoint[];
  permissionMode?: PermissionMode;
  // The model spawned subagents run on; null for the owner's own.
  subagentModel?: string | null;
  // Workers of this session as the snapshot kept them. One still working
  // when it was saved is restored as interrupted.
  workers?: readonly WorkerRecord[];
  inputContent?: string;
  // A newly-created session may still take its name from its first prompt.
  autoNamePending?: boolean;
  // A newly-created session whose model nobody chose: its first prompt asks
  // Jev which model fits, unless /model picks one first.
  routePending?: boolean;
  timing?: SessionTiming;
}

export interface SessionSnapshot {
  id: string;
  name: string;
  directory: string;
  participants: Participant[];
  defaultModel: Participant;
  // The timeline: every transcript's entries, once, in seq order.
  messages: Message[];
  // Absent in snapshots saved before session drafts were supported.
  inputContent?: string;
  // How tool calls are approved in this session; absent in older snapshots.
  permissionMode?: PermissionMode;
  // The model spawned subagents run on; absent for the owner's own.
  subagentModel?: string;
  // Every worker the session's participants spawned, oldest first; absent
  // when none.
  workers?: WorkerRecord[];
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
  messages: readonly (Message | Draft)[];
  checkpoints: readonly Checkpoint[];
  permissionMode: PermissionMode;
  subagentModel: string | null;
  workers: readonly WorkerRecord[];
  inputContent: string;
  autoNamePending: boolean;
  routePending: boolean;
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
    subagentModel: options.subagentModel ?? null,
    workers: options.workers ?? [],
    inputContent: options.inputContent ?? '',
    autoNamePending: options.autoNamePending ?? false,
    routePending: options.routePending ?? false,
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
// its participants and their transcripts, the timeline over them, its
// checkpoints and its queue. Everything the UI and the commands touch goes
// through here.
export class Session {
  private readonly changes = new ChangeFeed(() => this.timeline.touch());
  private readonly queue = new MessageQueue();
  private readonly timeline: Timeline;
  private readonly roster: ParticipantRoster;
  private readonly checkpoints: CheckpointLog;
  private readonly turns: TurnRunner;

  private readonly id: string;
  private readonly directory: string;
  private name: string;
  private permissionMode: PermissionMode;
  private subagentModel: string | null;
  // Drafts typed while a turn is active belong to the session, so switching
  // away and back does not discard them.
  private inputContent: string;
  private autoNamePending: boolean;
  private routePending: boolean;
  private namingController: AbortController | null = null;

  // Workers that ended while the session was busy, oldest first. Their
  // reports go out as soon as it is free, ahead of the user's queued prompts.
  private readonly pendingReports: SubagentRun[] = [];

  private activeSends = 0;
  private status: SessionStatus = 'idle';
  private turnFailed = false;
  private lastTurnCancelled = false;
  private rewinding = false;
  private compacting = false;
  private disposed = false;
  private activeTurnStartedAt: number | null = null;

  constructor(options: SessionOptions = {}) {
    const resolved = resolveSessionOptions(options);
    this.id = resolved.id;
    this.name = resolved.name;
    this.directory = resolved.directory;
    this.permissionMode = resolved.permissionMode;
    this.subagentModel = resolved.subagentModel;
    this.inputContent = resolved.inputContent;
    this.autoNamePending = resolved.autoNamePending;
    this.routePending = resolved.routePending;
    this.roster = new ParticipantRoster(this.changes, {
      sessionId: this.id,
      model: resolved.model,
      defaultParticipant: resolved.defaultParticipant,
      participants: resolved.participants,
      host: this.runtimeHost(),
    });
    this.timeline = new Timeline(() => this.roster.transcripts(), this.changes, {
      updatedAt: resolved.updatedAt,
      conversationStartedAt: resolved.conversationStartedAt,
      lastResponseFinishedAt: resolved.lastResponseFinishedAt,
    });
    this.restore(resolved.messages);
    this.restoreWorkers(resolved.workers);
    this.checkpoints = new CheckpointLog(this.directory, resolved.checkpoints, this.changes);
    this.turns = new TurnRunner({ timeline: this.timeline, roster: this.roster });
    registerToolSession(this.id, {
      directory: this.directory,
      memoryEnabled: isMemoryAccessEnabled,
      hostFor: name => this.subagentHostFor(name),
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
      workers: snapshot.workers ?? [],
      checkpoints: snapshot.checkpoints ?? [],
      inputContent: snapshot.inputContent ?? '',
      autoNamePending: snapshot.autoNamePending ?? false,
      ...(snapshot.permissionMode ? { permissionMode: snapshot.permissionMode } : {}),
      ...(snapshot.subagentModel ? { subagentModel: snapshot.subagentModel } : {}),
      timing: {
        updatedAt: snapshot.updatedAt ?? 0,
        conversationStartedAt: snapshot.conversationStartedAt,
        lastResponseFinishedAt: snapshot.lastResponseFinishedAt,
      },
    });
  }

  // Everything a participant's runtime needs from the session, and the same
  // for a worker one of them spawns: the worker answers to this session's
  // mode and gate, as itself.
  private runtimeHost(): RuntimeHost {
    const host: RuntimeHost = {
      sessionId: this.id,
      directory: this.directory,
      systemPrompt: agent => systemPromptFor(this.directory, agent.name, false),
      mcpServer: agent => sirusMcpServerEntry(this.id, agent.name),
      permissionMode: () => this.permissionMode,
      requestPermission: (agent, request, signal) =>
        requestPermission({ sessionId: this.id, requester: agent.requester }, request, signal),
      subagentModel: () => this.subagentModel,
      forWorker: (id, directory) => ({
        ...host,
        directory,
        systemPrompt: () => getSystemPrompt(directory, 'sirus', true),
        mcpServer: () => sirusMcpServerEntry(this.id, `subagent:${id}`),
        forWorker: () => { throw new Error('A subagent cannot spawn a subagent'); },
      }),
      workerFinished: run => this.workerFinished(run),
    };
    return host;
  }

  // Puts the session file's worker records back where they belong: in the
  // run map of the participant that spawned them, and in the process index
  // so the strip lists them. Nothing restarts; a run that was working when
  // Sirus quit ended with the process.
  private restoreWorkers(records: readonly WorkerRecord[]): void {
    for (const record of records) {
      const owner = this.roster.find(record.owner) ?? this.roster.default;
      const transcript = record.transcript.map(entry => ({ ...entry }));
      const interrupted = record.status === 'working';
      const run: SubagentRun = {
        ...record,
        owner: owner.name,
        transcript,
        status: interrupted ? 'interrupted' : record.status,
        finishedAt: interrupted ? Date.now() : record.finishedAt,
        error: interrupted ? INTERRUPTED_REASON : record.error,
        sessionId: this.id,
        worker: null,
        content: transcript.find(entry => entry.role === 'assistant')?.content ?? [],
      };
      owner.adoptSubagent(run);
      registerSubagent(run);
    }
  }

  // Puts restored entries back into the transcripts they were delivered to.
  // An entry from before delivery was recorded goes where a fresh one would:
  // a prompt to the default participant, a response to its author.
  private restore(messages: readonly (Message | Draft)[]): void {
    const stamped: Message[] = [];
    let next = messages.reduce((highest, entry) => 'seq' in entry ? Math.max(highest, entry.seq + 1) : highest, 0);
    for (const message of messages) {
      const entry: Message = 'seq' in message ? message : { ...message, seq: next++ };
      stamped.push(entry);
      for (const transcript of this.transcriptsFor(entry)) transcript.append(entry);
    }
    this.timeline.restoreSeq(stamped);
  }

  // The transcripts an entry belongs in. A name the roster does not know
  // falls back to the default participant, so a restored file whose
  // participant list drifted still lands somewhere.
  private transcriptsFor(entry: Message) {
    const names = new Set<string>((entry.to ?? []).map(keyOf));
    if (entry.role === 'assistant') names.add(keyOf(entry.participant ?? this.roster.default.name));
    const known = this.roster.all().filter(agent => names.has(keyOf(agent.name)));
    return (known.length > 0 ? known : [this.roster.default]).map(agent => agent.transcript);
  }

  // Seeds one entry into the history without running a turn.
  append(message: Draft): void {
    for (const name of [...(message.to ?? []), ...(message.participant ? [message.participant] : [])]) {
      if (!this.roster.find(name)) throw new Error(`Participant ${name} not found`);
    }
    const to = this.transcriptsFor({ ...message, seq: -1 });
    this.timeline.add(message, to, this.activeSends === 0);
  }

  addParticipant(name: string, model: string): void {
    this.roster.add(name, model);
  }

  async sendMessage(message: Draft): Promise<Message[]> {
    if (message.role !== 'user') throw new Error('Only user messages can start a session turn');
    if (this.rewinding || this.checkpoints.isRestoringDirectory()) {
      throw new Error('Wait for the rewind to finish before sending a message.');
    }
    if (this.compacting) throw new Error('Wait for the context compaction to finish before sending a message.');

    if (this.activeSends === 0) {
      this.turnFailed = false;
      this.lastTurnCancelled = false;
      this.activeTurnStartedAt = Date.now();
    }
    this.activeSends++;
    this.checkpoints.beginTurn();
    this.setStatus('working');
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
      // any runtime sees the turn.
      const stored = stripCreationModels(resolved, mentions);
      // Jev reads the user's own words, like the naming does, and its pick
      // must land before any runtime starts: the turn waits for it.
      if (this.routePending) {
        this.routePending = false;
        const pick = await routeSessionModel(
          { prompt: textOf(stripCreationModels(message, mentions)), directory: this.directory },
          routingCandidates(),
        );
        if (pick && pick.model !== this.roster.default.model) this.roster.changeModel(this.roster.default.name, pick.model);
      }
      if (this.timeline.isEmpty() && this.autoNamePending) {
        // Name from the user's text, not the contents of resolved attachments.
        this.startNaming(textOf(stripCreationModels(message, mentions)));
      }
      if (this.activeSends === 1) this.timeline.startConversationIfNeeded(Date.now());
      accepted = true;
      this.appendRestoredReports();
      // The prompt enters the transcript of every participant it addresses,
      // and nothing else's.
      const entry = this.timeline.add(
        { ...stored, to: targets.map(target => target.name) },
        targets.map(target => target.transcript),
        false,
      );
      // The runtimes run their tools themselves and cannot wait on a barrier,
      // so the pre-turn snapshot is taken before any of them is prompted.
      await this.checkpoints.capture(entry.seq, messageText || '[image]');
      await this.turns.run(targets.map(participant => ({ participant, entries: [entry] })));
      return this.timeline.entries();
    } catch (error) {
      if (isAbortError(error)) this.lastTurnCancelled = true;
      else this.turnFailed = true;
      throw error;
    } finally {
      // Measure the reply gap from the end of model work, not streamed chunks.
      if (accepted) this.timeline.markResponseFinished();
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

  // One participant's delegation port: what its SpawnAgent, CheckAgent,
  // MessageAgent, CancelAgent and ListAgents calls reach through the tool
  // server.
  subagentHostFor(participantName: string): SubagentHost | null {
    return this.roster.find(participantName)?.subagentHost() ?? null;
  }

  // A worker of this session ended. Its report goes to the agent that
  // spawned it and wakes it, the way a message from another participant
  // does; while the session is busy the report waits, and it goes out ahead
  // of whatever the user queued behind the turn.
  private workerFinished(run: SubagentRun): void {
    if (run.reported || this.pendingReports.includes(run)) return;
    this.pendingReports.push(run);
    this.flushReports();
  }

  // Delivers whatever is waiting, unless something else has the session.
  private flushReports(): void {
    if (this.pendingReports.length === 0 || this.disposed) return;
    if (this.activeSends > 0 || this.rewinding || this.compacting || this.checkpoints.isRestoringDirectory()) return;
    void this.deliverReports();
  }

  // One turn for every report that is waiting: each worker's report enters
  // the transcript of the agent that spawned it, and that agent answers, as
  // it would a peer's message. The bookkeeping is `sendMessage`'s, since
  // this is a turn of the session like any other; the failure of one is
  // recorded in the status, because nobody is waiting on this.
  private async deliverReports(): Promise<void> {
    const pending = this.pendingReports.splice(0);
    const invocations = this.reportInvocations(pending);
    if (invocations.length === 0) return;
    if (this.activeSends === 0) {
      this.turnFailed = false;
      this.lastTurnCancelled = false;
      this.activeTurnStartedAt = Date.now();
    }
    this.activeSends++;
    this.checkpoints.beginTurn();
    this.setStatus('working');
    try {
      const [first] = invocations[0].entries;
      await this.checkpoints.capture(first.seq, `Report from ${pending.map(run => `@${run.id}`).join(', ')}`);
      await this.turns.run(invocations);
    } catch (error) {
      if (isAbortError(error)) this.lastTurnCancelled = true;
      else this.turnFailed = true;
    } finally {
      this.timeline.markResponseFinished();
      this.activeSends--;
      this.checkpoints.endTurn();
      if (this.activeSends === 0) this.activeTurnStartedAt = null;
      this.setStatus(this.activeSends > 0
        ? 'working'
        : this.turnFailed ? 'error' : 'idle');
      this.sendNextQueuedPrompt();
    }
  }

  // The reports as entries in their owners' transcripts, one invocation per
  // owner: two workers of the same agent wake it once, with both reports.
  private reportInvocations(runs: readonly SubagentRun[]): { participant: SessionAgent; entries: Message[] }[] {
    const invocations = new Map<string, { participant: SessionAgent; entries: Message[] }>();
    for (const run of runs) {
      const owner = this.roster.find(run.owner) ?? this.roster.default;
      const entry = this.reportEntry(run, owner);
      const existing = invocations.get(keyOf(owner.name));
      if (existing) existing.entries.push(entry);
      else invocations.set(keyOf(owner.name), { participant: owner, entries: [entry] });
    }
    return [...invocations.values()];
  }

  // The report itself: a message from the worker, addressed to its owner and
  // attributed to the run, so the chat shows who spoke and the owner's next
  // runtime reads it in the record like any other participant's message.
  private reportEntry(run: SubagentRun, owner: SessionAgent): Message {
    run.reported = true;
    notifySubagents();
    return this.timeline.add({
      role: 'assistant',
      participant: run.id,
      model: run.model,
      content: [{ type: 'text', text: workerReport(run) }],
      to: [owner.name],
    }, [owner.transcript], false);
  }

  // A run restored from the session file never received its report: nothing
  // restarts on launch, so it is read into the owner's record at the start
  // of the next prompt instead of starting a turn of its own.
  private appendRestoredReports(): void {
    for (const run of this.roster.workers()) {
      if (run.worker !== null || run.reported || run.status === 'working') continue;
      this.reportEntry(run, this.roster.find(run.owner) ?? this.roster.default);
    }
  }

  // Stops this session's turns. Workers are background tasks and keep
  // working: `cancelWorker`, CancelAgent and `dispose` stop those.
  cancel(): boolean {
    return this.roster.cancel();
  }

  // Asks the default participant's runtime to fold its own conversation now:
  // `/compact` is a slash command both vendors take as a prompt. What the
  // runtime reports lands in the record like any other turn. Like a rewind,
  // it waits for nothing else to be running and nothing else runs meanwhile.
  async compact(signal?: AbortSignal): Promise<void> {
    if (this.activeSends > 0 || this.rewinding || this.compacting) {
      throw new Error('Wait for the current operation to finish before compacting.');
    }
    if (this.timeline.isEmpty()) throw new Error('There is no history to compact.');
    const agent = this.roster.default;
    this.compacting = true;
    this.activeSends++;
    this.activeTurnStartedAt = Date.now();
    this.setStatus('working');
    const round = this.timeline.openRound([{ name: agent.name, model: agent.model, transcript: agent.transcript }]);
    try {
      await agent.respond({ text: '/compact' }, {
        entry: round.entries[0],
        onUpdate: () => round.update(0),
        ...(signal ? { signal } : {}),
      });
      round.settle(0);
      round.discardIfEmpty(0);
    } catch (error) {
      round.discardIfEmpty(0);
      throw error;
    } finally {
      round.flush();
      this.compacting = false;
      this.activeSends--;
      this.activeTurnStartedAt = null;
      this.setStatus(this.turnFailed ? 'error' : 'idle');
      this.changes.notify();
      this.flushReports();
    }
  }

  isCompacting(): boolean {
    return this.compacting;
  }

  // A vendor runtime's conversation must not outlive the record it mirrors.
  // Checkpoints go with it: they point into the history that was cleared.
  clear(): void {
    if (this.activeSends > 0 || this.rewinding) throw new Error('Wait for the current operation to finish before clearing the session.');
    if (this.timeline.isEmpty()) return;
    this.stopNaming();
    this.timeline.clear();
    this.checkpoints.clear();
    this.roster.resetRuntimes();
    this.changes.notify();
  }

  getCheckpoints(): Checkpoint[] {
    return this.checkpoints.list();
  }

  // Puts the directory, the chat, or both back to a checkpoint. Restoring
  // the chat drops that checkpoint and every later one, since the entries
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
        if (found.checkpoint.seq === 0) this.stopNaming();
        // Every participant loses what came from that seq on, and every
        // runtime is rebuilt from what is left.
        droppedMessages = this.timeline.truncateFrom(found.checkpoint.seq);
        this.checkpoints.dropFrom(found.index);
        this.roster.resetRuntimes();
      }
      this.changes.notify();
      return { checkpoint: found.checkpoint, files, droppedMessages };
    } finally {
      this.rewinding = false;
      if (options.files) this.checkpoints.endRestore();
      this.flushReports();
    }
  }

  private startNaming(text: string): void {
    this.autoNamePending = false;
    const controller = new AbortController();
    this.namingController = controller;
    void generateSessionName(text, this.directory, this.getModel(), controller.signal)
      .then(name => {
        if (!name || controller.signal.aborted || this.namingController !== controller) return;
        this.name = name;
        this.changes.notify();
      })
      .catch(() => { /* Naming must never fail the chat turn. */ })
      .finally(() => {
        if (this.namingController === controller) this.namingController = null;
      });
  }

  private stopNaming(): void {
    this.namingController?.abort();
    this.namingController = null;
  }

  setName(name: string): void {
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) throw new Error('A session name cannot be empty');
    this.stopNaming();
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
  // needs a mounted Chat. A worker that finished during the turn is news the
  // owner needs before it answers anything the user typed meanwhile, so the
  // reports go first and the queue drains after the turn they start.
  private sendNextQueuedPrompt(): void {
    if (this.activeSends > 0) return;
    if (this.pendingReports.length > 0) {
      this.flushReports();
      return;
    }
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
    return this.timeline.lastActivity;
  }

  getConversationStartedAt(): number {
    return this.timeline.conversationStartedAt;
  }

  // A participant's window as its runtime last reported it, or for the
  // status row the default participant's, else the last responder's.
  getContextUsage(participantName?: string): ContextUsage | null {
    if (participantName) return this.roster.require(participantName).context;
    if (this.roster.default.context) return this.roster.default.context;
    const entries = this.timeline.entries();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.role !== 'assistant' || !entry.participant) continue;
      const context = this.roster.find(entry.participant)?.context;
      if (context) return context;
    }
    return null;
  }

  // What a vendor could not honour about the session's mode, if anything:
  // the default participant's word first, then any other participant's.
  getModeNotice(): string | null {
    return this.roster.default.modeNotice
      ?? this.roster.all().find(agent => agent.modeNotice)?.modeNotice
      ?? null;
  }

  getMessages(): Message[] {
    return this.timeline.entries();
  }

  isEmpty(): boolean {
    return this.timeline.isEmpty();
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

  // A draft whose model nobody has chosen yet, with Jev configured to choose
  // one on the first prompt: the model it holds is the fallback, not a
  // choice, so the status row shows none until the pick lands or /model
  // makes one.
  isModelPending(): boolean {
    return this.routePending && jevApiKey() !== null;
  }

  getThinkingLevel(participantName?: string): ThinkingLevel {
    return this.roster.thinkingLevel(participantName);
  }

  setThinkingLevel(level: ThinkingLevel, participantName?: string): void {
    this.roster.setThinkingLevel(level, participantName);
  }

  // The user's own pick for the default participant settles the draft's
  // model: Jev is not asked.
  changeParticipantModel(participantName: string, newModel: string): void {
    this.roster.changeModel(participantName, newModel);
    if (keyOf(participantName.replace(/^@/, '')) === keyOf(this.roster.default.name)) this.routePending = false;
  }

  getSubagentModel(): string | null {
    return this.subagentModel;
  }

  // The session's workers, oldest first, restored records included.
  getWorkers(): SubagentRun[] {
    return this.roster.workers();
  }

  // Stops one working worker and waits for it to wind down.
  async cancelWorker(id: string): Promise<void> {
    await cancelSubagent(this.requireWorker(id));
  }

  // Sends text into a running worker's turn; rejects for one that has ended.
  async messageWorker(id: string, text: string): Promise<void> {
    await messageSubagent(this.requireWorker(id), text);
  }

  // Clears a finished worker's line from the strip; its record stays.
  dismissWorker(id: string): void {
    const run = this.requireWorker(id);
    if (run.dismissed) return;
    run.dismissed = true;
    notifySubagents();
    this.changes.notify();
  }

  private requireWorker(id: string): SubagentRun {
    const run = this.roster.workers().find(candidate => candidate.id === id);
    if (!run) throw new Error(`This session has no worker "${id}".`);
    return run;
  }

  setSubagentModel(model: string | null): void {
    if (model !== null && !servesModel(model)) {
      throw new Error(`Unknown model "${model}". Try: ${servableModelIds().join(', ')}`);
    }
    if (this.subagentModel === model) return;
    this.subagentModel = model;
    this.changes.notify();
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

  // Switches every live runtime of the session, workers included, and is
  // what any runtime started later begins in.
  setPermissionMode(mode: PermissionMode): void {
    if (this.permissionMode === mode) return;
    this.permissionMode = mode;
    this.roster.setPermissionMode(mode);
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
  // useSyncExternalStore, since entries are mutated in place
  getVersion(): number {
    return this.changes.version;
  }

  toSnapshot(): SessionSnapshot {
    const checkpoints = this.checkpoints.list();
    const workers = this.getWorkers().map(workerRecord);
    return {
      id: this.id,
      name: this.name,
      directory: this.directory,
      participants: this.getParticipants(),
      defaultModel: this.roster.default.toParticipant(),
      messages: [...this.timeline.entries()],
      inputContent: this.inputContent,
      permissionMode: this.permissionMode,
      ...(this.subagentModel ? { subagentModel: this.subagentModel } : {}),
      ...(workers.length > 0 ? { workers } : {}),
      ...(checkpoints.length > 0 ? { checkpoints } : {}),
      updatedAt: this.timeline.lastActivity,
      conversationStartedAt: this.timeline.conversationStartedAt,
      lastResponseFinishedAt: this.timeline.lastResponseFinishedAt,
      autoNamePending: this.autoNamePending,
    };
  }

  // A deleted session takes its runtimes, its workers and its tool server
  // binding with it. The workers are the slow part — each one is stopped and
  // waited for before its worktree can be removed — so this resolves when
  // the last of them is gone; callers that only need the session out of the
  // way need not wait.
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    this.stopNaming();
    const workers = this.getWorkers();
    this.roster.resetRuntimes();
    unregisterToolSession(this.id);
    await Promise.all(workers.map(run => this.disposeWorker(run)));
  }

  // One worker at the end of the session: stopped if it was still working,
  // then its worktree removed and its record dropped from the process index.
  // The branch it worked on stays behind for whoever merges it.
  private async disposeWorker(run: SubagentRun): Promise<void> {
    try {
      await cancelSubagent(run);
    } catch {
      // A worker that refuses to stop must not keep the worktree, or the
      // session, alive.
    }
    if (run.branch) await removeWorktree(this.directory, run.directory);
    unregisterSubagent(run.id);
    notifySubagents();
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.changes.notify();
  }
}
