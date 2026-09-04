import path from 'path';
import { mkdirSync } from 'fs';
import { dataDirectory } from '../../persistence';
import type { Vendor } from './provider';

export function subscriptionEnvironment(vendor: Vendor, profile = 'default'): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Subscription children must not silently select an inherited API credential.
  for (const key of vendor === 'claude'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    : ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
  if (profile !== 'default') {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid subscription profile');
    const directory = path.resolve(dataDirectory(), 'subscriptions', vendor, profile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    env[vendor === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = directory;
  }
  return env;
}
