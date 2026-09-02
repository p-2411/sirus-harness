import { mkdirSync } from 'fs';
import { join } from 'path';
import { dataDirectory } from '../data/persistence';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
}

export const LOCAL_EMBEDDING_MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';
export const LOCAL_EMBEDDING_MODEL = `${LOCAL_EMBEDDING_MODEL_ID}:q4:mean-normalized`;
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

interface FeatureExtractor {
  (text: string, options: { pooling: 'mean'; normalize: true }): Promise<{
    data: ArrayLike<number | bigint>;
  }>;
}

let extractorPromise: Promise<FeatureExtractor> | undefined;

async function loadExtractor(): Promise<FeatureExtractor> {
  const cacheDirectory = join(dataDirectory(), 'models');
  mkdirSync(cacheDirectory, { recursive: true });
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL_ID, {
    cache_dir: cacheDirectory,
    dtype: 'q4',
  });
  return extractor as FeatureExtractor;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model = LOCAL_EMBEDDING_MODEL;
  readonly dimensions = LOCAL_EMBEDDING_DIMENSIONS;

  async embed(text: string): Promise<Float32Array> {
    if (!text.trim()) throw new TypeError('Cannot embed empty text');

    extractorPromise ??= loadExtractor().catch(error => {
      extractorPromise = undefined;
      throw error;
    });
    const extractor = await extractorPromise;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const embedding = Float32Array.from(output.data, value => Number(value));

    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Local embedding model returned ${embedding.length} dimensions; expected ${this.dimensions}`,
      );
    }

    return embedding;
  }
}
