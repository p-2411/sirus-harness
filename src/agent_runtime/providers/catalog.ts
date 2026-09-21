// Every fact about the models and vendors Sirus can talk to, as data. This
// module imports nothing from the rest of the app: it is the leaf that the
// launch specs, the credential store, the login flows and the UI all read
// from.
//
// Adding a model is one row in MODELS. Adding a vendor is one row in
// VENDOR_TABLE plus a launch spec in src/agent_runtime/runtime/launch.ts.

// What Jev is told about a model when it routes. Four kinds of evidence, kept
// apart because they answer different questions: what the model is for, what
// it measurably does, what living with it is like, and what it costs.
// Researched, and the owner's to correct; it decides the routing more than
// anything else. A model's remaining allowance is not here: that is live, and
// the router adds it per candidate.
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
  // List price in US dollars per million tokens.
  cost: { input: number; output: number; note?: string };
}

export interface ModelInfo {
  id: string;
  vendor: Vendor;
  // The vendor's newest model: what Jev chooses between when it picks a new
  // session's model. One per vendor.
  latest?: true;
  // Never offered as a worker. A subagent is left alone with a task for a
  // while, which is not what every model in the line is for.
  worker?: false;
  profile: ModelProfile;
}

export interface VendorInfo {
  id: Vendor;
  // The vendor's name as it appears on an API key, for messages to the user.
  displayName: string;
  // The consumer account behind a subscription, for messages to the user.
  accountName: string;
  // The short label the sidebar shows next to a subscription's remaining
  // allowance.
  sidebarLabel: string;
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
  limitPeriod: '5-hour' | '7-day';
}

const VENDOR_TABLE = {
  claude: {
    id: 'claude',
    displayName: 'Anthropic',
    accountName: 'Claude',
    sidebarLabel: 'claude',
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
    displayName: 'OpenAI',
    accountName: 'ChatGPT',
    sidebarLabel: 'codex',
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

export function parseVendor(name: string | undefined): Vendor {
  if (name !== undefined && name in VENDOR_TABLE) return name as Vendor;
  throw new Error(`Unknown provider "${name ?? ''}". Try: ${VENDORS.join(', ')}`);
}

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'gpt-5.6-luna',
    vendor: 'gpt',
    profile: {
      strengths: 'OpenAI\'s cheapest and fastest tier: high-volume work that needs little reasoning, such as classification, extraction, routing, short summaries and small mechanical edits where the change is already decided. It shares the family\'s 1M-token window but recalls far less of it, and has no top reasoning effort, so anything that must hold a large codebase or a subtle bug in mind belongs elsewhere.',
      benchmarks: [
        'Terminal-Bench 2.1 84.7%, about four points under Sol (July 2026)',
        'Agents\' Last Exam 50.3, within 3.3 of Sol (July 2026)',
        'MRCR v2 long-context recall 41.3%, against Sol\'s 91.5% (July 2026)',
        'Artificial Analysis Coding Agent Index 75, Intelligence Index 51 (July 2026)',
        'Arena creative writing Elo 1411, rank 81 (13 Sept 2026)',
      ],
      reviews: 'The batch workhorse: a thousand news summaries for $3.80 in twelve minutes with no malformed JSON, and structured instructions followed to the letter. It comes apart on open-ended reasoning and on long inputs, where it starts summarising instead of citing at around 300K tokens, and Artificial Analysis found it unusually verbose for its tier.',
      cost: { input: 0.2, output: 1.2, note: 'after the 80% cut of 30 July 2026; the cheapest tier by an order of magnitude' },
    },
  },
  {
    id: 'gpt-5.6-terra',
    vendor: 'gpt',
    profile: {
      strengths: 'The balanced middle of the GPT-5.6 family and OpenAI\'s default for everyday work: scoped implementation, first-pass review, document analysis, data work and general agentic tasks, at well under half Sol\'s price and about twice its throughput. Recall across its 1M-token window is close behind Sol\'s. Effort goes up to max but not Sol\'s parallel ultra mode, so the hardest open-ended reasoning belongs on Sol and bulk mechanical work on Luna.',
      benchmarks: [
        'SWE-bench Pro 63.4%, 1.2 points behind Sol on fewer tokens (July 2026)',
        'Terminal-Bench 2.1 87.4% (July 2026)',
        'Agents\' Last Exam 50.4 (July 2026)',
        'MRCR v2 long-context recall 89.6% (July 2026)',
        'Artificial Analysis Coding Agent Index 77, Intelligence Index 55 (July 2026)',
        'Arena creative writing Elo 1426, rank 69 (13 Sept 2026)',
      ],
      reviews: 'Reviewers treat it as the sensible default: near-Sol results on ordinary production work at half the cost, competent on anything routine. Precision falls away at scale, and a 700K-token read missed two references buried past the 500K mark; several argue it is a step back from GPT-5.5 on the benchmarks OpenAI did not print.',
      cost: { input: 2, output: 12, note: 'after the 20% cut of 30 July 2026' },
    },
  },
  {
    id: 'gpt-5.6-sol',
    vendor: 'gpt',
    profile: {
      strengths: 'OpenAI\'s flagship of the GPT-5.6 generation, for long-horizon agentic work that has to persist across files, tests and follow-up fixes, and for hard reasoning, terminal and computer-use tasks, browsing and security research. The family\'s best recall over its 1M-token window, with an ultra mode that fans the work out to parallel subagents. Wasted on classification, summaries and routine scoped edits.',
      benchmarks: [
        'SWE-bench Pro 64.6% (July 2026)',
        'Terminal-Bench 2.1 88.8%, 91.9% in ultra mode (July 2026)',
        'Terminal-Bench 4.0 37.3%, a generation behind the 2026 frontier (Sept 2026)',
        'BrowseComp 90.4% (July 2026); GPQA Diamond above 92% (July 2026)',
        'MRCR v2 long-context recall 91.5% (July 2026)',
        'EQ-Bench creative writing Elo 1963, rank 3 (Sept 2026)',
        'Arena creative writing Elo 1473, rank 12 (13 Sept 2026)',
      ],
      reviews: 'Fast and decisive on work that is already specified: a full FastAPI migration in one pass in under nine minutes, and the best presentation output Artificial Analysis has rated. Diagnosis is its weak spot, and testers watched it patch the symptom of a websocket race twice while a Claude model found the cause. Strong on browsing and security research.',
      cost: { input: 5, output: 30 },
    },
  },
  {
    id: 'gpt-6-astra',
    vendor: 'gpt',
    latest: true,
    profile: {
      strengths: 'OpenAI\'s most capable model, at its best carrying out work that is already well defined. A 1M-token window holds a whole mid-sized repository at once, so it suits large refactors and long multi-step tasks in one session, and it leads on math, browser and computer use. Effort adjusts from low to max, so routine work is not over-thought. Expert-level academic reasoning is where it trails.',
      benchmarks: [
        'Terminal-Bench 4.0 57.7% vs Fable 5.1\'s 55.8%; DeepSWE 74.1% (Sept 2026)',
        'FrontierCode 1.1 53.3%, behind both Claudes; no SWE-bench figure',
        'OSWorld 2.0 72.6%, ScreenSpot-Pro 92.7% (Sept 2026)',
        'BrowseComp 91.5%, just above Opus 5 (Sept 2026)',
        'Humanity\'s Last Exam with tools 57.2%, behind every Claude (Sept 2026)',
        'GPQA Diamond 96.0%, FrontierMath Tier 4 97.6%, MRCR v2 96.3% (Sept 2026)',
        'Arena creative writing Elo 1461, rank 25 (13 Sept 2026)',
      ],
      reviews: 'The executor of the two frontier models: it one-shots well-specified features, drives desktop and browser workflows unsupervised, and holds a multi-day build together. It assumes where Fable asks, moving past ambiguity fast and flagging fewer of its own leaps. Concise and cheap per task.',
      cost: { input: 10, output: 50, note: 'cached input $1; dearer above 272K tokens' },
    },
  },
  {
    id: 'claude-opus-5',
    vendor: 'claude',
    profile: {
      strengths: 'Anthropic\'s model for complex agentic coding and enterprise work, and where it says to start for most workloads: a large codebase to navigate, multi-file refactors across tightly coupled code, debugging that spans systems, vision-heavy workflows, computer use, and autonomous runs measured in hours. 1M-token context, at half Fable 5.1\'s price for coding within a whisker of it.',
      benchmarks: [
        'Frontier-Bench v0.1 agentic terminal coding 43.3%, against Fable 5\'s 33.7% (July 2026)',
        'Terminal-Bench 2.1 89.1% at max effort, Terminal-Bench 4.0 52.3% (2026)',
        'CursorBench 3.2 within 0.5% of Fable 5 at half the cost (July 2026)',
        'BrowseComp 90.8%; Humanity\'s Last Exam with tools 63.6% (2026)',
        'ARC-AGI-3 30.2% against Sol\'s 7.8%; FrontierMath Tier 4 73.2% (2026)',
        'EQ-Bench creative writing Elo 2121, rank 1 (Sept 2026)',
        'No SWE-bench figure published',
      ],
      reviews: 'It plans deliberately, checks its own work unasked and keeps going for hours, which reviewers value on ambiguous, design-heavy work. It is expensive with it: about 50% more input and 65% more output tokens than a GPT-5.6 call for the same review, and it widens the task unless the deliverable is spelled out.',
      cost: { input: 5, output: 25 },
    },
  },
  {
    id: 'claude-sonnet-5',
    vendor: 'claude',
    profile: {
      strengths: 'Anthropic\'s best combination of speed and intelligence, for work that is well scoped however large: code generation and short coding sessions, data analysis, documentation and other writing, visual understanding and ordinary agentic tool use, at a fraction of the price above it and with the same 1M-token context. Ambiguous architecture calls and subtle multi-system debugging belong higher.',
      benchmarks: [
        'SWE-bench Pro 63.2, against Opus 4.8\'s 69.2 (launch, 30 June 2026)',
        'SWE-bench Verified 72.7% (third-party, 2026)',
        'Terminal-Bench 2.1 80.4, up 13.4 on Sonnet 4.6; CursorBench 57% (June 2026)',
        'Humanity\'s Last Exam with tools 57.4 (June 2026)',
        'OSWorld-Verified 81.2; GDPval-AA v2 knowledge work Elo 1618 (June 2026)',
        'Arena creative writing Elo 1437, rank 55 (13 Sept 2026)',
      ],
      reviews: 'The best of the middle tier on scoped agentic coding, at its best given named files and a clear target: it follows a multi-step change through and checks itself before handing back. Adaptive thinking makes it slower than Sonnet 4.6 on small edits, which it over-thinks, at twice the output tokens and three times the agentic turns.',
      cost: { input: 3, output: 15, note: 'the $2/$10 introductory rate ended 31 Aug 2026' },
    },
  },
  {
    id: 'claude-haiku-4-5',
    vendor: 'claude',
    worker: false,
    profile: {
      strengths: 'Anthropic\'s fastest and cheapest model, with near-frontier intelligence for its class: real-time responses, high-volume processing, and simple, fully specified tasks. A 200K-token context, a knowledge cutoff more than a year older than the rest of the line, and the older manual thinking rather than the adaptive kind, so it loses the thread on long multi-step work, large codebases and anything whose answer is not already clear.',
      benchmarks: [
        'SWE-bench Verified 73.3%, averaged over 50 trials with a 128K thinking budget (Oct 2025)',
        'Matches Sonnet 4 on coding, computer use and agentic tasks (Anthropic, Oct 2025)',
        'Absent from the 2026 research and writing leaderboards',
      ],
      reviews: 'Rated the pick of the cheap tier for latency and for straightforward code, and it holds up on well-specified edits. It is out of its depth on anything exploratory: the short context, the older cutoff and the lack of adaptive thinking leave it assuming rather than asking, and drifting on multi-step work.',
      cost: { input: 1, output: 5, note: 'up to 90% off cached input, 50% off batched' },
    },
  },
  {
    id: 'claude-fable-5-1',
    vendor: 'claude',
    latest: true,
    profile: {
      strengths: 'Anthropic\'s most capable model, for demanding reasoning, long-horizon agentic engineering and work whose goal is not yet crisp: hard debugging, architecture and design judgement, security-sensitive review, long documents to read or write, and research whose conclusion must be defended. Thinks before every answer and can spend minutes on one turn, wasted on quick lookups or small edits. 1M-token context.',
      benchmarks: [
        'SWE-bench Pro 81.2, ahead of Fable 5 and Opus 5 (system card, Sept 2026)',
        'Terminal-Bench 4.0 55.8%, up from Fable 5\'s 42.0% (Sept 2026)',
        'Terminal-Bench-Science 0.1 52.6%; CursorBench 3.2.0 73.4% (Sept 2026)',
        'Humanity\'s Last Exam 65.0% with tools, 60.9% without, best of any (Sept 2026)',
        'GDPval-AA v2 knowledge work Elo 1853 vs Astra\'s 1580 (Sept 2026)',
        'Arena creative writing Elo 1486, rank 6, the highest (13 Sept 2026)',
      ],
      reviews: 'The collaborator of the two frontier models: it asks before deciding, says what it is unsure of and refuses a premature conclusion, which reviewers prefer when the goal is vague or the analysis must be defended; its prose is the most natural of the line. On crisp work it costs, at some 35% more text and twice Astra\'s price per task.',
      cost: { input: 10, output: 50, note: 'cache reads $0.25' },
    },
  },
];

// The model a new session starts with when nothing else has been chosen.
export const DEFAULT_MODEL = 'gpt-5.6-luna';

const BY_ID = new Map(MODELS.map(model => [model.id, model]));

export function modelInfo(id: string): ModelInfo | undefined {
  return BY_ID.get(id);
}

export function isKnownModel(id: string): boolean {
  return BY_ID.has(id);
}

export function modelIds(): string[] {
  return MODELS.map(model => model.id);
}

export function modelsOf(vendor: Vendor): string[] {
  return MODELS.filter(model => model.vendor === vendor).map(model => model.id);
}

// The models a vendor offers as workers: all of its own, minus the ones the
// table keeps off the subagent list.
export function workerModelsOf(vendor: Vendor): ModelInfo[] {
  return MODELS.filter(model => model.vendor === vendor && model.worker !== false);
}

export function vendorOf(id: string): Vendor | undefined {
  return modelInfo(id)?.vendor;
}

// The vendor's newest model, or undefined for a vendor that marks none.
export function latestModelOf(vendor: Vendor): ModelInfo | undefined {
  return MODELS.find(model => model.vendor === vendor && model.latest);
}
