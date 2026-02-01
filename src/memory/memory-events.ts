/**
 * Memory file update events
 *
 * Provides an event system for memory file updates that allows the
 * MemoryIndexManager to be notified when memory files are written,
 * triggering immediate re-indexing instead of waiting for watch debounce.
 */

export type MemoryFileUpdate = {
  /** Absolute path to the memory file that was updated */
  memoryFile: string;
  /** The agent ID that owns this memory file */
  agentId: string;
  /** Type of update */
  updateType: "created" | "modified" | "flush";
};

type MemoryFileListener = (update: MemoryFileUpdate) => void;

const MEMORY_FILE_LISTENERS = new Set<MemoryFileListener>();

/**
 * Subscribe to memory file update events.
 * Returns an unsubscribe function.
 */
export function onMemoryFileUpdate(listener: MemoryFileListener): () => void {
  MEMORY_FILE_LISTENERS.add(listener);
  return () => {
    MEMORY_FILE_LISTENERS.delete(listener);
  };
}

/**
 * Emit a memory file update event.
 * Called when a memory file is written (e.g., after memory flush).
 */
export function emitMemoryFileUpdate(update: MemoryFileUpdate): void {
  const trimmed = update.memoryFile.trim();
  if (!trimmed) {
    return;
  }
  const normalized = { ...update, memoryFile: trimmed };
  for (const listener of MEMORY_FILE_LISTENERS) {
    try {
      listener(normalized);
    } catch {
      // Ignore listener errors
    }
  }
}

/**
 * Check if there are any active memory file listeners.
 */
export function hasMemoryFileListeners(): boolean {
  return MEMORY_FILE_LISTENERS.size > 0;
}
