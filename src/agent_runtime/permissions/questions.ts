import crypto from 'crypto';
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';
import type { PermissionContext } from './policy';
import type { Requester } from './approvals';

// Questions an agent puts to the user: Claude's AskUserQuestion, Codex's
// request_user_input, and forms an MCP server raises through either. Both
// adapters send them as ACP form elicitations, a flat JSON Schema of
// primitive fields, and take the answers back as the form's content. One
// process-wide queue, like the approvals', so the UI subscribes once.
//
// Both adapters pair a question with a free-text field for an answer of the
// user's own, marked in its `_meta`. The card offers that as "Other" under
// the question's options rather than asking it as a field of its own.

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export type QuestionField =
  | {
    kind: 'choice';
    key: string;
    title: string;
    description?: string;
    options: QuestionOption[];
    multiple: boolean;
    required: boolean;
    minimum?: number;
    maximum?: number;
    // The field an answer of the user's own goes in, and for Codex the
    // option that says the answer is in it.
    other?: { key: string; value?: string };
  }
  | { kind: 'text'; key: string; title: string; description?: string; required: boolean; secret: boolean }
  | { kind: 'number'; key: string; title: string; description?: string; required: boolean; integer: boolean; minimum?: number; maximum?: number }
  | { kind: 'boolean'; key: string; title: string; description?: string; required: boolean };

export interface QuestionRequest {
  id: string;
  sessionId: string;
  requester: Requester;
  message: string;
  fields: QuestionField[];
}

export type QuestionAnswer =
  | { action: 'accept'; content: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' };

interface PendingEntry {
  request: QuestionRequest;
  settle: (answer: QuestionAnswer) => void;
}

const pending: PendingEntry[] = [];
const listeners = new Set<() => void>();
let version = 0;

function notifyListeners(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribeQuestions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Monotonic counter for useSyncExternalStore; the queue is mutated in place.
export function getQuestionsVersion(): number {
  return version;
}

export function pendingQuestions(sessionId?: string): QuestionRequest[] {
  return pending
    .map(entry => entry.request)
    .filter(request => sessionId === undefined || request.sessionId === sessionId);
}

export function resolveQuestion(id: string, answer: QuestionAnswer): boolean {
  const index = pending.findIndex(entry => entry.request.id === id);
  if (index === -1) return false;
  const [entry] = pending.splice(index, 1);
  notifyListeners();
  entry.settle(answer);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// The question a free-text field adds an answer to, when it is one:
// claude-agent-acp marks it `_askUserQuestionCustomAnswer`, codex-acp
// `codex.role: "user_note"`.
function otherFieldOf(schema: Record<string, unknown>): string | undefined {
  const meta = isRecord(schema._meta) ? schema._meta : {};
  const claude = meta._askUserQuestionCustomAnswer;
  if (isRecord(claude) && claude.isCustomAnswer === true && typeof claude.questionId === 'string') return claude.questionId;
  const codex = meta.codex;
  if (isRecord(codex) && codex.role === 'user_note' && typeof codex.questionId === 'string') return codex.questionId;
  return undefined;
}

// Codex adds this option to a question that takes an answer of the user's
// own, and reads the answer from the note field when it is chosen.
const CODEX_OTHER_OPTION = 'None of the above';

function optionsOf(list: unknown, plain: unknown): QuestionOption[] {
  if (Array.isArray(list)) {
    return list.filter(isRecord).flatMap(option => typeof option.const === 'string'
      ? [{ value: option.const, label: text(option.title) ?? option.const, ...(text(option.description) ? { description: option.description as string } : {}) }]
      : []);
  }
  return Array.isArray(plain) ? plain.filter((value): value is string => typeof value === 'string').map(value => ({ value, label: value })) : [];
}

// The form as the card asks it: one field after another, in the schema's
// order, with each question's free-text field folded into it. Null for a
// form the card cannot ask.
export function questionFields(request: CreateElicitationRequest): QuestionField[] | null {
  if (request.mode !== 'form' || !('requestedSchema' in request) || !isRecord(request.requestedSchema)) return null;
  const properties = isRecord(request.requestedSchema.properties) ? request.requestedSchema.properties : {};
  const required = new Set(Array.isArray(request.requestedSchema.required) ? request.requestedSchema.required : []);
  const others = new Map<string, string>();
  for (const [key, schema] of Object.entries(properties)) {
    const question = isRecord(schema) ? otherFieldOf(schema) : undefined;
    if (question && question in properties) others.set(question, key);
  }
  const folded = new Set(others.values());
  const fields: QuestionField[] = [];
  for (const [key, schema] of Object.entries(properties)) {
    if (folded.has(key) || !isRecord(schema)) continue;
    const title = text(schema.title) ?? text(schema.description) ?? key;
    const description = text(schema.title) ? text(schema.description) : undefined;
    const base = { key, title, ...(description ? { description } : {}) };
    const isRequired = required.has(key);
    if (schema.type === 'string' && (Array.isArray(schema.oneOf) || Array.isArray(schema.enum))) {
      let options = optionsOf(schema.oneOf, schema.enum);
      const otherKey = others.get(key);
      const codexOther = otherKey ? options.find(option => option.value === CODEX_OTHER_OPTION) : undefined;
      if (codexOther) options = options.filter(option => option !== codexOther);
      fields.push({
        kind: 'choice', ...base, options, multiple: false, required: isRequired,
        ...(otherKey ? { other: { key: otherKey, ...(codexOther ? { value: codexOther.value } : {}) } } : {}),
      });
    } else if (schema.type === 'array' && isRecord(schema.items)) {
      const otherKey = others.get(key);
      fields.push({
        kind: 'choice', ...base, options: optionsOf(schema.items.anyOf, schema.items.enum), multiple: true, required: isRequired,
        ...(typeof schema.minItems === 'number' ? { minimum: schema.minItems } : {}),
        ...(typeof schema.maxItems === 'number' ? { maximum: schema.maxItems } : {}),
        ...(otherKey ? { other: { key: otherKey } } : {}),
      });
    } else if (schema.type === 'string') {
      const meta = isRecord(schema._meta) && isRecord(schema._meta.codex) ? schema._meta.codex : {};
      fields.push({ kind: 'text', ...base, required: isRequired, secret: meta.isSecret === true });
    } else if (schema.type === 'number' || schema.type === 'integer') {
      fields.push({
        kind: 'number', ...base, required: isRequired, integer: schema.type === 'integer',
        ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
        ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
      });
    } else if (schema.type === 'boolean') {
      fields.push({ kind: 'boolean', ...base, required: isRequired });
    } else {
      return null;
    }
  }
  return fields.length > 0 ? fields : null;
}

const DECLINE: CreateElicitationResponse = { action: 'decline' };
const CANCEL: CreateElicitationResponse = { action: 'cancel' };

// Puts one question in front of the user and answers it with what they
// gave. A subagent's is declined at once: nobody is watching it, and its
// contract tells it so. A cancelled turn withdraws the card and cancels.
export function requestAnswers(
  context: PermissionContext,
  request: CreateElicitationRequest,
  signal?: AbortSignal,
): Promise<CreateElicitationResponse> {
  if (signal?.aborted) return Promise.resolve(CANCEL);
  const fields = questionFields(request);
  if (!fields || 'subagent' in context.requester) return Promise.resolve(DECLINE);
  const question: QuestionRequest = {
    id: crypto.randomUUID(),
    sessionId: context.sessionId,
    requester: context.requester,
    message: request.message,
    fields,
  };
  return new Promise<CreateElicitationResponse>(resolve => {
    const onAbort = () => {
      const index = pending.findIndex(entry => entry.request === question);
      if (index !== -1) pending.splice(index, 1);
      notifyListeners();
      resolve(CANCEL);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.push({
      request: question,
      settle: answer => {
        signal?.removeEventListener('abort', onAbort);
        resolve(answer.action === 'accept' ? { action: 'accept', content: answer.content } : DECLINE);
      },
    });
    notifyListeners();
  });
}
