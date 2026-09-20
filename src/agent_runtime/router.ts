import path from 'path';
import { choice, TypeSafeClient, type ChoiceCriteria } from '@typesafe-ai/sdk';
import { parseFileMentions } from '../fileMentions';
import { allProviders } from './providers';
import { latestModelOf, type Vendor } from './providers/catalog';
import { cachedSubscriptionRemaining } from './providers/usage';
import type { ThinkingLevel } from './types';

// Jev, TypeSafe AI's System One model, picks a new session's model from its
// first prompt: one typed choice between the latest model of each vendor
// that can still run, answered in well under a second. Nothing here blocks
// a turn for long or fails it: no key, a slow answer, an error or an unsure
// answer all leave the session on the model it started with.

// The key comes from the environment like the vendors' own do.
export const JEV_API_KEY_ENV = 'JEV_API';

// One attempt, no retries: a pick that takes longer than this is not worth
// the wait before the first turn.
export const ROUTING_TIMEOUT_MS = 2_000;

// Below this the distribution is spread across the candidates and the pick is
// a coin toss; the draft's own model is as good.
export const ROUTING_CONFIDENCE = 0.5;

export interface RoutingCandidate {
  model: string;
  strengths: string;
}

export interface RoutingInput {
  prompt: string;
  directory: string;
}

export interface RoutingPick {
  model: string;
  confidence: number;
}

// The latest model of every vendor with a credential that has allowance
// left: an API key always has; a subscription has when the cached figure the
// sidebar refreshes (the vendor's own window) is above zero. A vendor the
// sidebar has not read yet counts as available rather than making the first
// turn wait on a live read.
export function routingCandidates(): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];
  for (const provider of allProviders()) {
    const latest = latestModelOf(provider.vendor.id);
    if (!latest?.strengths) continue;
    const usable = provider.sources.list().some(source => source.kind === 'api'
      || (cachedSubscriptionRemaining(provider.vendor.id, source.profile, provider.vendor.limitPeriod) ?? 1) > 0);
    if (usable) candidates.push({ model: latest.id, strengths: latest.strengths });
  }
  return candidates;
}

// What Jev answers with: the shape the SDK's `systemOne` returns for one
// choice question, narrowed to what the router reads.
export interface RoutingClient {
  systemOne(request: {
    state: Record<string, string | string[]>;
    questions: { model: ReturnType<typeof choice<ChoiceCriteria>> };
  }, options: { signal?: AbortSignal; timeout: number; retry: { maxRetries: number } }): Promise<{
    answers: { model: { choice: string; confidence: number } };
  }>;
}

function defaultClient(): RoutingClient | null {
  const apiKey = process.env[JEV_API_KEY_ENV]?.trim();
  return apiKey ? new TypeSafeClient({ apiKey }) : null;
}

// The pick for one prompt among the candidates, or null when Jev is not
// configured, did not answer in time, failed, or was unsure. With one
// candidate there is nothing to ask.
export async function routeSessionModel(
  input: RoutingInput,
  candidates: readonly RoutingCandidate[],
  options: { signal?: AbortSignal; client?: RoutingClient | null } = {},
): Promise<RoutingPick | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { model: candidates[0].model, confidence: 1 };
  const client = options.client === undefined ? defaultClient() : options.client;
  if (!client) return null;
  const criteria: ChoiceCriteria = Object.fromEntries(candidates.map(candidate => [candidate.model, candidate.strengths]));
  try {
    const { answers } = await client.systemOne({
      state: {
        request: input.prompt,
        mentionedFiles: parseFileMentions(input.prompt, input.directory).map(mention => mention.path),
        project: path.basename(input.directory),
      },
      questions: {
        model: choice(
          'A software engineer is starting a coding session in the project with this first request. Which model should run the session? Pick the one whose strengths fit the work the request describes; when the request is small or routine, prefer the model that handles routine work without over-thinking.',
          criteria,
        ),
      },
    }, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: ROUTING_TIMEOUT_MS,
      retry: { maxRetries: 0 },
    });
    const { choice: model, confidence } = answers.model;
    if (confidence < ROUTING_CONFIDENCE || !candidates.some(candidate => candidate.model === model)) return null;
    return { model, confidence };
  } catch {
    return null;
  }
}

// Jev also picks a worker's model and thinking level when the session has
// no fixed subagent model. Candidates are every catalog model of a vendor
// with allowance, except the ones the catalog keeps off the worker list;
// the state carries the task, the project's name and each vendor's remaining
// allowance, so a vendor near its limit is chosen less. Two questions in one
// call: the model, then how hard to think.

export interface WorkerCandidate {
  model: string;
  strengths: string;
}

export interface WorkerRoutingInput {
  task: string;
  directory: string;
}

export interface WorkerPick {
  model: string;
  thinkingLevel: ThinkingLevel;
}

// One vendor's remaining allowance as a percentage, or null for one on an
// API key (no window to run out of) or with no cached figure yet.
export interface VendorAllowance {
  vendor: Vendor;
  remaining: number | null;
}

export function workerCandidates(): WorkerCandidate[] {
  throw new Error('not implemented');
}

export function vendorAllowance(): VendorAllowance[] {
  throw new Error('not implemented');
}

// The pick for one task, or null when Jev is not configured, did not answer
// in time, failed, or was unsure about the model; the caller then keeps the
// owner's model and level. An unsure thinking level alone falls back to the
// owner's level while the model pick stands.
export async function routeWorker(
  input: WorkerRoutingInput,
  candidates: readonly WorkerCandidate[],
  allowance: readonly VendorAllowance[],
  options: { signal?: AbortSignal; client?: RoutingClient | null; fallbackLevel?: ThinkingLevel } = {},
): Promise<WorkerPick | null> {
  void input; void candidates; void allowance; void options;
  throw new Error('not implemented');
}
