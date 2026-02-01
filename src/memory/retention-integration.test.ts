/**
 * Integration tests for memory retention system
 *
 * Tests the end-to-end workflow of memory indexing with retention
 * scoring, access tracking, and pruning.
 */

import { describe, expect, it } from "vitest";
import { EMBEDDING_CACHE_TABLE, FTS_TABLE } from "./constants.js";
import { chunkMarkdown, hashText } from "./internal.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  calculateImportanceScore,
  ensureRetentionSchema,
  enforceStorageLimits,
  getRetentionStats,
  initializeChunkTimestamps,
  pruneChunks,
  recordChunkAccess,
  updateImportanceScores,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
} from "./retention.js";

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

// Helper to simulate memory file indexing
function indexMemoryFile(
  db: ReturnType<typeof createTestDb>,
  params: {
    path: string;
    content: string;
    source?: "memory" | "sessions";
    model?: string;
    createdAt?: number;
  },
) {
  const now = params.createdAt ?? Date.now();
  const chunks = chunkMarkdown(params.content, { tokens: 100, overlap: 20 });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) {
      continue;
    }
    const id = `${hashText(params.path)}-${i}`;

    db.prepare(`
      INSERT INTO chunks (
        id, path, source, start_line, end_line, hash, model, text, embedding,
        created_at, last_accessed_at, access_count, importance, importance_score, pinned, tags, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.path,
      params.source ?? "memory",
      chunk.startLine,
      chunk.endLine,
      chunk.hash,
      params.model ?? "test-model",
      chunk.text,
      "[]",
      now,
      now,
      0,
      "normal",
      0.5,
      0,
      "[]",
      now,
    );
  }

  // Also record in files table
  db.prepare(`
    INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    params.path,
    params.source ?? "memory",
    hashText(params.content),
    now,
    params.content.length,
  );

  return chunks.length;
}

// Helper to simulate search results (returns chunk IDs)
function simulateSearch(db: ReturnType<typeof createTestDb>, limit: number = 5): string[] {
  const rows = db
    .prepare(`
      SELECT id FROM chunks
      ORDER BY importance_score DESC
      LIMIT ?
    `)
    .all(limit) as Array<{ id: string }>;

  return rows.map((r) => r.id);
}

describe("Memory Retention Integration", () => {
  describe("indexing workflow with retention", () => {
    it("initializes chunk timestamps during first indexing", () => {
      const db = createTestDb();
      const now = Date.now();

      // Index a file without timestamps (simulating old data)
      db.prepare(`
        INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
                            created_at, last_accessed_at, access_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
      `).run("old-chunk", "legacy.md", "memory", 1, 10, "hash", "model", "old content", "[]", now);

      const initialized = initializeChunkTimestamps(db, now);

      expect(initialized).toBe(1);

      const chunk = db
        .prepare(`
        SELECT created_at, last_accessed_at FROM chunks WHERE id = ?
      `)
        .get("old-chunk") as { created_at: number; last_accessed_at: number };

      expect(chunk.created_at).toBe(now);
      expect(chunk.last_accessed_at).toBe(now);

      db.close();
    });

    it("preserves timestamps when re-indexing existing content", () => {
      const db = createTestDb();
      const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      const now = Date.now();

      // First index
      indexMemoryFile(db, {
        path: "notes.md",
        content: "# My Notes\n\nImportant content here.",
        createdAt: oldTime,
      });

      // Verify initial timestamp
      const before = db
        .prepare(`
        SELECT created_at FROM chunks WHERE path = ?
      `)
        .get("notes.md") as { created_at: number };

      expect(before.created_at).toBe(oldTime);

      // Re-index should not call initializeChunkTimestamps (it only affects 0 timestamps)
      const initialized = initializeChunkTimestamps(db, now);
      expect(initialized).toBe(0);

      db.close();
    });
  });

  describe("access tracking affects importance", () => {
    it("increases importance score with repeated access", () => {
      const db = createTestDb();
      const now = Date.now();

      indexMemoryFile(db, {
        path: "frequently-used.md",
        content: "# Frequently Accessed\n\nThis content is accessed often.",
        createdAt: now,
      });

      const chunkIds = simulateSearch(db, 1);
      expect(chunkIds.length).toBeGreaterThan(0);

      const chunkId = chunkIds[0];
      expect(chunkId).toBeDefined();

      // Get initial state
      const before = db
        .prepare(`
        SELECT access_count, importance_score FROM chunks WHERE id = ?
      `)
        .get(chunkId) as { access_count: number; importance_score: number };

      // Simulate 10 accesses
      for (let i = 0; i < 10; i++) {
        recordChunkAccess(db, [chunkId], now + i * 1000);
      }

      // Update importance scores
      updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

      const after = db
        .prepare(`
        SELECT access_count, importance_score FROM chunks WHERE id = ?
      `)
        .get(chunkId) as { access_count: number; importance_score: number };

      expect(after.access_count).toBe(10);
      expect(after.importance_score).toBeGreaterThan(before.importance_score);

      db.close();
    });

    it("manual MEMORY.md content scores higher than sessions", () => {
      const db = createTestDb();
      const now = Date.now();

      indexMemoryFile(db, {
        path: "MEMORY.md",
        content: "# Manual Memory\n\nUser-written important notes.",
        source: "memory",
        createdAt: now,
      });

      indexMemoryFile(db, {
        path: "sessions/session-123.jsonl",
        content: "User: hello\nAssistant: hi there",
        source: "sessions",
        createdAt: now,
      });

      updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

      const memoryChunk = db
        .prepare(`
        SELECT importance_score FROM chunks WHERE source = 'memory' LIMIT 1
      `)
        .get() as { importance_score: number };

      const sessionChunk = db
        .prepare(`
        SELECT importance_score FROM chunks WHERE source = 'sessions' LIMIT 1
      `)
        .get() as { importance_score: number };

      expect(memoryChunk.importance_score).toBeGreaterThan(sessionChunk.importance_score);

      db.close();
    });
  });

  describe("pruning workflow", () => {
    it("prunes old, low-importance content while keeping recent", () => {
      const db = createTestDb();
      const now = Date.now();
      const oldTime = now - 100 * 24 * 60 * 60 * 1000; // 100 days ago

      // Index old content
      indexMemoryFile(db, {
        path: "old-notes.md",
        content: "# Old Notes\n\nThis is old content.",
        createdAt: oldTime,
      });

      // Index recent content
      indexMemoryFile(db, {
        path: "new-notes.md",
        content: "# New Notes\n\nThis is recent content.",
        createdAt: now,
      });

      // Update scores (old will have lower score due to recency decay)
      updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

      const policy: RetentionPolicy = {
        ...DEFAULT_RETENTION_POLICY,
        minImportanceScore: 0.3,
        archiveInsteadOfDelete: false,
      };

      const result = pruneChunks(db, policy, { now });

      // Old content should be pruned
      expect(result.pruned).toBeGreaterThan(0);

      // New content should remain
      const remaining = db
        .prepare(`
        SELECT COUNT(*) as count FROM chunks WHERE path = 'new-notes.md'
      `)
        .get() as { count: number };

      expect(remaining.count).toBeGreaterThan(0);

      db.close();
    });

    it("archives instead of deleting when configured", () => {
      const db = createTestDb();
      const now = Date.now();
      const oldTime = now - 100 * 24 * 60 * 60 * 1000;

      indexMemoryFile(db, {
        path: "archive-candidate.md",
        content: "# Archive Me\n\nOld but potentially useful.",
        createdAt: oldTime,
      });

      updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

      const policy: RetentionPolicy = {
        ...DEFAULT_RETENTION_POLICY,
        minImportanceScore: 0.5,
        archiveInsteadOfDelete: true,
      };

      const result = pruneChunks(db, policy, { now });

      expect(result.archived).toBeGreaterThan(0);
      expect(result.pruned).toBe(0);

      // Content should still exist with 'archive' importance
      const archived = db
        .prepare(`
        SELECT importance FROM chunks WHERE path = 'archive-candidate.md' LIMIT 1
      `)
        .get() as { importance: string };

      expect(archived.importance).toBe("archive");

      db.close();
    });

    it("enforces chunk count limits", () => {
      const db = createTestDb();
      const now = Date.now();

      // Index many files
      for (let i = 0; i < 20; i++) {
        indexMemoryFile(db, {
          path: `file-${i}.md`,
          content: `# File ${i}\n\nContent for file ${i}.`,
          createdAt: now - i * 24 * 60 * 60 * 1000, // Stagger creation times
        });
      }

      updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

      const beforeCountRow = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
      expect(beforeCountRow.c).toBeGreaterThan(10); // Ensure we have chunks to prune

      const policy: RetentionPolicy = {
        ...DEFAULT_RETENTION_POLICY,
        maxChunks: 10,
        archiveInsteadOfDelete: false,
        minImportanceScore: 0,
        maxAgeDays: 0,
      };

      const result = enforceStorageLimits(db, policy);

      const afterCount = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };

      expect(afterCount.c).toBeLessThanOrEqual(10);
      expect(result.pruned).toBeGreaterThan(0);

      db.close();
    });
  });

  describe("statistics and reporting", () => {
    it("provides comprehensive retention stats", () => {
      const db = createTestDb();
      const now = Date.now();

      // Index varied content
      indexMemoryFile(db, {
        path: "MEMORY.md",
        content: "# Important\n\nCritical notes.",
        source: "memory",
        createdAt: now - 5 * 24 * 60 * 60 * 1000,
      });

      indexMemoryFile(db, {
        path: "sessions/chat.jsonl",
        content: "User: question\nAssistant: answer",
        source: "sessions",
        createdAt: now - 30 * 24 * 60 * 60 * 1000,
      });

      updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

      const stats = getRetentionStats(db, DEFAULT_RETENTION_POLICY, now);

      expect(stats.totalChunks).toBeGreaterThan(0);
      expect(stats.bySource.memory).toBeGreaterThan(0);
      expect(stats.bySource.sessions).toBeGreaterThan(0);
      expect(stats.averageImportanceScore).toBeGreaterThan(0);
      expect(stats.averageImportanceScore).toBeLessThanOrEqual(1);

      db.close();
    });

    it("correctly identifies prune candidates", () => {
      const db = createTestDb();
      const now = Date.now();
      const veryOldTime = now - 200 * 24 * 60 * 60 * 1000;

      // Index very old, low-importance content
      indexMemoryFile(db, {
        path: "ancient.md",
        content: "# Ancient\n\nVery old content.",
        createdAt: veryOldTime,
      });

      // Index recent content
      indexMemoryFile(db, {
        path: "current.md",
        content: "# Current\n\nRecent content.",
        createdAt: now,
      });

      updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

      const stats = getRetentionStats(db, DEFAULT_RETENTION_POLICY, now);

      // Ancient content should be a prune candidate
      expect(stats.pruneCandidates).toBeGreaterThan(0);

      db.close();
    });
  });

  describe("importance score calculation edge cases", () => {
    it("handles brand new content correctly", () => {
      const now = Date.now();

      const score = calculateImportanceScore({
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        source: "memory",
        importance: "normal",
        pinned: false,
        policy: DEFAULT_RETENTION_POLICY,
        now,
      });

      expect(score).toBeGreaterThan(0.3);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("handles very old content correctly", () => {
      const now = Date.now();
      const veryOld = now - 365 * 24 * 60 * 60 * 1000; // 1 year ago

      const score = calculateImportanceScore({
        createdAt: veryOld,
        lastAccessedAt: veryOld,
        accessCount: 0,
        source: "sessions",
        importance: "low",
        pinned: false,
        policy: DEFAULT_RETENTION_POLICY,
        now,
      });

      expect(score).toBeLessThan(0.3);
      expect(score).toBeGreaterThan(0);
    });

    it("handles highly accessed old content", () => {
      const now = Date.now();
      const old = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago

      const score = calculateImportanceScore({
        createdAt: old,
        lastAccessedAt: now, // Recently accessed
        accessCount: 100, // Frequently accessed
        source: "memory",
        importance: "normal",
        pinned: false,
        policy: DEFAULT_RETENTION_POLICY,
        now,
      });

      // High access should boost score despite age
      expect(score).toBeGreaterThan(0.4);
    });
  });
});
