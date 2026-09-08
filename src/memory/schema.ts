import type { Database } from 'bun:sqlite';
import type { MemoryLink } from './store';

// The shape of the memory tables, the v1 -> v3 migration, and the queries that
// depend on the column layout. Everything here is schema-level: no embedding,
// no search, no validation of caller input.

export interface SchemaEmbedder {
  readonly model: string;
  readonly dimensions: number;
}

export interface MemoryRow {
  id: number;
  scope_id: number;
  scope: 'global' | 'project';
  project_directory: string | null;
  name: string;
  content: string;
  links_json: string;
  embedding_model: string;
  created_at: string;
  updated_at: string;
}

interface LegacyMemoryRow {
  id: number;
  name: string;
  content: string;
  links_json: string;
  embedding_model: string;
  created_at: string;
  updated_at: string;
}

export const MEMORY_COLUMNS = `
  memories.id, memories.scope_id, memory_scopes.kind AS scope,
  memory_scopes.directory AS project_directory, memories.name, memories.content,
  memories.links_json, memories.embedding_model, memories.created_at, memories.updated_at
`;

export const SELECT_MEMORIES = `
  SELECT ${MEMORY_COLUMNS}
  FROM memories JOIN memory_scopes ON memory_scopes.id = memories.scope_id
`;

export function migrate(database: Database, embedder: SchemaEmbedder): { needsReindex: boolean } {
  let needsReindex = false;
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_scopes (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('global', 'project')),
      directory TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (
        (kind = 'global' AND directory IS NULL)
        OR (kind = 'project' AND directory IS NOT NULL AND length(directory) > 0)
      )
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_scopes_one_global
      ON memory_scopes(kind) WHERE kind = 'global';
    CREATE UNIQUE INDEX IF NOT EXISTS memory_scopes_project_directory
      ON memory_scopes(directory) WHERE kind = 'project';
    INSERT OR IGNORE INTO memory_scopes (kind, directory) VALUES ('global', NULL);
  `);

  const scopeId = globalScopeId(database);
  let migratedLegacyMemories = false;
  if (!tableExists(database, 'memories')) {
    createMemoryTable(database);
  } else if (!tableHasColumn(database, 'memories', 'scope_id')) {
    migrateLegacyMemories(database, scopeId);
    migratedLegacyMemories = true;
  }
  createMemoryIndexes(database);

  const storedModel = setting(database, 'embedding_model');
  const storedDimensions = setting(database, 'embedding_dimensions');
  if (storedModel === undefined && storedDimensions === undefined) {
    const writeSettings = database.transaction(() => {
      database.query('INSERT INTO memory_settings (key, value) VALUES (?, ?)')
        .run('embedding_model', embedder.model);
      database.query('INSERT INTO memory_settings (key, value) VALUES (?, ?)')
        .run('embedding_dimensions', String(embedder.dimensions));
    });
    writeSettings();
  } else if (storedModel !== embedder.model || storedDimensions !== String(embedder.dimensions)) {
    needsReindex = true;
  }

  const vectorTableExists = tableExists(database, 'memory_vectors');
  if (migratedLegacyMemories || (vectorTableExists && !tableHasColumn(database, 'memory_vectors', 'scope_id'))) {
    needsReindex = true;
  }
  if (!vectorTableExists && countAllMemories(database) > 0) needsReindex = true;
  if (!needsReindex) createVectorTable(database, embedder.dimensions);
  database.exec('PRAGMA user_version = 3');
  return { needsReindex };
}

export function createVectorTable(database: Database, dimensions: number): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
      embedding float[${dimensions}] distance_metric=cosine,
      scope_id integer
    )
  `);
}

export function globalScopeId(database: Database): number {
  const id = database.query<{ id: number }, []>(`
    SELECT id FROM memory_scopes WHERE kind = 'global'
  `).get()?.id;
  if (id === undefined) throw new Error('Global memory scope is missing');
  return id;
}

function createMemoryTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      scope_id INTEGER NOT NULL REFERENCES memory_scopes(id),
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json)),
      embedding_model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT
  `);
}

function createMemoryIndexes(database: Database): void {
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_name
      ON memories(scope_id, name);
    CREATE INDEX IF NOT EXISTS memories_scope_updated
      ON memories(scope_id, updated_at DESC);
  `);
}

function migrateLegacyMemories(database: Database, scopeId: number): void {
  const legacyRows = database.query<LegacyMemoryRow, []>(`
    SELECT id, name, content, links_json, embedding_model, created_at, updated_at
    FROM memories ORDER BY id
  `).all();
  const migration = database.transaction(() => {
    database.exec('ALTER TABLE memories RENAME TO memories_legacy_v2');
    createMemoryTable(database);
    const insert = database.query(`
      INSERT INTO memories (
        id, scope_id, name, content, links_json, embedding_model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of legacyRows) {
      insert.run(
        row.id,
        scopeId,
        row.name,
        row.content,
        JSON.stringify(legacyLinks(row.links_json)),
        row.embedding_model,
        row.created_at,
        row.updated_at,
      );
    }
    database.exec('DROP TABLE memories_legacy_v2');
  });
  migration.immediate();
}

function setting(database: Database, key: string): string | undefined {
  return database.query<{ value: string }, [string]>(
    'SELECT value FROM memory_settings WHERE key = ?',
  ).get(key)?.value;
}

function tableExists(database: Database, name: string): boolean {
  return database.query<{ found: number }, [string]>(`
    SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name)?.found === 1;
}

function tableHasColumn(
  database: Database,
  table: 'memories' | 'memory_vectors',
  column: string,
): boolean {
  return database.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all().some(info => info.name === column);
}

function countAllMemories(database: Database): number {
  return database.query<{ count: number }, []>(
    'SELECT count(*) AS count FROM memories',
  ).get()?.count ?? 0;
}

function legacyLinks(linksJson: string): MemoryLink[] {
  const parsed: unknown = JSON.parse(linksJson);
  if (!Array.isArray(parsed) || parsed.some(link => typeof link !== 'string' || !link.trim())) {
    throw new Error('Legacy memory has invalid links');
  }
  return parsed.map(name => ({ scope: 'global', name: name.trim() }));
}
