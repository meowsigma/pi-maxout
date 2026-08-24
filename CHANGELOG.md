# Changelog

## 2.2.0

- Auto mode now learns per-model output budgets: a new pure controller
  (`adaptive.mjs`) tracks separate cap and compaction-reservation targets per
  `provider:model:thinkingLevel` on a discrete decimal-token ladder with
  conservative cold starts (8K/16K/32K by thinking level).
- Attributable explicit length stops raise both targets one rung immediately;
  successful outputs grow only the reservation from bounded recent p90 output
  (+25%), never above the cap.
- Two successful maxout-initiated compactions within eight observed responses
  downshift one rung (hysteresis); failed, manual, and Pi-core compactions
  never create pressure.
- Learned profiles persist in state-schema v3 (v1/v2 migrate automatically)
  with validated, size-bounded histories, lazy 14-day decay toward cold start,
  and 90-day expiry.
- Proactive compaction is justified by the learned reservation target rather
  than the cap target; fixed overrides, unsupported APIs, provider ceilings,
  overflow-margin learning, retry semantics, and the hard
  input + max_tokens <= context_limit invariant are unchanged.
- Adds `/maxout learn reset` (clears only learning data), learned-profile
  status reporting, installer/verifier packaging of the new modules, and
  focused deterministic plus randomized controller coverage.
- Adds a real `/maxout off` command that clears fixed caps globally and leaves
  provider payloads untouched across model switches.
- Codex adapters that omit `max_output_tokens` remain untouched instead of
  receiving a parameter their endpoint rejects.
- Installer staging and backups now live outside `extensions/`, preventing Pi
  from loading backup copies as duplicate maxout extensions.

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
