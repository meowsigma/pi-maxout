# Adaptive Auto Budgeting Design

## Objective

Replace auto mode's static thinking-level lookup with a conservative, per-model feedback controller that learns how much completion room a model needs while minimizing unnecessary maxout-triggered compaction. Preserve the hard invariant `estimated_input + patched_max_tokens <= context_limit`.

## Reframing

One number currently serves two different purposes:

1. **Cap target** — the maximum completion the provider may generate when room exists.
2. **Reservation target** — the completion room worth compacting history to create.

These must be learned and applied separately. A large cap should not itself force compaction when observed outputs are usually short.

## Scope

- Applies only to dynamic auto mode. Explicit session and saved fixed caps retain current behavior.
- Learns independently per `provider:model:thinkingLevel`.
- Uses runtime evidence already available to the extension; no backend changes, prompt inspection, tokenizer dependency, or external service.
- Persists learning in the existing state file with bounded history and age-based decay.

## Controller

### Target ladder

Use the discrete decimal-token ladder:

`8K, 12K, 16K, 24K, 32K, 40K, 48K, 56K`

Cold-start cap targets:

- off/minimal/low/medium: 8K
- high: 16K
- xhigh/max: 32K

Maximum learned targets remain the configured thinking-level targets (defaults: 16K, 32K, 56K), further bounded by a valid `model.maxTokens`.

Cold-start reservation targets equal the cold-start cap targets. This is intentionally conservative.

### Observations

After each successfully sized main request, record:

- actual output tokens when available;
- the patched cap;
- whether the assistant explicitly stopped for a length/token-limit reason;
- whether maxout initiated a successful compaction;
- monotonically increasing observation sequence and update timestamp.

Keep at most the latest 12 positive output-token observations per profile.

### Upward adaptation

An explicit length stop counts only when attributable to the current successfully patched attempt. It immediately moves both cap and reservation up one ladder rung, bounded by the configured/provider ceiling. This is faster than downward adaptation and must not be confused with HTTP context-overflow margin learning.

### Reservation learning

On successful non-truncated output, append output usage and compute the nearest ladder rung at or above `1.25 × recent p90 output`. Reservation may rise to that value immediately but may not exceed cap target. Ordinary short answers do not lower cap or reservation by themselves.

### Downward adaptation

A successful maxout-initiated compaction adds pressure. Two such compactions within eight observed main responses, with no truncation since the previous compaction, move cap and reservation down one rung. Never move below the cold-start target. After a downshift, clear the pressure window. This hysteresis prevents turn-by-turn oscillation.

### Decay

Persist profiles, but on use move cap and reservation one rung toward their cold-start values for each complete 14-day period since the last update. Clear stale output samples and compaction pressure after decay is applied. Profiles older than 90 days may be dropped. Decay is deterministic and lazy; no timer is required.

## Request Flow

1. Resolve model, state, context limit, provider output ceiling, and fixed override.
2. Fixed override: retain current fixed-cap behavior and do not update adaptive learning.
3. Auto mode: load/decay the profile for the active model and thinking level.
4. Patch the request using the profile's cap target, clamped by provider ceiling and remaining hard/soft context room.
5. Use the profile's reservation target—not cap target—to decide whether proactive compaction is justified.
6. Attribute response observations only to the current successfully patched main attempt.
7. Persist a changed profile atomically and refresh status.

## Compaction

- Maxout compacts only when safe remaining room is below the learned reservation target.
- Compaction-summary provider requests remain suspended from maxout sizing.
- Only successful compactions initiated by maxout count as downshift pressure; manual and Pi-core compactions do not.
- Existing cooldown, failure rollback, and awaited pre-agent behavior remain intact.

## State and Commands

Migrate state schema from v2 to v3 by adding a validated `adaptiveProfiles` object. Malformed, prototype-polluting, oversized-history, future-dated, or invalid numeric data is discarded or normalized safely.

Add `/maxout learn reset` to clear adaptive profiles without changing fixed defaults, context limits, margins, or custom target ceilings.

`/maxout status` reports, for the active auto profile:

- learned cap target;
- learned reservation target;
- observation count;
- recent truncation/compaction-pressure indicators.

## Failure Handling

- Missing output usage: do not update output history, but process a trustworthy length stop.
- Unknown stop reason: no upward learning.
- Unsupported payload API or failed patch: create no adaptive attempt and learn nothing.
- Failed compaction: add no compaction pressure and retain immediate-retry behavior.
- Unknown context limit: fail open as today.
- Corrupt adaptive state: normalize to cold-start behavior without breaking extension load.

## Testing

Pure controller tests cover ladder bounds, p90 reservation, length increases, compaction hysteresis, decay, profile validation, and randomized bounds. Integration tests cover attempt attribution, fixed-mode bypass, unsupported APIs, compaction driven by reservation rather than cap, successful-compaction pressure, failed-compaction exclusion, persistence, reset command, status, provider ceiling, session reload, and all existing retry/compaction behavior.

Acceptance requires focused red-green evidence, the complete test suite, TypeScript, installer verification, and a live-load smoke test before release. No backend/runtime configuration changes are permitted.
