/**
 * Tests for HistoryManager
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { HistoryManager, createHistoryManager, createHistoryMap } from "./history-manager.js";

describe("HistoryManager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-manager-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("in-memory mode", () => {
    it("works without persistence", async () => {
      const manager = new HistoryManager();
      await manager.initialize();

      manager.appendEntry("chat-1", { sender: "user", body: "hello" });
      manager.appendEntry("chat-1", { sender: "bot", body: "hi" });

      const history = manager.getHistory("chat-1");
      expect(history.length).toBe(2);
      expect(history[0]?.body).toBe("hello");
      expect(history[1]?.body).toBe("hi");

      manager.close();
    });

    it("returns empty array for unknown keys", async () => {
      const manager = new HistoryManager();
      await manager.initialize();

      const history = manager.getHistory("unknown");
      expect(history).toEqual([]);

      manager.close();
    });

    it("clears history for a key", async () => {
      const manager = new HistoryManager();
      await manager.initialize();

      manager.appendEntry("chat-1", { sender: "user", body: "test" });
      expect(manager.getHistory("chat-1").length).toBe(1);

      manager.clearHistory("chat-1");
      expect(manager.getHistory("chat-1").length).toBe(0);

      manager.close();
    });

    it("deletes a key entirely", async () => {
      const manager = new HistoryManager();
      await manager.initialize();

      manager.appendEntry("chat-1", { sender: "user", body: "test" });
      manager.deleteKey("chat-1");

      expect(manager.getMap().has("chat-1")).toBe(false);

      manager.close();
    });

    it("enforces entry limit per key", async () => {
      const manager = new HistoryManager({ maxEntriesPerKey: 3 });
      await manager.initialize();

      for (let i = 0; i < 10; i++) {
        manager.appendEntry("chat-1", { sender: "user", body: `msg-${i}` });
      }

      const history = manager.getHistory("chat-1");
      expect(history.length).toBe(3);
      expect(history[0]?.body).toBe("msg-7");
      expect(history[2]?.body).toBe("msg-9");

      manager.close();
    });

    it("returns stats", async () => {
      const manager = new HistoryManager();
      await manager.initialize();

      manager.appendEntry("chat-1", { sender: "user", body: "msg1" });
      manager.appendEntry("chat-1", { sender: "bot", body: "msg2" });
      manager.appendEntry("chat-2", { sender: "user", body: "msg3" });

      const stats = manager.getStats();
      expect(stats.inMemoryKeys).toBe(2);
      expect(stats.inMemoryEntries).toBe(3);
      expect(stats.persistentKeys).toBe(0);
      expect(stats.persistentEntries).toBe(0);

      manager.close();
    });
  });

  describe("persistent mode", () => {
    it("persists history to disk", async () => {
      const agentId = "test-agent";

      // First manager - write history
      const manager1 = new HistoryManager({
        persistent: true,
        agentId,
        stateDir: tempDir,
      });
      await manager1.initialize();

      manager1.appendEntry("chat-1", { sender: "user", body: "hello", timestamp: 1000 });
      manager1.appendEntry("chat-1", { sender: "bot", body: "hi", timestamp: 2000 });

      manager1.close();

      // Second manager - should load history
      const manager2 = new HistoryManager({
        persistent: true,
        agentId,
        stateDir: tempDir,
      });
      await manager2.initialize();

      const history = manager2.getHistory("chat-1");
      expect(history.length).toBe(2);
      expect(history[0]?.body).toBe("hello");
      expect(history[1]?.body).toBe("hi");

      manager2.close();
    });

    it("syncs to persistent storage", async () => {
      const manager = new HistoryManager({
        persistent: true,
        agentId: "test-agent",
        stateDir: tempDir,
      });
      await manager.initialize();

      manager.appendEntry("chat-1", { sender: "user", body: "test", timestamp: 1000 });

      const stats = manager.getStats();
      expect(stats.persistentKeys).toBeGreaterThan(0);
      expect(stats.persistentEntries).toBeGreaterThan(0);

      manager.close();
    });

    it("clears persistent history", async () => {
      const manager = new HistoryManager({
        persistent: true,
        agentId: "test-agent",
        stateDir: tempDir,
      });
      await manager.initialize();

      manager.appendEntry("chat-1", { sender: "user", body: "test", timestamp: 1000 });
      manager.clearHistory("chat-1");

      const history = manager.getHistory("chat-1");
      expect(history.length).toBe(0);

      manager.close();
    });
  });

  describe("compatibility", () => {
    it("exposes underlying Map for legacy code", async () => {
      const manager = new HistoryManager();
      await manager.initialize();

      manager.appendEntry("chat-1", { sender: "user", body: "test" });

      const map = manager.getMap();
      expect(map.get("chat-1")?.length).toBe(1);

      manager.close();
    });
  });
});

describe("createHistoryManager", () => {
  it("creates a manager instance", () => {
    const manager = createHistoryManager();
    expect(manager).toBeInstanceOf(HistoryManager);
    manager.close();
  });
});

describe("createHistoryMap", () => {
  it("creates a simple Map", () => {
    const map = createHistoryMap();
    expect(map).toBeInstanceOf(Map);
  });
});
