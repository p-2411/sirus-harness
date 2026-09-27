import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as sqliteVec from 'sqlite-vec';
import { errorMessage } from '../abort';
import { dataDirectory } from '../dataDirectory';
import { LocalEmbeddingProvider, type EmbeddingProvider } from './embeddings';
import { SELECT_MEMORIES, globalScopeId, migrate, type MemoryRow } from './schema';
import { VectorIndex, type IndexableMemory } from './vectorIndex';

// Where a memory lives: shared by every project, or tied to one directory.
export const MEMORY_SCOPES = ['global', 'project'] as const;

export type MemoryScope = typeof MEMORY_SCOPES[number];

// What a search looks through: one scope, or every one the session can see.
export const MEMORY_SEARCH_SCOPES = ['available', ...MEMORY_SCOPES] as const;

export type MemorySearchScope = typeof MEMORY_SEARCH_SCOPES[number];

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

// The scope a memory operation addresses: global, or one project keyed by its
// resolved directory. `directory` is ignored (and blank) for global memories.
export interface MemoryTarget {
  scope: MemoryScope;
  directory: string;
}

export interface MemoryInput {
  name: string;
  content: string;
  // Model- and caller-supplied; validated (not merely cast) in validateMemoryInput.
  links?: unknown;
}

export interface MemoryStore {
  save(target: MemoryTarget, input: MemoryInput): Promise<Memory>;
  get(target: MemoryTarget, name: string): Memory | undefined;
  delete(target: MemoryTarget, name: string): boolean;
  search(
    scope: MemorySearchScope,
    directory: string,
    query: string,
    limit?: number,
  ): Promise<MemorySearchResult[]>;
  close(): void;
}

export interface MemoryStoreOptions {
  databasePath: string;
  embedder: EmbeddingProvider;
}

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
    const detail = errorMessage(error);
    const macHint = process.platform === 'darwin'
      ? ' Install SQLite with `brew install sqlite` or set SIRUS_SQLITE_LIBRARY.'
      : '';
    throw new Error(`Unable to load sqlite-vec: ${detail}.${macHint}`);
  }
}

class SqliteMemoryStore implements MemoryStore {
  private readonly database: Database;
  private readonly embedder: EmbeddingProvider;
  private readonly index: VectorIndex;

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
      const { needsReindex } = migrate(this.database, this.embedder);
      this.index = new VectorIndex({
        database: this.database,
        embedder: this.embedder,
        needsReindex,
        memories: () => this.indexableMemories(),
        embed: text => this.embed(text),
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  // Whether the name already exists is settled by the write itself, not before
  // the embedding is awaited, since a save or delete of the same name may run
  // in between. Any vector already under the id goes first: the old one on an
  // update, or on an insert one an older build left behind for a deleted
  // memory whose id is now reused.
  async save(target: MemoryTarget, input: MemoryInput): Promise<Memory> {
    const scoped = memoryTarget(target.scope, target.directory);
    const memory = validateMemoryInput(scoped.scope, input);
    await this.index.ensure();
    const embedding = await this.embed(memoryEmbeddingText(memory.name, memory.content, memory.links));
    const scopeId = this.scopeId(scoped, true)!;
    const write = this.database.transaction(() => {
      const { id } = this.database.query<{ id: number }, [number, string, string, string, string]>(`
        INSERT INTO memories (scope_id, name, content, links_json, embedding_model)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, name) DO UPDATE
        SET content = excluded.content, links_json = excluded.links_json,
            embedding_model = excluded.embedding_model,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        RETURNING id
      `).get(scopeId, memory.name, memory.content, JSON.stringify(memory.links), this.embedder.model)!;
      this.index.remove(id);
      this.index.insert(id, embedding, scopeId);
      return id;
    });
    return this.memoryById(write.immediate())!;
  }

  get(target: MemoryTarget, name: string): Memory | undefined {
    const scoped = memoryTarget(target.scope, target.directory);
    const scopeId = this.scopeId(scoped, false);
    if (scopeId === undefined) return undefined;
    const row = this.database.query<MemoryRow, [number, string]>(`
      ${SELECT_MEMORIES} WHERE memories.scope_id = ? AND memories.name = ?
    `).get(scopeId, requiredText(name, 'Memory name'));
    return row ? memoryFromRow(row) : undefined;
  }

  delete(target: MemoryTarget, name: string): boolean {
    const existing = this.get(target, name);
    if (!existing) return false;
    const remove = this.database.transaction(() => {
      this.index.remove(existing.id);
      this.database.query('DELETE FROM memories WHERE id = ?').run(existing.id);
    });
    remove.immediate();
    return true;
  }

  async search(
    scope: MemorySearchScope,
    directory: string,
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    const normalizedScope = memorySearchScope(scope);
    const normalizedQuery = requiredText(query, 'Memory search query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError('Memory search limit must be an integer between 1 and 50');
    }
    await this.index.ensure();
    const scopeIds = this.visibleScopeIds(normalizedScope, directory)
      .filter(scopeId => this.countMemories(scopeId) > 0);
    if (scopeIds.length === 0) return [];

    const embedding = await this.embed(normalizedQuery);
    const rows = scopeIds.flatMap(scopeId => this.index.search(embedding, scopeId, limit));
    return rows
      .sort((left, right) => left.distance - right.distance || left.id - right.id)
      .slice(0, limit)
      .map(row => ({
        ...memoryFromRow(row),
        distance: row.distance,
        similarity: 1 - row.distance,
      }));
  }

  private visibleScopeIds(scope: MemorySearchScope, directory: string): number[] {
    if (scope === 'global') return [globalScopeId(this.database)];
    const projectScopeId = this.projectScopeId(directory, false);
    if (scope === 'project') return projectScopeId === undefined ? [] : [projectScopeId];
    return projectScopeId === undefined
      ? [globalScopeId(this.database)]
      : [globalScopeId(this.database), projectScopeId];
  }

  private scopeId(target: MemoryTarget, create: boolean): number | undefined {
    return target.scope === 'global'
      ? globalScopeId(this.database)
      : this.projectScopeId(target.directory, create);
  }

  private projectScopeId(directory: string, create: boolean): number | undefined {
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

  private countMemories(scopeId: number): number {
    return this.database.query<{ count: number }, [number]>(
      'SELECT count(*) AS count FROM memories WHERE scope_id = ?',
    ).get(scopeId)?.count ?? 0;
  }

  private indexableMemories(): IndexableMemory[] {
    return this.database.query<MemoryRow, []>(`
      ${SELECT_MEMORIES} ORDER BY memories.id
    `).all().map(row => {
      const memory = memoryFromRow(row);
      return {
        id: memory.id,
        scopeId: row.scope_id,
        text: memoryEmbeddingText(memory.name, memory.content, memory.links),
      };
    });
  }

  private memoryById(id: number): Memory | undefined {
    const row = this.database.query<MemoryRow, [number]>(`
      ${SELECT_MEMORIES} WHERE memories.id = ?
    `).get(id);
    return row ? memoryFromRow(row) : undefined;
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

export function openMemoryStore(options: MemoryStoreOptions): MemoryStore {
  return new SqliteMemoryStore(options);
}

const stores = new Map<string, MemoryStore>();

// One store per database file. The data directory is read at call time, so a
// test or a relocated install is not pinned to whatever the first caller saw.
export function memoryStoreFor(directory: string = dataDirectory()): MemoryStore {
  const databasePath = join(resolve(directory), 'sirus.db');
  let store = stores.get(databasePath);
  if (!store) {
    store = openMemoryStore({ databasePath, embedder: new LocalEmbeddingProvider() });
    stores.set(databasePath, store);
  }
  return store;
}

export function closeAllMemoryStores(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}

// A validated scope/directory pair. Callers hand user- or model-supplied values
// straight in; every store method re-derives the target from what it is given.
export function memoryTarget(scope: unknown, directory: string): MemoryTarget {
  if (!isMemoryScope(scope)) {
    throw new TypeError('Memory scope must be global or project');
  }
  return {
    scope,
    directory: scope === 'project' ? normalizeDirectory(directory) : '',
  };
}

export function memorySearchScope(scope: unknown): MemorySearchScope {
  if (!(MEMORY_SEARCH_SCOPES as readonly unknown[]).includes(scope)) {
    throw new TypeError('Memory search scope must be available, global, or project');
  }
  return scope as MemorySearchScope;
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return (MEMORY_SCOPES as readonly unknown[]).includes(value);
}

interface ValidMemoryInput {
  name: string;
  content: string;
  links: MemoryLink[];
}

function validateEmbedder(embedder: EmbeddingProvider): void {
  requiredText(embedder.model, 'Embedding model');
  if (!Number.isInteger(embedder.dimensions) || embedder.dimensions < 1) {
    throw new TypeError('Embedding dimensions must be a positive integer');
  }
}

function validateMemoryInput(scope: MemoryScope, input: MemoryInput): ValidMemoryInput {
  const links = input.links ?? [];
  if (!Array.isArray(links)) throw new TypeError('Memory links must be an array');
  const normalizedLinks = links.map((link: unknown): MemoryLink => {
    const candidate = link as { scope?: unknown; name?: unknown } | null;
    if (!candidate || typeof candidate !== 'object' || !isMemoryScope(candidate.scope)) {
      throw new TypeError('Memory links must contain a global or project scope and a non-empty name');
    }
    return { scope: candidate.scope, name: requiredText(candidate.name, 'Memory link name') };
  });
  if (scope === 'global' && normalizedLinks.some(link => link.scope === 'project')) {
    throw new TypeError('Global memories may only link to global memories');
  }
  return {
    name: requiredText(input.name, 'Memory name'),
    content: requiredText(input.content, 'Memory content'),
    links: [...new Map(normalizedLinks.map(link => [`${link.scope}\0${link.name}`, link])).values()],
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeDirectory(directory: string): string {
  return resolve(requiredText(directory, 'Project directory'));
}

function memoryEmbeddingText(name: string, content: string, links: MemoryLink[]): string {
  return [
    `Memory: ${name}`,
    content,
    links.length > 0 ? `Related: ${links.map(link => `${link.scope}:${link.name}`).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function memoryFromRow(row: MemoryRow): Memory {
  const links: unknown = JSON.parse(row.links_json);
  if (!Array.isArray(links) || links.some(link =>
    !link
    || typeof link !== 'object'
    || !isMemoryScope(link.scope)
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
