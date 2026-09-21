import crypto from 'crypto';
import path from 'path';
import { mkdirSync } from 'fs';
import { dataDirectory } from '../../dataDirectory';
import { VENDOR_INFO, type Vendor } from './catalog';
import type { Source } from './sources';

// The environment an agent process is started with: this process's, minus
// every credential of the vendor's it must not inherit, plus the one the
// source names. A credential is nothing more than this environment.

export function subscriptionEnvironment(vendor: Vendor, profile = 'default'): NodeJS.ProcessEnv {
  const info = VENDOR_INFO[vendor];
  const env = { ...process.env };
  // Subscription children must not silently select an inherited API credential.
  for (const key of info.scrubEnv) delete env[key];
  if (profile !== 'default') {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid subscription profile');
    const directory = path.resolve(dataDirectory(), 'subscriptions', vendor, profile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    env[info.profileDirEnv] = directory;
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
  const env = { ...process.env };
  for (const key of info.scrubEnv) delete env[key];
  env[info.credentialEnv] = source.key;
  if (info.apiKeyLogin) {
    const fingerprint = crypto.createHash('sha256').update(source.key).digest('hex').slice(0, 16);
    const directory = path.resolve(dataDirectory(), 'api', vendor, fingerprint);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    env[info.profileDirEnv] = directory;
  }
  return env;
}
