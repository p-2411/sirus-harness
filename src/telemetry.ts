import { randomBytes } from 'crypto';
import path from 'path';
import { dataDirectory } from './dataDirectory';
import { readJson, writeJson } from './persistence/atomicJson';
import { SIRUS_VERSION } from './version';

const INSTALLATION_FILE = 'installation.json';
const STATE_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_HEARTBEAT_ENDPOINT = 'https://sirus-stats.parhamsepas.workers.dev/heartbeat';

interface InstallationState {
  version: typeof STATE_VERSION;
  installationId: string;
  lastHeartbeatAt?: number;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HeartbeatOptions {
  endpoint?: string;
  directory?: string;
  fetchImpl?: FetchLike;
}

function installationPath(directory: string): string {
  return path.join(directory, INSTALLATION_FILE);
}

function isInstallationState(value: unknown): value is InstallationState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<InstallationState>;
  return state.version === STATE_VERSION
    && typeof state.installationId === 'string'
    && /^[0-9a-f]{32}$/.test(state.installationId)
    && (state.lastHeartbeatAt === undefined || (typeof state.lastHeartbeatAt === 'number' && Number.isFinite(state.lastHeartbeatAt)));
}

function newInstallationState(): InstallationState {
  return {
    version: STATE_VERSION,
    installationId: randomBytes(16).toString('hex'),
  };
}

function loadOrCreateState(directory: string): InstallationState {
  const stored = readJson(installationPath(directory));
  if (isInstallationState(stored)) return stored;

  const state = newInstallationState();
  writeJson(installationPath(directory), state);
  return state;
}

function heartbeatEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if (url.protocol !== 'https:' && !localHttp) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Sends a best-effort installation heartbeat. Network failures are returned to
 * the caller and never intended to affect application startup.
 */
export async function sendHeartbeat(options: HeartbeatOptions = {}): Promise<boolean> {
  const endpoint = heartbeatEndpoint(options.endpoint ?? process.env.SIRUS_HEARTBEAT_URL ?? DEFAULT_HEARTBEAT_ENDPOINT);
  if (!endpoint) return false;

  const directory = options.directory ?? dataDirectory();
  const state = loadOrCreateState(directory);
  const now = Date.now();
  if (state.lastHeartbeatAt !== undefined && now - state.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installation_id: state.installationId, version: SIRUS_VERSION }),
      signal: controller.signal,
    });
    if (!response.ok) return false;

    writeJson(installationPath(directory), { ...state, lastHeartbeatAt: now });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
