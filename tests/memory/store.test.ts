import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as sqliteVec from 'sqlite-vec';
import type { EmbeddingProvider } from '../../src/memory/embeddings';
import {
  openMemoryStore,
  type MemoryLink,
  type MemoryScope,
  type MemoryTarget,
} from '../../src/memory/store';

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
const target = (scope: MemoryScope, directory: string): MemoryTarget => ({ scope, directory });

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
    const store = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    const saved = await store.save(target('project', projectA), {
      name: 'preferred-database',
      content: 'The project uses SQLite for local storage.',
      links: [globalLink('local-first'), projectLink('schema')],
    });
    store.close();

    const reopened = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    expect(reopened.get(target('project', projectA), 'preferred-database')).toMatchObject({
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
    const store = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    await store.save(target('global', projectA), {
      name: 'cats',
      content: 'Felines make excellent pets.',
    });
    await store.save(target('project', projectA), {
      name: 'persistence',
      content: 'SQLite is the local database storage layer.',
    });
    await store.save(target('project', projectB), {
      name: 'other-project',
      content: 'SQL storage belonging elsewhere.',
    });

    const results = await store.search('available', projectA, 'How is SQL data stored?', 5);

    expect(results.map(result => result.name)).toEqual(['persistence', 'cats']);
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    expect(results.some(result => result.name === 'other-project')).toBe(false);
    store.close();
  });

  test('isolates exact reads, updates, and deletes by project directory', async () => {
    const store = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    const shared = { name: 'shared-name' };
    const global = await store.save(target('global', projectA), {
      ...shared,
      content: 'Global cat preference.',
    });
    const first = await store.save(target('project', projectA), {
      ...shared,
      content: 'Project A uses SQLite.',
    });
    const second = await store.save(target('project', projectB), {
      ...shared,
      content: 'Project B likes dogs.',
    });

    expect(new Set([global.id, first.id, second.id]).size).toBe(3);
    expect(store.get(target('project', projectA), 'shared-name')?.content).toContain('Project A');
    expect(store.get(target('project', projectB), 'shared-name')?.content).toContain('Project B');
    expect(store.get(target('global', projectB), 'shared-name')?.content).toContain('Global');

    await store.save(target('project', projectA), { ...shared, content: 'Project A now uses dogs.' });
    expect(store.get(target('project', projectA), 'shared-name')?.content).toContain('now uses dogs');
    expect(store.get(target('project', projectB), 'shared-name')?.content).toContain('Project B');

    expect(store.delete(target('project', projectA), 'shared-name')).toBe(true);
    expect(store.get(target('project', projectA), 'shared-name')).toBeUndefined();
    expect(store.get(target('project', projectB), 'shared-name')).toBeDefined();
    expect(store.get(target('global', projectA), 'shared-name')).toBeDefined();
    store.close();
  });

  test('supports explicit global and project-only searches', async () => {
    const store = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    await store.save(target('global', projectA), {
      name: 'global-cat',
      content: 'A feline preference.',
    });
    await store.save(target('project', projectA), {
      name: 'project-dog',
      content: 'This project uses canines.',
    });

    expect((await store.search('global', projectA, 'pets', 5)).map(memory => memory.name))
      .toEqual(['global-cat']);
    expect((await store.search('project', projectA, 'pets', 5)).map(memory => memory.name))
      .toEqual(['project-dog']);
    expect(await store.search('project', projectB, 'pets', 5)).toEqual([]);
    store.close();
  });

  test('enforces scoped link rules', async () => {
    const store = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    expect(store.save(target('global', projectA), {
      name: 'invalid-link',
      content: 'Global memory.',
      links: [projectLink('private-project-memory')],
    })).rejects.toThrow('only link to global');
    await expect(store.save(target('project', projectA), {
      name: 'valid-links',
      content: 'Project memory.',
      links: [globalLink('preference'), projectLink('decision')],
    })).resolves.toMatchObject({ scope: 'project' });
    store.close();
  });

  test('keeps one memory per name within one scope', async () => {
    const store = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    const first = await store.save(target('project', projectA), {
      name: 'unique',
      content: 'A cat memory.',
    });
    const second = await store.save(target('project', projectA), {
      name: 'unique',
      content: 'Another cat memory.',
    });

    expect(second.id).toBe(first.id);
    expect(store.get(target('project', projectA), 'unique')?.content).toBe('Another cat memory.');
    expect((await store.search('project', projectA, 'cat', 5)).map(memory => memory.name))
      .toEqual(['unique']);
    store.close();

    // The assertions above hold purely from `save`'s read-then-update branch and would
    // still pass even if the `memories_scope_name` unique index (schema.ts) were dropped.
    // Exercise the index directly: a raw insert duplicating the same (scope_id, name)
    // pair must be rejected by sqlite itself.
    const raw = new Database(databasePath, { strict: true });
    sqliteVec.load(raw);
    const scopeId = raw.query<{ id: number }, [string]>(
      "SELECT id FROM memory_scopes WHERE kind = 'project' AND directory = ?",
    ).get(projectA)?.id;
    if (scopeId === undefined) throw new Error('Project memory scope was not created');
    expect(() => raw.query(`
      INSERT INTO memories (scope_id, name, content, embedding_model)
      VALUES (?, ?, ?, ?)
    `).run(scopeId, 'unique', 'Duplicate row.', 'test-embedding-v1'))
      .toThrow(/UNIQUE/);
    raw.close();
  });

  test('reindexes all scopes when the embedding configuration changes', async () => {
    const original = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    await original.save(target('global', projectA), {
      name: 'global-existing',
      content: 'A cat memory.',
    });
    await original.save(target('project', projectA), {
      name: 'project-existing',
      content: 'A dog memory.',
    });
    original.close();

    const replacement: EmbeddingProvider = {
      model: 'test-embedding-v2',
      dimensions: 2,
      embed: async text => text.toLowerCase().includes('cat')
        ? new Float32Array([1, 0])
        : new Float32Array([0, 1]),
    };
    const migrated = openMemoryStore({ databasePath, embedder: replacement });

    expect((await migrated.search('global', projectA, 'cat', 1))[0].name)
      .toBe('global-existing');
    expect((await migrated.search('project', projectA, 'dog', 1))[0].name)
      .toBe('project-existing');
    expect(migrated.get(target('project', projectA), 'project-existing')?.embeddingModel)
      .toBe('test-embedding-v2');
    migrated.close();
  });

  test('migrates legacy unscoped memories and links into global scope', async () => {
    const bootstrap = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
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

    const migrated = openMemoryStore({ databasePath, embedder: new TestEmbeddingProvider() });
    expect(migrated.get(target('global', projectA), 'legacy-memory')).toMatchObject({
      id: 42,
      scope: 'global',
      projectDirectory: null,
      links: [globalLink('related-memory')],
    });
    expect(migrated.get(target('project', projectA), 'legacy-memory')).toBeUndefined();
    expect((await migrated.search('available', projectA, 'SQL storage', 1))[0].name)
      .toBe('legacy-memory');
    migrated.close();
  });
});
