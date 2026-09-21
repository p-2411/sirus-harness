import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { sendHeartbeat, type FetchLike } from '../src/telemetry';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-telemetry-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('installation heartbeat', () => {
  test('creates a random installation id and sends at most once per day', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    expect(await sendHeartbeat({ endpoint: 'https://stats.example.test/heartbeat', directory, fetchImpl })).toBe(true);
    expect(await sendHeartbeat({ endpoint: 'https://stats.example.test/heartbeat', directory, fetchImpl })).toBe(false);
    expect(requests).toHaveLength(1);

    const body = JSON.parse(String(requests[0]!.body)) as { installation_id: string; version: string };
    expect(body.installation_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(requests[0]!.method).toBe('POST');
  });

  test('does not record a heartbeat when the request fails', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return new Response(null, { status: attempts === 1 ? 503 : 204 });
    };

    expect(await sendHeartbeat({ endpoint: 'https://stats.example.test/heartbeat', directory, fetchImpl })).toBe(false);
    expect(await sendHeartbeat({ endpoint: 'https://stats.example.test/heartbeat', directory, fetchImpl })).toBe(true);
    expect(attempts).toBe(2);
  });

  test('does not create local telemetry state when no endpoint is configured', async () => {
    expect(await sendHeartbeat({ endpoint: '', directory })).toBe(false);
    expect(() => readFileSync(path.join(directory, 'installation.json'))).toThrow();
  });
});
