/**
 * History Manager
 *
 * Provides a unified interface for managing chat history with optional
 * persistent storage. Wraps the in-memory Map with disk-backed SQLite
 * storage for high-value channels.
 *
 * Persistence is enabled by default when a channel is specified.
 */

import type { HistoryEntry } from "./history.js";
import { STATE_DIR } from "../../config/paths.js";
import {
  appendHistoryEntry,
  clearHistoryEntries,
  MAX_HISTORY_KEYS,
  DEFAULT_GROUP_HISTORY_LIMIT,
} from "./history.js";
import {
  PersistentHistoryStore,
  createPersistentHistoryStore,
  type PersistedHistoryEntry,
  type PersistentHistoryConfig,
} from "./persistent-history.js";

export type HistoryManagerConfig = {
  /**
   * Channel name (telegram, discord, slack, signal, imessage, whatsapp).
   * When provided, persistence is enabled automatically.
   */
  channel?: string;
  /**
   * Account ID for multi-account channels (optional).
   * Used to separate history for different accounts of the same channel.
   */
  accountId?: string;
  /**
   * Enable persistent storage.
   * Default: true when channel is provided, false otherwise.
   */
  persistent?: boolean;
  /** Agent ID for persistent storage path (legacy, prefer channel) */
  agentId?: string;
  /** State directory for persistent storage (auto-resolved if not provided) */
  stateDir?: string;
  /** Maximum entries per history key */
  maxEntriesPerKey?: number;
  /** Maximum history keys to retain */
  maxKeys?: number;
  /** Persistent storage config */
  persistentConfig?: Partial<PersistentHistoryConfig>;
};

/**
 * Unified history manager with optional persistence
 */
export class HistoryManager {
  private readonly historyMap = new Map<string, HistoryEntry[]>();
  private readonly persistentStore: PersistentHistoryStore | null = null;
  private readonly maxEntriesPerKey: number;
  private readonly maxKeys: number;
  private initialized = false;
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: HistoryManagerConfig = {}) {
    this.maxEntriesPerKey = config.maxEntriesPerKey ?? DEFAULT_GROUP_HISTORY_LIMIT;
    this.maxKeys = config.maxKeys ?? MAX_HISTORY_KEYS;

    // Resolve persistence configuration
    const stateDir = config.stateDir ?? STATE_DIR;
    const hasChannel = Boolean(config.channel);

    // Build storage ID from channel and optional accountId
    const storageId = config.channel
      ? config.accountId
        ? `${config.channel}-${config.accountId}`
        : config.channel
      : config.agentId;

    // Enable persistence by default when channel is specified
    const shouldPersist = config.persistent ?? hasChannel;

    // Create persistent store if enabled and we have a valid storage ID
    if (shouldPersist && storageId && stateDir) {
      this.persistentStore = createPersistentHistoryStore({
        agentId: storageId,
        stateDir,
        config: {
          ...config.persistentConfig,
          maxEntriesPerKey: this.maxEntriesPerKey,
          maxKeys: this.maxKeys,
        },
      });
    }
  }

  /**
   * Initialize the history manager (loads from persistent storage if enabled)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.persistentStore) {
      await this.persistentStore.initialize();

      // Only set up sync if store initialized successfully
      if (this.persistentStore.isInitialized) {
        // Load existing history from persistent storage
        this.persistentStore.loadToMemory(this.historyMap as Map<string, PersistedHistoryEntry[]>);

        // Set up periodic sync (every 30 seconds)
        this.syncInterval = setInterval(() => {
          this.syncToPersistent();
        }, 30_000);
      }
    }

    this.initialized = true;
  }

  /**
   * Get history entries for a key
   */
  getHistory(historyKey: string): HistoryEntry[] {
    return this.historyMap.get(historyKey) ?? [];
  }

  /**
   * Append an entry to history
   */
  appendEntry(historyKey: string, entry: HistoryEntry): HistoryEntry[] {
    const result = appendHistoryEntry({
      historyMap: this.historyMap,
      historyKey,
      entry: {
        ...entry,
        timestamp: entry.timestamp ?? Date.now(),
      },
      limit: this.maxEntriesPerKey,
    });

    // Immediately persist if storage is enabled
    if (this.persistentStore && result.length > 0) {
      const lastEntry = result[result.length - 1];
      if (lastEntry) {
        this.persistentStore.appendEntry(historyKey, lastEntry as PersistedHistoryEntry);
      }
    }

    return result;
  }

  /**
   * Clear history for a key
   */
  clearHistory(historyKey: string): void {
    clearHistoryEntries({
      historyMap: this.historyMap,
      historyKey,
    });

    if (this.persistentStore) {
      this.persistentStore.clearHistory(historyKey);
    }
  }

  /**
   * Delete a history key entirely
   */
  deleteKey(historyKey: string): void {
    this.historyMap.delete(historyKey);

    if (this.persistentStore) {
      this.persistentStore.deleteKey(historyKey);
    }
  }

  /**
   * Get the underlying Map (for compatibility with existing code)
   */
  getMap(): Map<string, HistoryEntry[]> {
    return this.historyMap;
  }

  /**
   * Get statistics
   */
  getStats(): {
    inMemoryKeys: number;
    inMemoryEntries: number;
    persistentKeys: number;
    persistentEntries: number;
  } {
    let inMemoryEntries = 0;
    for (const entries of this.historyMap.values()) {
      inMemoryEntries += entries.length;
    }

    const persistentStats = this.persistentStore?.getStats() ?? {
      totalKeys: 0,
      totalEntries: 0,
    };

    return {
      inMemoryKeys: this.historyMap.size,
      inMemoryEntries,
      persistentKeys: persistentStats.totalKeys,
      persistentEntries: persistentStats.totalEntries,
    };
  }

  /**
   * Sync in-memory history to persistent storage
   */
  syncToPersistent(): number {
    if (!this.persistentStore) {
      return 0;
    }
    return this.persistentStore.syncFromMemory(
      this.historyMap as Map<string, PersistedHistoryEntry[]>,
    );
  }

  /**
   * Load from persistent storage to memory
   */
  loadFromPersistent(): number {
    if (!this.persistentStore) {
      return 0;
    }
    return this.persistentStore.loadToMemory(
      this.historyMap as Map<string, PersistedHistoryEntry[]>,
    );
  }

  /**
   * Close the history manager (syncs and closes persistent storage)
   */
  close(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    // Final sync before closing
    this.syncToPersistent();

    if (this.persistentStore) {
      this.persistentStore.close();
    }

    this.historyMap.clear();
    this.initialized = false;
  }
}

/**
 * Create a history manager instance
 */
export function createHistoryManager(config: HistoryManagerConfig = {}): HistoryManager {
  return new HistoryManager(config);
}

/**
 * Create a simple in-memory history map (for backward compatibility)
 * Use this when persistence is not needed.
 */
export function createHistoryMap(): Map<string, HistoryEntry[]> {
  return new Map<string, HistoryEntry[]>();
}
