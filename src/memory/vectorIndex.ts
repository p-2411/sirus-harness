import type { Database } from 'bun:sqlite';
import { MEMORY_COLUMNS, createVectorTable, type MemoryRow, type SchemaEmbedder } from './schema';

// The sqlite-vec index over memory embeddings: nearest-neighbour lookup, the
// per-row writes the store performs inside its own transactions, and the lazy
// rebuild that runs when the embedding configuration or the table layout changed.

export interface SearchRow extends MemoryRow {
  distance: number;
}

export interface IndexableMemory {
  id: number;
  scopeId: number;
  text: string;
}

export interface VectorIndexOptions {
  database: Database;
  embedder: SchemaEmbedder;
  needsReindex: boolean;
  // Everything that must be re-embedded when the index is rebuilt.
  memories: () => IndexableMemory[];
  embed: (text: string) => Promise<Float32Array>;
}

export class VectorIndex {
  private readonly database: Database;
  private readonly embedder: SchemaEmbedder;
  private needsReindex: boolean;
  private reindexPromise: Promise<void> | undefined;

  constructor(private readonly options: VectorIndexOptions) {
    this.database = options.database;
    this.embedder = options.embedder;
    this.needsReindex = options.needsReindex;
  }

  async ensure(): Promise<void> {
    if (!this.needsReindex) return;
    this.reindexPromise ??= this.reindex().catch(error => {
      this.reindexPromise = undefined;
      throw error;
    });
    await this.reindexPromise;
  }

  insert(id: number, embedding: Float32Array, scopeId: number): void {
    this.database.query('INSERT INTO memory_vectors(rowid, embedding, scope_id) VALUES (?, ?, ?)')
      .run(id, embedding, scopeId);
  }

  remove(id: number): void {
    this.database.query('DELETE FROM memory_vectors WHERE rowid = ?').run(id);
  }

  search(embedding: Float32Array, scopeId: number, limit: number): SearchRow[] {
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

  private async reindex(): Promise<void> {
    const vectors: Array<{ id: number; scopeId: number; embedding: Float32Array }> = [];
    for (const memory of this.options.memories()) {
      vectors.push({
        id: memory.id,
        scopeId: memory.scopeId,
        embedding: await this.options.embed(memory.text),
      });
    }

    const rebuild = this.database.transaction(() => {
      this.database.exec('DROP TABLE IF EXISTS memory_vectors');
      createVectorTable(this.database, this.embedder.dimensions);
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
}
