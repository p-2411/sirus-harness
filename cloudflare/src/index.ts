interface D1Result<T = Record<string, unknown>> {
  results: T[];
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}

interface Env {
  DB: D1Database;
  INSTALLATION_HASH_SECRET: string;
  ALLOWED_ORIGIN?: string;
}

interface HeartbeatPayload {
  installation_id: string;
  version: string;
}

const MAX_BODY_BYTES = 2_048;
const MAX_VERSION_LENGTH = 64;
const RETENTION_DAYS = 35;

function corsHeaders(env: Env): Headers {
  const headers = new Headers({
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    vary: 'Origin',
  });
  headers.set('access-control-allow-origin', env.ALLOWED_ORIGIN || '*');
  return headers;
}

function response(body: unknown, status: number, env: Env): Response {
  const headers = corsHeaders(env);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyResponse(status: number, env: Env): Response {
  return new Response(null, { status, headers: corsHeaders(env) });
}

function utcSqlTimestamp(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHeartbeatPayload(value: unknown): HeartbeatPayload | null {
  if (!isRecord(value)) return null;
  const installationId = value.installation_id;
  const version = value.version;
  if (typeof installationId !== 'string' || !/^[0-9a-f]{32}$/.test(installationId)) return null;
  if (typeof version !== 'string' || version.length < 1 || version.length > MAX_VERSION_LENGTH) return null;
  return { installation_id: installationId, version };
}

async function hmacInstallationId(installationId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(installationId));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  if (!env.INSTALLATION_HASH_SECRET) return response({ error: 'service unavailable' }, 503, env);

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return response({ error: 'invalid request' }, 400, env);
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return response({ error: 'invalid request' }, 400, env);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return response({ error: 'invalid request' }, 400, env);
  }

  const heartbeat = parseHeartbeatPayload(payload);
  if (!heartbeat) return response({ error: 'invalid request' }, 400, env);

  const installationHash = await hmacInstallationId(heartbeat.installation_id, env.INSTALLATION_HASH_SECRET);
  const timestamp = utcSqlTimestamp();
  await env.DB.prepare(`
    INSERT INTO installations (installation_hash, first_seen, last_seen)
    VALUES (?, ?, ?)
    ON CONFLICT(installation_hash) DO UPDATE SET last_seen = excluded.last_seen
    WHERE installations.last_seen <= datetime(excluded.last_seen, '-1 day')
  `).bind(installationHash, timestamp, timestamp).run();

  return response({ ok: true }, 200, env);
}

async function handleStats(env: Env): Promise<Response> {
  const counts = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(last_seen >= datetime('now', '-1 day')), 0) AS day,
      COALESCE(SUM(last_seen >= datetime('now', '-7 days')), 0) AS week,
      COALESCE(SUM(last_seen >= datetime('now', '-30 days')), 0) AS month
    FROM installations
    WHERE last_seen >= datetime('now', '-30 days')
  `).first<{ day?: number; week?: number; month?: number }>();
  return response({
    day: Number(counts?.day ?? 0),
    week: Number(counts?.week ?? 0),
    month: Number(counts?.month ?? 0),
  }, 200, env);
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return emptyResponse(204, env);
  const pathname = new URL(request.url).pathname;
  if (request.method === 'POST' && pathname === '/heartbeat') return handleHeartbeat(request, env);
  if (request.method === 'GET' && pathname === '/stats') return handleStats(env);
  return response({ error: 'not found' }, 404, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      return response({ error: 'internal server error' }, 500, env);
    }
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await env.DB.prepare(`
      DELETE FROM installations
      WHERE last_seen < datetime('now', '-${RETENTION_DAYS} days')
    `).run();
  },
};
