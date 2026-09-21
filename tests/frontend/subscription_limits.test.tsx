import { expect, spyOn, test } from 'bun:test';
import { render, renderToString } from 'ink';
import { PassThrough } from 'stream';
import stripAnsi from 'strip-ansi';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { providerFor } from '../../src/agent_runtime/providers';
import * as usage from '../../src/agent_runtime/providers/usage';
import SubscriptionLimits, { SubscriptionLimitRows } from '../../src/frontend/SubscriptionLimits';
import { saveSubscriptionLimitCache } from '../../src/persistence';
import Sidebar from '../../src/frontend/Sidebar';

test('renders compact subscription percentages, including zero and unavailable', () => {
  const text = stripAnsi(renderToString(<SubscriptionLimitRows rows={[
    { id: 'gpt:one', label: 'codex', remaining: 0 },
    { id: 'claude:one', label: 'claude', remaining: null },
  ]} />, { columns: 23 }));
  expect(text).toBe('codex: 0%\nclaude: unavailable');
});

test('shows the active subscription and follows fallback, removal and API selection', async () => {
  const previous = process.env.SIRUS_DATA_DIR;
  const directory = mkdtempSync(path.join(tmpdir(), 'sirus-sidebar-limits-'));
  process.env.SIRUS_DATA_DIR = directory;
  let releaseLimits!: () => void;
  let limitsReady = new Promise<void>(resolve => { releaseLimits = resolve; });
  const reader = spyOn(usage, 'readSubscriptionUsage').mockImplementation(async (vendor, _signal, profile) => {
    await limitsReady;
    return { windows: [
      { label: '5-hour', usedPercent: vendor === 'claude' ? 20 : 60, resetsAt: null },
      { label: '7-day', usedPercent: vendor === 'claude' ? 95 : profile === 'one' ? 25 : 90, resetsAt: null },
    ] };
  });
  const stdout = Object.assign(new PassThrough(), { columns: 26, rows: 12 });
  let output = '';
  stdout.on('data', chunk => { if (chunk.toString().trim()) output = stripAnsi(chunk.toString()); });
  const current = providerFor('gpt');
  current.sources.addSubscription('one'); current.sources.addSubscription('two');
  providerFor('claude').sources.addSubscription('claude-one');
  saveSubscriptionLimitCache([
    { vendor: 'gpt', profile: 'two', period: '7-day', remaining: 35, checkedAt: Date.now(), resetsAt: null },
    { vendor: 'claude', profile: 'other-account', period: '5-hour', remaining: 99, checkedAt: Date.now(), resetsAt: null },
  ]);
  const subscription = (profile: string) =>
    current.sources.list().find(source => source.kind === 'subscription' && source.profile === profile)!;
  // Capture the initial sidebar output while all provider reads are pending.
  const firstFrame = stripAnsi(renderToString(<Sidebar sessions={[]} currSession={null}
    selectSession={() => {}} addSession={() => {}} deleteSession={() => {}} />, { columns: 26 }));
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
    expect(firstFrame).toContain('claude: loading…');
    await flush();
    expect(output).toContain('codex: 35%');
    expect(output).toContain('claude: loading…');
    expect(output).not.toContain('unavailable');
    releaseLimits();
    await flush();
    expect(output).toContain('codex: 10%');
    expect(output).not.toContain('codex 2');
    expect(output).toContain('claude: 80%');
    expect(reader.mock.calls.map(call => call[2]).sort()).toEqual(['claude-one', 'two']);
    limitsReady = new Promise<void>(resolve => { releaseLimits = resolve; });
    // A change to the list that leaves the active source alone: the rows keep
    // their values while the refresh it triggers is in flight.
    current.sources.promote('two');
    await flush();
    expect(output).toContain('codex: 10%');
    expect(output).toContain('claude: 80%');
    expect(output).not.toContain('loading');
    expect(output).not.toContain('unavailable');
    releaseLimits();
    await flush();
    // A participant whose runtime fell back to the other subscription: the
    // row follows the credential that runtime is actually on.
    current.markActive('sidebar-test', subscription('one'));
    await flush();
    expect(output).toContain('codex: 75%');
    expect(output).not.toContain('codex: 10%');
    current.sources.remove('one');
    await flush();
    expect(output).toContain('codex: 10%');
    expect(output).not.toContain('codex 2');
    current.sources.addApiKey('sidebar-test-key');
    await flush();
    expect(output).toContain('codex: 10%');
    expect(output).toContain('claude: 80%');
    reader.mockResolvedValue({ windows: [], unavailable: 'could not read limits' });
    providerFor('claude').sources.promote('claude-one');
    await flush();
    expect(output).toContain('claude: unavailable');
  } finally {
    releaseLimits();
    current.clearActive('sidebar-test');
    app.unmount(); stdout.destroy(); reader.mockRestore();
    if (previous === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
