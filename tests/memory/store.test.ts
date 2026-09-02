import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as sqliteVec from 'sqlite-vec';
import type { EmbeddingProvider } from '../../src/memory/embeddings';
import { MemoryStore, type MemoryLink } from '../../src/memory/store';

class TestEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-embedding-v1';
  readonly dimensions = 3;

  async embed(text: string): Promise<Float32Array> {
    const value = text.toLowerCase();
    const vector: number[] = [
      score(value, ['cat', 'feline', 'kitten']),
      score(value, ['dog', 'canine', 'puppy']),
      score(value, ['database', 'sqlite', 'sql', 'storage']),
    ];
    if (vector[0] + vector[1] + vector[2] === 0) {
      vector[0] = 0.01;
      vector[1] = 0.01;
      vector[2] = 0.01;
    }
    const magnitude = Math.hypot(...vector);
    return new Float32Array(vector.map(component => component / magnitude));
  }
}

function score(text: string, words: string[]): number {
  return words.reduce((total, word) => total + (text.includes(word) ? 1 : 0), 0);
}

const globalLink = (name: string): MemoryLink => ({ scope: 'global', name });
const projectLink = (name: string): MemoryLink => ({ scope: 'project', name });

let directory: string;
let databasePath: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sirus-memory-'));
  databasePath = join(directory, 'memory.sqlite');
  projectA = join(directory, 'project-a');
  projectB = join(directory, 'project-b');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('MemoryStore', () => {
  test('persists scoped memories, links, and embedding metadata across reopen', async () => {
    const store = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    const saved = await store.addMemory(
      'project',
      projectA,
      'preferred-database',
      'The project uses SQLite for local storage.',
      [globalLink('local-first'), projectLink('schema')],
    );
    store.close();

    const reopened = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    expect(reopened.getMemory('project', projectA, 'preferred-database')).toMatchObject({
      id: saved.id,
      scope: 'project',
      projectDirectory: projectA,
      name: 'preferred-database',
      links: [globalLink('local-first'), projectLink('schema')],
      embeddingModel: 'test-embedding-v1',
    });
    reopened.close();
  });

  test('searches global and the current project together by semantic distance', async () => {
    const store = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    await store.addMemory('global', projectA, 'cats', 'Felines make excellent pets.');
    await store.addMemory('project', projectA, 'persistence', 'SQLite is the local database storage layer.');
    await store.addMemory('project', projectB, 'other-project', 'SQL storage belonging elsewhere.');

    const results = await store.searchMemories('available', projectA, 'How is SQL data stored?', 5);

    expect(results.map(result => result.name)).toEqual(['persistence', 'cats']);
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    expect(results.some(result => result.name === 'other-project')).toBe(false);
    store.close();
  });

  test('isolates exact reads, updates, and deletes by project directory', async () => {
    const store = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    const global = await store.saveMemory('global', projectA, 'shared-name', 'Global cat preference.');
    const first = await store.saveMemory('project', projectA, 'shared-name', 'Project A uses SQLite.');
    const second = await store.saveMemory('project', projectB, 'shared-name', 'Project B likes dogs.');

    expect(new Set([global.id, first.id, second.id]).size).toBe(3);
    expect(store.getMemory('project', projectA, 'shared-name')?.content).toContain('Project A');
    expect(store.getMemory('project', projectB, 'shared-name')?.content).toContain('Project B');
    expect(store.getMemory('global', projectB, 'shared-name')?.content).toContain('Global');

    await store.updateMemory('project', projectA, 'shared-name', 'Project A now uses dogs.');
    expect(store.getMemory('project', projectA, 'shared-name')?.content).toContain('now uses dogs');
    expect(store.getMemory('project', projectB, 'shared-name')?.content).toContain('Project B');

    expect(store.deleteMemory('project', projectA, 'shared-name')).toBe(true);
    expect(store.getMemory('project', projectA, 'shared-name')).toBeUndefined();
    expect(store.getMemory('project', projectB, 'shared-name')).toBeDefined();
    expect(store.getMemory('global', projectA, 'shared-name')).toBeDefined();
    store.close();
  });

  test('supports explicit global and project-only searches', async () => {
    const store = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    await store.addMemory('global', projectA, 'global-cat', 'A feline preference.');
    await store.addMemory('project', projectA, 'project-dog', 'This project uses canines.');

    expect((await store.searchMemories('global', projectA, 'pets', 5)).map(memory => memory.name))
      .toEqual(['global-cat']);
    expect((await store.searchMemories('project', projectA, 'pets', 5)).map(memory => memory.name))
      .toEqual(['project-dog']);
    expect(await store.searchMemories('project', projectB, 'pets', 5)).toEqual([]);
    store.close();
  });

  test('enforces scoped link rules', async () => {
    const store = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    expect(store.addMemory(
      'global',
      projectA,
      'invalid-link',
      'Global memory.',
      [projectLink('private-project-memory')],
    )).rejects.toThrow('only link to global');
    await expect(store.addMemory(
      'project',
      projectA,
      'valid-links',
      'Project memory.',
      [globalLink('preference'), projectLink('decision')],
    )).resolves.toMatchObject({ scope: 'project' });
    store.close();
  });

  test('rejects duplicate names within one scope', async () => {
    const store = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    await store.addMemory('project', projectA, 'unique', 'A cat memory.');
    expect(store.addMemory('project', projectA, 'unique', 'Another cat memory.'))
      .rejects.toThrow('UNIQUE');
    store.close();
  });

  test('reindexes all scopes when the embedding configuration changes', async () => {
    const original = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    await original.addMemory('global', projectA, 'global-existing', 'A cat memory.');
    await original.addMemory('project', projectA, 'project-existing', 'A dog memory.');
    original.close();

    const replacement: EmbeddingProvider = {
      model: 'test-embedding-v2',
      dimensions: 2,
      embed: async text => text.toLowerCase().includes('cat')
        ? new Float32Array([1, 0])
        : new Float32Array([0, 1]),
    };
    const migrated = new MemoryStore({ databasePath, embedder: replacement });

    expect((await migrated.searchMemories('global', projectA, 'cat', 1))[0].name)
      .toBe('global-existing');
    expect((await migrated.searchMemories('project', projectA, 'dog', 1))[0].name)
      .toBe('project-existing');
    expect(migrated.getMemory('project', projectA, 'project-existing')?.embeddingModel)
      .toBe('test-embedding-v2');
    migrated.close();
  });

  test('migrates legacy unscoped memories and links into global scope', async () => {
    const bootstrap = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    bootstrap.close();

    const legacy = new Database(databasePath, { strict: true });
    sqliteVec.load(legacy);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE memory_vectors;
      DROP TABLE memories;
      DROP TABLE memory_scopes;
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json)),
        embedding_model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE memory_vectors USING vec0(
        embedding float[3] distance_metric=cosine
      );
    `);
    legacy.query(`
      INSERT INTO memories (
        id, name, content, links_json, embedding_model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      42,
      'legacy-memory',
      'Legacy SQLite storage.',
      JSON.stringify(['related-memory']),
      'test-embedding-v1',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );
    legacy.query('INSERT INTO memory_vectors(rowid, embedding) VALUES (?, ?)')
      .run(42, new Float32Array([0, 0, 1]));
    legacy.exec('PRAGMA user_version = 2');
    legacy.close();

    const migrated = new MemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    expect(migrated.getMemory('global', projectA, 'legacy-memory')).toMatchObject({
      id: 42,
      scope: 'global',
      projectDirectory: null,
      links: [globalLink('related-memory')],
    });
    expect(migrated.getMemory('project', projectA, 'legacy-memory')).toBeUndefined();
    expect((await migrated.searchMemories('available', projectA, 'SQL storage', 1))[0].name)
      .toBe('legacy-memory');
    migrated.close();
  });
});
