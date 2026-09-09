// Every fact about the models and vendors Sirus can talk to, as data. This
// module imports nothing from the rest of the app: it is the leaf that model
// dispatch, the credential store, the login flows and the UI all read from.
//
// Adding a model is one row in MODELS. Adding a vendor is one entry in
// VENDOR_TABLE plus the two transports that vendor needs.

export interface ModelInfo {
  id: string;
  vendor: Vendor;
  // The window the model is assumed to have when the provider does not report
  // one. The direct APIs report token counts but not the window, so this
  // figure drives the context gauge on that path; a subscription runtime's
  // own figure wins.
  contextWindow: number;
  // Vendor-specific facts a transport needs for this model and nothing else.
  traits?: Record<string, unknown>;
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
  // The environment variable an API key may come from.
  apiKeyEnv: string;
  // The cheapest model of this vendor, for one-shot questions such as the
  // permission judge.
  judgeModel: string;
  // Credentials a subscription child must not inherit from this process.
  scrubEnv: readonly string[];
  // The variable that points a subscription child at an isolated profile.
  profileDirEnv: string;
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
    judgeModel: 'claude-haiku-4-5',
    scrubEnv: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ],
    profileDirEnv: 'CLAUDE_CONFIG_DIR',
    limitPeriod: '5-hour',
  },
  gpt: {
    id: 'gpt',
    displayName: 'OpenAI',
    accountName: 'ChatGPT',
    sidebarLabel: 'codex',
    apiKeyEnv: 'OPENAI_SECRET',
    judgeModel: 'gpt-5.6-luna',
    scrubEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    profileDirEnv: 'CODEX_HOME',
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
  { id: 'gpt-5.6-luna', vendor: 'gpt', contextWindow: 400_000 },
  { id: 'gpt-5.6-terra', vendor: 'gpt', contextWindow: 400_000 },
  { id: 'gpt-5.6-sol', vendor: 'gpt', contextWindow: 400_000 },
  {
    id: 'gpt-6-astra',
    vendor: 'gpt',
    contextWindow: 1_050_000,
    // Thread-local Codex budgets: a large-window Astra thread must not change
    // other models' budgets on the shared account runtime.
    traits: {
      codexThreadConfig: { model_context_window: 1_050_000, model_auto_compact_token_limit: 900_000 },
    },
  },
  { id: 'claude-opus-5', vendor: 'claude', contextWindow: 200_000 },
  { id: 'claude-sonnet-5', vendor: 'claude', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5', vendor: 'claude', contextWindow: 200_000 },
  { id: 'claude-fable-5-1', vendor: 'claude', contextWindow: 200_000 },
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

export function contextWindowFor(id: string): number | undefined {
  return modelInfo(id)?.contextWindow;
}

export function vendorOf(id: string): Vendor | undefined {
  return modelInfo(id)?.vendor;
}

// The judge runs on the cheapest model of the same vendor. A model the
// catalog does not know has no judge, and the caller falls back to asking.
export function judgeModelFor(id: string): string | null {
  const vendor = vendorOf(id);
  return vendor ? VENDOR_INFO[vendor].judgeModel : null;
}

export function traitsOf(id: string): Record<string, unknown> {
  return modelInfo(id)?.traits ?? {};
}
