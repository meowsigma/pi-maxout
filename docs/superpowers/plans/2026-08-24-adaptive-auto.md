# Adaptive Auto Budgeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task has an Acceptance Contract; do not mark a task complete until its Quality Gate review returns PASS.

**Goal:** Make auto mode learn separate output-cap and compaction-reservation targets per model and thinking level, with fast truncation recovery, slow compaction-pressure downshifts, and persistent decay.

**Architecture:** Add a pure `adaptive.mjs` reducer for profile validation and deterministic transitions, extend core state to schema v3, then wire attributable attempt/response and maxout-compaction observations in `index.ts`. Fixed overrides and existing hard-window arithmetic remain independent and unchanged.

**Tech Stack:** TypeScript extension glue, dependency-free ESM pure modules, Node test runner, Pi extension lifecycle hooks.

---

## File map

- Create `adaptive.mjs`: ladder, profile keys/defaults, validation, decay, output/truncation/compaction transitions.
- Create `adaptive.d.mts`: strict public types for the pure controller.
- Create `test/controller.test.mjs`: deterministic and randomized pure-controller tests.
- Modify `core.mjs` / `core.d.mts`: schema-v3 adaptive profile persistence and migration.
- Modify `test/state.test.mjs` and `tests/core.test.mjs`: migration and hostile-state coverage.
- Modify `index.ts`: dual-target request/compaction wiring, attribution, persistence, reset/status.
- Modify `test/harness.mjs`, `test/integration.test.mjs`, and `test/followup.test.mjs`: lifecycle coverage.
- Modify `README.md`, `CHANGELOG.md`, `package.json`, and `package-lock.json`: v2.2.0 behavior and release metadata.

### Task 1: Pure adaptive controller

**Files:**
- Create: `adaptive.mjs`
- Create: `adaptive.d.mts`
- Create: `test/controller.test.mjs`

**Acceptance Contract:**
- User-visible behavior: Auto profiles start conservatively, rise after attributable length truncation, reserve recent p90 output plus 25%, downshift only after repeated maxout compaction, and decay toward baseline.
- Wiring proof command: `node --test test/controller.test.mjs`
- Expected output / observable behavior: controller tests report zero failures and include cold-start, ceiling, truncation, p90, hysteresis, decay, malformed profile, and randomized-bound cases.
- Test-quality proof: tests call exported production reducers and assert exact target transitions; removing any transition causes a named failure.
- Regression proof command: `npm test`
- Failure this catches: oscillating targets, ceiling violations, corrupt persistence, history growth, and accidental downshift after one compaction.

- [ ] Write failing tests importing the wished-for exports:
  `profileKey`, `coldStartTarget`, `normalizeAdaptiveProfile`, `decayAdaptiveProfile`, `observeAdaptiveOutput`, and `observeAdaptiveCompaction`.
- [ ] Run `node --test test/controller.test.mjs` and record the expected missing-module/export failure.
- [ ] Implement the decimal ladder `[8000,12000,16000,24000,32000,40000,48000,56000]`, cold starts, bounded 12-sample history, nearest-rung p90 reservation, one-rung truncation increase, two-in-eight compaction downshift, 14-day rung decay, and 90-day expiry.
- [ ] Run `node --test test/controller.test.mjs`; expect all controller tests to pass.
- [ ] Run `npm test`; expect all tests to pass.
- [ ] Commit with `git commit -am "feat: add adaptive budget controller"` after adding new files.

### Task 2: State schema v3

**Files:**
- Modify: `core.mjs`
- Modify: `core.d.mts`
- Modify: `test/state.test.mjs`
- Modify: `tests/core.test.mjs`

**Acceptance Contract:**
- User-visible behavior: Existing v1/v2 state loads unchanged while validated adaptive profiles persist in v3.
- Wiring proof command: `node --test test/state.test.mjs tests/core.test.mjs`
- Expected output / observable behavior: migrations produce version 3, preserve prior settings, and normalize hostile adaptive data without prototype keys or unbounded arrays.
- Test-quality proof: fixtures exercise `normalizeState` and would fail if profiles were dropped, malformed entries retained, or old schemas rejected.
- Regression proof command: `npm test`
- Failure this catches: lost user configuration, unsafe state hydration, schema incompatibility, and unbounded state growth.

- [ ] Add failing state tests for v1/v2 migration, valid profile round-trip, invalid key/value removal, history truncation to 12, and prototype-pollution rejection.
- [ ] Run `node --test test/state.test.mjs tests/core.test.mjs`; verify schema-v3 assertions fail against v2.
- [ ] Add `adaptiveProfiles` to the default/normalized state and declarations, delegating profile normalization to `adaptive.mjs` without introducing filesystem dependencies there.
- [ ] Run the focused state tests; expect all to pass.
- [ ] Run `npm test && npm run typecheck`; expect success.
- [ ] Commit with `git commit -am "feat: persist adaptive budget profiles"`.

### Task 3: Runtime feedback and dual-target compaction

**Files:**
- Modify: `index.ts`
- Modify: `test/harness.mjs`
- Modify: `test/integration.test.mjs`
- Modify: `test/followup.test.mjs`

**Acceptance Contract:**
- User-visible behavior: Auto request caps use learned cap targets, proactive compaction uses learned reservation targets, and only attributable successful main attempts/maxout compactions update learning.
- Wiring proof command: `node --experimental-strip-types --test test/integration.test.mjs test/followup.test.mjs`
- Expected output / observable behavior: a 32K cap with an 8K reservation does not compact when 12K remains; length stop raises the next cap; two successful maxout compactions downshift; fixed mode, failed patches, streamed errors, and failed/manual compactions do not learn.
- Test-quality proof: lifecycle tests drive real registered extension hooks through the harness and inspect patched payloads, state, compaction calls, and status.
- Regression proof command: `npm test && npm run typecheck`
- Failure this catches: misattributed learning, compaction driven by maximum ceiling, duplicate updates, fixed-mode mutation, retry regressions, and provider-ceiling violations.

- [ ] Add failing integration tests for cold targets, per-thinking/profile isolation, cap-versus-reservation compaction, attributable length growth, output-history reservation, two-compaction downshift, failed/manual compaction exclusion, fixed override bypass, unsupported patch bypass, reload persistence, and provider ceiling.
- [ ] Run the focused command and confirm failures identify missing adaptive wiring.
- [ ] Extend `currentAttempt` with patched cap/profile identity; resolve/decay profiles before sizing; use cap for `resolveRequestCap`; use reservation in `maybeCompactForHeadroom`.
- [ ] On `message_end`, classify explicit length stop reasons, read positive output usage, apply one attributable output transition, persist only changed state, and retain existing overflow-margin semantics.
- [ ] Count pressure only when maxout's own `ctx.compact` reaches `onComplete`; persist the compaction transition after success and never on error/manual/core compaction.
- [ ] Run focused lifecycle tests, then `npm test && npm run typecheck`; expect success.
- [ ] Commit with `git commit -am "feat: wire adaptive auto feedback"`.

### Task 4: User controls, status, and release proof

**Files:**
- Modify: `index.ts`
- Modify: `test/integration.test.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `install.sh`
- Modify: `verify.sh`

**Acceptance Contract:**
- User-visible behavior: `/maxout` displays learned cap/reservation and `/maxout learn reset` clears only learning; documentation describes adaptive auto accurately as v2.2.0.
- Wiring proof command: `npm run verify`
- Expected output / observable behavior: 0 test failures, clean TypeScript, installer artifact checks pass; focused command tests show learning fields before reset and cold targets afterward while other settings remain.
- Test-quality proof: command tests use the registered `/maxout` handler and persisted state rather than directly calling reset helpers.
- Regression proof command: `tmp=$(mktemp -d); PI_CODING_AGENT_DIR="$tmp" ./install.sh >/tmp/pi-maxout-install.log && test -f "$tmp/extensions/pi-maxout/adaptive.mjs"; rc=$?; rm -rf "$tmp"; exit $rc`
- Failure this catches: undiscoverable learning, destructive reset, missing installer artifacts, stale release metadata, and incomplete packaging.

- [ ] Add failing command/status tests for profile reporting and reset isolation.
- [ ] Run the focused integration test and verify expected failures.
- [ ] Implement `learn reset`, argument completion, and concise status/description fields.
- [ ] Update installer/verification artifact lists to include `adaptive.mjs` and `adaptive.d.mts`.
- [ ] Update README, changelog, runtime/package versions to 2.2.0 and synchronize the lockfile.
- [ ] Run `npm run verify`, isolated install proof, `git diff --check`, and `git status --short`.
- [ ] Commit with `git commit -am "feat: release adaptive auto mode v2.2.0"` after adding any new files.

### Task 5: Final audit and live smoke

**Files:**
- Review all changed files; modify only through a focused repair commit if a reproduced defect exists.

**Acceptance Contract:**
- User-visible behavior: The released extension loads in Pi and adaptive auto preserves all hard safety and lifecycle invariants.
- Wiring proof command: `npm run verify && timeout 120 pi -p "Reply with exactly: ADAPTIVE-MAXOUT-OK"`
- Expected output / observable behavior: verification succeeds and Pi prints `ADAPTIVE-MAXOUT-OK` without extension-load errors.
- Test-quality proof: final reviewer maps every design requirement to tests and identifies residual risks; parent independently inspects diffs and command output.
- Regression proof command: `git diff 999e848..HEAD --check && git status --short`
- Failure this catches: integration omissions, release drift, syntax/load errors, unreviewed changes, and dirty artifacts.

- [ ] Dispatch read-only spec and quality reviews against the complete branch.
- [ ] Route confirmed findings to one focused writer, require regression-first repair, and re-review.
- [ ] Independently run full verification and inspect the final diff.
- [ ] Install only after all gates pass, verify installed files byte-for-byte, run the live Pi smoke, and push only with explicit existing user authorization.
