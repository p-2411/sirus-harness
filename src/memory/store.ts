import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as sqliteVec from 'sqlite-vec';
import { dataDirectory } from '../persistence';
import { LocalEmbeddingProvider, type EmbeddingProvider } from './embeddings';

export type MemoryScope = 'global' | 'project';
export type MemorySearchScope = MemoryScope | 'available';

export interface MemoryLink {
  scope: MemoryScope;
  name: string;
}

export interface Memory {
  id: number;
  scope: MemoryScope;
  projectDirectory: string | null;
  name: string;
  content: string;
  links: MemoryLink[];
  embeddingModel: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult extends Memory {
  distance: number;
  similarity: number;
}

export interface MemoryStoreOptions {
  databasePath: string;
  embedder: EmbeddingProvider;
}

interface MemoryRow {
  id: number;
  scope_id: number;
  scope: MemoryScope;
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

interface SearchRow extends MemoryRow {
  distance: number;
}

const MEMORY_COLUMNS = `
  memories.id, memories.scope_id, memory_scopes.kind AS scope,
  memory_scopes.directory AS project_directory, memories.name, memories.content,
  memories.links_json, memories.embedding_model, memories.created_at, memories.updated_at
`;

let sqliteConfigured = false;

function configureSQLite(): void {
  if (sqliteConfigured) return;
  if (process.platform === 'darwin') {
    const candidates = [
      process.env.SIRUS_SQLITE_LIBRARY,
      '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
      '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
    ].filter((path): path is string => Boolean(path));
    const libraryPath = candidates.find(existsSync);
    if (libraryPath) Database.setCustomSQLite(libraryPath);
  }
  sqliteConfigured = true;
}

function loadVectorExtension(database: Database): void {
  try {
    sqliteVec.load(database);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const macHint = process.platform === 'darwin'
      ? ' Install SQLite with `brew install sqlite` or set SIRUS_SQLITE_LIBRARY.'
      : '';
    throw new Error(`Unable to load sqlite-vec: ${detail}.${macHint}`);
  }
}

export function defaultMemoryDatabasePath(): string {
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true });
  return join(directory, 'sirus.db');
}

export class MemoryStore {
  private readonly database: Database;
  private readonly embedder: EmbeddingProvider;
  private needsReindex = false;
  private reindexPromise: Promise<void> | undefined;

  constructor(options: MemoryStoreOptions) {
    validateEmbedder(options.embedder);
    configureSQLite();
    if (options.databasePath !== ':memory:') {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }

    this.embedder = options.embedder;
    this.database = new Database(options.databasePath, { create: true, strict: true });
    try {
      this.database.exec('PRAGMA foreign_keys = ON');
      this.database.exec('PRAGMA busy_timeout = 5000');
      if (options.databasePath !== ':memory:') this.database.exec('PRAGMA journal_mode = WAL');
      loadVectorExtension(this.database);
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  async addMemory(
    scope: MemoryScope,
    directory: string,
    name: string,
    content: string,
    links: MemoryLink[] = [],
  ): Promise<Memory> {
    const target = validateTarget(scope, directory);
    const input = validateMemoryInput(target.scope, name, content, links);
    await this.ensureIndex();
    const embedding = await this.embedMemory(input.name, input.content, input.links);
    const scopeId = this.scopeId(target.scope, target.directory, true)!;
    const insert = this.database.transaction(() => {
      const result = this.database.query(`
        INSERT INTO memories (scope_id, name, content, links_json, embedding_model)
        VALUES (?, ?, ?, ?, ?)
      `).run(scopeId, input.name, input.content, JSON.stringify(input.links), this.embedder.model);
      const id = Number(result.lastInsertRowid);
      this.database.query('INSERT INTO memory_vectors(rowid, embedding, scope_id) VALUES (?, ?, ?)')
        .run(id, embedding, scopeId);
      return id;
    });
    const id = insert.immediate();
    return this.getMemoryById(id)!;
  }

  async saveMemory(
    scope: MemoryScope,
    directory: string,
    name: string,
    content: string,
    links: MemoryLink[] = [],
  ): Promise<Memory> {
    return this.getMemory(scope, directory, name)
      ? (await this.updateMemory(scope, directory, name, content, links))!
      : this.addMemory(scope, directory, name, content, links);
  }

  async updateMemory(
    scope: MemoryScope,
    directory: string,
    name: string,
    content: string,
    links: MemoryLink[] = [],
  ): Promise<Memory | undefined> {
    const target = validateTarget(scope, directory);
    const existing = this.getMemory(target.scope, target.directory, name);
    if (!existing) return undefined;
    const input = validateMemoryInput(target.scope, name, content, links);
    await this.ensureIndex();
    const embedding = await this.embedMemory(input.name, input.content, input.links);
    const update = this.database.transaction(() => {
      this.database.query(`
        UPDATE memories
        SET content = ?, links_json = ?, embedding_model = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(input.content, JSON.stringify(input.links), this.embedder.model, existing.id);
      this.database.query('DELETE FROM memory_vectors WHERE rowid = ?').run(existing.id);
      this.database.query('INSERT INTO memory_vectors(rowid, embedding, scope_id) VALUES (?, ?, ?)')
        .run(existing.id, embedding, this.scopeId(target.scope, target.directory, false)!);
    });
    update.immediate();
    return this.getMemoryById(existing.id);
  }

  deleteMemory(scope: MemoryScope, directory: string, name: string): boolean {
    const existing = this.getMemory(scope, directory, name);
    if (!existing) return false;
    const remove = this.database.transaction(() => {
      this.database.query('DELETE FROM memory_vectors WHERE rowid = ?').run(existing.id);
      this.database.query('DELETE FROM memories WHERE id = ?').run(existing.id);
    });
    remove.immediate();
    return true;
  }

  getMemory(scope: MemoryScope, directory: string, name: string): Memory | undefined {
    const target = validateTarget(scope, directory);
    const scopeId = this.scopeId(target.scope, target.directory, false);
    if (scopeId === undefined) return undefined;
    const row = this.database.query<MemoryRow, [number, string]>(`
      SELECT ${MEMORY_COLUMNS}
      FROM memories JOIN memory_scopes ON memory_scopes.id = memories.scope_id
      WHERE memories.scope_id = ? AND memories.name = ?
    `).get(scopeId, requiredText(name, 'Memory name'));
    return row ? memoryFromRow(row) : undefined;
  }

  listMemories(scope: MemorySearchScope = 'available', directory: string = process.cwd()): Memory[] {
    const scopeIds = this.visibleScopeIds(validateSearchScope(scope), directory);
    const memories = scopeIds.flatMap(scopeId => this.database.query<MemoryRow, [number]>(`
      SELECT ${MEMORY_COLUMNS}
      FROM memories JOIN memory_scopes ON memory_scopes.id = memories.scope_id
      WHERE memories.scope_id = ?
    `).all(scopeId).map(memoryFromRow));
    return memories.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.id - left.id);
  }

  async searchMemories(
    scope: MemorySearchScope,
    directory: string,
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    const normalizedScope = validateSearchScope(scope);
    const normalizedQuery = requiredText(query, 'Memory search query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError('Memory search limit must be an integer between 1 and 50');
    }
    await this.ensureIndex();
    const scopeIds = this.visibleScopeIds(normalizedScope, directory)
      .filter(scopeId => this.countMemories(scopeId) > 0);
    if (scopeIds.length === 0) return [];

    const embedding = await this.embed(normalizedQuery);
    const rows = scopeIds.flatMap(scopeId => this.searchScope(embedding, scopeId, limit));
    return rows
      .sort((left, right) => left.distance - right.distance || left.id - right.id)
      .slice(0, limit)
      .map(row => ({
        ...memoryFromRow(row),
        distance: row.distance,
        similarity: 1 - row.distance,
      }));
  }

  private migrate(): void {
    this.database.exec(`
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

    const globalScopeId = this.globalScopeId();
    let migratedLegacyMemories = false;
    if (!this.tableExists('memories')) {
      this.createMemoryTable();
    } else if (!this.tableHasColumn('memories', 'scope_id')) {
      this.migrateLegacyMemories(globalScopeId);
      migratedLegacyMemories = true;
    }
    this.createMemoryIndexes();

    const storedModel = this.setting('embedding_model');
    const storedDimensions = this.setting('embedding_dimensions');
    if (storedModel === undefined && storedDimensions === undefined) {
      const writeSettings = this.database.transaction(() => {
        this.database.query('INSERT INTO memory_settings (key, value) VALUES (?, ?)')
          .run('embedding_model', this.embedder.model);
        this.database.query('INSERT INTO memory_settings (key, value) VALUES (?, ?)')
          .run('embedding_dimensions', String(this.embedder.dimensions));
      });
      writeSettings();
    } else if (storedModel !== this.embedder.model || storedDimensions !== String(this.embedder.dimensions)) {
      this.needsReindex = true;
    }

    const vectorTableExists = this.tableExists('memory_vectors');
    if (migratedLegacyMemories || (vectorTableExists && !this.tableHasColumn('memory_vectors', 'scope_id'))) {
      this.needsReindex = true;
    }
    if (!vectorTableExists && this.countAllMemories() > 0) this.needsReindex = true;
    if (!this.needsReindex) this.createVectorTable();
    this.database.exec('PRAGMA user_version = 3');
  }

  private createMemoryTable(): void {
    this.database.exec(`
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

  private createMemoryIndexes(): void {
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_name
        ON memories(scope_id, name);
      CREATE INDEX IF NOT EXISTS memories_scope_updated
        ON memories(scope_id, updated_at DESC);
    `);
  }

  private migrateLegacyMemories(globalScopeId: number): void {
    const legacyRows = this.database.query<LegacyMemoryRow, []>(`
      SELECT id, name, content, links_json, embedding_model, created_at, updated_at
      FROM memories ORDER BY id
    `).all();
    const migrate = this.database.transaction(() => {
      this.database.exec('ALTER TABLE memories RENAME TO memories_legacy_v2');
      this.createMemoryTable();
      const insert = this.database.query(`
        INSERT INTO memories (
          id, scope_id, name, content, links_json, embedding_model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        insert.run(
          row.id,
          globalScopeId,
          row.name,
          row.content,
          JSON.stringify(legacyLinks(row.links_json)),
          row.embedding_model,
          row.created_at,
          row.updated_at,
        );
      }
      this.database.exec('DROP TABLE memories_legacy_v2');
    });
    migrate.immediate();
  }

  private createVectorTable(): void {
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        embedding float[${this.embedder.dimensions}] distance_metric=cosine,
        scope_id integer
      )
    `);
  }

  private async ensureIndex(): Promise<void> {
    if (!this.needsReindex) return;
    this.reindexPromise ??= this.reindex().catch(error => {
      this.reindexPromise = undefined;
      throw error;
    });
    await this.reindexPromise;
  }

  private async reindex(): Promise<void> {
    const memories = this.listAllMemories();
    const vectors: Array<{ id: number; scopeId: number; embedding: Float32Array }> = [];
    for (const memory of memories) {
      vectors.push({
        id: memory.memory.id,
        scopeId: memory.scopeId,
        embedding: await this.embedMemory(memory.memory.name, memory.memory.content, memory.memory.links),
      });
    }

    const rebuild = this.database.transaction(() => {
      this.database.exec('DROP TABLE IF EXISTS memory_vectors');
      this.createVectorTable();
      this.database.query(`
        INSERT INTO memory_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run('embedding_model', this.embedder.model);
      this.database.query(`
        INSERT INTO memory_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run('embedding_dimensions', String(this.embedder.dimensions));
      this.database.query('UPDATE memories SET embedding_model = ?').run(this.embedder.model);
      const insertVector = this.database.query(
        'INSERT INTO memory_vectors(rowid, embedding, scope_id) VALUES (?, ?, ?)',
      );
      for (const vector of vectors) insertVector.run(vector.id, vector.embedding, vector.scopeId);
    });
    rebuild.immediate();
    this.needsReindex = false;
  }

  private searchScope(embedding: Float32Array, scopeId: number, limit: number): SearchRow[] {
    return this.database.query<SearchRow, [Float32Array, number, number]>(`
      WITH nearest AS (
        SELECT rowid, distance FROM memory_vectors
        WHERE embedding MATCH ? AND k = ? AND scope_id = ?
      )
      SELECT ${MEMORY_COLUMNS}, nearest.distance
      FROM nearest
      JOIN memories ON memories.id = nearest.rowid
      JOIN memory_scopes ON memory_scopes.id = memories.scope_id
      ORDER BY nearest.distance
    `).all(embedding, limit, scopeId);
  }

  private visibleScopeIds(scope: MemorySearchScope, directory: string): number[] {
    if (scope === 'global') return [this.globalScopeId()];
    const projectScopeId = this.scopeId('project', normalizeDirectory(directory), false);
    if (scope === 'project') return projectScopeId === undefined ? [] : [projectScopeId];
    return projectScopeId === undefined
      ? [this.globalScopeId()]
      : [this.globalScopeId(), projectScopeId];
  }

  private scopeId(scope: MemoryScope, directory: string, create: boolean): number | undefined {
    if (scope === 'global') return this.globalScopeId();
    const normalizedDirectory = normalizeDirectory(directory);
    let id = this.database.query<{ id: number }, [string]>(`
      SELECT id FROM memory_scopes WHERE kind = 'project' AND directory = ?
    `).get(normalizedDirectory)?.id;
    if (id !== undefined || !create) return id;
    this.database.query(`
      INSERT OR IGNORE INTO memory_scopes (kind, directory) VALUES ('project', ?)
    `).run(normalizedDirectory);
    id = this.database.query<{ id: number }, [string]>(`
      SELECT id FROM memory_scopes WHERE kind = 'project' AND directory = ?
    `).get(normalizedDirectory)?.id;
    if (id === undefined) throw new Error('Could not create project memory scope');
    return id;
  }

  private globalScopeId(): number {
    const id = this.database.query<{ id: number }, []>(`
      SELECT id FROM memory_scopes WHERE kind = 'global'
    `).get()?.id;
    if (id === undefined) throw new Error('Global memory scope is missing');
    return id;
  }

  private setting(key: string): string | undefined {
    return this.database.query<{ value: string }, [string]>(
      'SELECT value FROM memory_settings WHERE key = ?',
    ).get(key)?.value;
  }

  private tableExists(name: string): boolean {
    return this.database.query<{ found: number }, [string]>(`
      SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(name)?.found === 1;
  }

  private tableHasColumn(table: 'memories' | 'memory_vectors', column: string): boolean {
    return this.database.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all().some(info => info.name === column);
  }

  private countAllMemories(): number {
    return this.database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM memories',
    ).get()?.count ?? 0;
  }

  private countMemories(scopeId: number): number {
    return this.database.query<{ count: number }, [number]>(
      'SELECT count(*) AS count FROM memories WHERE scope_id = ?',
    ).get(scopeId)?.count ?? 0;
  }

  private listAllMemories(): Array<{ scopeId: number; memory: Memory }> {
    return this.database.query<MemoryRow, []>(`
      SELECT ${MEMORY_COLUMNS}
      FROM memories JOIN memory_scopes ON memory_scopes.id = memories.scope_id
      ORDER BY memories.id
    `).all().map(row => ({ scopeId: row.scope_id, memory: memoryFromRow(row) }));
  }

  private getMemoryById(id: number): Memory | undefined {
    const row = this.database.query<MemoryRow, [number]>(`
      SELECT ${MEMORY_COLUMNS}
      FROM memories JOIN memory_scopes ON memory_scopes.id = memories.scope_id
      WHERE memories.id = ?
    `).get(id);
    return row ? memoryFromRow(row) : undefined;
  }

  private embedMemory(name: string, content: string, links: MemoryLink[]): Promise<Float32Array> {
    return this.embed([
      `Memory: ${name}`,
      content,
      links.length > 0 ? `Related: ${links.map(link => `${link.scope}:${link.name}`).join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }

  private async embed(text: string): Promise<Float32Array> {
    const embedding = await this.embedder.embed(text);
    if (!(embedding instanceof Float32Array) || embedding.length !== this.embedder.dimensions) {
      throw new Error(
        `Embedding provider returned ${embedding.length} dimensions; expected ${this.embedder.dimensions}`,
      );
    }
    for (const value of embedding) {
      if (!Number.isFinite(value)) throw new Error('Embedding provider returned a non-finite value');
    }
    return embedding;
  }
}

function validateEmbedder(embedder: EmbeddingProvider): void {
  requiredText(embedder.model, 'Embedding model');
  if (!Number.isInteger(embedder.dimensions) || embedder.dimensions < 1) {
    throw new TypeError('Embedding dimensions must be a positive integer');
  }
}

function validateTarget(scope: MemoryScope, directory: string): { scope: MemoryScope; directory: string } {
  if (scope !== 'global' && scope !== 'project') {
    throw new TypeError('Memory scope must be global or project');
  }
  return {
    scope,
    directory: scope === 'project' ? normalizeDirectory(directory) : '',
  };
}

function validateSearchScope(scope: MemorySearchScope): MemorySearchScope {
  if (scope !== 'available' && scope !== 'global' && scope !== 'project') {
    throw new TypeError('Memory search scope must be available, global, or project');
  }
  return scope;
}

function validateMemoryInput(scope: MemoryScope, name: string, content: string, links: MemoryLink[]) {
  if (!Array.isArray(links)) throw new TypeError('Memory links must be an array');
  const normalizedLinks = links.map(link => {
    if (!link || typeof link !== 'object' || (link.scope !== 'global' && link.scope !== 'project')) {
      throw new TypeError('Memory links must contain a global or project scope and a non-empty name');
    }
    return { scope: link.scope, name: requiredText(link.name, 'Memory link name') };
  });
  if (scope === 'global' && normalizedLinks.some(link => link.scope === 'project')) {
    throw new TypeError('Global memories may only link to global memories');
  }
  return {
    name: requiredText(name, 'Memory name'),
    content: requiredText(content, 'Memory content'),
    links: [...new Map(normalizedLinks.map(link => [`${link.scope}\0${link.name}`, link])).values()],
  };
}

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeDirectory(directory: string): string {
  return resolve(requiredText(directory, 'Project directory'));
}

function legacyLinks(linksJson: string): MemoryLink[] {
  const parsed: unknown = JSON.parse(linksJson);
  if (!Array.isArray(parsed) || parsed.some(link => typeof link !== 'string' || !link.trim())) {
    throw new Error('Legacy memory has invalid links');
  }
  return parsed.map(name => ({ scope: 'global', name: name.trim() }));
}

function memoryFromRow(row: MemoryRow): Memory {
  const links: unknown = JSON.parse(row.links_json);
  if (!Array.isArray(links) || links.some(link =>
    !link
    || typeof link !== 'object'
    || (link.scope !== 'global' && link.scope !== 'project')
    || typeof link.name !== 'string')) {
    throw new Error(`Memory ${row.name} has invalid links`);
  }
  return {
    id: row.id,
    scope: row.scope,
    projectDirectory: row.project_directory,
    name: row.name,
    content: row.content,
    links: links as MemoryLink[],
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

let defaultStore: MemoryStore | undefined;

export function getDefaultMemoryStore(): MemoryStore {
  defaultStore ??= new MemoryStore({
    databasePath: defaultMemoryDatabasePath(),
    embedder: new LocalEmbeddingProvider(),
  });
  return defaultStore;
}
