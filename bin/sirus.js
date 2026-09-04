#!/usr/bin/env node
'use strict';

// Node launcher for Sirus. The application itself runs under Bun (it uses
// bun:sqlite and TSX sources), so this shim locates a Bun binary and re-execs
// src/cli.ts with it. Bun is resolved in this order:
//   1. the `bun` npm package installed alongside Sirus (pulled in as a
//      dependency, so `npm install -g sirus-harness` works without a
//      pre-existing Bun install),
//   2. a `bun` already on PATH.

const { spawnSync } = require('child_process');
const { existsSync, statSync } = require('fs');
const path = require('path');

function bundledBun() {
  try {
    const binDir = path.join(path.dirname(require.resolve('bun/package.json')), 'bin');
    // The bun npm package ships bin/bun.exe as a tiny placeholder and its
    // postinstall replaces it with the real binary under the same name on
    // every platform. Check the size so a skipped postinstall is detected.
    for (const name of ['bun.exe', 'bun']) {
      const candidate = path.join(binDir, name);
      if (existsSync(candidate) && statSync(candidate).size > 1024 * 1024) {
        return candidate;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function systemBun() {
  const probe = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  return probe.error ? null : 'bun';
}

const bun = bundledBun() || systemBun();
if (!bun) {
  process.stderr.write(
    'sirus: could not find a Bun runtime.\n' +
      'The bundled copy is missing (was the install run with --ignore-scripts?).\n' +
      'Install Bun from https://bun.sh and re-run, or reinstall sirus-harness.\n',
  );
  process.exit(1);
}

const entry = path.join(__dirname, '..', 'src', 'cli.ts');
const result = spawnSync(bun, ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });

if (result.error) {
  process.stderr.write(`sirus: failed to start Bun (${bun}): ${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status == null ? 1 : result.status);
