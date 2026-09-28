import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Bun loads the project's .env into every run, tests included, so a
// developer's own vendor key would sign the suite in to that vendor. Tests
// start signed out; one that needs a key sets it itself.
delete process.env.ANTHROPIC_API;
delete process.env.OPENAI_SECRET;

// Nor does a run read anything else of the developer's: their Sirus data
// directory, the vendors' logins and the usage those report all live under
// the home directory, so every run gets a fresh, empty one of its own. A test
// that needs something there puts it there.
const home = mkdtempSync(path.join(tmpdir(), 'sirus-test-'));
process.env.HOME = home;
process.env.SIRUS_DATA_DIR = path.join(home, 'data');
delete process.env.CODEX_HOME;
delete process.env.CLAUDE_CONFIG_DIR;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
