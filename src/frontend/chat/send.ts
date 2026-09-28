import type { Session } from '../../agent_runtime/session';
import type { ImageBlock, MessageBlock } from '../../agent_runtime/types';
import { isImmediateCommand, promptContent, splitPrompt, vendorCommandFor, type PromptCommand } from '../../commands/registry';
import { isThinkingArgument } from '../../commands/agents/behavior';

// What a line of input to one agent's conversation does, decided the same way
// whether it was typed in the terminal (Chat.tsx `send`) or sent from the
// phone (`src/remote`). Each caller then runs, queues or delivers it itself.

// A draft read into Sirus's own commands, wherever they are written, and
// what is left of it for the agents (see splitPrompt).
export interface SplitDraft {
  commands: PromptCommand[];
  prompt: string;
  promptBlocks?: MessageBlock[];
}

export function splitDraft(session: Session, text: string, recipient: string, content?: MessageBlock[]): SplitDraft {
  const typed = content ? content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : text;
  const parts = splitPrompt(typed, session.getNativeCommands(recipient), session);
  const prompt = parts.cuts.length > 0 ? parts.prompt : text;
  const promptBlocks = content && parts.cuts.length > 0 ? promptContent(content, parts) : content;
  return { commands: parts.commands, prompt, promptBlocks };
}

// Whether a draft's commands have to wait for the turn under way.
export function commandsWait(session: Session, draft: SplitDraft, commandRunning = false): boolean {
  return (commandRunning || session.getStatus() === 'working')
    && !draft.commands.every(command => isImmediateCommand(command.text));
}

// A draft held back goes into the queue as it would have run: each command
// an item of its own, so none is read again with another's words or sent to
// the agents unrun, then what is left for the agents.
export function queueDraft(
  draft: SplitDraft,
  images: readonly ImageBlock[],
  queue: (text: string, images: readonly ImageBlock[], content: MessageBlock[] | undefined) => void,
): void {
  for (const command of draft.commands) queue(command.text, [], undefined);
  if (draft.prompt || images.length) queue(draft.prompt, images, draft.promptBlocks);
}

// Text with no command of Sirus's left in it, on its way to the agents.
export interface InputRoute {
  // The user entry as it would be delivered.
  message: ReturnType<Session['messageForParticipant']>;
  // A vendor command that only reports: it runs aside on this participant,
  // in the vendor's own words (`/codex:status` is Codex's `/status`).
  aside: { participant: string; text: string } | null;
  // It has to wait: an agent it addresses is working.
  busy: boolean;
  // A command that runs whatever the agents are doing.
  immediate: boolean;
}

export function routeInput(session: Session, text: string, recipient: string, images: readonly ImageBlock[] = [], content?: MessageBlock[], to?: readonly string[]): InputRoute {
  // An agent's own command goes to the agent on that command's vendor: the
  // recipient when it is, else another. Anything else that starts with a
  // slash, or a name nobody knows, goes out as a message and the agent's
  // harness makes of it what it will.
  const vendorCommand = vendorCommandFor(text, session.getNativeCommands(recipient));
  const vendorTarget = vendorCommand?.vendor ? session.participantOn(vendorCommand.vendor, recipient) : null;
  const addressed = to?.length ? [...to] : vendorTarget && vendorTarget !== recipient ? [vendorTarget] : undefined;
  const message = session.messageForParticipant({ role: 'user', ...(addressed ? { to: addressed } : {}),
    content: content ?? [...images, { type: 'text', text }] }, recipient);
  return {
    message,
    aside: vendorCommand?.reporting && vendorTarget ? { participant: vendorTarget, text: vendorCommand.command.invocation } : null,
    busy: message.to?.some(name => session.isParticipantWorking(name)) ?? false,
    immediate: isImmediateCommand(text),
  };
}

// Input that has to wait goes into the session's queue, addressed as it
// would have been sent.
export function queueInput(session: Session, text: string, recipient: string, images: readonly ImageBlock[] = [], content?: MessageBlock[]): void {
  const message = session.messageForParticipant({ role: 'user', content: content ?? [{ type: 'text', text }] }, recipient);
  session.queueMessage(text, images, content, message.to);
}

// Agent-specific pickers bake their destination into the resulting command,
// as does a model, with or without a level, named alone.
export function commandArgs(command: string, args: readonly string[], recipient: string): readonly string[] {
  const unnamed = args.length === 1 || (command === 'model' && args.length === 2 && isThinkingArgument(args[1]));
  return ['model', 'thinking', 'effort', 'fast'].includes(command)
    && (args.length === 0 || (unnamed && !args[0].startsWith('@') && args[0] !== 'subagent'))
    ? [`@${recipient}`, ...args] : args;
}
