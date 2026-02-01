# Feature Request: Zero-Configuration Memory System

## Summary

OpenClaw has powerful memory capabilities that are underutilized because they require configuration or aren't wired up:

- **Memory tools exist but aren't available to agents** - The `memory_search` and `memory_get` tools are defined in code but never added to the agent tool set, so agents can't actually use them despite the system prompt instructing them to.

- **Chat history is lost on restart** - All messaging channels (Telegram, Discord, Slack, Signal, iMessage, WhatsApp) store conversation history in memory only. When the gateway restarts, all context is lost.

- **Memory consolidation never runs** - Code exists to deduplicate and consolidate similar memory chunks, but it's never executed in production paths.

- **Retention policies aren't enforced** - Importance scoring and automatic pruning exist in the codebase but aren't connected to the indexing pipeline.

- **No visibility into memory health** - Users have no way to see consolidation stats, retention status, or trigger manual maintenance.

Users write to `MEMORY.md` expecting agents to recall information, but agents can't search it. Long-running conversations lose context after restarts. Memory files grow unbounded with duplicate content.

## Proposed solution

### 1. Make memory tools available to agents by default

Add `memory_search` and `memory_get` to `createOpenClawTools()` so they're automatically available in all agent sessions. The system prompt already instructs agents to use these tools - they just need to be present.

### 2. Enable persistent chat history by default

Update `HistoryManager` to auto-enable SQLite persistence when a channel name is provided. Each channel gets its own persistent store. On startup, existing history is loaded automatically.

### 3. Run consolidation and retention automatically

During sync operations:
- Remove exact duplicate chunks (same content hash)
- Detect similar chunks (>85% vector similarity) and boost their importance
- Apply importance decay to old content
- Archive or prune low-importance content when storage limits are reached

Default retention policy: 90 days max age, 100MB max storage, 10,000 max chunks per agent.

### 4. Add CLI commands for visibility and control

- `openclaw memory status` - Show consolidation stats, retention stats, index health
- `openclaw memory maintain` - Manually trigger deduplication, scoring, and pruning

### 5. Expose stats in memory tool results

When agents use `memory_search`, include health stats in the response so users can see memory system status.

### 6. Set sensible sync defaults

Enable 30-minute interval sync as a backup mechanism (in addition to file watcher and search-triggered sync).

## Alternatives considered

### Require explicit opt-in configuration

Rejected because most users don't know these features exist. Memory is a core value proposition and configuration barriers reduce adoption.

### Separate memory service

Rejected because it adds deployment complexity, increases latency, and fragments the user experience.

### Cloud-based memory

Rejected due to privacy concerns, account/subscription requirements, and offline functionality needs.

## Additional context

### Files involved

- `src/agents/openclaw-tools.ts` - Add memory tools to agent tool set
- `src/agents/tools/memory-tool.ts` - Add stats to tool results
- `src/memory/manager.ts` - Add runMaintenance(), integrate consolidation
- `src/memory/consolidation.ts` - Deduplication and similarity detection
- `src/memory/retention.ts` - Importance scoring and pruning
- `src/auto-reply/reply/history-manager.ts` - Unified history interface with persistence
- `src/auto-reply/reply/persistent-history.ts` - SQLite storage backend
- `src/cli/memory-cli.ts` - Add maintain command, enhance status output
- All 6 channel monitors - Pass channel name to enable persistence

### Success criteria

- Memory tools available in all agent sessions without configuration
- Chat history persists across gateway restarts for all 6 channels
- Consolidation runs automatically during sync
- Retention policies enforced with sensible defaults
- `openclaw memory status` shows comprehensive health information
- `openclaw memory maintain` allows manual maintenance
- All features work with zero user configuration
- Existing behavior preserved (no breaking changes)
