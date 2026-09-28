import path from 'path';
import { dataDirectory } from '../../dataDirectory';
import { readJson, writeJson } from '../../persistence/atomicJson';
import type { LimitPeriod } from '../types';

// Every fact about the models and vendors Sirus can talk to. This module
// imports nothing from the rest of the app but where its one file lives and
// the allowance windows' names: it is the leaf that the launch specs, the
// credential store, the login flows and the UI all read from.
//
// Which models there are is the vendors' to say: each runtime reports the
// models its harness offers, and `/model` lists those (see "What the vendors
// offer" below), so a model Claude Code or Codex adds is there without a
// change here. MODELS is what Sirus knows about a model beyond its name,
// including the strengths agents see when choosing a model for delegated work.
// Profiling a model is one row in MODELS. Adding a vendor starts with one row
// in VENDOR_TABLE; every per-vendor table, switch and enum elsewhere, the
// launch spec in src/agent_runtime/runtime/launch.ts among them, then fails
// to compile until it covers the new vendor (docs/ARCHITECTURE.md lists them).

// Researched model strengths, benchmarks, user reports, and pricing.
export interface ModelProfile {
  // What the model is good at and what it is wasted on, in prose.
  strengths: string;
  // Published results under the metric's own name, each with its score and
  // the version or date it was measured, so an ageing figure shows its age.
  // A number nobody published is left out rather than guessed at.
  benchmarks: readonly string[];
  // What people report after using it: where it shines, where it
  // disappoints, how fast and how wordy it is, and how it behaves when the
  // goal is under-specified.
  reviews: string;
  // Primary sources checked when this profile was researched.
  sources?: readonly string[];
  // List price in US dollars per million tokens.
  cost: { input: number; output: number; note?: string };
}

export interface ModelInfo {
  id: string;
  vendor: Vendor;
  profile: ModelProfile;
}

export interface VendorInfo {
  // The key settings and session files store the vendor under. Never shown:
  // `gpt` predates Codex being the only harness Sirus runs for it.
  id: Vendor;
  // The vendor's one name everywhere the user reads it: the harness Sirus
  // runs for it.
  displayName: string;
  // The same name as the user types it: `/login codex`, `/codex:status`, and
  // the tag on the vendor's own rows of the `/` menu.
  command: string;
  // The account a subscription signs in with, which is not always the
  // vendor's name: Codex takes a ChatGPT login.
  accountName: string;
  // The environment variable an API key may come from: the Sirus-facing
  // name `sources.ts` reads.
  apiKeyEnv: string;
  // The variable the vendor's own harness reads a key from: what an API-key
  // source is handed to the agent process as.
  credentialEnv: string;
  // Credentials a subscription child must not inherit from this process.
  scrubEnv: readonly string[];
  // The variable that points a subscription child at an isolated profile.
  profileDirEnv: string;
  // Whether the harness has to be logged in with an API key rather than
  // reading it from the environment. Codex ignores `OPENAI_API_KEY` while a
  // ChatGPT login sits in its home, so an API-key source gets a home of its
  // own and the adapter logs it in there; Claude Code reads the key as it is.
  apiKeyLogin: boolean;
  // The allowance window the sidebar shows for this vendor.
  limitPeriod: LimitPeriod;
}

const VENDOR_TABLE = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    command: 'claude',
    accountName: 'Claude',
    apiKeyEnv: 'ANTHROPIC_API',
    credentialEnv: 'ANTHROPIC_API_KEY',
    scrubEnv: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ],
    profileDirEnv: 'CLAUDE_CONFIG_DIR',
    apiKeyLogin: false,
    limitPeriod: '5-hour',
  },
  gpt: {
    id: 'gpt',
    displayName: 'Codex',
    command: 'codex',
    accountName: 'ChatGPT',
    apiKeyEnv: 'OPENAI_SECRET',
    credentialEnv: 'OPENAI_API_KEY',
    scrubEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    profileDirEnv: 'CODEX_HOME',
    apiKeyLogin: true,
    limitPeriod: '7-day',
  },
} as const;

export type Vendor = keyof typeof VENDOR_TABLE;

export const VENDOR_INFO: Record<Vendor, VendorInfo> = VENDOR_TABLE;

export const VENDORS: readonly Vendor[] = Object.keys(VENDOR_TABLE) as Vendor[];

// A vendor as the user typed it: its command word, or the stored key, which
// older habits and scripts still use (`/login gpt`).
export function vendorNamed(name: string | undefined): Vendor | undefined {
  const typed = name?.toLocaleLowerCase();
  return VENDORS.find(vendor => vendor === typed || VENDOR_TABLE[vendor].command === typed);
}

export function parseVendor(name: string | undefined): Vendor {
  const vendor = vendorNamed(name);
  if (vendor) return vendor;
  throw new Error(`Unknown provider "${name ?? ''}". Try: ${VENDORS.map(id => VENDOR_TABLE[id].command).join(', ')}`);
}

// Primary-source research refreshed 28 September 2026. Vendor-listed models
// without a profile retain the vendor’s own description in SpawnAgent.
export const MODELS: readonly ModelInfo[] = [
  {
    id: 'gpt-5.5',
    vendor: 'gpt',
    profile: {
      strengths: 'Legacy model for sustained coding, debugging and research across tools. Newer GPT-5.6 and GPT-6 tiers offer alternatives at lower prices.',
      benchmarks: [
        'Terminal-Bench 2.0 82.7% (OpenAI, April 2026)',
        'OSWorld-Verified 78.7% (OpenAI, April 2026)',
      ],
      reviews: 'Cursor’s launch testing reported greater persistence and more reliable tool use than GPT-5.4. OpenAI reports fewer tokens used on Codex tasks than its predecessor.',
      cost: { input: 5, output: 30, note: 'Above 272K input tokens, input costs double and output costs rise by 50%.' },
      sources: [
        'https://openai.com/index/introducing-gpt-5-5/',
        'https://developers.openai.com/api/docs/models/gpt-5.5',
      ],
    },
  },
  {
    id: 'gpt-5.6-luna',
    vendor: 'gpt',
    profile: {
      strengths: 'Fast, inexpensive work such as extraction, short summaries and small edits with clear instructions. Long-context recall is substantially below Terra and Sol.',
      benchmarks: [
        'Terminal-Bench 2.1 84.7% (OpenAI, July 2026)',
        'MRCR v2 256K–512K 41.3% (OpenAI, July 2026)',
      ],
      reviews: 'OpenAI positions Luna for volume and latency; reserve context-heavy investigations for a larger tier.',
      cost: { input: 0.2, output: 1.2 },
      sources: [
        'https://openai.com/index/gpt-5-6/',
      ],
    },
  },
  {
    id: 'gpt-5.6-terra',
    vendor: 'gpt',
    profile: {
      strengths: 'Balanced everyday implementation, review and data analysis, with stronger long-context recall than Luna.',
      benchmarks: [
        'SWE-bench Pro 63.4% (OpenAI, July 2026)',
        'MRCR v2 256K–512K 89.6% (OpenAI, July 2026)',
      ],
      reviews: 'A middle tier for routine work; compare with newer GPT-6 Sol at the same input price.',
      cost: { input: 2, output: 12 },
      sources: [
        'https://openai.com/index/gpt-5-6/',
      ],
    },
  },
  {
    id: 'gpt-5.6-sol',
    vendor: 'gpt',
    profile: {
      strengths: 'Complex coding, terminal work and research that need sustained reasoning across a large context.',
      benchmarks: [
        'SWE-bench Pro 64.6% (OpenAI, July 2026)',
        'Terminal-Bench 2.1 88.8% (OpenAI, July 2026)',
      ],
      reviews: 'Cognition reported strong coding-agent cost efficiency in OpenAI’s launch testing. GPT-6 offers newer alternatives.',
      cost: { input: 4, output: 20 },
      sources: [
        'https://openai.com/index/gpt-5-6/',
        'https://openai.com/index/introducing-gpt-6-sol-and-luna/',
      ],
    },
  },
  {
    id: 'gpt-6-luna',
    vendor: 'gpt',
    profile: {
      strengths: 'High-volume coding and everyday agent tasks where low cost and speed matter. Supports a 1,050,000-token context and reasoning through max.',
      benchmarks: [
        'DeepSWE v1.1 66.6% at max (OpenAI, September 2026)',
      ],
      reviews: 'OpenAI reports stronger factuality and clearer communication than GPT-5.6 Luna. Independent long-running production evidence is still limited.',
      cost: { input: 0.1, output: 0.5 },
      sources: [
        'https://openai.com/index/introducing-gpt-6-sol-and-luna/',
        'https://developers.openai.com/api/docs/models/gpt-6-luna',
      ],
    },
  },
  {
    id: 'gpt-6-sol',
    vendor: 'gpt',
    profile: {
      strengths: 'Everyday coding, multi-step workflows and reviews that need more reasoning than the smallest tier at a moderate price. Supports a 1,050,000-token context and reasoning through max.',
      benchmarks: [
        'DeepSWE v1.1 68.8% at max (OpenAI, September 2026)',
        'Agents’ Last Exam V1 56.4% at max (OpenAI, September 2026)',
      ],
      reviews: 'OpenAI reports improvements in coding and factuality over GPT-5.6 Sol. Astra remains its recommendation for the hardest work.',
      cost: { input: 2, output: 10 },
      sources: [
        'https://openai.com/index/introducing-gpt-6-sol-and-luna/',
        'https://developers.openai.com/api/docs/models/gpt-6-sol',
      ],
    },
  },
  {
    id: 'gpt-6-astra',
    vendor: 'gpt',
    profile: {
      strengths: 'OpenAI’s strongest tier for demanding software engineering, scientific research, browsing and computer use. Use it when correctness and sustained reasoning justify the higher cost.',
      benchmarks: [
        'Terminal-Bench 4.0 57.9% at high (OpenAI, September 2026)',
        'FrontierCode 1.1 Main 53.3% (OpenAI, September 2026)',
        'Terminal-Bench Science 0.1 64.6% (OpenAI, September 2026)',
      ],
      reviews: 'OpenAI’s launch partners report fewer iterations on complex coding and professional workflows. Its evaluation results depend on effort, harness and safeguards.',
      cost: { input: 10, output: 50 },
      sources: [
        'https://openai.com/index/gpt-6-astra/',
      ],
    },
  },
  {
    id: 'claude-opus-5',
    vendor: 'claude',
    profile: {
      strengths: 'Complex agentic coding, debugging and professional work requiring sustained follow-through.',
      benchmarks: [
        'CursorBench 3.2 within 0.5 percentage points of Fable 5 at half the cost per task (Anthropic, July 2026)',
      ],
      reviews: 'Anthropic’s launch testing reports stronger engineering and computer use than Opus 4.8. Opus 5.5 is the newer, cheaper successor.',
      cost: { input: 5, output: 25 },
      sources: [
        'https://www.anthropic.com/news/claude-opus-5',
        'https://www.anthropic.com/claude/opus',
      ],
    },
  },
  {
    id: 'claude-sonnet-5',
    vendor: 'claude',
    profile: {
      strengths: 'Routine and moderately complex implementation, debugging and review with a balance of speed, intelligence and cost.',
      benchmarks: [
        'BrowseComp and OSWorld-Verified cost-performance curves improve over Sonnet 4.6 (Anthropic, July 2026)',
      ],
      reviews: 'Early partners report better task completion and checking of its own output. Anthropic made its introductory $2/$10 token pricing permanent.',
      cost: { input: 2, output: 10 },
      sources: [
        'https://www.anthropic.com/news/claude-sonnet-5',
      ],
    },
  },
  {
    id: 'claude-haiku-4-5',
    vendor: 'claude',
    profile: {
      strengths: 'Fast, bounded coding subtasks, lookups and responsive pair programming where latency matters.',
      benchmarks: [
        'SWE-bench Verified 73.3%, 50 trials with a bash/edit scaffold (Anthropic, October 2025)',
      ],
      reviews: 'Augment’s launch evaluation put it at 90% of Sonnet 4.5 on its coding tasks. It suits scoped delegation more than open-ended investigations.',
      cost: { input: 1, output: 5 },
      sources: [
        'https://www.anthropic.com/news/claude-haiku-4-5',
      ],
    },
  },
  {
    id: 'claude-fable-5-1',
    vendor: 'claude',
    profile: {
      strengths: 'Difficult root-cause investigations, long-running coding and research with many interacting constraints.',
      benchmarks: [
        'Terminal-Bench 4.0 55.8% (Anthropic, September 2026)',
        'Humanity’s Last Exam with tools 65.6% (Anthropic, September 2026)',
      ],
      reviews: 'Anthropic reports that Millennium used it to diagnose a rare crash other models had missed. Safeguards and fallback models affect some published scores; Opus 5.5 now offers a cheaper alternative.',
      cost: { input: 10, output: 50 },
      sources: [
        'https://www.anthropic.com/claude-fable-and-mythos-5-1',
      ],
    },
  },
  {
    id: 'claude-opus-5-5',
    vendor: 'claude',
    profile: {
      strengths: 'Large code migrations, audits, difficult debugging and long-running agent tasks that need frontier reasoning.',
      benchmarks: [
        'Terminal-Bench 4.0 66.4% at xhigh (Anthropic, September 2026)',
        'FrontierCode v1.1 Main 54.4% at max (Anthropic, September 2026)',
        'CursorBench 4.0 57.8% (Anthropic, September 2026)',
      ],
      reviews: 'Early testers report large migrations and audits completing with fewer tokens and steps. Anthropic reports roughly 40% lower typical task costs than Opus 5; some evaluations use fallback models when safeguards intervene.',
      cost: { input: 4, output: 20 },
      sources: [
        'https://www.anthropic.com/claude-opus-5-5',
        'https://www.anthropic.com/claude/opus',
      ],
    },
  },
];

// The model a new session starts with when nothing else has been chosen.
export const DEFAULT_MODEL = 'gpt-5.6-luna';

const BY_ID = new Map(MODELS.map(model => [model.id, model]));

export function modelInfo(id: string): ModelInfo | undefined {
  return BY_ID.get(id);
}

// A model Sirus can run: one it has a profile for, or one a vendor lists.
export function isKnownModel(id: string): boolean {
  return BY_ID.has(id) || listedVendorOf(id) !== undefined;
}

export function modelIds(): string[] {
  return [...new Set(VENDORS.flatMap(modelsOf))];
}

// The model a short reference names without guessing: an id in any case, or
// a vendor alias written without its qualifier (`opus` for Claude's
// `opus[1m]`). A mention is read out of prose, so it goes no further; `/model`
// also matches part of an id.
export function modelNamed(reference: string, ids: readonly string[] = modelIds()): string | undefined {
  const key = reference.toLocaleLowerCase();
  const exact = ids.find(id => id.toLocaleLowerCase() === key);
  if (exact) return exact;
  const aliases = ids.filter(id => id.toLocaleLowerCase().replace(/\[[^\]]+\]$/, '') === key);
  return aliases.length === 1 ? aliases[0] : undefined;
}

// Selectable models come only from the vendor. Profiles describe models;
// they do not establish availability, even before the first discovery.
export function modelsOf(vendor: Vendor): string[] {
  return (listedModels()[vendor] ?? []).map(model => model.id);
}

// The vendor's models that have a profile, in the table's order.
export function profiledModelsOf(vendor: Vendor): string[] {
  return MODELS.filter(model => model.vendor === vendor).map(model => model.id);
}

export function vendorOf(id: string): Vendor | undefined {
  return modelInfo(id)?.vendor ?? listedVendorOf(id);
}

// ── What the vendors offer ──────────────────────────────────────────────
// Each runtime reports the models its harness offers when its session opens:
// Claude Code's aliases (`sonnet`, `opus[1m]`), which always name that line's
// newest model, and Codex's ids. The last list per vendor is kept, on disk
// too, so the menu is right before any runtime has started. A model only a
// vendor lists can be chosen and run without a catalog profile. What a
// runtime shows about its own model (its reasoning depths, its window) is
// kept beside the lists, by model id.

export interface ListedModel {
  id: string;
  // The vendor's own description, for the menu.
  description: string;
}

// What a runtime showed about the model it runs, beyond the name: the
// reasoning depths its effort option offers (none when it has no such
// option), the one the vendor picks when nobody sets one, and the context
// window it reported. Claude's adapter reports a
// 200k window until its first reply names the real one, so the largest
// window seen stands, and the gauge does not read 20% and then 4% for the
// same tokens.
export interface ModelFacts {
  efforts?: string[];
  defaultEffort?: string;
  window?: number;
}

const LISTED_FILE_VERSION = 1;

interface Listed {
  file: string;
  byVendor: Partial<Record<Vendor, ListedModel[]>>;
  facts: Record<string, ModelFacts>;
}

// Read once per data directory, which the test suite moves between files.
let listed: Listed | null = null;

function listedFile(): string {
  return path.join(dataDirectory(), 'listed-models.json');
}

function isListedModel(value: unknown): value is ListedModel {
  if (typeof value !== 'object' || value === null) return false;
  const model = value as Record<string, unknown>;
  return typeof model.id === 'string' && model.id.length > 0 && typeof model.description === 'string';
}

function isModelFacts(value: unknown): value is ModelFacts {
  if (typeof value !== 'object' || value === null) return false;
  const facts = value as Record<string, unknown>;
  return (facts.efforts === undefined || (Array.isArray(facts.efforts) && facts.efforts.every(level => typeof level === 'string')))
    && (facts.defaultEffort === undefined || typeof facts.defaultEffort === 'string')
    && (facts.window === undefined || (typeof facts.window === 'number' && facts.window > 0));
}

function readListed(): Listed {
  const file = listedFile();
  if (listed?.file === file) return listed;
  const read = readJson(file) as { version?: unknown; vendors?: Record<string, unknown>; facts?: Record<string, unknown> } | null;
  const byVendor: Partial<Record<Vendor, ListedModel[]>> = {};
  const facts: Record<string, ModelFacts> = {};
  if (read?.version === LISTED_FILE_VERSION && read.vendors) {
    for (const vendor of VENDORS) {
      const models = read.vendors[vendor];
      if (Array.isArray(models)) byVendor[vendor] = models.filter(isListedModel);
    }
    for (const [id, value] of Object.entries(read.facts ?? {})) if (isModelFacts(value)) facts[id] = value;
  }
  listed = { file, byVendor, facts };
  return listed;
}

function writeListed(next: Omit<Listed, 'file'>): void {
  listed = { file: listedFile(), ...next };
  writeJson(listed.file, { version: LISTED_FILE_VERSION, vendors: next.byVendor, facts: next.facts });
}

function listedModels(): Partial<Record<Vendor, ListedModel[]>> {
  return readListed().byVendor;
}

export function modelFacts(id: string): ModelFacts {
  return readListed().facts[id] ?? {};
}

// Keeps what a runtime just showed about its model. A window only grows.
export function rememberModelFacts(id: string, facts: ModelFacts): void {
  const current = readListed();
  const previous = current.facts[id] ?? {};
  const next: ModelFacts = {
    ...previous,
    ...(facts.efforts ? { efforts: [...facts.efforts] } : {}),
    ...(facts.defaultEffort ? { defaultEffort: facts.defaultEffort } : {}),
    ...(facts.window && facts.window > (previous.window ?? 0) ? { window: facts.window } : {}),
  };
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  writeListed({ byVendor: current.byVendor, facts: { ...current.facts, [id]: next } });
}

function listedVendorOf(id: string): Vendor | undefined {
  const byVendor = listedModels();
  return VENDORS.find(vendor => byVendor[vendor]?.some(model => model.id === id));
}

// The vendor's words for a model it lists, or undefined.
export function listedDescription(id: string): string | undefined {
  const byVendor = listedModels();
  for (const vendor of VENDORS) {
    const model = byVendor[vendor]?.find(candidate => candidate.id === id);
    if (model) return model.description;
  }
  return undefined;
}

// Keeps what a vendor's runtime just said it offers.
export function rememberListedModels(vendor: Vendor, models: readonly ListedModel[]): void {
  const current = readListed();
  if (JSON.stringify(current.byVendor[vendor] ?? []) === JSON.stringify(models)) return;
  writeListed({ byVendor: { ...current.byVendor, [vendor]: [...models] }, facts: current.facts });
}
