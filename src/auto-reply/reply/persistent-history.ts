/**
 * Persistent History Storage
 *
 * SQLite-backed storage for runtime chat history, preserving context
 * across restarts. Uses an LRU eviction strategy with configurable limits.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MAX_HISTORY_KEYS, DEFAULT_GROUP_HISTORY_LIMIT } from "./history.js";

const log = createSubsystemLogger("history");

export type PersistedHistoryEntry = {
  sender: string;
  body: string;
  timestamp: number;
  messageId?: string;
};

export type PersistentHistoryConfig = {
  /** Path to SQLite database file */
  dbPath: string;
  /** Maximum entries per history key */
  maxEntriesPerKey: number;
  /** Maximum number of history keys to retain */
  maxKeys: number;
  /** Whether persistence is enabled */
  enabled: boolean;
};

const DEFAULT_CONFIG: PersistentHistoryConfig = {
  dbPath: "",
  maxEntriesPerKey: DEFAULT_GROUP_HISTORY_LIMIT,
  maxKeys: MAX_HISTORY_KEYS,
  enabled: true,
};

/**
 * Persistent history store backed by SQLite
 */
export class PersistentHistoryStore {
  private db: DatabaseSync | null = null;
  private readonly config: PersistentHistoryConfig;
  private initialized = false;

  constructor(config: Partial<PersistentHistoryConfig> & { dbPath: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the database connection and schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.config.enabled || !this.config.dbPath) {
      return;
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Open database
      const { DatabaseSync } = await import("node:sqlite");
      this.db = new DatabaseSync(this.config.dbPath);

      // Create schema
      this.ensureSchema();
      this.initialized = true;

      log.debug(`Persistent history initialized at ${this.config.dbPath}`);
    } catch (err) {
      log.warn(`Failed to initialize persistent history: ${String(err)}`);
      this.db = null;
    }
  }

  private ensureSchema(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_keys (
        key TEXT PRIMARY KEY,
        last_accessed_at INTEGER NOT NULL,
        entry_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        history_key TEXT NOT NULL,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        message_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (history_key) REFERENCES history_keys(key) ON DELETE CASCADE
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_entries_key
      ON history_entries(history_key)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_entries_timestamp
      ON history_entries(history_key, timestamp DESC)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_keys_accessed
      ON history_keys(last_accessed_at)
    `);
  }

  /**
   * Get history entries for a key
   */
  getHistory(historyKey: string): PersistedHistoryEntry[] {
    if (!this.db) {
      return [];
    }

    try {
      // Update last accessed time
      const now = Date.now();
      this.db
        .prepare(`
        UPDATE history_keys SET last_accessed_at = ? WHERE key = ?
      `)
        .run(now, historyKey);

      // Get entries
      const rows = this.db
        .prepare(`
          SELECT sender, body, timestamp, message_id
          FROM history_entries
          WHERE history_key = ?
          ORDER BY timestamp ASC
          LIMIT ?
        `)
        .all(historyKey, this.config.maxEntriesPerKey) as Array<{
        sender: string;
        body: string;
        timestamp: number;
        message_id: string | null;
      }>;

      return rows.map((row) => ({
        sender: row.sender,
        body: row.body,
        timestamp: row.timestamp,
        messageId: row.message_id ?? undefined,
      }));
    } catch (err) {
      log.debug(`Failed to get history for ${historyKey}: ${String(err)}`);
      return [];
    }
  }

  /**
   * Append an entry to history
   */
  appendEntry(historyKey: string, entry: PersistedHistoryEntry): void {
    if (!this.db) {
      return;
    }

    try {
      const now = Date.now();

      // Ensure key exists
      this.db
        .prepare(`
        INSERT INTO history_keys (key, last_accessed_at, entry_count)
        VALUES (?, ?, 0)
        ON CONFLICT(key) DO UPDATE SET last_accessed_at = excluded.last_accessed_at
      `)
        .run(historyKey, now);

      // Insert entry
      this.db
        .prepare(`
        INSERT INTO history_entries (history_key, sender, body, timestamp, message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .run(historyKey, entry.sender, entry.body, entry.timestamp, entry.messageId ?? null, now);

      // Update entry count
      this.db
        .prepare(`
        UPDATE history_keys
        SET entry_count = (SELECT COUNT(*) FROM history_entries WHERE history_key = ?)
        WHERE key = ?
      `)
        .run(historyKey, historyKey);

      // Enforce per-key limit
      this.enforceKeyLimit(historyKey);

      // Enforce global key limit
      this.enforceGlobalKeyLimit();
    } catch (err) {
      log.debug(`Failed to append history entry: ${String(err)}`);
    }
  }

  /**
   * Enforce entry limit for a single key
   */
  private enforceKeyLimit(historyKey: string): void {
    if (!this.db) {
      return;
    }

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM history_entries WHERE history_key = ?`)
      .get(historyKey) as { count: number };

    if (countRow.count > this.config.maxEntriesPerKey) {
      const excess = countRow.count - this.config.maxEntriesPerKey;
      this.db
        .prepare(`
        DELETE FROM history_entries
        WHERE id IN (
          SELECT id FROM history_entries
          WHERE history_key = ?
          ORDER BY timestamp ASC
          LIMIT ?
        )
      `)
        .run(historyKey, excess);
    }
  }

  /**
   * Enforce global key limit (LRU eviction)
   */
  private enforceGlobalKeyLimit(): void {
    if (!this.db) {
      return;
    }

    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM history_keys`).get() as {
      count: number;
    };

    if (countRow.count > this.config.maxKeys) {
      const excess = countRow.count - this.config.maxKeys;

      // Get oldest keys
      const oldestKeys = this.db
        .prepare(`
          SELECT key FROM history_keys
          ORDER BY last_accessed_at ASC
          LIMIT ?
        `)
        .all(excess) as Array<{ key: string }>;

      for (const row of oldestKeys) {
        this.deleteKey(row.key);
      }
    }
  }

  /**
   * Clear history for a key
   */
  clearHistory(historyKey: string): void {
    if (!this.db) {
      return;
    }

    try {
      this.db.prepare(`DELETE FROM history_entries WHERE history_key = ?`).run(historyKey);
      this.db.prepare(`UPDATE history_keys SET entry_count = 0 WHERE key = ?`).run(historyKey);
    } catch (err) {
      log.debug(`Failed to clear history for ${historyKey}: ${String(err)}`);
    }
  }

  /**
   * Delete a history key and all its entries
   */
  deleteKey(historyKey: string): void {
    if (!this.db) {
      return;
    }

    try {
      this.db.prepare(`DELETE FROM history_entries WHERE history_key = ?`).run(historyKey);
      this.db.prepare(`DELETE FROM history_keys WHERE key = ?`).run(historyKey);
    } catch (err) {
      log.debug(`Failed to delete history key ${historyKey}: ${String(err)}`);
    }
  }

  /**
   * Get statistics about stored history
   */
  getStats(): { totalKeys: number; totalEntries: number; oldestAccessMs: number } {
    if (!this.db) {
      return { totalKeys: 0, totalEntries: 0, oldestAccessMs: 0 };
    }

    try {
      const keysRow = this.db.prepare(`SELECT COUNT(*) as count FROM history_keys`).get() as {
        count: number;
      };

      const entriesRow = this.db.prepare(`SELECT COUNT(*) as count FROM history_entries`).get() as {
        count: number;
      };

      const oldestRow = this.db
        .prepare(`SELECT MIN(last_accessed_at) as oldest FROM history_keys`)
        .get() as { oldest: number | null };

      const now = Date.now();
      const oldestAccessMs = oldestRow.oldest ? now - oldestRow.oldest : 0;

      return {
        totalKeys: keysRow.count,
        totalEntries: entriesRow.count,
        oldestAccessMs,
      };
    } catch {
      return { totalKeys: 0, totalEntries: 0, oldestAccessMs: 0 };
    }
  }

  /**
   * Sync in-memory history map to persistent storage
   */
  syncFromMemory(historyMap: Map<string, PersistedHistoryEntry[]>): number {
    if (!this.db) {
      return 0;
    }

    let synced = 0;
    for (const [key, entries] of historyMap) {
      try {
        // Clear existing entries
        this.clearHistory(key);

        // Insert all entries
        for (const entry of entries) {
          this.appendEntry(key, entry);
        }
        synced++;
      } catch (err) {
        log.debug(`Failed to sync history for ${key}: ${String(err)}`);
      }
    }

    return synced;
  }

  /**
   * Load persistent history into memory map
   */
  loadToMemory(historyMap: Map<string, PersistedHistoryEntry[]>): number {
    if (!this.db) {
      return 0;
    }

    try {
      const keys = this.db
        .prepare(`SELECT key FROM history_keys ORDER BY last_accessed_at DESC`)
        .all() as Array<{ key: string }>;

      let loaded = 0;
      for (const row of keys) {
        const entries = this.getHistory(row.key);
        if (entries.length > 0) {
          historyMap.set(row.key, entries);
          loaded++;
        }
      }

      return loaded;
    } catch (err) {
      log.debug(`Failed to load history to memory: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors
      }
      this.db = null;
    }
    this.initialized = false;
  }
}

/**
 * Create a persistent history store for an agent
 */
export function createPersistentHistoryStore(params: {
  agentId: string;
  stateDir: string;
  config?: Partial<PersistentHistoryConfig>;
}): PersistentHistoryStore {
  const dbPath = path.join(params.stateDir, "agents", params.agentId, "history.sqlite");
  return new PersistentHistoryStore({
    dbPath,
    ...params.config,
  });
}
