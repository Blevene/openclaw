# Memory Mechanisms Analysis

This document analyzes the memory systems in OpenClaw and identifies improvement opportunities.

## Current Architecture

OpenClaw has **five distinct memory subsystems**:

| Subsystem               | Location                                      | Purpose                                       |
| ----------------------- | --------------------------------------------- | --------------------------------------------- |
| **MemoryIndexManager**  | `src/memory/manager.ts`                       | Semantic search over MEMORY.md + memory/\*.md |
| **Session Transcripts** | `~/.openclaw/agents/{id}/sessions/*.jsonl`    | Full conversation history (JSONL)             |
| **In-Memory History**   | `src/auto-reply/reply/history.ts`             | Runtime message context between replies       |
| **Memory Flush**        | `src/auto-reply/reply/memory-flush.ts`        | Pre-compaction memory save trigger            |
| **Session Memory Hook** | `src/hooks/bundled/session-memory/handler.ts` | `/new` command session archiving              |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Runtime                            │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐ │
│  │  In-Memory   │   │   Session    │   │  Memory Flush    │ │
│  │   History    │   │  Transcripts │   │    Trigger       │ │
│  │   (Map)      │   │   (.jsonl)   │   │ (Pre-compaction) │ │
│  └──────────────┘   └──────┬───────┘   └────────┬─────────┘ │
│                            │                     │           │
│                            ▼                     ▼           │
│               ┌────────────────────────────────────────┐    │
│               │        MemoryIndexManager              │    │
│               │  ┌─────────────────────────────────┐   │    │
│               │  │    SQLite + sqlite-vec + FTS5   │   │    │
│               │  │  ┌─────────┐  ┌──────────────┐  │   │    │
│               │  │  │ chunks  │  │ chunks_vec   │  │   │    │
│               │  │  │ (text)  │  │ (embeddings) │  │   │    │
│               │  │  └─────────┘  └──────────────┘  │   │    │
│               │  └─────────────────────────────────┘   │    │
│               └────────────────────────────────────────┘    │
│                            ▲                                 │
│                            │                                 │
│  ┌──────────────┐   ┌──────┴───────┐   ┌──────────────────┐ │
│  │  MEMORY.md   │   │  memory/*.md │   │ Session Memory   │ │
│  │  (manual)    │   │  (auto/hook) │   │    Hook          │ │
│  └──────────────┘   └──────────────┘   └──────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Key Improvement Opportunities

### 1. MemoryIndexManager is a Monolith (~2400 LOC)

**Problem:** `manager.ts` violates the ~500-700 LOC guideline significantly. It handles database management, embedding provider management, file watching, sync, session delta tracking, batch embedding orchestration, vector table management, cache management, and hybrid search merging.

**Refactor Opportunity:**

```
src/memory/
├── manager.ts           → Slim coordinator (~300 LOC)
├── sync/
│   ├── memory-sync.ts   → Memory file syncing
│   ├── session-sync.ts  → Session file syncing
│   └── delta-tracker.ts → Session delta tracking logic
├── embedding/
│   ├── batcher.ts       → Batch embedding logic
│   └── cache.ts         → Embedding cache operations
├── db/
│   └── operations.ts    → All DB read/write operations
└── watchers.ts          → File watcher setup
```

### 2. Duplicated Embedding Cache Logic

**Problem:** The same cache lookup/upsert pattern appears 3 times in `embedChunksInBatches()`, `embedChunksWithOpenAiBatch()`, and `embedChunksWithGeminiBatch()`.

**Fix:** Extract to a shared method that handles cache-first embedding.

### 3. History System is Memory-Only

**Problem:** `history.ts` uses `Map<string, HistoryEntry[]>` with no persistence. On restart, context is lost.

**Improvement:** Consider optional disk-backed history (LRU cache with SQLite spillover) for high-value channels.

### 4. Session Memory Hook Has Hard-Coded Paths

**Problem:** Dynamic import uses fragile path manipulation instead of standard module resolution.

**Fix:** Use standard module resolution or dependency injection.

### 5. Inconsistent Memory Sources Configuration

**Problem:** Two overlapping concepts: `sources: ["memory", "sessions"]` and `experimental.sessionMemory` flag.

**Fix:** Consolidate - if `sessions` is in sources, it implies session memory is enabled.

### 6. Memory Flush Coupling

**Problem:** `memory-flush.ts` writes files that `MemoryIndexManager` must re-index, but there's no direct integration.

**Improvement:** Add a flush event that triggers immediate re-indexing of the new memory file.

### 7. Magic Numbers Scattered

**Problem:** Constants are spread across multiple files without centralization.

**Fix:** Create `src/memory/constants.ts` for shared defaults.

### 8. No Memory Pruning Strategy

**Problem:** Memory files accumulate indefinitely. Session transcripts grow without bounds.

**Improvement:** Add configurable retention policies for archiving, summarizing, and compacting.

### 9. Hybrid Search Weight Normalization

**Problem:** Weights are normalized after being read from config.

**Fix:** Move normalization into `mergeConfig()` to ensure weights are always valid.

### 10. Session Entry Parsing is Fragile

**Problem:** Session JSONL parsing uses `any` type casting, no schema validation, and silent failures.

**Fix:** Add a shared session entry schema/parser with proper typing.

## Recommended Refactoring Priority

| Priority   | Task                                     | Impact                       |
| ---------- | ---------------------------------------- | ---------------------------- |
| **High**   | Split `manager.ts` into focused modules  | Maintainability, testability |
| **High**   | Extract duplicated embedding cache logic | DRY, bug reduction           |
| **Medium** | Centralize memory constants              | Consistency                  |
| **Medium** | Add session entry schema validation      | Reliability                  |
| **Low**    | Add memory retention/pruning             | Resource management          |
| **Low**    | Persist runtime history to disk          | Better UX                    |

## Key Files

- `src/memory/manager.ts` - Core memory index manager (2400 LOC)
- `src/memory/hybrid.ts` - Hybrid search merging
- `src/memory/manager-search.ts` - Vector/keyword search implementation
- `src/agents/memory-search.ts` - Configuration resolution
- `src/agents/tools/memory-tool.ts` - Agent memory tools
- `src/auto-reply/reply/history.ts` - Runtime history tracking
- `src/auto-reply/reply/memory-flush.ts` - Pre-compaction flush
- `src/hooks/bundled/session-memory/handler.ts` - Session archiving hook
