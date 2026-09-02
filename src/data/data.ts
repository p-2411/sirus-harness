export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  callId: string;
  result: string;
  isError: boolean;
}

export type MessageBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: MessageBlock[];
  // Present on agent messages so a shared multi-participant transcript keeps
  // the identity of the agent that produced it. Legacy messages omit it and
  // are treated as coming from the default participant.
  participant?: string;
  // Captured on agent responses so the UI can show the model that produced a
  // historical message even if that participant changes models later.
  model?: string;
}

export interface Error {
  message: string;
}

export { Session, type Participant, type SessionSnapshot, type SessionStatus } from '../runtime/session';
