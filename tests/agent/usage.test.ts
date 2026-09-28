import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSubscriptionUsage, codexSubscriptionUsage } from '../../src/agent_runtime/providers/usage';
import { describeSubscriptionUsage } from '../../src/commands/authentication/behavior';
import { turnFailure } from '../../src/agent_runtime/runtime/errors';
import { rememberListedModels } from '../../src/agent_runtime/providers/catalog';
import { providerFor } from '../../src/agent_runtime/providers';

describe('subscription allowance normalization', () => {
  test('prefers all Codex buckets over the duplicate legacy view', () => {
    const window = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 };
    const result = codexSubscriptionUsage({
      rateLimits: { primary: { ...window, usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: { primary: window, secondary: { ...window, windowDurationMins: 10080, usedPercent: 80 } },
        spark: { limitName: 'Spark', primary: { ...window, usedPercent: 50 } },
      },
    });
    expect(result.windows).toEqual([
      { label: 'codex · 5-hour', usedPercent: 25, resetsAt: 1_800_000_000_000 },
      { label: 'codex · 7-day', usedPercent: 80, resetsAt: 1_800_000_000_000 },
      { label: 'Spark · 5-hour', usedPercent: 50, resetsAt: 1_800_000_000_000 },
    ]);
  });

  test('supports legacy responses without treating null fields as zero', () => {
    expect(codexSubscriptionUsage({ rateLimitsByLimitId: {}, rateLimits: {
      primary: { usedPercent: null, resetsAt: null }, secondary: null,
    } }).windows).toEqual([{ label: 'Codex · primary window', usedPercent: null, resetsAt: null }]);
    expect(codexSubscriptionUsage({ rateLimits: null }).unavailable).toBeDefined();
  });

  test('validates percentages and reset timestamps', () => {
    const result = codexSubscriptionUsage({ rateLimits: {
      primary: { usedPercent: 120, resetsAt: Infinity },
      secondary: { usedPercent: NaN, resetsAt: 1e20 },
    } });
    expect(result.windows.map(window => window.usedPercent)).toEqual([100, null]);
    expect(result.windows.map(window => window.resetsAt)).toEqual([null, null]);
  });

  test('reads Claude overall and model windows as percentages, not fractions', () => {
    const window = { utilization: 25, resets_at: '2026-09-06T00:00:00Z' };
    const result = claudeSubscriptionUsage({ rate_limits_available: true, rate_limits: {
      five_hour: window,
      seven_day: { ...window, utilization: 0 },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: 'Fable', ...window }],
    } });
    expect(result.windows).toEqual([
      { label: '5-hour', usedPercent: 25, resetsAt: Date.parse(window.resets_at) },
      { label: '7-day', usedPercent: 0, resetsAt: Date.parse(window.resets_at) },
      { label: '7-day Sonnet', usedPercent: null, resetsAt: null },
      { label: '7-day Fable', usedPercent: 25, resetsAt: Date.parse(window.resets_at) },
    ]);
    expect(claudeSubscriptionUsage({ rate_limits_available: false, rate_limits: {} }).unavailable).toBeDefined();
  });
});

describe('allowance display', () => {
  test('selects the overall Codex bucket even when its display name changes', () => {
    const usage = codexSubscriptionUsage({ rateLimitsByLimitId: {
      spark: { primary: { usedPercent: 99, windowDurationMins: 300 } },
      codex: { limitName: 'Coding', primary: { usedPercent: 12.5, windowDurationMins: 300 },
        secondary: { usedPercent: 45, windowDurationMins: 10080 } },
    } });
    expect(describeSubscriptionUsage(usage)).toBe('5h 87.5% left · 7d 55% left');
  });
  test('shows only the two overall remaining percentages', () => {
    expect(describeSubscriptionUsage({ windows: [
      { label: '5-hour', usedPercent: 25, resetsAt: 1234 },
      { label: '7-day', usedPercent: 100, resetsAt: 1234 },
      { label: '7-day Sonnet', usedPercent: 50, resetsAt: 1234 },
    ] })).toBe('5h 75% left · 7d 0% left');
  });

  test('distinguishes missing data from unused allowance', () => {
    expect(describeSubscriptionUsage({ windows: [
      { label: '5-hour', usedPercent: null, resetsAt: null },
      { label: '7-day', usedPercent: 0, resetsAt: 1000 },
    ] })).toBe('5h unavailable · 7d 100% left');
    expect(describeSubscriptionUsage({ windows: [], unavailable: 'request timed out' }))
      .toBe('limits unavailable');
  });

  test('omits windows the vendor does not report', () => {
    expect(describeSubscriptionUsage(codexSubscriptionUsage({ rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 10, windowDurationMins: 10080 } },
    } }))).toBe('7d 90% left');
  });
});

test('rate-limit switch hint requires a current credential for the other vendor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sirus-limit-hint-'));
  const previous = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = directory;
  try {
    rememberListedModels('claude', [{ id: 'claude-hint-model', description: '' }]);
    expect(turnFailure(new Error('Rate limit exceeded'), 'gpt', 'sirus').message)
      .toContain('sign in with /login');
    const source = providerFor('claude').sources.addApiKey('test-key');
    expect(turnFailure(new Error('Rate limit exceeded'), 'gpt', 'sirus').message)
      .toContain('/model claude-hint-model');
    providerFor('claude').sources.remove(source.id);
    expect(turnFailure(new Error('Rate limit exceeded'), 'gpt', 'sirus').message)
      .toContain('sign in with /login');
  } finally {
    if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
