/**
 * Tests for session file utilities including delta reading
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  readSessionDelta,
  updateDeltaState,
  shouldSyncDelta,
  resetDeltaCounters,
  buildSessionEntry,
  sessionPathForFile,
  type SessionDeltaState,
} from "./session-files.js";

describe("session-files", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-files-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("sessionPathForFile", () => {
    it("extracts session path from absolute path", () => {
      const absPath = "/home/user/.openclaw/agents/agent-1/sessions/2024-01-01.jsonl";
      const result = sessionPathForFile(absPath);
      expect(result).toBe("sessions/2024-01-01.jsonl");
    });

    it("handles Windows-style paths", () => {
      const absPath = "C:\\Users\\test\\.openclaw\\sessions\\test.jsonl";
      const result = sessionPathForFile(absPath);
      expect(result).toBe("sessions/test.jsonl");
    });
  });

  describe("buildSessionEntry", () => {
    it("builds entry from valid session file", async () => {
      const filePath = path.join(tempDir, "test.jsonl");
      const content = [
        '{"type":"message","message":{"role":"user","content":"hello"}}',
        '{"type":"message","message":{"role":"assistant","content":"hi there"}}',
      ].join("\n");

      fs.writeFileSync(filePath, content);

      const entry = await buildSessionEntry(filePath);

      expect(entry).not.toBeNull();
      expect(entry?.path).toBe("sessions/test.jsonl");
      expect(entry?.content).toContain("User: hello");
      expect(entry?.content).toContain("Assistant: hi there");
    });

    it("returns null for non-existent file", async () => {
      const entry = await buildSessionEntry("/nonexistent/path.jsonl");
      expect(entry).toBeNull();
    });
  });

  describe("readSessionDelta", () => {
    it("reads entire file when offset is 0", async () => {
      const filePath = path.join(tempDir, "delta.jsonl");
      const lines = [
        '{"type":"message","message":{"role":"user","content":"first"}}',
        '{"type":"message","message":{"role":"assistant","content":"second"}}',
      ];
      fs.writeFileSync(filePath, lines.join("\n"));

      const result = await readSessionDelta(filePath, 0);

      expect(result).not.toBeNull();
      expect(result?.lineCount).toBe(2);
      expect(result?.content).toContain("User: first");
      expect(result?.content).toContain("Assistant: second");
      expect(result?.wasTruncated).toBe(false);
    });

    it("reads only new content after offset", async () => {
      const filePath = path.join(tempDir, "delta.jsonl");
      const line1 = '{"type":"message","message":{"role":"user","content":"first"}}';
      const line2 = '{"type":"message","message":{"role":"assistant","content":"second"}}';

      // Write first line
      fs.writeFileSync(filePath, line1 + "\n");
      const initialSize = fs.statSync(filePath).size;

      // Append second line
      fs.appendFileSync(filePath, line2 + "\n");

      // Read only the delta
      const result = await readSessionDelta(filePath, initialSize);

      expect(result).not.toBeNull();
      expect(result?.lineCount).toBe(1);
      expect(result?.content).toContain("Assistant: second");
      expect(result?.content).not.toContain("User: first");
    });

    it("returns empty result when no new content", async () => {
      const filePath = path.join(tempDir, "delta.jsonl");
      const content = '{"type":"message","message":{"role":"user","content":"test"}}';
      fs.writeFileSync(filePath, content);

      const size = fs.statSync(filePath).size;
      const result = await readSessionDelta(filePath, size);

      expect(result).not.toBeNull();
      expect(result?.lineCount).toBe(0);
      expect(result?.content).toBe("");
    });

    it("handles file truncation", async () => {
      const filePath = path.join(tempDir, "delta.jsonl");
      const longContent =
        '{"type":"message","message":{"role":"user","content":"this is a long message"}}';
      fs.writeFileSync(filePath, longContent);

      const originalSize = fs.statSync(filePath).size;

      // Truncate file (simulating rotation)
      const shortContent = '{"type":"message","message":{"role":"user","content":"short"}}';
      fs.writeFileSync(filePath, shortContent);

      const result = await readSessionDelta(filePath, originalSize);

      expect(result).not.toBeNull();
      expect(result?.wasTruncated).toBe(true);
      expect(result?.content).toContain("User: short");
    });

    it("returns null for non-existent file", async () => {
      const result = await readSessionDelta("/nonexistent/path.jsonl", 0);
      expect(result).toBeNull();
    });
  });

  describe("updateDeltaState", () => {
    it("updates state with new delta", () => {
      const state: SessionDeltaState = {
        lastSize: 100,
        pendingBytes: 0,
        pendingMessages: 0,
      };

      const result = updateDeltaState(state, {
        content: "test content",
        lineCount: 5,
        currentSize: 200,
        wasTruncated: false,
      });

      expect(result.lastSize).toBe(200);
      expect(result.pendingBytes).toBe(100);
      expect(result.pendingMessages).toBe(5);
    });

    it("resets state on truncation", () => {
      const state: SessionDeltaState = {
        lastSize: 500,
        pendingBytes: 100,
        pendingMessages: 10,
      };

      const result = updateDeltaState(state, {
        content: "new content",
        lineCount: 2,
        currentSize: 50,
        wasTruncated: true,
      });

      expect(result.lastSize).toBe(50);
      expect(result.pendingBytes).toBe(0);
      expect(result.pendingMessages).toBe(0);
    });
  });

  describe("shouldSyncDelta", () => {
    it("returns true when bytes threshold exceeded", () => {
      const state: SessionDeltaState = {
        lastSize: 0,
        pendingBytes: 1000,
        pendingMessages: 5,
      };

      expect(shouldSyncDelta(state, { deltaBytes: 500 })).toBe(true);
    });

    it("returns true when messages threshold exceeded", () => {
      const state: SessionDeltaState = {
        lastSize: 0,
        pendingBytes: 100,
        pendingMessages: 20,
      };

      expect(shouldSyncDelta(state, { deltaMessages: 10 })).toBe(true);
    });

    it("returns false when thresholds not met", () => {
      const state: SessionDeltaState = {
        lastSize: 0,
        pendingBytes: 100,
        pendingMessages: 5,
      };

      expect(shouldSyncDelta(state, { deltaBytes: 500, deltaMessages: 10 })).toBe(false);
    });

    it("returns true on any change when no thresholds set", () => {
      const state: SessionDeltaState = {
        lastSize: 0,
        pendingBytes: 1,
        pendingMessages: 0,
      };

      expect(shouldSyncDelta(state, {})).toBe(true);
    });

    it("returns false when no changes and no thresholds", () => {
      const state: SessionDeltaState = {
        lastSize: 0,
        pendingBytes: 0,
        pendingMessages: 0,
      };

      expect(shouldSyncDelta(state, {})).toBe(false);
    });
  });

  describe("resetDeltaCounters", () => {
    it("resets pending counters but preserves position", () => {
      const state: SessionDeltaState = {
        lastSize: 1000,
        pendingBytes: 500,
        pendingMessages: 25,
        lastHash: "abc123",
      };

      const result = resetDeltaCounters(state);

      expect(result.lastSize).toBe(1000);
      expect(result.pendingBytes).toBe(0);
      expect(result.pendingMessages).toBe(0);
      expect(result.lastHash).toBe("abc123");
    });
  });
});
