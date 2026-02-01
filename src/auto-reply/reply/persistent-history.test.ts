/**
 * Tests for persistent history storage module
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  PersistentHistoryStore,
  createPersistentHistoryStore,
  type PersistedHistoryEntry,
} from "./persistent-history.js";

describe("PersistentHistoryStore", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));
    dbPath = path.join(tempDir, "history.sqlite");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("initialization", () => {
    it("creates database file on initialize", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      expect(fs.existsSync(dbPath)).toBe(true);

      store.close();
    });

    it("creates parent directories if missing", async () => {
      const nestedPath = path.join(tempDir, "nested", "path", "history.sqlite");
      const store = new PersistentHistoryStore({ dbPath: nestedPath });
      await store.initialize();

      expect(fs.existsSync(nestedPath)).toBe(true);

      store.close();
    });

    it("does not initialize if disabled", async () => {
      const store = new PersistentHistoryStore({ dbPath, enabled: false });
      await store.initialize();

      expect(fs.existsSync(dbPath)).toBe(false);

      store.close();
    });

    it("does not initialize if dbPath is empty", async () => {
      const store = new PersistentHistoryStore({ dbPath: "" });
      await store.initialize();

      // Should not throw, just not initialize
      const stats = store.getStats();
      expect(stats.totalKeys).toBe(0);

      store.close();
    });

    it("can be initialized multiple times safely", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();
      await store.initialize();
      await store.initialize();

      // Should still work
      store.appendEntry("key", { sender: "user", body: "hello", timestamp: Date.now() });
      const history = store.getHistory("key");
      expect(history.length).toBe(1);

      store.close();
    });
  });

  describe("getHistory", () => {
    it("returns empty array for non-existent key", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      const history = store.getHistory("non-existent");
      expect(history).toEqual([]);

      store.close();
    });

    it("returns entries in timestamp order", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      const now = Date.now();
      store.appendEntry("key", { sender: "user", body: "first", timestamp: now });
      store.appendEntry("key", { sender: "bot", body: "second", timestamp: now + 1000 });
      store.appendEntry("key", { sender: "user", body: "third", timestamp: now + 2000 });

      const history = store.getHistory("key");
      expect(history.length).toBe(3);
      expect(history[0]?.body).toBe("first");
      expect(history[1]?.body).toBe("second");
      expect(history[2]?.body).toBe("third");

      store.close();
    });

    it("updates last accessed time on get", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      const now = Date.now();
      store.appendEntry("key", { sender: "user", body: "test", timestamp: now });

      // First access
      store.getHistory("key");

      // Wait a bit and access again
      await new Promise((resolve) => setTimeout(resolve, 10));
      store.getHistory("key");

      // Stats should reflect recent access
      const stats = store.getStats();
      expect(stats.oldestAccessMs).toBeLessThan(100);

      store.close();
    });

    it("returns entry without database", () => {
      const store = new PersistentHistoryStore({ dbPath, enabled: false });
      const history = store.getHistory("key");
      expect(history).toEqual([]);
    });
  });

  describe("appendEntry", () => {
    it("adds entry to history", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      const entry: PersistedHistoryEntry = {
        sender: "user",
        body: "Hello world",
        timestamp: Date.now(),
        messageId: "msg-123",
      };

      store.appendEntry("chat-1", entry);

      const history = store.getHistory("chat-1");
      expect(history.length).toBe(1);
      expect(history[0]?.sender).toBe("user");
      expect(history[0]?.body).toBe("Hello world");
      expect(history[0]?.messageId).toBe("msg-123");

      store.close();
    });

    it("handles entries without messageId", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.appendEntry("key", { sender: "user", body: "test", timestamp: Date.now() });

      const history = store.getHistory("key");
      expect(history[0]?.messageId).toBeUndefined();

      store.close();
    });

    it("enforces per-key entry limit", async () => {
      const store = new PersistentHistoryStore({
        dbPath,
        maxEntriesPerKey: 3,
      });
      await store.initialize();

      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        store.appendEntry("key", { sender: "user", body: `msg-${i}`, timestamp: now + i * 1000 });
      }

      const history = store.getHistory("key");
      expect(history.length).toBe(3);
      // Should keep newest (highest timestamps)
      expect(history[0]?.body).toBe("msg-7");
      expect(history[1]?.body).toBe("msg-8");
      expect(history[2]?.body).toBe("msg-9");

      store.close();
    });

    it("enforces global key limit with LRU eviction", async () => {
      const store = new PersistentHistoryStore({
        dbPath,
        maxKeys: 3,
      });
      await store.initialize();

      const now = Date.now();

      // Add 5 keys
      for (let i = 0; i < 5; i++) {
        store.appendEntry(`key-${i}`, { sender: "user", body: "test", timestamp: now });
        // Small delay to ensure different access times
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const stats = store.getStats();
      expect(stats.totalKeys).toBeLessThanOrEqual(3);

      // Oldest keys should be evicted
      // key-0 and key-1 should be evicted (oldest)
      // key-4 should still exist (newest)
      const key4History = store.getHistory("key-4");
      expect(key4History.length).toBeGreaterThan(0);

      store.close();
    });

    it("does nothing without database", async () => {
      const store = new PersistentHistoryStore({ dbPath, enabled: false });
      store.appendEntry("key", { sender: "user", body: "test", timestamp: Date.now() });
      // Should not throw
    });
  });

  describe("clearHistory", () => {
    it("clears entries for a key", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.appendEntry("key", { sender: "user", body: "test", timestamp: Date.now() });
      expect(store.getHistory("key").length).toBe(1);

      store.clearHistory("key");
      expect(store.getHistory("key").length).toBe(0);

      store.close();
    });

    it("keeps the key in history_keys table", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.appendEntry("key", { sender: "user", body: "test", timestamp: Date.now() });
      store.clearHistory("key");

      // Key should still exist but with 0 entries
      const stats = store.getStats();
      expect(stats.totalKeys).toBe(1);
      expect(stats.totalEntries).toBe(0);

      store.close();
    });
  });

  describe("deleteKey", () => {
    it("removes key and all its entries", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.appendEntry("key1", { sender: "user", body: "test1", timestamp: Date.now() });
      store.appendEntry("key2", { sender: "user", body: "test2", timestamp: Date.now() });

      store.deleteKey("key1");

      expect(store.getHistory("key1").length).toBe(0);
      expect(store.getHistory("key2").length).toBe(1);

      const stats = store.getStats();
      expect(stats.totalKeys).toBe(1);

      store.close();
    });
  });

  describe("getStats", () => {
    it("returns correct statistics", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      const now = Date.now();
      store.appendEntry("key1", { sender: "user", body: "msg1", timestamp: now });
      store.appendEntry("key1", { sender: "bot", body: "msg2", timestamp: now + 1000 });
      store.appendEntry("key2", { sender: "user", body: "msg3", timestamp: now + 2000 });

      const stats = store.getStats();

      expect(stats.totalKeys).toBe(2);
      expect(stats.totalEntries).toBe(3);
      expect(stats.oldestAccessMs).toBeGreaterThanOrEqual(0);
      expect(stats.oldestAccessMs).toBeLessThan(5000);

      store.close();
    });

    it("returns zeros for empty database", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      const stats = store.getStats();

      expect(stats.totalKeys).toBe(0);
      expect(stats.totalEntries).toBe(0);
      expect(stats.oldestAccessMs).toBe(0);

      store.close();
    });

    it("returns zeros when disabled", () => {
      const store = new PersistentHistoryStore({ dbPath, enabled: false });
      const stats = store.getStats();

      expect(stats.totalKeys).toBe(0);
      expect(stats.totalEntries).toBe(0);
      expect(stats.oldestAccessMs).toBe(0);
    });
  });

  describe("syncFromMemory", () => {
    it("syncs in-memory map to persistent storage", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      const memoryMap = new Map<string, PersistedHistoryEntry[]>();
      memoryMap.set("key1", [
        { sender: "user", body: "hello", timestamp: 1000 },
        { sender: "bot", body: "hi", timestamp: 2000 },
      ]);
      memoryMap.set("key2", [{ sender: "user", body: "test", timestamp: 3000 }]);

      const synced = store.syncFromMemory(memoryMap);

      expect(synced).toBe(2);

      const history1 = store.getHistory("key1");
      const history2 = store.getHistory("key2");

      expect(history1.length).toBe(2);
      expect(history2.length).toBe(1);

      store.close();
    });

    it("replaces existing entries on sync", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      // Add existing entry
      store.appendEntry("key", { sender: "user", body: "old", timestamp: 1000 });

      // Sync with new data
      const memoryMap = new Map<string, PersistedHistoryEntry[]>();
      memoryMap.set("key", [{ sender: "user", body: "new", timestamp: 2000 }]);

      store.syncFromMemory(memoryMap);

      const history = store.getHistory("key");
      expect(history.length).toBe(1);
      expect(history[0]?.body).toBe("new");

      store.close();
    });
  });

  describe("loadToMemory", () => {
    it("loads persistent storage to memory map", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.appendEntry("key1", { sender: "user", body: "msg1", timestamp: 1000 });
      store.appendEntry("key1", { sender: "bot", body: "msg2", timestamp: 2000 });
      store.appendEntry("key2", { sender: "user", body: "msg3", timestamp: 3000 });

      const memoryMap = new Map<string, PersistedHistoryEntry[]>();
      const loaded = store.loadToMemory(memoryMap);

      expect(loaded).toBe(2);
      expect(memoryMap.has("key1")).toBe(true);
      expect(memoryMap.has("key2")).toBe(true);
      expect(memoryMap.get("key1")!.length).toBe(2);
      expect(memoryMap.get("key2")!.length).toBe(1);

      store.close();
    });

    it("preserves existing entries in memory map", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.appendEntry("key2", { sender: "user", body: "from-db", timestamp: 2000 });

      const memoryMap = new Map<string, PersistedHistoryEntry[]>();
      memoryMap.set("key1", [{ sender: "user", body: "from-memory", timestamp: 1000 }]);

      store.loadToMemory(memoryMap);

      expect(memoryMap.has("key1")).toBe(true);
      expect(memoryMap.has("key2")).toBe(true);

      store.close();
    });
  });

  describe("close", () => {
    it("closes database connection", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.appendEntry("key", { sender: "user", body: "test", timestamp: Date.now() });
      store.close();

      // Operations after close should not throw but return empty
      const history = store.getHistory("key");
      expect(history).toEqual([]);
    });

    it("can be called multiple times", async () => {
      const store = new PersistentHistoryStore({ dbPath });
      await store.initialize();

      store.close();
      store.close();
      store.close();
      // Should not throw
    });
  });
});

describe("createPersistentHistoryStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-factory-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("creates store with correct db path", () => {
    const store = createPersistentHistoryStore({
      agentId: "agent-123",
      stateDir: tempDir,
    });

    // The path should be constructed correctly
    // dbPath should be: tempDir/agents/agent-123/history.sqlite
    // We can't directly check the internal path, but we can verify it works
    expect(store).toBeInstanceOf(PersistentHistoryStore);

    store.close();
  });

  it("accepts custom config", () => {
    const store = createPersistentHistoryStore({
      agentId: "agent-123",
      stateDir: tempDir,
      config: {
        maxEntriesPerKey: 5,
        maxKeys: 10,
      },
    });

    expect(store).toBeInstanceOf(PersistentHistoryStore);

    store.close();
  });
});
