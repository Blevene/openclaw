/**
 * Embedding cache operations
 *
 * Centralizes the duplicated cache lookup/upsert patterns that were
 * scattered across embedChunksInBatches, embedChunksWithOpenAiBatch,
 * and embedChunksWithGeminiBatch.
 */

import type { DatabaseSync } from "node:sqlite";
import { EMBEDDING_CACHE_TABLE } from "./constants.js";
import { parseEmbedding, type MemoryChunk } from "./internal.js";

export type EmbeddingCacheConfig = {
  enabled: boolean;
  maxEntries?: number;
};

export type CacheProviderInfo = {
  providerId: string;
  model: string;
  providerKey: string;
};

/**
 * Result of checking cache for embeddings
 */
export type CacheLookupResult = {
  /** Cached embeddings by hash */
  cached: Map<string, number[]>;
  /** Indices of chunks that need embedding */
  missingIndices: number[];
  /** Chunks that need embedding */
  missingChunks: MemoryChunk[];
};

/**
 * Load embeddings from cache for the given hashes
 *
 * @param db - SQLite database connection
 * @param provider - Provider info for cache lookup
 * @param hashes - Content hashes to look up
 * @param enabled - Whether caching is enabled
 * @returns Map of hash to embedding vectors
 */
export function loadEmbeddingCache(
  db: DatabaseSync,
  provider: CacheProviderInfo,
  hashes: string[],
  enabled: boolean,
): Map<string, number[]> {
  if (!enabled) {
    return new Map();
  }

  if (hashes.length === 0) {
    return new Map();
  }

  // Dedupe hashes
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (!hash || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    unique.push(hash);
  }

  if (unique.length === 0) {
    return new Map();
  }

  const result = new Map<string, number[]>();
  const baseParams = [provider.providerId, provider.model, provider.providerKey];
  const batchSize = 400;

  for (let start = 0; start < unique.length; start += batchSize) {
    const batch = unique.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}
         WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
      )
      .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;

    for (const row of rows) {
      result.set(row.hash, parseEmbedding(row.embedding));
    }
  }

  return result;
}

/**
 * Insert or update embeddings in cache
 *
 * @param db - SQLite database connection
 * @param provider - Provider info for cache key
 * @param entries - Embeddings to cache
 * @param enabled - Whether caching is enabled
 */
export function upsertEmbeddingCache(
  db: DatabaseSync,
  provider: CacheProviderInfo,
  entries: Array<{ hash: string; embedding: number[] }>,
  enabled: boolean,
): void {
  if (!enabled || entries.length === 0) {
    return;
  }

  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
       embedding=excluded.embedding,
       dims=excluded.dims,
       updated_at=excluded.updated_at`,
  );

  for (const entry of entries) {
    const embedding = entry.embedding ?? [];
    stmt.run(
      provider.providerId,
      provider.model,
      provider.providerKey,
      entry.hash,
      JSON.stringify(embedding),
      embedding.length,
      now,
    );
  }
}

/**
 * Prune cache to stay within max entries limit
 *
 * @param db - SQLite database connection
 * @param config - Cache configuration with maxEntries
 */
export function pruneEmbeddingCacheIfNeeded(db: DatabaseSync, config: EmbeddingCacheConfig): void {
  if (!config.enabled) {
    return;
  }

  const max = config.maxEntries;
  if (!max || max <= 0) {
    return;
  }

  const row = db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
    | { c: number }
    | undefined;

  const count = row?.c ?? 0;
  if (count <= max) {
    return;
  }

  const excess = count - max;
  db.prepare(
    `DELETE FROM ${EMBEDDING_CACHE_TABLE}
     WHERE rowid IN (
       SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}
       ORDER BY updated_at ASC
       LIMIT ?
     )`,
  ).run(excess);
}

/**
 * Get cache entry count
 *
 * @param db - SQLite database connection
 * @returns Number of entries in cache
 */
export function getEmbeddingCacheCount(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
    | { c: number }
    | undefined;
  return row?.c ?? 0;
}

/**
 * Separate chunks into cached and uncached
 *
 * This is the core deduplication logic that was repeated across
 * the three embedding methods.
 *
 * @param chunks - Chunks to check
 * @param db - SQLite database connection
 * @param provider - Provider info for cache lookup
 * @param cacheEnabled - Whether caching is enabled
 * @returns Lookup result with cached embeddings and missing chunks
 */
export function checkEmbeddingCache(
  chunks: MemoryChunk[],
  db: DatabaseSync,
  provider: CacheProviderInfo,
  cacheEnabled: boolean,
): CacheLookupResult {
  if (chunks.length === 0) {
    return {
      cached: new Map(),
      missingIndices: [],
      missingChunks: [],
    };
  }

  const cached = loadEmbeddingCache(
    db,
    provider,
    chunks.map((chunk) => chunk.hash),
    cacheEnabled,
  );

  const missingIndices: number[] = [];
  const missingChunks: MemoryChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) {
      continue;
    }

    const hit = chunk.hash ? cached.get(chunk.hash) : undefined;
    if (!hit || hit.length === 0) {
      missingIndices.push(i);
      missingChunks.push(chunk);
    }
  }

  return {
    cached,
    missingIndices,
    missingChunks,
  };
}

/**
 * Build embeddings array from cache lookup and fresh embeddings
 *
 * @param chunks - All chunks being processed
 * @param cacheResult - Result from checkEmbeddingCache
 * @param freshEmbeddings - Newly computed embeddings for missing chunks
 * @returns Complete embeddings array matching chunk order
 */
export function mergeEmbeddingsWithCache(
  chunks: MemoryChunk[],
  cacheResult: CacheLookupResult,
  freshEmbeddings: number[][],
): number[][] {
  const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);

  // Fill in cached embeddings
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) {
      continue;
    }

    const hit = chunk.hash ? cacheResult.cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    }
  }

  // Fill in fresh embeddings at missing indices
  for (let j = 0; j < cacheResult.missingIndices.length; j++) {
    const originalIndex = cacheResult.missingIndices[j];
    const embedding = freshEmbeddings[j];
    if (originalIndex !== undefined && embedding) {
      embeddings[originalIndex] = embedding;
    }
  }

  return embeddings;
}

/**
 * Seed cache from another database (used during safe reindex)
 *
 * @param targetDb - Target database to seed
 * @param sourceDb - Source database with cached embeddings
 * @param enabled - Whether caching is enabled
 */
export function seedEmbeddingCache(
  targetDb: DatabaseSync,
  sourceDb: DatabaseSync,
  enabled: boolean,
): void {
  if (!enabled) {
    return;
  }

  try {
    const rows = sourceDb
      .prepare(
        `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
      )
      .all() as Array<{
      provider: string;
      model: string;
      provider_key: string;
      hash: string;
      embedding: string;
      dims: number | null;
      updated_at: number;
    }>;

    if (!rows.length) {
      return;
    }

    const insert = targetDb.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
         embedding=excluded.embedding,
         dims=excluded.dims,
         updated_at=excluded.updated_at`,
    );

    targetDb.exec("BEGIN");
    for (const row of rows) {
      insert.run(
        row.provider,
        row.model,
        row.provider_key,
        row.hash,
        row.embedding,
        row.dims,
        row.updated_at,
      );
    }
    targetDb.exec("COMMIT");
  } catch (err) {
    try {
      targetDb.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  }
}
