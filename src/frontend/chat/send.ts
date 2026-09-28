import type { Session } from '../../agent_runtime/session';
import type { ImageBlock, MessageBlock } from '../../agent_runtime/types';
import { commandRegistry, isImmediateCommand, isSirusCommand, parseCommandLine, vendorCommandFor } from '../../commands/registry';
import { isThinkingArgument } from '../../commands/agents/behavior';

// What a line of input to one agent's conversation does, decided the same way
// whether it was typed in the terminal (Chat.tsx `send`) or sent from the
// phone (`src/remote`). Each caller then runs, queues or delivers it itself.
export interface InputRoute {
  // The user entry as it would be delivered.
  message: ReturnType<Session['messageForParticipant']>;
  // A Sirus command to run instead of delivering anything.
  command: ReturnType<typeof parseCommandLine> | null;
  // A vendor command that only reports: it runs aside on this participant,
  // in the vendor's own words (`/codex:status` is Codex's `/status`).
  aside: { participant: string; text: string } | null;
  // It has to wait: an agent it addresses is working, or it is a command
  // and the session is.
  busy: boolean;
  // A command that runs whatever the agents are doing.
  immediate: boolean;
}

export function routeInput(session: Session, text: string, recipient: string, images: readonly ImageBlock[] = [], content?: MessageBlock[], to?: readonly string[]): InputRoute {
  const commandName = /^\/(\S+)/.exec(text)?.[1];
  // An agent's own command goes to the agent on that command's vendor: the
  // recipient when it is, else another.
  const vendorCommand = vendorCommandFor(text, session.getNativeCommands(recipient));
  const vendorTarget = vendorCommand?.vendor ? session.participantOn(vendorCommand.vendor, recipient) : null;
  const addressed = to?.length ? [...to] : vendorTarget && vendorTarget !== recipient ? [vendorTarget] : undefined;
  const message = session.messageForParticipant({ role: 'user', ...(addressed ? { to: addressed } : {}),
    content: content ?? [...images, { type: 'text', text }] }, recipient);
  const taskCommand = commandName !== undefined && commandRegistry.some(spec => spec.name === commandName);
  // A Sirus command runs here. Anything else that starts with a slash, an
  // agent's own command or a name nobody knows, goes out as a message and
  // the agent's harness makes of it what it will.
  const command = isSirusCommand(text, session.getNativeCommands(recipient)) ? parseCommandLine(text) : null;
  return {
    message,
    command: command && commandRegistry.some(spec => spec.name === command.name) ? command : null,
    aside: vendorCommand?.reporting && vendorTarget ? { participant: vendorTarget, text: vendorCommand.command.invocation } : null,
    busy: (message.to?.some(name => session.isParticipantWorking(name)) ?? false)
      || (taskCommand && session.getStatus() === 'working'),
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
// as does a model, with or without a level, named alone. Chat.tsx's
// runCommand applies the same rule.
export function commandArgs(command: string, args: readonly string[], recipient: string): readonly string[] {
  const unnamed = args.length === 1 || (command === 'model' && args.length === 2 && isThinkingArgument(args[1]));
  return ['model', 'thinking', 'effort', 'fast'].includes(command)
    && (args.length === 0 || (unnamed && !args[0].startsWith('@') && args[0] !== 'subagent'))
    ? [`@${recipient}`, ...args] : args;
}
