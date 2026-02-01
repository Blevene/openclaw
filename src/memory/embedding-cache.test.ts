import { describe, expect, it } from "vitest";
import type { MemoryChunk } from "./internal.js";
import { EMBEDDING_CACHE_TABLE } from "./constants.js";
import {
  loadEmbeddingCache,
  upsertEmbeddingCache,
  pruneEmbeddingCacheIfNeeded,
  getEmbeddingCacheCount,
  checkEmbeddingCache,
  mergeEmbeddingsWithCache,
  seedEmbeddingCache,
  type CacheProviderInfo,
} from "./embedding-cache.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

// Helper to create a test database
function createTestDb() {
  // Use node:sqlite synchronously
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: EMBEDDING_CACHE_TABLE,
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

const testProvider: CacheProviderInfo = {
  providerId: "openai",
  model: "text-embedding-3-small",
  providerKey: "test-key-hash",
};

describe("loadEmbeddingCache", () => {
  it("returns empty map when disabled", () => {
    const db = createTestDb();
    const result = loadEmbeddingCache(db, testProvider, ["hash1", "hash2"], false);
    expect(result.size).toBe(0);
    db.close();
  });

  it("returns empty map for empty hashes", () => {
    const db = createTestDb();
    const result = loadEmbeddingCache(db, testProvider, [], true);
    expect(result.size).toBe(0);
    db.close();
  });

  it("returns cached embeddings for known hashes", () => {
    const db = createTestDb();

    // Insert some cached embeddings
    db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "openai",
      "text-embedding-3-small",
      "test-key-hash",
      "hash1",
      "[1.0, 2.0, 3.0]",
      3,
      Date.now(),
    );

    const result = loadEmbeddingCache(db, testProvider, ["hash1", "hash2"], true);
    expect(result.size).toBe(1);
    expect(result.get("hash1")).toEqual([1.0, 2.0, 3.0]);
    expect(result.get("hash2")).toBeUndefined();
    db.close();
  });

  it("dedupes hashes before lookup", () => {
    const db = createTestDb();

    db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("openai", "text-embedding-3-small", "test-key-hash", "hash1", "[1.0]", 1, Date.now());

    const result = loadEmbeddingCache(db, testProvider, ["hash1", "hash1", "hash1"], true);
    expect(result.size).toBe(1);
    db.close();
  });

  it("handles large batches", () => {
    const db = createTestDb();

    // Insert 500 cached embeddings
    for (let i = 0; i < 500; i++) {
      db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "openai",
        "text-embedding-3-small",
        "test-key-hash",
        `hash${i}`,
        `[${i}]`,
        1,
        Date.now(),
      );
    }

    const hashes = Array.from({ length: 500 }, (_, i) => `hash${i}`);
    const result = loadEmbeddingCache(db, testProvider, hashes, true);
    expect(result.size).toBe(500);
    db.close();
  });
});

describe("upsertEmbeddingCache", () => {
  it("does nothing when disabled", () => {
    const db = createTestDb();
    upsertEmbeddingCache(db, testProvider, [{ hash: "hash1", embedding: [1.0] }], false);
    expect(getEmbeddingCacheCount(db)).toBe(0);
    db.close();
  });

  it("inserts new entries", () => {
    const db = createTestDb();
    upsertEmbeddingCache(
      db,
      testProvider,
      [
        { hash: "hash1", embedding: [1.0, 2.0] },
        { hash: "hash2", embedding: [3.0, 4.0] },
      ],
      true,
    );
    expect(getEmbeddingCacheCount(db)).toBe(2);
    db.close();
  });

  it("updates existing entries", () => {
    const db = createTestDb();

    upsertEmbeddingCache(db, testProvider, [{ hash: "hash1", embedding: [1.0] }], true);
    upsertEmbeddingCache(db, testProvider, [{ hash: "hash1", embedding: [2.0, 3.0] }], true);

    const result = loadEmbeddingCache(db, testProvider, ["hash1"], true);
    expect(result.get("hash1")).toEqual([2.0, 3.0]);
    expect(getEmbeddingCacheCount(db)).toBe(1);
    db.close();
  });
});

describe("pruneEmbeddingCacheIfNeeded", () => {
  it("does nothing when disabled", () => {
    const db = createTestDb();
    upsertEmbeddingCache(db, testProvider, [{ hash: "h1", embedding: [1] }], true);
    pruneEmbeddingCacheIfNeeded(db, { enabled: false, maxEntries: 0 });
    expect(getEmbeddingCacheCount(db)).toBe(1);
    db.close();
  });

  it("does nothing when under limit", () => {
    const db = createTestDb();
    upsertEmbeddingCache(db, testProvider, [{ hash: "h1", embedding: [1] }], true);
    pruneEmbeddingCacheIfNeeded(db, { enabled: true, maxEntries: 10 });
    expect(getEmbeddingCacheCount(db)).toBe(1);
    db.close();
  });

  it("prunes oldest entries when over limit", () => {
    const db = createTestDb();

    // Insert entries with different timestamps
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("openai", "text-embedding-3-small", "test-key-hash", `hash${i}`, `[${i}]`, 1, i * 1000);
    }

    expect(getEmbeddingCacheCount(db)).toBe(5);
    pruneEmbeddingCacheIfNeeded(db, { enabled: true, maxEntries: 3 });
    expect(getEmbeddingCacheCount(db)).toBe(3);

    // Check that oldest entries were removed
    const remaining = loadEmbeddingCache(
      db,
      testProvider,
      ["hash0", "hash1", "hash2", "hash3", "hash4"],
      true,
    );
    expect(remaining.has("hash0")).toBe(false);
    expect(remaining.has("hash1")).toBe(false);
    expect(remaining.has("hash2")).toBe(true);
    expect(remaining.has("hash3")).toBe(true);
    expect(remaining.has("hash4")).toBe(true);
    db.close();
  });
});

describe("checkEmbeddingCache", () => {
  it("returns all chunks as missing when cache empty", () => {
    const db = createTestDb();
    const chunks: MemoryChunk[] = [
      { startLine: 1, endLine: 5, text: "chunk 1", hash: "hash1" },
      { startLine: 6, endLine: 10, text: "chunk 2", hash: "hash2" },
    ];

    const result = checkEmbeddingCache(chunks, db, testProvider, true);
    expect(result.cached.size).toBe(0);
    expect(result.missingIndices).toEqual([0, 1]);
    expect(result.missingChunks).toEqual(chunks);
    db.close();
  });

  it("separates cached and uncached chunks", () => {
    const db = createTestDb();

    // Cache one embedding
    upsertEmbeddingCache(db, testProvider, [{ hash: "hash1", embedding: [1.0, 2.0] }], true);

    const chunks: MemoryChunk[] = [
      { startLine: 1, endLine: 5, text: "chunk 1", hash: "hash1" },
      { startLine: 6, endLine: 10, text: "chunk 2", hash: "hash2" },
    ];

    const result = checkEmbeddingCache(chunks, db, testProvider, true);
    expect(result.cached.size).toBe(1);
    expect(result.cached.get("hash1")).toEqual([1.0, 2.0]);
    expect(result.missingIndices).toEqual([1]);
    expect(result.missingChunks).toHaveLength(1);
    expect(result.missingChunks[0]?.hash).toBe("hash2");
    db.close();
  });

  it("returns empty result for empty chunks", () => {
    const db = createTestDb();
    const result = checkEmbeddingCache([], db, testProvider, true);
    expect(result.cached.size).toBe(0);
    expect(result.missingIndices).toEqual([]);
    expect(result.missingChunks).toEqual([]);
    db.close();
  });
});

describe("mergeEmbeddingsWithCache", () => {
  it("combines cached and fresh embeddings in correct order", () => {
    const chunks: MemoryChunk[] = [
      { startLine: 1, endLine: 1, text: "a", hash: "h1" },
      { startLine: 2, endLine: 2, text: "b", hash: "h2" },
      { startLine: 3, endLine: 3, text: "c", hash: "h3" },
    ];

    const chunk1 = chunks[1];
    expect(chunk1).toBeDefined();

    const cacheResult = {
      cached: new Map([
        ["h1", [1.0]],
        ["h3", [3.0]],
      ]),
      missingIndices: [1],
      missingChunks: chunk1 ? [chunk1] : [],
    };

    const freshEmbeddings = [[2.0]];

    const result = mergeEmbeddingsWithCache(chunks, cacheResult, freshEmbeddings);
    expect(result).toEqual([[1.0], [2.0], [3.0]]);
  });

  it("handles all cached scenario", () => {
    const chunks: MemoryChunk[] = [{ startLine: 1, endLine: 1, text: "a", hash: "h1" }];

    const cacheResult = {
      cached: new Map([["h1", [1.0, 2.0]]]),
      missingIndices: [],
      missingChunks: [],
    };

    const result = mergeEmbeddingsWithCache(chunks, cacheResult, []);
    expect(result).toEqual([[1.0, 2.0]]);
  });

  it("handles all fresh scenario", () => {
    const chunks: MemoryChunk[] = [
      { startLine: 1, endLine: 1, text: "a", hash: "h1" },
      { startLine: 2, endLine: 2, text: "b", hash: "h2" },
    ];

    const cacheResult = {
      cached: new Map(),
      missingIndices: [0, 1],
      missingChunks: chunks,
    };

    const freshEmbeddings = [[1.0], [2.0]];

    const result = mergeEmbeddingsWithCache(chunks, cacheResult, freshEmbeddings);
    expect(result).toEqual([[1.0], [2.0]]);
  });
});

describe("seedEmbeddingCache", () => {
  it("copies embeddings from source to target", () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();

    // Add entries to source
    upsertEmbeddingCache(
      sourceDb,
      testProvider,
      [
        { hash: "h1", embedding: [1.0] },
        { hash: "h2", embedding: [2.0] },
      ],
      true,
    );

    seedEmbeddingCache(targetDb, sourceDb, true);

    expect(getEmbeddingCacheCount(targetDb)).toBe(2);
    const cached = loadEmbeddingCache(targetDb, testProvider, ["h1", "h2"], true);
    expect(cached.get("h1")).toEqual([1.0]);
    expect(cached.get("h2")).toEqual([2.0]);

    sourceDb.close();
    targetDb.close();
  });

  it("does nothing when disabled", () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();

    upsertEmbeddingCache(sourceDb, testProvider, [{ hash: "h1", embedding: [1.0] }], true);
    seedEmbeddingCache(targetDb, sourceDb, false);

    expect(getEmbeddingCacheCount(targetDb)).toBe(0);

    sourceDb.close();
    targetDb.close();
  });
});
