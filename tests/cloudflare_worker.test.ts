import { describe, expect, test } from 'bun:test';
import worker from '../cloudflare/src/index';

// The shape the worker's `D1Statement` expects, plus what the tests read
// back: the SQL and the values bound to it.
interface Statement {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => Statement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  run: () => Promise<unknown>;
}

function fakeDatabase(stats = { day: 1, week: 2, month: 3 }) {
  const statements: Statement[] = [];
  const database = {
    statements,
    prepare(sql: string): Statement {
      const statement = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first<T>() {
          return stats as unknown as T;
        },
        async run() {},
      };
      statements.push(statement);
      return statement;
    },
  };
  return database;
}

describe('Cloudflare statistics worker', () => {
  test('rejects malformed heartbeat payloads without touching D1', async () => {
    const database = fakeDatabase();
    const response = await worker.fetch(
      new Request('https://stats.example.test/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ installation_id: 'not-an-id', version: '1.2.1' }),
      }),
      { DB: database, INSTALLATION_HASH_SECRET: 'test-secret' },
    );

    expect(response.status).toBe(400);
    expect(database.statements).toHaveLength(0);
  });

  test('hashes valid IDs before writing and returns rolling counts', async () => {
    const database = fakeDatabase({ day: 4, week: 8, month: 16 });
    const environment = { DB: database, INSTALLATION_HASH_SECRET: 'test-secret' };
    const heartbeat = await worker.fetch(
      new Request('https://stats.example.test/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ installation_id: 'a'.repeat(32), version: '1.2.1' }),
      }),
      environment,
    );

    expect(heartbeat.status).toBe(200);
    expect(database.statements[0]!.values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(database.statements[0]!.values[0]).not.toBe('a'.repeat(32));

    const stats = await worker.fetch(new Request('https://stats.example.test/stats'), environment);
    expect(stats.status).toBe(200);
    expect(await stats.json()).toEqual({ day: 4, week: 8, month: 16 });
  });

  test('supports CORS preflight and hides internal failures', async () => {
    const database = fakeDatabase();
    const preflight = await worker.fetch(new Request('https://stats.example.test/stats', { method: 'OPTIONS' }), {
      DB: database,
      INSTALLATION_HASH_SECRET: 'test-secret',
      ALLOWED_ORIGIN: 'https://example.github.io',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://example.github.io');

    const broken = await worker.fetch(new Request('https://stats.example.test/stats'), {
      DB: {
        ...database,
        prepare() {
          return {
            bind() { return this; },
            async first() { throw new Error('database details must not escape'); },
            async run() {},
          };
        },
      },
      INSTALLATION_HASH_SECRET: 'test-secret',
    });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: 'internal server error' });
  });
});
