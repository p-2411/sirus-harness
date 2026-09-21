import path from 'path';
import { choice, TypeSafeClient, type ChoiceCriteria } from '@typesafe-ai/sdk';
import { parseFileMentions } from '../fileMentions';
import { allProviders } from './providers';
import { latestModelOf, workerModelsOf, VENDOR_INFO, type ModelProfile, type Vendor } from './providers/catalog';
import type { Provider } from './providers/provider';
import { cachedSubscriptionRemaining } from './providers/usage';
import { parseThinkingLevel, type ThinkingLevel } from './types';

// Jev, TypeSafe AI's System One model, picks a new session's model from its
// first prompt: one typed choice between the latest model of each vendor
// that can still run, answered in well under a second. Each candidate is
// described by its catalog profile, what it is for, what it scored, what
// users found and what it costs, with its vendor's remaining allowance added
// live. Nothing here blocks a turn for long or fails it: no key, a slow
// answer, an error or an unsure answer all leave the session on the model it
// started with.

// The key comes from the environment like the vendors' own do.
export const JEV_API_KEY_ENV = 'JEV_API';

// One attempt, no retries: a pick that takes longer than this is not worth
// the wait before the first turn.
export const ROUTING_TIMEOUT_MS = 2_000;

// Below this the distribution is spread across the candidates and the pick is
// a coin toss; the draft's own model is as good.
export const ROUTING_CONFIDENCE = 0.5;

// A model Jev may pick, with everything it is judged on. The profile is the
// catalog's; the vendor is carried so the live allowance can be attached to it
// at routing time, which is the one part of the criteria the catalog cannot
// know.
export interface RoutingCandidate {
  model: string;
  vendor: Vendor;
  profile: ModelProfile;
}

export interface RoutingInput {
  prompt: string;
  directory: string;
}

export interface RoutingPick {
  model: string;
  confidence: number;
}

// A vendor can be routed to when it has a credential with allowance left: an
// API key always has; a subscription has when the cached figure the sidebar
// refreshes (the vendor's own window) is above zero. A vendor the sidebar has
// not read yet counts as available rather than making the first turn wait on
// a live read.
function usableVendor(provider: Provider): boolean {
  return provider.sources.list().some(source => source.kind === 'api'
    || (cachedSubscriptionRemaining(provider.vendor.id, source.profile, provider.vendor.limitPeriod) ?? 1) > 0);
}

// The latest model of every vendor that can still run.
export function routingCandidates(): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];
  for (const provider of allProviders()) {
    const latest = latestModelOf(provider.vendor.id);
    if (!latest || !usableVendor(provider)) continue;
    candidates.push({ model: latest.id, vendor: latest.vendor, profile: latest.profile });
  }
  return candidates;
}

// One vendor's remaining allowance as a percentage, or null for one on an
// API key (no window to run out of) or with no cached figure yet.
export interface VendorAllowance {
  vendor: Vendor;
  remaining: number | null;
}

// Prices read as money rather than as floats: $0.20, $10, $1.20.
function dollars(perMillion: number): string {
  return `$${perMillion.toFixed(2).replace(/\.00$/, '')}`;
}

// What one candidate looks like to Jev: the researched profile, plus the
// allowance its vendor has left, which is live and so cannot live in the
// catalog. A vendor with no entry at all has not been read rather than being
// spent, and says so.
function candidateCriteria(candidate: RoutingCandidate, allowance: readonly VendorAllowance[]): string {
  const { profile } = candidate;
  const vendor = VENDOR_INFO[candidate.vendor];
  const entry = allowance.find(item => item.vendor === candidate.vendor);
  // No cached figure reads the same as an API key here: both mean there is no
  // known window to spend down, which is how the candidates treat them too.
  const remaining = entry === undefined
    ? 'not read yet'
    : entry.remaining === null
      ? 'API key, no window'
      : `${entry.remaining}% of the ${vendor.limitPeriod} window remaining`;
  const { input, output, note } = profile.cost;
  return [
    `Strengths: ${profile.strengths}`,
    `Benchmarks: ${profile.benchmarks.join('; ')}.`,
    `In practice: ${profile.reviews}`,
    `Cost: ${dollars(input)} per million input tokens, ${dollars(output)} per million output${note ? ` (${note})` : ''}.`,
    `Allowance: ${vendor.displayName} has ${remaining}.`,
  ].join('\n');
}

function criteriaFor(candidates: readonly RoutingCandidate[], allowance: readonly VendorAllowance[]): ChoiceCriteria {
  return Object.fromEntries(candidates.map(candidate => [candidate.model, candidateCriteria(candidate, allowance)]));
}

// How Jev is told to read a profile. The same sentence ends both questions
// about a model, because the trade is the same one either way.
const WEIGHING = 'Weigh the benchmarks and what users report against what the work actually demands, cost against how large that work is, and remaining allowance against both: a vendor near the end of its window should lose a close call, while work that plainly needs the stronger model should still get it.';

// What Jev answers with: the shape the SDK's `systemOne` returns for choice
// questions, narrowed to what the routers read and keyed by the names they
// ask under.
export interface RoutingClient {
  systemOne(request: {
    state: Record<string, string | string[]>;
    questions: Record<string, ReturnType<typeof choice<ChoiceCriteria>>>;
  }, options: { signal?: AbortSignal; timeout: number; retry: { maxRetries: number } }): Promise<{
    answers: Record<string, { choice: string; confidence: number }>;
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
  options: { signal?: AbortSignal; client?: RoutingClient | null; allowance?: readonly VendorAllowance[] } = {},
): Promise<RoutingPick | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { model: candidates[0].model, confidence: 1 };
  const client = options.client === undefined ? defaultClient() : options.client;
  if (!client) return null;
  const criteria = criteriaFor(candidates, options.allowance ?? vendorAllowance());
  try {
    const { answers } = await client.systemOne({
      state: {
        request: input.prompt,
        mentionedFiles: parseFileMentions(input.prompt, input.directory).map(mention => mention.path),
        project: path.basename(input.directory),
      },
      questions: {
        model: choice(
          `A software engineer is starting a coding session in the project with this first request. Which model should run the session? ${WEIGHING} A small or routine request should go to the model that handles it without over-thinking.`,
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
// with allowance, except the ones the catalog keeps off the worker list, each
// with its own vendor's allowance rendered into its criteria, so a vendor near
// its limit is chosen less. The state carries the task, the files it names and
// the project's name. Two questions in one call: the model, then how hard to
// think.

export interface WorkerRoutingInput {
  task: string;
  directory: string;
}

export interface WorkerPick {
  model: string;
  thinkingLevel: ThinkingLevel;
}

export function workerCandidates(): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];
  for (const provider of allProviders()) {
    if (!usableVendor(provider)) continue;
    for (const model of workerModelsOf(provider.vendor.id)) {
      candidates.push({ model: model.id, vendor: model.vendor, profile: model.profile });
    }
  }
  return candidates;
}

// Every vendor the user has a credential for. A subscription reports what the
// sidebar last cached, and the most generous of several stands for the
// vendor; an API key has no window at all, so a vendor holding one reports
// nothing however little its subscription has left.
export function vendorAllowance(): VendorAllowance[] {
  const allowances: VendorAllowance[] = [];
  for (const provider of allProviders()) {
    const sources = provider.sources.list();
    if (sources.length === 0) continue;
    let remaining: number | null = null;
    for (const source of sources) {
      if (source.kind === 'api') {
        remaining = null;
        break;
      }
      const cached = cachedSubscriptionRemaining(provider.vendor.id, source.profile, provider.vendor.limitPeriod);
      if (cached !== undefined && (remaining === null || cached > remaining)) remaining = cached;
    }
    allowances.push({ vendor: provider.vendor.id, remaining });
  }
  return allowances;
}

// The levels a worker may be routed to, and what each one is for. `max` is
// left off on purpose: a worker that thinks that hard costs more than the
// delegation saves, and the owner can still set it by hand.
const WORKER_THINKING: Record<Exclude<ThinkingLevel, 'max'>, string> = {
  low: 'Fastest, with lighter reasoning: a mechanical or fully specified change, a lookup, a rename, a small edit whose answer is already plain.',
  medium: 'Balanced speed and reasoning depth: ordinary scoped work with a few judgement calls in it, such as a contained feature or a straightforward review.',
  high: 'Deep reasoning for complex work: several files or constraints to hold at once, a careful review, a design decision, or a bug whose cause is not obvious.',
  xhigh: 'Extended reasoning for difficult, long-running work: a hidden root cause, a large multi-file refactor, a security audit, anything that will take many careful steps to get right.',
};

// The pick for one task, or null when Jev is not configured, did not answer
// in time, failed, or was unsure about the model; the caller then keeps the
// owner's model and level. An unsure thinking level alone falls back to the
// owner's level while the model pick stands.
export async function routeWorker(
  input: WorkerRoutingInput,
  candidates: readonly RoutingCandidate[],
  allowance: readonly VendorAllowance[],
  options: { signal?: AbortSignal; client?: RoutingClient | null; fallbackLevel?: ThinkingLevel } = {},
): Promise<WorkerPick | null> {
  const fallbackLevel = options.fallbackLevel ?? 'high';
  if (candidates.length === 0) return null;
  // One candidate is not a choice, and the level alone does not earn a round
  // trip before the worker's first turn: it takes the owner's.
  if (candidates.length === 1) return { model: candidates[0].model, thinkingLevel: fallbackLevel };
  const client = options.client === undefined ? defaultClient() : options.client;
  if (!client) return null;
  const criteria = criteriaFor(candidates, allowance);
  try {
    const { answers } = await client.systemOne({
      state: {
        task: input.task,
        mentionedFiles: parseFileMentions(input.task, input.directory).map(mention => mention.path),
        project: path.basename(input.directory),
      },
      questions: {
        model: choice(
          `A coding agent is delegating this task to a subagent that will carry it out on its own. Which model should the subagent run on? ${WEIGHING} Routine, well-scoped work belongs on a cheaper, faster model.`,
          criteria,
        ),
        thinkingLevel: choice(
          'How hard should that subagent think about this task? Pick the level the task actually needs: more reasoning costs time and tokens, less risks a shallow or wrong answer.',
          WORKER_THINKING,
        ),
      },
    }, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: ROUTING_TIMEOUT_MS,
      retry: { maxRetries: 0 },
    });
    const { choice: model, confidence } = answers.model;
    if (confidence < ROUTING_CONFIDENCE || !candidates.some(candidate => candidate.model === model)) return null;
    // A level Jev is unsure of, or one it was not offered, costs the model
    // pick nothing: the worker takes the owner's level and keeps the model.
    const answered = answers.thinkingLevel;
    const level = parseThinkingLevel(answered?.choice);
    const sure = level !== null && level in WORKER_THINKING && (answered?.confidence ?? 0) >= ROUTING_CONFIDENCE;
    return { model, thinkingLevel: sure ? level : fallbackLevel };
  } catch {
    return null;
  }
}
