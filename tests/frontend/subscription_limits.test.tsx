import { expect, setSystemTime, spyOn, test } from 'bun:test';
import { render, renderToString } from 'ink';
import { PassThrough } from 'stream';
import stripAnsi from 'strip-ansi';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { providerFor } from '../../src/agent_runtime/providers';
import * as usage from '../../src/agent_runtime/providers/usage';
import SubscriptionLimits, { SubscriptionLimitRows, type SubscriptionLimitRow } from '../../src/frontend/SubscriptionLimits';
import { saveSubscriptionLimitCache } from '../../src/persistence/subscriptionLimits';
import Sidebar from '../../src/frontend/Sidebar';

test('renders compact subscription percentages, including zero and unavailable', () => {
  const text = stripAnsi(renderToString(<SubscriptionLimitRows rows={[
    { id: 'gpt:one', vendor: 'gpt', label: 'codex', remaining: 0, resetsAt: null },
    { id: 'claude:one', vendor: 'claude', label: 'claude', remaining: null, resetsAt: Date.now() },
    { id: 'claude:two', vendor: 'claude', label: 'claude', remaining: undefined, resetsAt: Date.now() },
    { id: 'gpt:two', vendor: 'gpt', label: 'codex', remaining: 50, resetsAt: NaN },
  ]} />, { columns: 23 }));
  expect(text.split('\n').map(line => line.trimEnd())).toEqual([
    'codex: 0%', 'claude: unavailable', 'claude: loading…', 'codex: 50%',
  ]);
});

test('right-aligns reset times and dates on the allowance row at sidebar width', () => {
  setSystemTime(new Date(2026, 8, 28, 12));
  try {
    const claudeReset = new Date(2026, 8, 29, 10, 45);
    const codexToday = new Date(2026, 8, 28, 15, 30);
    const codexLater = new Date(2027, 8, 28, 15, 30);
    const rows: SubscriptionLimitRow[] = [
      { id: 'claude:one', vendor: 'claude', label: 'claude', remaining: 99.9, resetsAt: +claudeReset },
      { id: 'gpt:one', vendor: 'gpt', label: 'codex', remaining: 0, resetsAt: +codexToday },
      { id: 'gpt:two', vendor: 'gpt', label: 'codex', remaining: 100, resetsAt: +codexLater },
    ];
    const lines = stripAnsi(renderToString(<SubscriptionLimitRows rows={rows} />, { columns: 23 })).split('\n');
    const labels = ['claude: 99.9%', 'codex: 0%', 'codex: 100%'];
    const resets = [
      claudeReset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, '').toLowerCase(),
      codexToday.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, '').toLowerCase(),
      codexLater.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    ];
    expect(lines).toEqual(labels.map((label, i) => label + resets[i]!.padStart(23 - label.length)));
  } finally {
    setSystemTime();
  }
});

test('switches the Codex reset date to a time on its local calendar day', () => {
  const reset = new Date(2027, 0, 1, 10, 30);
  const rows: SubscriptionLimitRow[] = [
    { id: 'gpt:one', vendor: 'gpt', label: 'codex', remaining: 25, resetsAt: +reset },
  ];
  const row = () => stripAnsi(renderToString(<SubscriptionLimitRows rows={rows} />, { columns: 23 }));
  try {
    setSystemTime(new Date(2026, 11, 31, 23, 59));
    expect(row().trimEnd().endsWith(reset.toLocaleDateString([], { month: 'short', day: 'numeric' }))).toBe(true);
    setSystemTime(new Date(2027, 0, 1, 0, 0));
    expect(row().trimEnd().endsWith(reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      .replace(/\s+/g, '').toLowerCase())).toBe(true);
  } finally {
    setSystemTime();
  }
});

test('shows the active subscription and follows fallback, removal and API selection', async () => {
  const previous = process.env.SIRUS_DATA_DIR;
  const directory = mkdtempSync(path.join(tmpdir(), 'sirus-sidebar-limits-'));
  process.env.SIRUS_DATA_DIR = directory;
  let releaseLimits!: () => void;
  const limitsReady = new Promise<void>(resolve => { releaseLimits = resolve; });
  const now = Date.now();
  const claudeReset = new Date(now + 3 * 3600_000);
  const cachedReset = new Date(now + 2 * 86400_000);
  const codexResets = { one: new Date(now + 5 * 86400_000), two: new Date(now + 6 * 86400_000) };
  const resetDate = (date: Date) => date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const claudeResetLabel = claudeReset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(/\s+/g, '').toLowerCase();
  const reader = spyOn(usage, 'readSubscriptionUsage').mockImplementation(async (vendor, _signal, profile) => {
    await limitsReady;
    return { windows: [
      { label: '5-hour', usedPercent: vendor === 'claude' ? 20 : 60, resetsAt: +claudeReset },
      { label: '7-day', usedPercent: vendor === 'claude' ? 95 : profile === 'one' ? 25 : 90,
        resetsAt: +(profile === 'one' ? codexResets.one : codexResets.two) },
    ] };
  });
  const stdout = Object.assign(new PassThrough(), { columns: 26, rows: 12 });
  let output = '';
  stdout.on('data', chunk => { if (chunk.toString().trim()) output = stripAnsi(chunk.toString()); });
  const current = providerFor('gpt');
  current.sources.addSubscription('one'); current.sources.addSubscription('two');
  providerFor('claude').sources.addSubscription('claude-one');
  saveSubscriptionLimitCache([
    { vendor: 'gpt', profile: 'two', period: '7-day', remaining: 35, checkedAt: now, resetsAt: +cachedReset },
    { vendor: 'claude', profile: 'other-account', period: '5-hour', remaining: 99, checkedAt: Date.now(), resetsAt: null },
  ]);
  const subscription = (profile: string) =>
    current.sources.list().find(source => source.kind === 'subscription' && source.profile === profile)!;
  // Capture the initial sidebar output while all provider reads are pending.
  const firstFrame = stripAnsi(renderToString(<Sidebar sessions={[]} currSession={null}
    selectSession={() => {}} focusDraftSession={() => {}} deleteSession={() => {}} />, { columns: 26 }));
  reader.mockClear();
  const app = render(<SubscriptionLimits />, { stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
    }
  };
  try {
    expect(firstFrame).toContain('sirus');
    expect(firstFrame).toContain('codex: 35%');
    expect(firstFrame.split('\n').find(line => line.includes('codex:'))).toContain(resetDate(cachedReset));
    expect(firstFrame).toContain('claude: loading…');
    await flush();
    expect(output).toContain('codex: 35%');
    expect(output.split('\n').find(line => line.includes('codex:'))?.trimEnd().endsWith(resetDate(cachedReset))).toBe(true);
    expect(output).toContain('claude: loading…');
    expect(output).not.toContain('unavailable');
    releaseLimits();
    await flush();
    expect(output).toContain('codex: 10%');
    expect(output).not.toContain('codex 2');
    expect(output).toContain('claude: 80%');
    expect(output.split('\n').find(line => line.includes('codex:'))?.trimEnd().endsWith(resetDate(codexResets.two))).toBe(true);
    expect(output.split('\n').find(line => line.includes('claude:'))?.trimEnd().endsWith(claudeResetLabel)).toBe(true);
    expect(reader.mock.calls.map(call => call[2]).sort()).toEqual(['claude-one', 'two']);
    // Every read is a vendor process. A change to the list that leaves the
    // rows as they are reads nothing again, and neither does a runtime
    // starting and stopping on a subscription already shown.
    reader.mockClear();
    current.sources.promote('two');
    current.markActive('sidebar-worker', subscription('two'));
    current.clearActive('sidebar-worker');
    await flush();
    expect(reader).not.toHaveBeenCalled();
    expect(output).toContain('codex: 10%');
    expect(output).toContain('claude: 80%');
    // A participant whose runtime fell back to the other subscription: the
    // row follows the credential that runtime is actually on.
    current.markActive('sidebar-test', subscription('one'));
    await flush();
    expect(output).toContain('codex: 75%');
    expect(output.split('\n').find(line => line.includes('codex:'))?.trimEnd().endsWith(resetDate(codexResets.one))).toBe(true);
    expect(output).not.toContain('codex: 10%');
    current.sources.remove('one');
    await flush();
    expect(output).toContain('codex: 10%');
    expect(output).not.toContain('codex 2');
    current.sources.addApiKey('sidebar-test-key');
    await flush();
    expect(output).toContain('codex: 10%');
    expect(output).toContain('claude: 80%');
    // A subscription shown for the first time is read at once.
    reader.mockResolvedValue({ windows: [], unavailable: 'could not read limits' });
    providerFor('claude').sources.addSubscription('claude-two');
    await flush();
    expect(output).toContain('claude: unavailable');
    expect(output).not.toContain(claudeResetLabel);
  } finally {
    releaseLimits();
    current.clearActive('sidebar-test');
    app.unmount(); stdout.destroy(); reader.mockRestore();
    if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
