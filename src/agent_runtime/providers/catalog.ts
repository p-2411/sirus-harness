// Every fact about the models and vendors Sirus can talk to, as data. This
// module imports nothing from the rest of the app: it is the leaf that the
// launch specs, the credential store, the login flows and the UI all read
// from.
//
// Adding a model is one row in MODELS. Adding a vendor is one row in
// VENDOR_TABLE plus a launch spec in src/agent_runtime/runtime/launch.ts.

export interface ModelInfo {
  id: string;
  vendor: Vendor;
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
  { id: 'gpt-5.6-luna', vendor: 'gpt' },
  { id: 'gpt-5.6-terra', vendor: 'gpt' },
  { id: 'gpt-5.6-sol', vendor: 'gpt' },
  { id: 'gpt-6-astra', vendor: 'gpt' },
  { id: 'claude-opus-5', vendor: 'claude' },
  { id: 'claude-sonnet-5', vendor: 'claude' },
  { id: 'claude-haiku-4-5', vendor: 'claude' },
  { id: 'claude-fable-5-1', vendor: 'claude' },
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

export function vendorOf(id: string): Vendor | undefined {
  return modelInfo(id)?.vendor;
}
