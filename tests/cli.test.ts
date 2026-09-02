import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCliArguments } from '../src/cli';
import packageManifest from '../package.json';

describe('sirus CLI', () => {
  test('is installed as a package-level executable', () => {
    expect(packageManifest.bin).toEqual({ sirus: 'src/cli.ts' });
    expect(readFileSync(join(import.meta.dir, '..', packageManifest.bin.sirus), 'utf8'))
      .toStartWith('#!/usr/bin/env bun');
  });

  test('uses the current directory when no path is supplied', () => {
    expect(parseCliArguments([], process.cwd())).toEqual({
      directory: process.cwd(),
      help: false,
    });
  });

  test('resolves a supplied relative directory from the current directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'sirus-cli-'));
    const project = join(parent, 'project');
    mkdirSync(project);
    try {
      expect(parseCliArguments(['project'], parent)).toEqual({
        directory: realpathSync(project),
        help: false,
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('rejects missing paths and files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sirus-cli-'));
    const file = join(directory, 'file.txt');
    writeFileSync(file, 'not a directory');
    try {
      expect(() => parseCliArguments(['missing'], directory)).toThrow('Directory does not exist');
      expect(() => parseCliArguments([file], directory)).toThrow('Not a directory');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('supports help and rejects extra arguments', () => {
    expect(parseCliArguments(['--help'])).toEqual({ directory: null, help: true });
    expect(() => parseCliArguments(['one', 'two'])).toThrow('at most one directory');
  });
});
