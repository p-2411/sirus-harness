import type { AsideOutput } from '../agent_runtime/agent';
import type { BackgroundTask, McpServerState } from '../agent_runtime/runtime/runtime';
import type { PermissionMode } from '../agent_runtime/permissions/policy';
import type { Source } from '../agent_runtime/providers/sources';
import type { Checkpoint, Participant, RewindOptions, RewindResult, RewindPreview, SessionSnapshot } from '../agent_runtime/session';
import type { SubagentRun } from '../agent_runtime/tools/subagents';
import type { ImageBlock, ThinkingLevel, Message, TurnUsage } from '../agent_runtime/types';
import type { ContextUsage } from '../agent_runtime/usage';
import type { Feedback } from './feedback';

export type CommandResult = void | Feedback | Promise<void | Feedback>;

export interface CommandMenuHeading {
  type: 'heading';
  key: string;
  label: string;
}

export interface CommandMenuItem {
  type: 'item';
  key: string;
  label: string;
  description?: string;
  command: string;
  // What is in effect now: marked in the menu, and where the menu opens.
  current?: boolean;
  // The item needs one more value the menu cannot offer as a choice. Both ask
  // for it in the input bar and append what was typed as the command's final
  // argument; a secret is echoed as dots, an input stays visible.
  secret?: { prompt: string };
  input?: { prompt: string };
}

export type CommandMenuEntry = CommandMenuHeading | CommandMenuItem;

// Interim progress from a long-running command, shown while it is still going.
export type { Notify } from '../agent_runtime/providers/login';

// The conversation as commands see it: the Session methods they call, and
// nothing else. Session satisfies this structurally, so the session code has
// no idea the commands exist.
export interface CommandSession {
  changeParticipantModel(participantName: string, newModel: string): void;
  clear(): void;
  getMessages(): Message[];
  getModel(): string;
  fork(): SessionSnapshot;
  previewRewind(checkpointId: string, options: RewindOptions): Promise<RewindPreview>;
  // Sends /compact, with any instructions, to a participant's runtime (the
  // selected one's unless named) as a turn. Rejects while the session is busy.
  compact(signal?: AbortSignal, participantName?: string, instructions?: string): Promise<void>;
  getCheckpoints(): Checkpoint[];
  getContextUsage(participantName?: string): ContextUsage | null;
  // What a participant's turns have used, summed from their entries.
  getTurnUsage(participantName: string): TurnUsage | null;
  getCredential(participantName: string): Source | null;
  getMcpServers(participantName: string): McpServerState[] | null;
  getOfferedThinkingLevels(participantName?: string): ThinkingLevel[] | null;
  getModelThinkingDefault(participantName?: string): string | undefined;
  // A participant's reporting vendor command, run on a throwaway fork of its
  // runtime: no turn, no checkpoint, nothing kept.
  runCommandAside(participantName: string, text: string, signal: AbortSignal): Promise<AsideOutput>;
  getId(): string;
  getParticipants(): Participant[];
  getDirectory(): string;
  getName(): string;
  getPermissionMode(): PermissionMode;
  // Undefined: the participant runs at its model's default.
  getThinkingLevel(participantName?: string): ThinkingLevel | undefined;
  isEmpty(): boolean;
  rewind(checkpointId: string, options: RewindOptions): Promise<RewindResult>;
  setName(name: string): void;
  setPermissionMode(mode: PermissionMode): void;
  setThinkingLevel(level: ThinkingLevel | undefined, participantName?: string): void;
  // The model spawned subagents run on; null means the spawning
  // participant's own.
  getSubagentModel(): string | null;
  setSubagentModel(model: string | null): void;
  // The session's workers, oldest first, and what the user can do to one.
  getWorkers(): SubagentRun[];
  getBackgroundTasks(): (BackgroundTask & { participant: string })[];
  stopBackgroundTask(participant: string, id: string): Promise<boolean>;
  cancelWorker(id: string): Promise<void>;
  messageWorker(id: string, text: string): Promise<void>;
  dismissWorker(id: string): void;
}

// What every command gets: the conversation it runs in, a way to report
// progress while it is still going, and the turn's cancellation.
export interface CommandContext {
  session: CommandSession;
  participant?: string;
  signal: AbortSignal;
  notify(text: string): void;
}

// Adds an image to the message the user is composing.
export interface AttachesImages {
  attachImage(image: ImageBlock): void;
}

// Quits the app, saving sessions as ctrl+c does.
export interface QuitsApp {
  exit(): void;
}

// Capabilities beyond the conversation are opt-in: a caller that cannot
// attach images or quit simply leaves them out, and the one command that
// needs each says so.
export type CommandCapabilities = Partial<AttachesImages & QuitsApp & {
  // Sends text to the agents as the user's own message, the way typing it
  // would, and settles when the turn it starts is over.
  sendPrompt(text: string): Promise<void>;
  newSession(): void;
  openSession(snapshot: SessionSnapshot): void;
  resumeSession(query?: string): void;
  archiveSession(): void;
  deleteSession(): void;
  confirm(text: string): Promise<boolean>;
  copy(text: string): void;
}>;

export interface CommandSpec {
  name: string;
  args?: string;
  description: string;
  // Returned feedback is shown after completion; notify shows interim info
  // while a long command such as browser login is still running.
  run: (args: readonly string[], context: CommandContext & CommandCapabilities) => CommandResult;
  // Picking a menu item sends its command text, plus any secret entered.
  // Null means the command should run directly. The session is the one the
  // command would run in, for menus that list its state.
  menu?: (args: readonly string[], session: CommandSession) => CommandMenuEntry[] | null;
}
