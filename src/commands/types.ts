import type { Participant } from '../agent_runtime/agent';
import type { BackgroundTask } from '../agent_runtime/runtime/runtime';
import type { SessionSnapshot } from '../agent_runtime/session';
import type { RewindOptions, RewindPreview, RewindResult } from '../agent_runtime/session/checkpointLog';
import type { SubagentRun } from '../agent_runtime/tools/subagents';
import type { ImageBlock, Message, PermissionMode, ThinkingLevel } from '../agent_runtime/types';
import type { Checkpoint } from '../checkpoints';
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
  // The item needs one more value the menu cannot offer as a choice. Both ask
  // for it in the input bar and append what was typed as the command's final
  // argument; a secret is echoed as dots, an input stays visible.
  secret?: { prompt: string };
  input?: { prompt: string };
}

export type CommandMenuEntry = CommandMenuHeading | CommandMenuItem;

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
  // Sends /compact to the selected participant's runtime as a turn. Rejects
  // while the session is busy.
  compact(signal?: AbortSignal, participantName?: string): Promise<void>;
  getCheckpoints(): Checkpoint[];
  getContextUsage(participantName?: string): ContextUsage | null;
  getParticipants(): Participant[];
  getDirectory(): string;
  getName(): string;
  getPermissionMode(): PermissionMode;
  getThinkingLevel(participantName?: string): ThinkingLevel;
  isEmpty(): boolean;
  rewind(checkpointId: string, options: RewindOptions): Promise<RewindResult>;
  setName(name: string): void;
  setPermissionMode(mode: PermissionMode): void;
  setThinkingLevel(level: ThinkingLevel, participantName?: string): void;
  // The model every spawned subagent is pinned to; null leaves it to the
  // spawn: its model argument, then the agent definition's, then the
  // spawning participant's own.
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
  // Everything after the command's name as the user typed it, when they
  // did. A command whose one argument may hold runs of spaces, a path say,
  // reads it here rather than rejoining the split arguments.
  argumentText?: string;
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
  // The arguments it takes, as the menu and /help write them. A spec without
  // them takes none, and executeCommand turns any away with its usage.
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

// A command written out with the arguments it takes: `/undo [all|files|chat]`.
// The `/` menu, /help and every usage error that names the spec's own
// arguments use this one line, so they cannot drift apart.
export function commandUsage(spec: Pick<CommandSpec, 'name' | 'args'>): string {
  return `/${spec.name}${spec.args ? ` ${spec.args}` : ''}`;
}
