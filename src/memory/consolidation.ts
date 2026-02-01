/**
 * Memory Consolidation and Summarization
 *
 * Provides intelligent memory management through:
 * - Detecting similar/duplicate memories via embedding similarity
 * - Consolidating related memories into summaries
 * - Reinforcing important memories through the retention system
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryImportance, RetentionPolicy } from "./retention.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VECTOR_TABLE } from "./constants.js";
import { parseEmbedding } from "./internal.js";
import { setChunkImportance, updateImportanceScores } from "./retention.js";

const log = createSubsystemLogger("memory-consolidation");

// =============================================================================
// Types
// =============================================================================

export type SimilarChunkPair = {
  chunkId1: string;
  chunkId2: string;
  similarity: number;
  path1: string;
  path2: string;
  text1: string;
  text2: string;
};

export type ConsolidationCandidate = {
  /** Primary chunk (highest importance) */
  primaryId: string;
  /** Related chunks that could be merged */
  relatedIds: string[];
  /** Average similarity score */
  avgSimilarity: number;
  /** Combined text for summarization */
  combinedText: string;
};

export type ConsolidationResult = {
  /** Number of duplicate pairs found */
  duplicatesFound: number;
  /** Number of chunks marked for consolidation */
  markedForConsolidation: number;
  /** Number of chunks with boosted importance */
  importanceBoosted: number;
  /** Consolidation candidates identified */
  candidates: ConsolidationCandidate[];
};

export type DeduplicationResult = {
  /** Number of exact duplicates removed */
  exactDuplicatesRemoved: number;
  /** Number of near-duplicates found */
  nearDuplicatesFound: number;
  /** Chunk IDs that were removed */
  removedIds: string[];
};

// =============================================================================
// Similarity Detection
// =============================================================================

/**
 * Calculate cosine similarity between two embedding vectors
 */
export function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length || vec1.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    const v1 = vec1[i] ?? 0;
    const v2 = vec2[i] ?? 0;
    dotProduct += v1 * v2;
    norm1 += v1 * v1;
    norm2 += v2 * v2;
  }

  const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);
  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Find chunks with similar embeddings
 */
export function findSimilarChunks(
  db: DatabaseSync,
  options?: {
    /** Minimum similarity threshold (0-1, default 0.9) */
    similarityThreshold?: number;
    /** Maximum pairs to return */
    maxPairs?: number;
    /** Only compare within same source type */
    sameSourceOnly?: boolean;
  },
): SimilarChunkPair[] {
  const threshold = options?.similarityThreshold ?? 0.9;
  const maxPairs = options?.maxPairs ?? 100;
  const sameSourceOnly = options?.sameSourceOnly ?? false;

  // Get all chunks with embeddings
  const chunks = db
    .prepare(`
      SELECT c.id, c.path, c.source, c.text, c.embedding
      FROM chunks c
      WHERE c.embedding IS NOT NULL AND c.embedding != '[]'
    `)
    .all() as Array<{
    id: string;
    path: string;
    source: string;
    text: string;
    embedding: string;
  }>;

  const pairs: SimilarChunkPair[] = [];

  // Compare all pairs (O(n^2) but necessary for similarity detection)
  for (let i = 0; i < chunks.length && pairs.length < maxPairs; i++) {
    const chunk1 = chunks[i];
    if (!chunk1) {
      continue;
    }
    const vec1 = parseEmbedding(chunk1.embedding);

    if (vec1.length === 0) {
      continue;
    }

    for (let j = i + 1; j < chunks.length && pairs.length < maxPairs; j++) {
      const chunk2 = chunks[j];
      if (!chunk2) {
        continue;
      }

      // Skip if different sources and sameSourceOnly is true
      if (sameSourceOnly && chunk1.source !== chunk2.source) {
        continue;
      }

      const vec2 = parseEmbedding(chunk2.embedding);
      if (vec2.length === 0 || vec1.length !== vec2.length) {
        continue;
      }

      const similarity = cosineSimilarity(vec1, vec2);

      if (similarity >= threshold) {
        pairs.push({
          chunkId1: chunk1.id,
          chunkId2: chunk2.id,
          similarity,
          path1: chunk1.path,
          path2: chunk2.path,
          text1: chunk1.text,
          text2: chunk2.text,
        });
      }
    }
  }

  // Sort by similarity descending
  return pairs.toSorted((a, b) => b.similarity - a.similarity);
}

/**
 * Find exact duplicate chunks (same text hash)
 */
export function findExactDuplicates(
  db: DatabaseSync,
): Array<{ hash: string; chunkIds: string[]; paths: string[] }> {
  const duplicates = db
    .prepare(`
      SELECT hash, GROUP_CONCAT(id) as ids, GROUP_CONCAT(path) as paths
      FROM chunks
      GROUP BY hash
      HAVING COUNT(*) > 1
    `)
    .all() as Array<{ hash: string; ids: string; paths: string }>;

  return duplicates.map((row) => ({
    hash: row.hash,
    chunkIds: row.ids.split(","),
    paths: row.paths.split(","),
  }));
}

// =============================================================================
// Deduplication
// =============================================================================

/**
 * Remove exact duplicate chunks, keeping the one with highest importance
 */
export function removeExactDuplicates(
  db: DatabaseSync,
  options?: {
    /** Dry run - don't actually delete */
    dryRun?: boolean;
    vectorTable?: string;
    ftsTable?: string;
  },
): DeduplicationResult {
  const result: DeduplicationResult = {
    exactDuplicatesRemoved: 0,
    nearDuplicatesFound: 0,
    removedIds: [],
  };

  const duplicates = findExactDuplicates(db);

  for (const group of duplicates) {
    if (group.chunkIds.length <= 1) {
      continue;
    }

    // Get importance scores for all duplicates
    const chunks = db
      .prepare(`
        SELECT id, importance_score, pinned, created_at
        FROM chunks
        WHERE id IN (${group.chunkIds.map(() => "?").join(", ")})
        ORDER BY pinned DESC, importance_score DESC, created_at ASC
      `)
      .all(...group.chunkIds) as Array<{
      id: string;
      importance_score: number;
      pinned: number;
      created_at: number;
    }>;

    // Keep the first one (highest importance), remove the rest
    const toRemove = chunks.slice(1).map((c) => c.id);

    if (!options?.dryRun) {
      for (const id of toRemove) {
        try {
          // Delete from vector table
          if (options?.vectorTable) {
            try {
              db.prepare(`DELETE FROM ${options.vectorTable} WHERE id = ?`).run(id);
            } catch {
              // Vector table may not exist
            }
          }

          // Delete from FTS table
          if (options?.ftsTable) {
            try {
              db.prepare(`DELETE FROM ${options.ftsTable} WHERE id = ?`).run(id);
            } catch {
              // FTS table may not exist
            }
          }

          // Delete chunk
          db.prepare(`DELETE FROM chunks WHERE id = ?`).run(id);
          result.removedIds.push(id);
        } catch (err) {
          log.debug(`Failed to remove duplicate chunk ${id}: ${String(err)}`);
        }
      }
    } else {
      result.removedIds.push(...toRemove);
    }

    result.exactDuplicatesRemoved += toRemove.length;
  }

  return result;
}

// =============================================================================
// Consolidation
// =============================================================================

/**
 * Identify consolidation candidates from similar chunks
 */
export function identifyConsolidationCandidates(
  db: DatabaseSync,
  options?: {
    similarityThreshold?: number;
    maxCandidates?: number;
  },
): ConsolidationCandidate[] {
  const similarPairs = findSimilarChunks(db, {
    similarityThreshold: options?.similarityThreshold ?? 0.85,
    maxPairs: 500,
  });

  // Group similar chunks together
  const groups = new Map<string, Set<string>>();
  const similarities = new Map<string, number[]>();

  for (const pair of similarPairs) {
    // Find or create group
    let groupId: string | null = null;

    for (const [gid, members] of groups) {
      if (members.has(pair.chunkId1) || members.has(pair.chunkId2)) {
        groupId = gid;
        break;
      }
    }

    if (groupId) {
      groups.get(groupId)!.add(pair.chunkId1);
      groups.get(groupId)!.add(pair.chunkId2);
      similarities.get(groupId)!.push(pair.similarity);
    } else {
      groupId = pair.chunkId1;
      groups.set(groupId, new Set([pair.chunkId1, pair.chunkId2]));
      similarities.set(groupId, [pair.similarity]);
    }
  }

  // Convert groups to candidates
  const candidates: ConsolidationCandidate[] = [];

  for (const [groupId, members] of groups) {
    if (members.size < 2) {
      continue;
    }

    const memberIds = Array.from(members);
    const sims = similarities.get(groupId) ?? [];
    const avgSimilarity = sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;

    // Get chunk details to find primary
    const chunks = db
      .prepare(`
        SELECT id, text, importance_score, pinned
        FROM chunks
        WHERE id IN (${memberIds.map(() => "?").join(", ")})
        ORDER BY pinned DESC, importance_score DESC
      `)
      .all(...memberIds) as Array<{
      id: string;
      text: string;
      importance_score: number;
      pinned: number;
    }>;

    if (chunks.length < 2) {
      continue;
    }

    const primary = chunks[0];
    if (!primary) {
      continue;
    }
    const related = chunks.slice(1);

    candidates.push({
      primaryId: primary.id,
      relatedIds: related.map((c) => c.id),
      avgSimilarity,
      combinedText: chunks.map((c) => c.text).join("\n\n---\n\n"),
    });
  }

  // Sort by group size and similarity
  return candidates
    .toSorted((a, b) => {
      const sizeA = a.relatedIds.length;
      const sizeB = b.relatedIds.length;
      if (sizeA !== sizeB) {
        return sizeB - sizeA;
      }
      return b.avgSimilarity - a.avgSimilarity;
    })
    .slice(0, options?.maxCandidates ?? 50);
}

/**
 * Boost importance of primary chunks and reduce importance of related chunks
 *
 * This reinforces the most important version of similar content
 * while marking duplicates for eventual pruning.
 */
export function reinforceConsolidationCandidates(
  db: DatabaseSync,
  candidates: ConsolidationCandidate[],
  options?: {
    /** Boost primary chunk importance by this amount */
    primaryBoost?: MemoryImportance;
    /** Reduce related chunk importance to this level */
    relatedLevel?: MemoryImportance;
  },
): { boosted: number; reduced: number } {
  const primaryBoost = options?.primaryBoost ?? "high";
  const relatedLevel = options?.relatedLevel ?? "low";

  let boosted = 0;
  let reduced = 0;

  for (const candidate of candidates) {
    // Boost primary
    if (setChunkImportance(db, candidate.primaryId, primaryBoost)) {
      boosted++;
    }

    // Reduce related
    for (const relatedId of candidate.relatedIds) {
      if (setChunkImportance(db, relatedId, relatedLevel)) {
        reduced++;
      }
    }
  }

  return { boosted, reduced };
}

// =============================================================================
// Main Consolidation Flow
// =============================================================================

/**
 * Run full consolidation workflow
 */
export function runConsolidation(
  db: DatabaseSync,
  policy: RetentionPolicy,
  options?: {
    /** Remove exact duplicates */
    removeExactDupes?: boolean;
    /** Reinforce similar content */
    reinforceSimilar?: boolean;
    /** Similarity threshold for near-duplicates */
    similarityThreshold?: number;
    /** Dry run mode */
    dryRun?: boolean;
    vectorTable?: string;
    ftsTable?: string;
  },
): ConsolidationResult {
  const result: ConsolidationResult = {
    duplicatesFound: 0,
    markedForConsolidation: 0,
    importanceBoosted: 0,
    candidates: [],
  };

  // 1. Remove exact duplicates
  if (options?.removeExactDupes !== false) {
    const dedupeResult = removeExactDuplicates(db, {
      dryRun: options?.dryRun,
      vectorTable: options?.vectorTable ?? VECTOR_TABLE,
      ftsTable: options?.ftsTable,
    });
    result.duplicatesFound = dedupeResult.exactDuplicatesRemoved;
  }

  // 2. Identify consolidation candidates
  const candidates = identifyConsolidationCandidates(db, {
    similarityThreshold: options?.similarityThreshold ?? 0.85,
  });
  result.candidates = candidates;

  // 3. Reinforce similar content
  if (options?.reinforceSimilar !== false && !options?.dryRun) {
    const reinforceResult = reinforceConsolidationCandidates(db, candidates);
    result.importanceBoosted = reinforceResult.boosted;
    result.markedForConsolidation = reinforceResult.reduced;

    // 4. Update importance scores after changes
    updateImportanceScores(db, policy);
  }

  return result;
}

// =============================================================================
// Summarization Preparation
// =============================================================================

/**
 * Prepare text for LLM summarization
 *
 * This formats consolidation candidates for external summarization.
 * The actual LLM call should be done by the caller.
 */
export function prepareForSummarization(
  candidates: ConsolidationCandidate[],
  options?: {
    /** Maximum combined text length */
    maxLength?: number;
  },
): Array<{
  primaryId: string;
  relatedIds: string[];
  textToSummarize: string;
  truncated: boolean;
}> {
  const maxLength = options?.maxLength ?? 10000;

  return candidates.map((candidate) => {
    let text = candidate.combinedText;
    let truncated = false;

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + "\n\n[Content truncated...]";
      truncated = true;
    }

    return {
      primaryId: candidate.primaryId,
      relatedIds: candidate.relatedIds,
      textToSummarize: text,
      truncated,
    };
  });
}

/**
 * Get consolidation statistics
 */
export function getConsolidationStats(db: DatabaseSync): {
  totalChunks: number;
  exactDuplicates: number;
  potentialConsolidations: number;
  uniqueHashes: number;
} {
  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM chunks`).get() as { count: number };

  const hashesRow = db.prepare(`SELECT COUNT(DISTINCT hash) as count FROM chunks`).get() as {
    count: number;
  };

  const duplicates = findExactDuplicates(db);
  const exactDuplicateCount = duplicates.reduce((sum, d) => sum + d.chunkIds.length - 1, 0);

  // Quick estimate of potential consolidations (high similarity pairs)
  const similarPairs = findSimilarChunks(db, {
    similarityThreshold: 0.9,
    maxPairs: 100,
  });

  return {
    totalChunks: totalRow.count,
    exactDuplicates: exactDuplicateCount,
    potentialConsolidations: similarPairs.length,
    uniqueHashes: hashesRow.count,
  };
}
