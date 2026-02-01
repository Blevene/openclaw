/**
 * Centralized constants for memory subsystem
 *
 * This file consolidates magic numbers and defaults used across
 * the memory indexing, embedding, and search components.
 */

// =============================================================================
// Database Tables
// =============================================================================

export const VECTOR_TABLE = "chunks_vec";
export const FTS_TABLE = "chunks_fts";
export const EMBEDDING_CACHE_TABLE = "embedding_cache";
export const META_KEY = "memory_index_meta_v1";

// =============================================================================
// Search & Display
// =============================================================================

/** Maximum characters to include in search result snippets */
export const SNIPPET_MAX_CHARS = 700;

/** Default maximum results returned from search */
export const DEFAULT_MAX_RESULTS = 6;

/** Default minimum score threshold for search results */
export const DEFAULT_MIN_SCORE = 0.35;

// =============================================================================
// Hybrid Search Weights
// =============================================================================

/** Whether hybrid search is enabled by default */
export const DEFAULT_HYBRID_ENABLED = true;

/** Default weight for vector similarity in hybrid search (0-1) */
export const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;

/** Default weight for BM25 text matching in hybrid search (0-1) */
export const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;

/** Multiplier for candidate retrieval before final ranking */
export const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;

// =============================================================================
// Chunking
// =============================================================================

/** Default token count per chunk */
export const DEFAULT_CHUNK_TOKENS = 400;

/** Default overlap tokens between chunks */
export const DEFAULT_CHUNK_OVERLAP = 80;

/** Approximate characters per token for estimation */
export const EMBEDDING_APPROX_CHARS_PER_TOKEN = 1;

// =============================================================================
// Embedding Batching
// =============================================================================

/** Maximum tokens per embedding batch request */
export const EMBEDDING_BATCH_MAX_TOKENS = 8000;

/** Default concurrent embedding operations */
export const EMBEDDING_INDEX_CONCURRENCY = 4;

/** Maximum retry attempts for embedding requests */
export const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;

/** Base delay (ms) for exponential backoff on embedding retries */
export const EMBEDDING_RETRY_BASE_DELAY_MS = 500;

/** Maximum delay (ms) for exponential backoff on embedding retries */
export const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;

/** Number of batch failures before disabling batch mode */
export const BATCH_FAILURE_LIMIT = 2;

// =============================================================================
// Timeouts
// =============================================================================

/** Timeout (ms) for loading sqlite-vec extension */
export const VECTOR_LOAD_TIMEOUT_MS = 30_000;

/** Timeout (ms) for remote embedding queries */
export const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;

/** Timeout (ms) for local embedding queries */
export const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;

/** Timeout (ms) for remote embedding batches */
export const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;

/** Timeout (ms) for local embedding batches */
export const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;

// =============================================================================
// Sync & Watch
// =============================================================================

/** Debounce time (ms) for file watcher before triggering sync */
export const DEFAULT_WATCH_DEBOUNCE_MS = 1500;

/** Debounce time (ms) for session dirty detection */
export const SESSION_DIRTY_DEBOUNCE_MS = 5000;

/** Bytes of session file change before triggering index */
export const DEFAULT_SESSION_DELTA_BYTES = 100_000;

/** Message count change before triggering session index */
export const DEFAULT_SESSION_DELTA_MESSAGES = 50;

/** Chunk size (bytes) for reading session file deltas */
export const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;

// =============================================================================
// History
// =============================================================================

/** Maximum history entries per chat key */
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

/** Maximum number of history keys to retain (LRU eviction) */
export const MAX_HISTORY_KEYS = 1000;

// =============================================================================
// Memory Flush (Pre-compaction)
// =============================================================================

/** Soft threshold tokens before triggering memory flush */
export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;

// =============================================================================
// Cache
// =============================================================================

/** Whether embedding cache is enabled by default */
export const DEFAULT_CACHE_ENABLED = true;

// =============================================================================
// Models
// =============================================================================

/** Default OpenAI embedding model */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/** Default Gemini embedding model */
export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

// =============================================================================
// Sources
// =============================================================================

/** Memory source types */
export type MemorySource = "memory" | "sessions";

/** Default sources to index */
export const DEFAULT_SOURCES: MemorySource[] = ["memory"];
