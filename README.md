# pi-maxout v2.2.0

Provider-aware dynamic output-budget control for Pi. v2 turns `maxout:auto`
into a per-request dynamic budgeting system that prevents the known
`input + max_tokens > context_window` rejection using conservative accounting.

## Install

```bash
git clone https://github.com/meowsigma/pi-maxout.git
cd pi-maxout
./install.sh
```

The installer runs the bundled tests, atomically replaces
`~/.pi/agent/extensions/pi-maxout/` (or `$PI_CODING_AGENT_DIR`), and keeps a
timestamped backup of an existing install. Restart Pi or run `/reload`.

Use `./uninstall.sh` to remove the extension, or `./uninstall.sh --purge` to
also remove saved settings.

## What it does

On every main agent request (`before_provider_request`), the extension:

1. **Estimates input tokens** conservatively as the maximum of:
   - server-reported usage from prior turns plus trailing-message estimates
     (`ctx.getContextUsage()`), and
   - a structural walk over the exact outgoing payload (messages, system,
     **tool schemas**, images at a fixed cost, chat-template glue).
   This fixes the root cause of the original failure: pi-ai's own estimator
   skips tool schemas on continuation turns.
2. **Resolves the context limit** per model/provider: saved override first,
   then the catalog's `contextWindow`. Nothing is hard-coded — OpenRouter,
   Anthropic, local llama.cpp/vLLM models each use their own limit.
3. **Computes the budget**:
   ```
   margin        = max(1024, configured_margin) + learned_boost   [≤ window/4]
   soft_room     = context_limit − input_estimate − margin
   max_tokens    = min(target, soft_room)      // degrade to hard room if needed
   invariant:    input_estimate + max_tokens ≤ context_limit   (always)
   ```
4. **Patches the payload** field the provider adapter chose
   (`max_tokens`, `max_completion_tokens`, `max_output_tokens`,
   `generationConfig.maxOutputTokens`, …) without touching anything else.

Tool-less active main requests are still budgeted. Idle summaries and active
auto/overflow-compaction requests are explicitly excluded so they retain Pi
core's own summary budgets.

## Adaptive auto (v2.2.0)

Dynamic auto mode is no longer a static lookup table: it **learns** two
separate targets per `provider:model:thinkingLevel`, persisted in the state
file with bounded history:

- **cap target** — the completion ceiling patched into requests;
- **reservation target** — the completion room worth compacting history for.

Both live on a discrete decimal ladder (8K, 12K, 16K, 24K, 32K, 40K, 48K,
56K). Cold starts are conservative per thinking level (off/minimal/low/medium:
8K, high: 16K, xhigh/max: 32K) and equal for cap and reservation.

Learning rules:

- An explicit length stop attributable to the current patched attempt raises
  both targets one rung immediately, bounded by the configured thinking-level
  target and the model's advertised `maxTokens`.
- Successful non-truncated outputs keep the latest twelve positive output
  samples; the reservation may rise to the nearest rung at or above
  1.25 × recent p90 output, never above the cap. Ordinary short answers lower
  nothing.
- A successful maxout-initiated compaction adds pressure; two compactions
  within eight observed main responses and no truncation in between downshift
  both targets one rung (never below cold start), then clear the window.
  Failed, manual, and Pi-core compactions add no pressure.
- Profiles decay lazily one rung toward cold start per complete 14 days since
  their last update and are dropped after 90 days.

Compaction triggers on the *reservation* target only — a large learned cap
does not by itself force compaction when recent outputs are short. Fixed
session/saved overrides bypass learning entirely, and unsupported payload
APIs still fail open without creating a learnable attempt.

## Thinking-level fallbacks

When no profile has learned yet, auto mode falls back to the static targets:

| level              | fallback |
| ------------------ | -------- |
| off/minimal/low/medium | 16 000 |
| high               | 32 000 |
| xhigh/max          | 56 000 (~50K reasoning + answer/tools) |

Targets clamp to actual headroom; they are never allowed to produce an
oversized or zero/negative request. The adaptive ceiling also honors what the
model advertises (`model.maxTokens`): a target above the advertised output
limit clamps to it. Custom ceilings can be set per level via the state file
(`targets`).

## Overflow handling

- A pre-stream HTTP 400/413, or an assistant-level context-overflow error
  BEFORE streaming started, doubles a per-model **margin boost**
  (+2048 → +4096 → … capped at 16384), at most one learning per request
  attempt, so Pi's built-in single compact-and-retry re-runs against a larger
  margin. Successful responses reset the boost and its notification dedupe;
  post-stream overflows are suppressed entirely.
- The extension never sends requests itself and never retries after streaming
  has started; re-sending is exclusively Pi core's single overflow recovery.
- When headroom is smaller than the selected mode's target, status flags it;
  if the context stays tight while idle, auto-compaction is scheduled
  (cooldown-gated). If not even a minimal answer fits, no oversized request is
  sent — the request is left untouched. Tight-but-not-urgent contexts compact
  in `before_agent_start`, which awaits compaction so it fully settles before
  the turn's first provider request; failed attempts clean up their state so
  later passes can retry.

## Status line

```
input 67.3K • maxout 56.0K • context 131.1K
input 129.0K • maxout 24 • context 131.1K [clamped]
input 131.0K • maxout 0.1K • context 131.1K [low-room, +margin 8.2K]
```

Updated after every request, turn end, model/thinking-level change, and
compaction.

## Commands

| command | effect |
| ------- | ------ |
| `/maxout` / `/maxout status` | describe current mode, limits, margins, last patch |
| `/maxout auto` / `/maxout save auto` | dynamic budgeting on (default); removes any session override AND saved fixed default for this model |
| `/maxout 32k` … `/maxout max` | fixed cap for this session (still safety-clamped to remaining context) |
| `/maxout save <spec>` | persist fixed cap; `/maxout save auto` enables auto and deletes the saved default |
| `/maxout learn reset` | clear all learned adaptive budgets; fixed caps, context limits, margins, and custom ceilings are untouched |
| `/maxout margin [n]` | view/set safety margin (min 1024, default 2048) |
| `/maxout limit [n\|clear]` | view/set/clear per-model context-limit override (values ABOVE the catalog window are allowed — that is its purpose) |

State lives in `~/.pi/agent/pi-maxout.json` (schema v3; v1/v2 files migrate
automatically):

```json
{
  "version": 3,
  "auto": true,
  "safetyMarginTokens": 2048,
  "targets": {},
  "contextLimits": {},
  "defaults": {}
}
```

## Development

Pure logic lives in `auto.mjs` / `core.mjs` (zero dependencies);
`index.ts` is thin glue. Tests: `npm test` (78 unit + integration tests,
including the original 67 347 + 63 726 → 131 073 regression).
Typecheck: `npm run typecheck`.

No prompt/response content is ever logged — only token counts.
