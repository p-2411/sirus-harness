import type { PermissionMode } from '../agent_runtime/permissions/policy';
import type {
  Checkpoint,
  RewindOptions,
  RewindResult,
  TokenTotals,
} from '../agent_runtime/session';
import type { ImageBlock, ThinkingLevel } from '../agent_runtime/types';
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
  secret?: { prompt: string };
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
  getCheckpoints(): Checkpoint[];
  getContextUsage(): ContextUsage | null;
  getDirectory(): string;
  getName(): string;
  getPermissionMode(): PermissionMode;
  getThinkingLevel(participantName?: string): ThinkingLevel;
  getTotalUsage(): TokenTotals | null;
  isEmpty(): boolean;
  rewind(checkpointId: string, options: RewindOptions): Promise<RewindResult>;
  setName(name: string): void;
  setPermissionMode(mode: PermissionMode): void;
  setThinkingLevel(level: ThinkingLevel, participantName?: string): void;
}

// What every command gets: the conversation it runs in, a way to report
// progress while it is still going, and the turn's cancellation.
export interface CommandContext {
  session: CommandSession;
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
export type CommandCapabilities = Partial<AttachesImages & QuitsApp>;

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
