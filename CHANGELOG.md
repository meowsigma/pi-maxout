# Changelog

## 2.1.0

- Recalculates provider-aware output budgets on every main request using
  server usage plus the final payload, including tool schemas.
- Adds 16K/32K/56K thinking-level targets, provider output-ceiling clamps,
  configurable safety margins, per-model context-limit overrides, and adaptive
  overflow margin learning.
- Awaits pre-send compaction when selected-mode headroom is insufficient and
  excludes Pi's own compaction/branch-summary requests from sizing.
- Deduplicates pre-stream overflow learning and suppresses learning after
  streaming begins; unsupported payload APIs remain untouched.
- Supports existing vLLM `thinking_token_budget` at xhigh/max while reserving
  answer/tool headroom.
- Adds state-schema v2 migration, dynamic status output, and comprehensive unit
  and integration coverage for arithmetic, lifecycle, retry, and provider cases.

## 1.0.0

- Provider-aware request patching with fail-open behavior for unknown API shapes.
- Per-model session overrides and optional persistent defaults.
- Atomic state writes with invalid-state backup and restrictive permissions.
- Uses Pi's active agent directory instead of assuming a fixed path.
- Reports the exact request field this extension changed.
- Removes the unsafe context-window fallback from `/maxout max`.
- Adds dependency-free tests, TypeScript declarations, and an installer with rollback.
