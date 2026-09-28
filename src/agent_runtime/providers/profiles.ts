import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { mkdirSync } from 'fs';
import { dataDirectory } from '../../dataDirectory';
import { PROFILE_NAME_PATTERN } from '../types';
import { VENDOR_INFO, type Vendor } from './catalog';
import type { Source } from './sources';

// The environment an agent process is started with: this process's, minus
// every credential of the vendor's it must not inherit, plus the one the
// source names. A credential is nothing more than this environment.

// Resolve without creating anything: recovery must notice a deleted profile
// before sourceEnvironment recreates its empty directory.
export function sourceProfileHome(vendor: Vendor, source: Source | null): string {
  const info = VENDOR_INFO[vendor];
  if (source?.kind === 'subscription' && source.profile !== 'default') {
    if (!/^[a-zA-Z0-9_-]+$/.test(source.profile)) throw new Error('Invalid subscription profile');
    return path.resolve(dataDirectory(), 'subscriptions', vendor, source.profile);
  }
  if (source?.kind === 'api' && info.apiKeyLogin) {
    const fingerprint = crypto.createHash('sha256').update(source.key).digest('hex').slice(0, 16);
    return path.resolve(dataDirectory(), 'api', vendor, fingerprint);
  }
  return path.resolve(process.env[info.profileDirEnv] || path.join(os.homedir(), vendor === 'gpt' ? '.codex' : '.claude'));
}

export function subscriptionEnvironment(vendor: Vendor, profile = 'default'): NodeJS.ProcessEnv {
  // Subscription children must not silently select an inherited API credential.
  const env = scrubbedEnvironment(vendor);
  if (profile !== 'default') {
    if (!PROFILE_NAME_PATTERN.test(profile)) throw new Error('Invalid subscription profile');
    useProfileDirectory(env, vendor, 'subscriptions', profile);
  }
  return env;
}

// An API key goes in under the name the vendor's harness reads; a
// subscription points the child at its profile. A harness that must be
// logged in with the key gets a profile of its own too, named after the key,
// so the login the launch performs lands there and never in the user's own
// home, where it would replace their ChatGPT sign-in.
export function sourceEnvironment(vendor: Vendor, source: Source): NodeJS.ProcessEnv {
  if (source.kind === 'subscription') return subscriptionEnvironment(vendor, source.profile);
  const info = VENDOR_INFO[vendor];
  const env = scrubbedEnvironment(vendor);
  env[info.credentialEnv] = source.key;
  if (info.apiKeyLogin) {
    const fingerprint = crypto.createHash('sha256').update(source.key).digest('hex').slice(0, 16);
    useProfileDirectory(env, vendor, 'api', fingerprint);
  }
  return env;
}

function scrubbedEnvironment(vendor: Vendor): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of VENDOR_INFO[vendor].scrubEnv) delete env[key];
  return env;
}

// Points the child at a profile directory of Sirus's own under the data
// directory, private to the user, made on first use.
function useProfileDirectory(env: NodeJS.ProcessEnv, vendor: Vendor, kind: 'subscriptions' | 'api', name: string): void {
  const directory = path.resolve(dataDirectory(), kind, vendor, name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  env[VENDOR_INFO[vendor].profileDirEnv] = directory;
}
