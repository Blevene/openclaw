import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";
import {
  parseSessionContent,
  parseSessionLines,
  extractTextFromContent,
} from "./session-entry-schema.js";

const log = createSubsystemLogger("memory");

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
};

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  // Normalize Windows backslashes to forward slashes before extracting basename
  // This ensures path.basename works correctly on all platforms
  const normalized = absPath.replace(/\\/g, "/");
  return path.join("sessions", path.basename(normalized)).replace(/\\/g, "/");
}

/**
 * Extract text from message content (for backward compatibility)
 * @deprecated Use extractTextFromContent from session-entry-schema.js instead
 */
export function extractSessionText(content: unknown): string | null {
  // Cast to the expected type for the schema function
  return extractTextFromContent(content as Parameters<typeof extractTextFromContent>[0]);
}

/**
 * Build a session file entry from an absolute path
 * Uses the validated session entry schema for parsing
 */
export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const content = parseSessionContent(raw);
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content),
      content,
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}

/**
 * Delta state for tracking session file changes
 */
export type SessionDeltaState = {
  /** Last known file size (byte offset) */
  lastSize: number;
  /** Accumulated bytes since last sync */
  pendingBytes: number;
  /** Accumulated message count since last sync */
  pendingMessages: number;
  /** Hash of last processed content */
  lastHash?: string;
};

/**
 * Result of reading a session file delta
 */
export type SessionDeltaResult = {
  /** New content since last read */
  content: string;
  /** Number of new lines/entries */
  lineCount: number;
  /** Current file size */
  currentSize: number;
  /** Whether file was truncated (size decreased) */
  wasTruncated: boolean;
};

/**
 * Read only the new portion of a session file since the last offset.
 * This enables incremental indexing without re-reading entire files.
 *
 * @param absPath - Absolute path to the session file
 * @param fromOffset - Byte offset to start reading from
 * @returns Delta result with new content, or null if file doesn't exist
 */
export async function readSessionDelta(
  absPath: string,
  fromOffset: number,
): Promise<SessionDeltaResult | null> {
  let handle: fs.FileHandle | null = null;

  try {
    const stat = await fs.stat(absPath);
    const currentSize = stat.size;

    // Handle file truncation (e.g., rotation)
    if (currentSize < fromOffset) {
      // File was truncated - read from beginning
      const raw = await fs.readFile(absPath, "utf-8");
      const lines = raw.split("\n").filter((line) => line.trim());
      return {
        content: parseSessionLines(lines),
        lineCount: lines.length,
        currentSize,
        wasTruncated: true,
      };
    }

    // No new content
    if (currentSize === fromOffset) {
      return {
        content: "",
        lineCount: 0,
        currentSize,
        wasTruncated: false,
      };
    }

    // Read only the delta portion
    handle = await fs.open(absPath, "r");
    const deltaSize = currentSize - fromOffset;
    const buffer = Buffer.alloc(deltaSize);

    const { bytesRead } = await handle.read(buffer, 0, deltaSize, fromOffset);

    if (bytesRead === 0) {
      return {
        content: "",
        lineCount: 0,
        currentSize,
        wasTruncated: false,
      };
    }

    const rawDelta = buffer.slice(0, bytesRead).toString("utf-8");

    // Handle partial line at the start (if we're mid-line from last read)
    // Only skip if: we're not at file start, doesn't start with newline,
    // AND doesn't start with '{' (which indicates a valid JSONL line start)
    let startIndex = 0;
    if (fromOffset > 0 && !rawDelta.startsWith("\n") && !rawDelta.startsWith("{")) {
      const firstNewline = rawDelta.indexOf("\n");
      if (firstNewline !== -1) {
        startIndex = firstNewline + 1;
      }
    }

    const cleanDelta = rawDelta.slice(startIndex);
    const lines = cleanDelta.split("\n").filter((line) => line.trim());
    const content = parseSessionLines(lines);

    return {
      content,
      lineCount: lines.length,
      currentSize,
      wasTruncated: false,
    };
  } catch (err) {
    log.debug(`Failed reading session delta from ${absPath}: ${String(err)}`);
    return null;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

/**
 * Update delta state after processing a session file.
 *
 * @param state - Current delta state
 * @param deltaResult - Result from readSessionDelta
 * @returns Updated state
 */
export function updateDeltaState(
  state: SessionDeltaState,
  deltaResult: SessionDeltaResult,
): SessionDeltaState {
  if (deltaResult.wasTruncated) {
    // File was truncated - reset state
    return {
      lastSize: deltaResult.currentSize,
      pendingBytes: 0,
      pendingMessages: 0,
      lastHash: hashText(deltaResult.content),
    };
  }

  return {
    lastSize: deltaResult.currentSize,
    pendingBytes: state.pendingBytes + (deltaResult.currentSize - state.lastSize),
    pendingMessages: state.pendingMessages + deltaResult.lineCount,
    lastHash: deltaResult.content ? hashText(deltaResult.content) : state.lastHash,
  };
}

/**
 * Check if delta should trigger a sync based on thresholds.
 */
export function shouldSyncDelta(
  state: SessionDeltaState,
  thresholds: { deltaBytes?: number; deltaMessages?: number },
): boolean {
  const { deltaBytes = 0, deltaMessages = 0 } = thresholds;

  if (deltaBytes > 0 && state.pendingBytes >= deltaBytes) {
    return true;
  }

  if (deltaMessages > 0 && state.pendingMessages >= deltaMessages) {
    return true;
  }

  // If no thresholds set, sync on any change
  if (deltaBytes <= 0 && deltaMessages <= 0) {
    return state.pendingBytes > 0 || state.pendingMessages > 0;
  }

  return false;
}

/**
 * Reset pending counters after sync (preserving last position)
 */
export function resetDeltaCounters(state: SessionDeltaState): SessionDeltaState {
  return {
    ...state,
    pendingBytes: 0,
    pendingMessages: 0,
  };
}
