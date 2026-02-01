/**
 * Tests for memory consolidation and summarization module
 */

import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  findSimilarChunks,
  findExactDuplicates,
  removeExactDuplicates,
  identifyConsolidationCandidates,
  reinforceConsolidationCandidates,
  runConsolidation,
  prepareForSummarization,
  getConsolidationStats,
  type ConsolidationCandidate,
} from "./consolidation.js";
import { EMBEDDING_CACHE_TABLE, FTS_TABLE } from "./constants.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { ensureRetentionSchema } from "./retention.js";
import { DEFAULT_RETENTION_POLICY } from "./retention.js";

// Helper to create a test database with all schemas
function createTestDb() {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");

  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: EMBEDDING_CACHE_TABLE,
    ftsTable: FTS_TABLE,
    ftsEnabled: false,
  });

  ensureRetentionSchema(db);

  return db;
}

// Helper to insert a test chunk
function insertChunk(
  db: ReturnType<typeof createTestDb>,
  params: {
    id: string;
    path: string;
    text: string;
    embedding?: number[];
    hash?: string;
    source?: string;
    importance?: string;
    importanceScore?: number;
    pinned?: boolean;
    createdAt?: number;
  },
) {
  const now = params.createdAt ?? Date.now();
  const embedding = params.embedding ?? [];
  const hash = params.hash ?? `hash-${params.id}`;

  db.prepare(`
    INSERT INTO chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding,
      created_at, last_accessed_at, access_count, importance, importance_score, pinned, tags, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.path,
    params.source ?? "memory",
    1,
    10,
    hash,
    "test-model",
    params.text,
    JSON.stringify(embedding),
    now,
    now,
    0,
    params.importance ?? "normal",
    params.importanceScore ?? 0.5,
    params.pinned ? 1 : 0,
    "[]",
    now,
  );
}

// Generate a normalized random embedding vector
function generateEmbedding(dims: number, seed: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dims; i++) {
    // Simple seeded random
    vec.push(Math.sin(seed * (i + 1) * 12.9898) * 0.5 + 0.5);
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / mag);
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const vec = [0.5, 0.5, 0.5, 0.5];
    const sim = cosineSimilarity(vec, vec);
    expect(sim).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const vec1 = [1, 0, 0, 0];
    const vec2 = [0, 1, 0, 0];
    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const vec1 = [1, 0, 0, 0];
    const vec2 = [-1, 0, 0, 0];
    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeCloseTo(-1, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("handles negative values", () => {
    const vec1 = [0.5, -0.5, 0.5];
    const vec2 = [0.5, -0.5, 0.5];
    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeCloseTo(1.0, 5);
  });
});

describe("findSimilarChunks", () => {
  it("finds highly similar chunk pairs", () => {
    const db = createTestDb();
    const baseEmb = generateEmbedding(128, 1);

    // Insert two very similar chunks (same embedding)
    insertChunk(db, { id: "chunk-1", path: "file1.md", text: "hello world", embedding: baseEmb });
    insertChunk(db, { id: "chunk-2", path: "file2.md", text: "hello world", embedding: baseEmb });

    // Insert a different chunk
    const diffEmb = generateEmbedding(128, 999);
    insertChunk(db, { id: "chunk-3", path: "file3.md", text: "different", embedding: diffEmb });

    const pairs = findSimilarChunks(db, { similarityThreshold: 0.95 });

    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const topPair = pairs[0];
    expect(topPair?.similarity).toBeGreaterThan(0.95);
    expect([topPair?.chunkId1, topPair?.chunkId2]).toContain("chunk-1");
    expect([topPair?.chunkId1, topPair?.chunkId2]).toContain("chunk-2");

    db.close();
  });

  it("respects similarity threshold", () => {
    const db = createTestDb();

    // Insert chunks with decreasing similarity
    const emb1 = generateEmbedding(128, 1);
    const emb2 = generateEmbedding(128, 2);

    insertChunk(db, { id: "chunk-1", path: "file1.md", text: "text1", embedding: emb1 });
    insertChunk(db, { id: "chunk-2", path: "file2.md", text: "text2", embedding: emb2 });

    // High threshold should return fewer pairs
    const highThresholdPairs = findSimilarChunks(db, { similarityThreshold: 0.99 });
    const lowThresholdPairs = findSimilarChunks(db, { similarityThreshold: 0.5 });

    expect(lowThresholdPairs.length).toBeGreaterThanOrEqual(highThresholdPairs.length);

    db.close();
  });

  it("limits number of returned pairs", () => {
    const db = createTestDb();

    // Insert many similar chunks
    const baseEmb = generateEmbedding(128, 1);
    for (let i = 0; i < 10; i++) {
      insertChunk(db, { id: `chunk-${i}`, path: `file${i}.md`, text: "same", embedding: baseEmb });
    }

    const pairs = findSimilarChunks(db, { maxPairs: 3 });
    expect(pairs.length).toBeLessThanOrEqual(3);

    db.close();
  });

  it("filters by same source when enabled", () => {
    const db = createTestDb();
    const emb = generateEmbedding(128, 1);

    insertChunk(db, {
      id: "mem-1",
      path: "mem1.md",
      text: "text",
      embedding: emb,
      source: "memory",
    });
    insertChunk(db, {
      id: "sess-1",
      path: "sess1.md",
      text: "text",
      embedding: emb,
      source: "sessions",
    });

    const sameSourcePairs = findSimilarChunks(db, { sameSourceOnly: true });
    // Verify sameSourceOnly filtering works (allPairs would include cross-source matches)
    findSimilarChunks(db, { sameSourceOnly: false });

    // Same source should not match memory with sessions
    for (const pair of sameSourcePairs) {
      const hasMemory = pair.path1.includes("mem") || pair.path2.includes("mem");
      const hasSessions = pair.path1.includes("sess") || pair.path2.includes("sess");
      expect(hasMemory && hasSessions).toBe(false);
    }

    db.close();
  });

  it("sorts pairs by similarity descending", () => {
    const db = createTestDb();

    const emb1 = generateEmbedding(128, 1);
    const emb2 = generateEmbedding(128, 1); // Same as emb1
    const emb3 = generateEmbedding(128, 5); // Slightly different

    insertChunk(db, { id: "chunk-1", path: "file1.md", text: "t1", embedding: emb1 });
    insertChunk(db, { id: "chunk-2", path: "file2.md", text: "t2", embedding: emb2 });
    insertChunk(db, { id: "chunk-3", path: "file3.md", text: "t3", embedding: emb3 });

    const pairs = findSimilarChunks(db, { similarityThreshold: 0.5 });

    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]?.similarity).toBeGreaterThanOrEqual(pairs[i]?.similarity ?? 0);
    }

    db.close();
  });

  it("handles empty database", () => {
    const db = createTestDb();
    const pairs = findSimilarChunks(db);
    expect(pairs).toEqual([]);
    db.close();
  });
});

describe("findExactDuplicates", () => {
  it("finds chunks with identical hashes", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk-1", path: "file1.md", text: "same text", hash: "same-hash" });
    insertChunk(db, { id: "chunk-2", path: "file2.md", text: "same text", hash: "same-hash" });
    insertChunk(db, { id: "chunk-3", path: "file3.md", text: "different", hash: "different-hash" });

    const duplicates = findExactDuplicates(db);

    expect(duplicates.length).toBe(1);
    expect(duplicates[0]?.hash).toBe("same-hash");
    expect(duplicates[0]?.chunkIds).toContain("chunk-1");
    expect(duplicates[0]?.chunkIds).toContain("chunk-2");

    db.close();
  });

  it("groups multiple duplicates correctly", () => {
    const db = createTestDb();

    insertChunk(db, { id: "a1", path: "f1.md", text: "text a", hash: "hash-a" });
    insertChunk(db, { id: "a2", path: "f2.md", text: "text a", hash: "hash-a" });
    insertChunk(db, { id: "a3", path: "f3.md", text: "text a", hash: "hash-a" });
    insertChunk(db, { id: "b1", path: "f4.md", text: "text b", hash: "hash-b" });
    insertChunk(db, { id: "b2", path: "f5.md", text: "text b", hash: "hash-b" });

    const duplicates = findExactDuplicates(db);

    expect(duplicates.length).toBe(2);

    const hashA = duplicates.find((d) => d.hash === "hash-a");
    const hashB = duplicates.find((d) => d.hash === "hash-b");

    expect(hashA?.chunkIds.length).toBe(3);
    expect(hashB?.chunkIds.length).toBe(2);

    db.close();
  });

  it("returns empty for no duplicates", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk-1", path: "f1.md", text: "text 1", hash: "hash-1" });
    insertChunk(db, { id: "chunk-2", path: "f2.md", text: "text 2", hash: "hash-2" });

    const duplicates = findExactDuplicates(db);
    expect(duplicates).toEqual([]);

    db.close();
  });
});

describe("removeExactDuplicates", () => {
  it("removes duplicates keeping highest importance", () => {
    const db = createTestDb();

    insertChunk(db, {
      id: "chunk-1",
      path: "f1.md",
      text: "same",
      hash: "same-hash",
      importanceScore: 0.3,
    });
    insertChunk(db, {
      id: "chunk-2",
      path: "f2.md",
      text: "same",
      hash: "same-hash",
      importanceScore: 0.8, // Highest
    });
    insertChunk(db, {
      id: "chunk-3",
      path: "f3.md",
      text: "same",
      hash: "same-hash",
      importanceScore: 0.5,
    });

    const result = removeExactDuplicates(db);

    expect(result.exactDuplicatesRemoved).toBe(2);
    expect(result.removedIds).not.toContain("chunk-2"); // Highest importance should be kept

    // Verify only chunk-2 remains
    const remaining = db.prepare(`SELECT id FROM chunks WHERE hash = 'same-hash'`).all() as Array<{
      id: string;
    }>;
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).toBe("chunk-2");

    db.close();
  });

  it("keeps pinned chunks over unpinned", () => {
    const db = createTestDb();

    insertChunk(db, {
      id: "chunk-1",
      path: "f1.md",
      text: "same",
      hash: "same-hash",
      importanceScore: 0.9,
      pinned: false,
    });
    insertChunk(db, {
      id: "chunk-2",
      path: "f2.md",
      text: "same",
      hash: "same-hash",
      importanceScore: 0.3,
      pinned: true, // Pinned takes priority
    });

    const result = removeExactDuplicates(db);

    expect(result.exactDuplicatesRemoved).toBe(1);

    const remaining = db.prepare(`SELECT id FROM chunks WHERE hash = 'same-hash'`).all() as Array<{
      id: string;
    }>;
    expect(remaining[0]?.id).toBe("chunk-2");

    db.close();
  });

  it("dry run does not delete", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk-1", path: "f1.md", text: "same", hash: "same-hash" });
    insertChunk(db, { id: "chunk-2", path: "f2.md", text: "same", hash: "same-hash" });

    const result = removeExactDuplicates(db, { dryRun: true });

    expect(result.exactDuplicatesRemoved).toBe(1);
    expect(result.removedIds.length).toBe(1);

    // Both should still exist
    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(2);

    db.close();
  });
});

describe("identifyConsolidationCandidates", () => {
  it("groups similar chunks into candidates", () => {
    const db = createTestDb();
    const emb = generateEmbedding(128, 1);

    insertChunk(db, {
      id: "primary",
      path: "f1.md",
      text: "Main content",
      embedding: emb,
      importanceScore: 0.9,
    });
    insertChunk(db, {
      id: "related-1",
      path: "f2.md",
      text: "Related content 1",
      embedding: emb,
      importanceScore: 0.5,
    });
    insertChunk(db, {
      id: "related-2",
      path: "f3.md",
      text: "Related content 2",
      embedding: emb,
      importanceScore: 0.3,
    });

    const candidates = identifyConsolidationCandidates(db);

    expect(candidates.length).toBeGreaterThan(0);
    const candidate = candidates[0];
    expect(candidate?.primaryId).toBe("primary"); // Highest importance
    expect(candidate?.relatedIds.length).toBeGreaterThanOrEqual(1);
    expect(candidate?.avgSimilarity).toBeGreaterThan(0.85);

    db.close();
  });

  it("respects maxCandidates limit", () => {
    const db = createTestDb();

    // Create multiple groups
    for (let group = 0; group < 10; group++) {
      const emb = generateEmbedding(128, group);
      for (let i = 0; i < 3; i++) {
        insertChunk(db, {
          id: `g${group}-c${i}`,
          path: `g${group}/f${i}.md`,
          text: `Group ${group} content ${i}`,
          embedding: emb,
        });
      }
    }

    const candidates = identifyConsolidationCandidates(db, { maxCandidates: 3 });
    expect(candidates.length).toBeLessThanOrEqual(3);

    db.close();
  });

  it("returns empty for no similar chunks", () => {
    const db = createTestDb();

    // Insert very different chunks
    insertChunk(db, {
      id: "c1",
      path: "f1.md",
      text: "text1",
      embedding: generateEmbedding(128, 1),
    });
    insertChunk(db, {
      id: "c2",
      path: "f2.md",
      text: "text2",
      embedding: generateEmbedding(128, 999),
    });

    const candidates = identifyConsolidationCandidates(db, { similarityThreshold: 0.99 });
    expect(candidates.length).toBe(0);

    db.close();
  });
});

describe("reinforceConsolidationCandidates", () => {
  it("boosts primary and reduces related importance", () => {
    const db = createTestDb();

    insertChunk(db, { id: "primary", path: "f1.md", text: "primary", importanceScore: 0.5 });
    insertChunk(db, { id: "related-1", path: "f2.md", text: "related 1", importanceScore: 0.5 });
    insertChunk(db, { id: "related-2", path: "f3.md", text: "related 2", importanceScore: 0.5 });

    const candidates: ConsolidationCandidate[] = [
      {
        primaryId: "primary",
        relatedIds: ["related-1", "related-2"],
        avgSimilarity: 0.9,
        combinedText: "primary\n\n---\n\nrelated 1\n\n---\n\nrelated 2",
      },
    ];

    const result = reinforceConsolidationCandidates(db, candidates);

    expect(result.boosted).toBe(1);
    expect(result.reduced).toBe(2);

    // Verify scores
    const primary = db
      .prepare(`SELECT importance_score FROM chunks WHERE id = ?`)
      .get("primary") as {
      importance_score: number;
    };
    const related = db
      .prepare(`SELECT importance_score FROM chunks WHERE id = ?`)
      .get("related-1") as { importance_score: number };

    expect(primary.importance_score).toBeGreaterThan(related.importance_score);

    db.close();
  });
});

describe("runConsolidation", () => {
  it("removes exact duplicates and identifies consolidation candidates", () => {
    const db = createTestDb();
    const emb = generateEmbedding(128, 1);

    // Exact duplicates
    insertChunk(db, {
      id: "dup-1",
      path: "f1.md",
      text: "duplicate",
      hash: "dup-hash",
      embedding: emb,
    });
    insertChunk(db, {
      id: "dup-2",
      path: "f2.md",
      text: "duplicate",
      hash: "dup-hash",
      embedding: emb,
    });

    // Similar but not exact
    insertChunk(db, {
      id: "sim-1",
      path: "f3.md",
      text: "similar content 1",
      hash: "hash-1",
      embedding: emb,
    });
    insertChunk(db, {
      id: "sim-2",
      path: "f4.md",
      text: "similar content 2",
      hash: "hash-2",
      embedding: emb,
    });

    const result = runConsolidation(db, DEFAULT_RETENTION_POLICY);

    expect(result.duplicatesFound).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);

    db.close();
  });

  it("respects dry run mode", () => {
    const db = createTestDb();

    insertChunk(db, { id: "dup-1", path: "f1.md", text: "same", hash: "same-hash" });
    insertChunk(db, { id: "dup-2", path: "f2.md", text: "same", hash: "same-hash" });

    const beforeCount = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };

    runConsolidation(db, DEFAULT_RETENTION_POLICY, { dryRun: true });

    const afterCount = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(afterCount.c).toBe(beforeCount.c);

    db.close();
  });

  it("can skip exact duplicate removal", () => {
    const db = createTestDb();

    insertChunk(db, { id: "dup-1", path: "f1.md", text: "same", hash: "same-hash" });
    insertChunk(db, { id: "dup-2", path: "f2.md", text: "same", hash: "same-hash" });

    const result = runConsolidation(db, DEFAULT_RETENTION_POLICY, { removeExactDupes: false });

    expect(result.duplicatesFound).toBe(0);

    // Both should still exist
    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(2);

    db.close();
  });
});

describe("prepareForSummarization", () => {
  it("formats candidates for LLM summarization", () => {
    const candidates: ConsolidationCandidate[] = [
      {
        primaryId: "primary",
        relatedIds: ["related-1", "related-2"],
        avgSimilarity: 0.9,
        combinedText:
          "Content from primary.\n\n---\n\nContent from related 1.\n\n---\n\nContent from related 2.",
      },
    ];

    const prepared = prepareForSummarization(candidates);

    expect(prepared.length).toBe(1);
    expect(prepared[0]?.primaryId).toBe("primary");
    expect(prepared[0]?.relatedIds).toEqual(["related-1", "related-2"]);
    expect(prepared[0]?.textToSummarize).toContain("Content from primary");
    expect(prepared[0]?.truncated).toBe(false);
  });

  it("truncates long text", () => {
    const longText = "x".repeat(20000);
    const candidates: ConsolidationCandidate[] = [
      {
        primaryId: "p",
        relatedIds: ["r"],
        avgSimilarity: 0.9,
        combinedText: longText,
      },
    ];

    const prepared = prepareForSummarization(candidates, { maxLength: 1000 });

    expect(prepared[0]?.textToSummarize.length).toBeLessThanOrEqual(1100); // Some buffer for truncation message
    expect(prepared[0]?.truncated).toBe(true);
    expect(prepared[0]?.textToSummarize).toContain("[Content truncated...]");
  });
});

describe("getConsolidationStats", () => {
  it("returns accurate statistics", () => {
    const db = createTestDb();
    const emb = generateEmbedding(128, 1);

    // Add some duplicates
    insertChunk(db, {
      id: "dup-1",
      path: "f1.md",
      text: "same",
      hash: "same-hash",
      embedding: emb,
    });
    insertChunk(db, {
      id: "dup-2",
      path: "f2.md",
      text: "same",
      hash: "same-hash",
      embedding: emb,
    });

    // Add unique chunks
    insertChunk(db, { id: "unique-1", path: "f3.md", text: "unique1", hash: "hash-1" });
    insertChunk(db, { id: "unique-2", path: "f4.md", text: "unique2", hash: "hash-2" });

    const stats = getConsolidationStats(db);

    expect(stats.totalChunks).toBe(4);
    expect(stats.exactDuplicates).toBe(1); // 2 chunks with same hash = 1 extra
    expect(stats.uniqueHashes).toBe(3);

    db.close();
  });

  it("handles empty database", () => {
    const db = createTestDb();
    const stats = getConsolidationStats(db);

    expect(stats.totalChunks).toBe(0);
    expect(stats.exactDuplicates).toBe(0);
    expect(stats.uniqueHashes).toBe(0);
    expect(stats.potentialConsolidations).toBe(0);

    db.close();
  });
});
