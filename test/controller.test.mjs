/**
 * Pure adaptive controller tests (schema + transitions, no I/O).
 * Every assertion targets an exported production reducer so removing any
 * transition produces a named failure here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTIVE_LADDER,
  coldStartTarget,
  decayAdaptiveProfile,
  normalizeAdaptiveProfile,
  observeAdaptiveCompaction,
  observeAdaptiveOutput,
  profileKey,
  resolveProfileCeiling,
} from "../adaptive.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

test("ladder is the documented decimal rung set", () => {
  assert.deepEqual([...ADAPTIVE_LADDER], [8000, 12000, 16000, 24000, 32000, 40000, 48000, 56000]);
});

test("profileKey is provider:model:thinkingLevel scoped", () => {
  assert.equal(profileKey("llama.cpp:gpt-oss", "high"), "llama.cpp:gpt-oss:high");
});

test("cold-start targets are conservative per thinking level", () => {
  for (const level of ["off", "minimal", "low", "medium"]) assert.equal(coldStartTarget(level), 8000);
  assert.equal(coldStartTarget("high"), 16000);
  assert.equal(coldStartTarget("xhigh"), 32000);
  assert.equal(coldStartTarget("max"), 32000);
  assert.equal(coldStartTarget("mystery"), 8000, "unknown levels fall back to the safest rung");
});

test("profile ceiling honors configured targets then model.maxTokens", () => {
  assert.equal(resolveProfileCeiling("low", {}, undefined), 16000);
  assert.equal(resolveProfileCeiling("high", {}, undefined), 32000);
  assert.equal(resolveProfileCeiling("xhigh", {}, undefined), 56000);
  assert.equal(resolveProfileCeiling("xhigh", { xhigh: 40000 }, undefined), 40000);
  assert.equal(resolveProfileCeiling("low", {}, 12000), 12000);
  assert.equal(resolveProfileCeiling("xhigh", { xhigh: 60000 }, 48000), 48000);
  // junk inputs are ignored rather than trusted
  assert.equal(resolveProfileCeiling("high", null, -5), 32000);
});

test("normalizeAdaptiveProfile starts at cold start and sanitizes junk", () => {
  const p = normalizeAdaptiveProfile(undefined, { level: "high" });
  assert.equal(p.capTarget, 16000);
  assert.equal(p.reservationTarget, 16000);
  assert.deepEqual(p.outputs, []);
  assert.equal(p.pressureCount, 0);

  const corrupt = normalizeAdaptiveProfile(
    {
      capTarget: "huge",
      reservationTarget: -1,
      outputs: [100, "x", -4, 0.5],
      pressureCount: Number.MAX_SAFE_INTEGER + 1,
      seq: "nope",
      updatedAt: "yesterday",
    },
    { level: "low" },
  );
  assert.equal(corrupt.capTarget, 8000);
  assert.equal(corrupt.reservationTarget, 8000);
  assert.deepEqual(corrupt.outputs, [100], "non-integer/non-positive samples are dropped");
});

test("normalizeAdaptiveProfile clamps learned values to ladder and ceiling", () => {
  const p = normalizeAdaptiveProfile(
    { capTarget: 999999, reservationTarget: 9000 },
    { level: "low", modelMaxTokens: 20000 },
  );
  assert.ok(ADAPTIVE_LADDER.includes(p.reservationTarget));
  assert.equal(p.reservationTarget, 12000); // <= modelMaxTokens 20000
  assert.equal(p.capTarget, 16000); // clamped to the low-level ceiling
  assert.ok(!ADAPTIVE_LADDER.includes(999999));

  // history is bounded to the latest 12 samples
  const many = normalizeAdaptiveProfile({ outputs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] }, { level: "low" });
  assert.deepEqual(many.outputs, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test("attributable length stop raises both cap and reservation exactly one rung", () => {
  let p = normalizeAdaptiveProfile(undefined, { level: "low" });
  p = observeAdaptiveOutput(p, { truncated: true, nowMs: NOW });
  assert.equal(p.capTarget, 12000);
  assert.equal(p.reservationTarget, 12000);
  p = observeAdaptiveOutput(p, { truncated: true, nowMs: NOW + 1 });
  assert.equal(p.capTarget, 16000);
});

test("length growth stops at the profile ceiling", () => {
  let p = normalizeAdaptiveProfile(undefined, { level: "low", modelMaxTokens: 17000 });
  for (let i = 0; i < 10; i++) p = observeAdaptiveOutput(p, { truncated: true, nowMs: NOW + i });
  assert.equal(p.capTarget, 16000, "never above the configured low-level target");
});

test("successful output grows only the reservation from recent p90 (+25%)", () => {
  // Learned state where the cap rose earlier but the reservation lagged behind.
  let p = normalizeAdaptiveProfile({ capTarget: 16000, reservationTarget: 8000 }, { level: "low" });
  // ten ~6K answers: p90 = 6000 -> 7500 -> nearest rung >= that is 8000
  for (let i = 0; i < 12; i++) {
    p = observeAdaptiveOutput(p, { outputTokens: 6000, nowMs: NOW + i });
  }
  assert.equal(p.capTarget, 16000, "ordinary short answers never raise the cap");
  assert.deepEqual(p.outputs.length, 12, "history stays bounded");
  assert.equal(p.reservationTarget, 8000);

  // push p90 above a rung boundary: two 7000 samples lift p90 -> 7000,
  // 7000 * 1.25 = 8750 -> nearest rung at or above is 12000
  p = observeAdaptiveOutput(p, { outputTokens: 7000, nowMs: NOW + 20 });
  p = observeAdaptiveOutput(p, { outputTokens: 7000, nowMs: NOW + 21 });
  assert.equal(p.reservationTarget, 12000);
});

test("reservation never exceeds the cap target", () => {
  let p = normalizeAdaptiveProfile({ capTarget: 8000 }, { level: "low" });
  for (let i = 0; i < 12; i++) {
    p = observeAdaptiveOutput(p, { outputTokens: 8000, nowMs: NOW + i }); // wants 12000
  }
  assert.ok(p.reservationTarget <= p.capTarget, `reservation ${p.reservationTarget} must not exceed cap ${p.capTarget}`);
});

test("missing usage with no truncation changes nothing upward and keeps history", () => {
  const before = normalizeAdaptiveProfile(undefined, { level: "high" });
  const after = observeAdaptiveOutput(before, { outputTokens: null, nowMs: NOW });
  assert.deepEqual(after, before);
});

test("two maxout compactions within eight responses downshift one rung", () => {
  let p = normalizeAdaptiveProfile({ capTarget: 16000, reservationTarget: 16000 }, { level: "low" });
  // eight observed main responses keep the window open
  for (let i = 0; i < 8; i++) p = observeAdaptiveOutput(p, { outputTokens: 500, nowMs: NOW + i });
  p = observeAdaptiveCompaction(p, { nowMs: NOW + 9 });
  assert.equal(p.pressureCount, 1);
  assert.equal(p.capTarget, 16000, "one compaction alone never downshifts");

  p = observeAdaptiveCompaction(p, { nowMs: NOW + 10 });
  assert.equal(p.capTarget, 12000);
  assert.equal(p.reservationTarget, 12000);
  assert.equal(p.pressureCount, 0, "pressure window clears after a downshift");
});

test("compaction pressure expires after eight observed main responses", () => {
  let p = normalizeAdaptiveProfile({ capTarget: 16000, reservationTarget: 16000 }, { level: "low" });
  p = observeAdaptiveCompaction(p, { nowMs: NOW });
  for (let i = 0; i < 8; i++) p = observeAdaptiveOutput(p, { outputTokens: 500, nowMs: NOW + 1 + i });
  p = observeAdaptiveCompaction(p, { nowMs: NOW + 99 });
  assert.equal(p.capTarget, 16000, "stale pressure must not downshift");
  // The stale window expired, so this compaction opens a fresh one.
  assert.equal(p.pressureCount, 1);
});

test("truncation in the window blocks the compaction downshift", () => {
  let p = normalizeAdaptiveProfile({ capTarget: 12000, reservationTarget: 12000 }, { level: "low" });
  p = observeAdaptiveCompaction(p, { nowMs: NOW });
  // the truncation itself legitimately raises one rung...
  p = observeAdaptiveOutput(p, { truncated: true, nowMs: NOW + 1 });
  assert.equal(p.capTarget, 16000);
  // ...but its presence in the window must block the second-compaction downshift
  p = observeAdaptiveCompaction(p, { nowMs: NOW + 2 });
  assert.equal(p.capTarget, 16000, "recent truncation means more room was genuinely needed");
  assert.equal(p.pressureCount, 2, "blocked pressure stays pending inside its window");
});

test("downshift never goes below the cold-start floor", () => {
  // already at the floor: pressure alone must not dig underneath it
  let p = normalizeAdaptiveProfile(undefined, { level: "low" }); // 8000/8000
  p = observeAdaptiveCompaction(p, { nowMs: NOW });
  p = observeAdaptiveCompaction(p, { nowMs: NOW + 1 });
  assert.equal(p.capTarget, 8000);
  assert.equal(p.reservationTarget, 8000);

  // one rung above the floor lands exactly on it
  let q = normalizeAdaptiveProfile({ capTarget: 12000, reservationTarget: 12000 }, { level: "low" });
  q = observeAdaptiveCompaction(q, { nowMs: NOW });
  q = observeAdaptiveCompaction(q, { nowMs: NOW + 1 });
  assert.equal(q.capTarget, 8000);
  assert.equal(q.reservationTarget, 8000);
});

test("decay moves targets one rung toward cold start per complete 14 days", () => {
  let p = normalizeAdaptiveProfile(
    { capTarget: 56000, reservationTarget: 56000, updatedAt: NOW - 14 * DAY },
    { level: "xhigh" },
  );
  p = decayAdaptiveProfile(p, NOW);
  assert.equal(p.capTarget, 48000);
  assert.equal(p.reservationTarget, 48000);

  const untouched = decayAdaptiveProfile(normalizeAdaptiveProfile(undefined, { level: "low" }), NOW);
  assert.equal(untouched.updatedAt, undefined, "no partial-period decay, no timestamp churn");
});

test("decay clears stale samples and pressure once applied", () => {
  let p = normalizeAdaptiveProfile(
    { capTarget: 16000, reservationTarget: 16000, outputs: [400, 500], pressureCount: 1, updatedAt: NOW - 28 * DAY },
    { level: "low" },
  );
  p = decayAdaptiveProfile(p, NOW);
  assert.deepEqual(p.outputs, []);
  assert.equal(p.pressureCount, 0);
  assert.equal(p.capTarget, 8000); // two periods of decay reach the floor
});

test("profiles older than 90 days may be dropped", () => {
  const stale = normalizeAdaptiveProfile({ capTarget: 16000, updatedAt: NOW - 91 * DAY }, { level: "low" });
  assert.equal(decayAdaptiveProfile(stale, NOW), null);
  const fresh = normalizeAdaptiveProfile({ capTarget: 16000, updatedAt: NOW - 89 * DAY }, { level: "low" });
  assert.notEqual(decayAdaptiveProfile(fresh, NOW), null);
});

test("randomized observations always land on ladder rungs within bounds", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let p = normalizeAdaptiveProfile(undefined, { level: "xhigh", modelMaxTokens: 45000 });
  const ceiling = resolveProfileCeiling("xhigh", {}, 45000);
  const floor = coldStartTarget("xhigh");
  for (let i = 0; i < 500; i++) {
    if (rand() < 0.5) {
      p = observeAdaptiveOutput(p, {
        outputTokens: rand() < 0.2 ? Math.floor(rand() * 60000) : Math.floor(rand() * 3000),
        truncated: rand() < 0.15,
        nowMs: NOW + i,
      });
    } else {
      p = observeAdaptiveCompaction(p, { nowMs: NOW + i });
    }
    assert.ok(ADAPTIVE_LADDER.includes(p.capTarget), `cap ${p.capTarget} off-ladder at step ${i}`);
    assert.ok(ADAPTIVE_LADDER.includes(p.reservationTarget), `reservation ${p.reservationTarget} off-ladder at step ${i}`);
    assert.ok(p.capTarget <= ceiling && p.capTarget >= floor, `cap out of bounds (${p.capTarget})`);
    assert.ok(p.reservationTarget >= floor, `reservation below floor (${p.reservationTarget})`);
    assert.ok(p.outputs.length <= 12, "history never exceeds twelve samples");
  }
});
