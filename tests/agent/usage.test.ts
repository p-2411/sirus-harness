import { describe, expect, test } from 'bun:test';
import { claudeSubscriptionUsage, codexSubscriptionUsage } from '../../src/agent_runtime/providers/usage';
import { describeSubscriptionUsage } from '../../src/commands/authentication/behavior';

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
    expect(describeSubscriptionUsage(usage)).toBe('  5 hour: 87.5%\n  7-day: 55%');
  });
  test('shows only the two overall remaining percentages', () => {
    expect(describeSubscriptionUsage({ windows: [
      { label: '5-hour', usedPercent: 25, resetsAt: 1234 },
      { label: '7-day', usedPercent: 100, resetsAt: 1234 },
      { label: '7-day Sonnet', usedPercent: 50, resetsAt: 1234 },
    ] })).toBe('  5 hour: 75%\n  7-day: 0%');
  });

  test('distinguishes missing data from unused allowance', () => {
    expect(describeSubscriptionUsage({ windows: [
      { label: '5-hour', usedPercent: null, resetsAt: null },
      { label: '7-day', usedPercent: 0, resetsAt: 1000 },
    ] })).toBe('  5 hour: unavailable\n  7-day: 100%');
    expect(describeSubscriptionUsage({ windows: [], unavailable: 'request timed out' }))
      .toBe('  5 hour: unavailable\n  7-day: unavailable');
  });
});
