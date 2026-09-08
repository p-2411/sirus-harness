import path from 'path';
import { mkdirSync } from 'fs';
import { dataDirectory } from '../../dataDirectory';
import { VENDOR_INFO, type Vendor } from './catalog';

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
