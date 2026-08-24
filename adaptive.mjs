/**
 * pi-maxout adaptive auto controller.
 *
 * Pure, dependency-free reducer functions that learn per-model output-budget
 * targets for dynamic auto mode. Everything here is deterministic and free of
 * filesystem/clock dependencies — callers feed `nowMs` in so behavior is
 * unit-testable and lazy (no timers).
 *
 * Two numbers are learned separately per `provider:model:thinkingLevel`:
 *   capTarget         — the completion ceiling patched into provider requests
 *   reservationTarget — the completion room worth compacting history to create
 *
 * All learned values live on a discrete decimal-token ladder so targets move
 * in visible, stable steps instead of oscillating token-by-token.
 */

export const ADAPTIVE_LADDER = Object.freeze([8000, 12000, 16000, 24000, 32000, 40000, 48000, 56000]);

/** Cold-start cap/reservation target per thinking level. */
const COLD_START_TARGETS = Object.freeze({
  off: 8000,
  minimal: 8000,
  low: 8000,
  medium: 8000,
  high: 16000,
  xhigh: 32000,
  max: 32000,
});

/** Default maximum learned targets per thinking level (custom table may raise/lower). */
const DEFAULT_LEVEL_CEILINGS = Object.freeze({
  off: 16000,
  minimal: 16000,
  low: 16000,
  medium: 16000,
  high: 32000,
  xhigh: 56000,
  max: 56000,
});

/** Keep at most the latest N positive output-token observations. */
export const MAX_OUTPUT_SAMPLES = 12;
/** Successful maxout compactions required inside the pressure window to downshift. */
export const COMPACTION_PRESSURE_THRESHOLD = 2;
/** Main responses observed while pressure is open before it expires. */
export const COMPACTION_WINDOW_RESPONSES = 8;
/** Move one rung toward cold start per complete period of this length. */
export const DECAY_PERIOD_DAYS = 14;
/** Profiles untouched longer than this many days may be dropped entirely. */
export const PROFILE_EXPIRY_DAYS = 90;
/** Reservation rises only when recent p90 output justifies it: rung(p90 * this). */
export const RESERVATION_P90_FACTOR = 1.25;

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function safeNonNegativeInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function ladderIndexAtOrBelow(value) {
  let index = 0;
  for (let i = 0; i < ADAPTIVE_LADDER.length; i++) {
    if (ADAPTIVE_LADDER[i] <= value) index = i;
    else break;
  }
  return index;
}

function nearestRungAtOrAbove(value) {
  for (const rung of ADAPTIVE_LADDER) {
    if (rung >= value) return rung;
  }
  return ADAPTIVE_LADDER[ADAPTIVE_LADDER.length - 1];
}

function nextRungAbove(value) {
  const index = ADAPTIVE_LADDER.indexOf(value);
  if (index === -1) return nearestRungAtOrAbove(value);
  return ADAPTIVE_LADDER[Math.min(index + 1, ADAPTIVE_LADDER.length - 1)];
}

function prevRungBelow(value) {
  const index = ADAPTIVE_LADDER.indexOf(value);
  if (index <= 0) return ADAPTIVE_LADDER[0];
  return ADAPTIVE_LADDER[index - 1];
}

// ---------------------------------------------------------------------------
// Profile identity & bounds
// ---------------------------------------------------------------------------

/** Stable profile identity: learning is scoped per model AND thinking level. */
export function profileKey(modelKeyString, thinkingLevel) {
  const base = typeof modelKeyString === "string" ? modelKeyString.trim() : "";
  const level = typeof thinkingLevel === "string" && thinkingLevel ? thinkingLevel : "off";
  return `${base}:${level}`;
}

/** Conservative starting point for a thinking level. Unknown levels get the safest rung. */
export function coldStartTarget(thinkingLevel) {
  const level = typeof thinkingLevel === "string" ? thinkingLevel : "off";
  return COLD_START_TARGETS[level] ?? COLD_START_TARGETS.off;
}

/**
 * Upper bound for learned targets of a thinking level:
 * configured thinking-level target first, then what the model advertises.
 */
export function resolveProfileCeiling(thinkingLevel, customTargets, modelMaxTokens) {
  const level = typeof thinkingLevel === "string" ? thinkingLevel : "off";
  let ceiling = DEFAULT_LEVEL_CEILINGS[level] ?? DEFAULT_LEVEL_CEILINGS.off;
  if (isRecord(customTargets)) {
    const custom = safePositiveInt(customTargets[level]);
    if (custom !== null && Object.hasOwn(DEFAULT_LEVEL_CEILINGS, level)) ceiling = custom;
  }
  const declared = safePositiveInt(modelMaxTokens);
  if (declared !== null && declared < ceiling) ceiling = declared;
  // Learned targets never leave the ladder.
  return ADAPTIVE_LADDER[ladderIndexAtOrBelow(ceiling)];
}

// ---------------------------------------------------------------------------
// Normalization (also used by state hydration)
// ---------------------------------------------------------------------------

function sanitizeBounds(level, storedFloor, storedCeiling, options) {
  const computedFloor = coldStartTarget(level);
  const computedCeiling =
    options && (options.customTargets !== undefined || options.modelMaxTokens !== undefined)
      ? resolveProfileCeiling(level, options.customTargets, options.modelMaxTokens)
      : null;
  const storedFloorRung = safePositiveInt(storedFloor) !== null ? storedFloor : null;
  const storedCeilingRung = safePositiveInt(storedCeiling) !== null ? storedCeiling : null;

  let floor = computedFloor;
  let ceiling = null;
  // Without fresh runtime context, stored ladder-aligned bounds are trusted
  // (they may encode user-customized ceilings); otherwise recompute defaults.
  if (
    computedCeiling === null &&
    storedFloorRung !== null &&
    storedCeilingRung !== null &&
    ADAPTIVE_LADDER.includes(storedFloorRung) &&
    ADAPTIVE_LADDER.includes(storedCeilingRung) &&
    storedFloorRung <= storedCeilingRung
  ) {
    floor = storedFloorRung;
    ceiling = storedCeilingRung;
  } else {
    ceiling = computedCeiling ?? ADAPTIVE_LADDER[ladderIndexAtOrBelow(DEFAULT_LEVEL_CEILINGS[level] ?? DEFAULT_LEVEL_CEILINGS.off)];
    floor = Math.min(computedFloor, ceiling);
  }
  if (floor > ceiling) floor = ceiling;
  return { floor, ceiling };
}

function snapDownToLadder(value, bounds) {
  const v = safePositiveInt(value);
  if (v === null) return null;
  const snapped = ADAPTIVE_LADDER[ladderIndexAtOrBelow(v)];
  return Math.min(snapped, bounds.ceiling);
}

/**
 * Validate/repair a persisted or in-memory profile.
 *
 * Corrupt, prototype-polluted, oversized, or future-dated data degrades to
 * cold-start behavior without ever throwing. Output shape:
 *   {
 *     capTarget, reservationTarget,        // ladder-aligned learned targets
 *     capFloor, capCeiling,                // ladder-aligned transition bounds
 *     outputs: number[],                   // latest positive samples, <= 12
 *     pressureCount, windowResponses,      // compaction-pressure window
 *     windowTruncations,
 *     seq,                                 // monotonic observation sequence
 *     updatedAt                            // epoch ms of the last update
 *   }
 */
export function normalizeAdaptiveProfile(value, options = {}) {
  const src = isRecord(value) ? value : {};
  const level = typeof options.level === "string" && options.level ? options.level : "off";
  const { floor, ceiling } = sanitizeBounds(
    level,
    src.capFloor,
    src.capCeiling,
    "modelMaxTokens" in options || "customTargets" in options ? options : {},
  );

  const rawOutputs = Array.isArray(src.outputs) ? src.outputs.slice(-MAX_OUTPUT_SAMPLES) : [];
  const outputs = [];
  for (const sample of rawOutputs) {
    const n = Number(sample);
    if (Number.isSafeInteger(n) && n > 0) outputs.push(n);
  }

  const storedCap = snapDownToLadder(src.capTarget, { ceiling });
  const storedReservation = (() => {
    const v = safePositiveInt(src.reservationTarget);
    if (v === null) return null;
    return Math.min(nearestRungAtOrAbove(v), ceiling);
  })();

  const updatedAtRaw = Number(src.updatedAt);
  const updatedAt =
    Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : undefined;

  return {
    capTarget: storedCap ?? floor,
    reservationTarget: storedReservation ?? floor,
    capFloor: floor,
    capCeiling: ceiling,
    outputs,
    pressureCount: safeNonNegativeInt(src.pressureCount) ?? 0,
    windowResponses: safeNonNegativeInt(src.windowResponses) ?? 0,
    windowTruncations: safeNonNegativeInt(src.windowTruncations) ?? 0,
    seq: safeNonNegativeInt(src.seq) ?? 0,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function p90(sortedSamples) {
  const n = sortedSamples.length;
  if (n === 0) return null;
  const index = Math.min(n - 1, Math.ceil(0.9 * n) - 1);
  return sortedSamples[index];
}

/**
 * Observation of an attributable main-response outcome.
 *
 * - explicit length stop → both targets rise exactly one rung (ceiling-bounded)
 * - successful non-truncated output with usage → history grows and the
 *   reservation may rise to rung(1.25 × p90), never above the cap; short
 *   answers never lower anything
 * - missing/unusable evidence → unchanged profile (same reference)
 */
export function observeAdaptiveOutput(profile, observation = {}) {
  const current = normalizeAdaptiveProfile(profile);
  const truncated = observation.truncated === true;
  const outputTokens = safePositiveInt(observation.outputTokens);
  if (!truncated && outputTokens === null) return current;
  const nowMs = safePositiveInt(observation.nowMs);

  const next = { ...current };
  next.seq = current.seq + 1;
  if (nowMs !== null) next.updatedAt = nowMs;

  // Compaction-pressure window bookkeeping: responses observed while a window
  // is open age it; eight responses without a second compaction expire it.
  if (next.pressureCount > 0) {
    next.windowResponses += 1;
    if (truncated) next.windowTruncations += 1;
    if (next.windowResponses >= COMPACTION_WINDOW_RESPONSES) {
      next.pressureCount = 0;
      next.windowResponses = 0;
      next.windowTruncations = 0;
    }
  }

  if (truncated) {
    next.capTarget = Math.min(nextRungAbove(current.capTarget), current.capCeiling);
    next.capTarget = Math.max(next.capTarget, current.capFloor);
    next.reservationTarget = Math.min(
      Math.max(nextRungAbove(current.reservationTarget), current.capFloor),
      next.capTarget,
    );
    return next;
  }

  // Positive usage on a non-truncated response feeds reservation learning.
  const outputs = [...current.outputs, outputTokens].slice(-MAX_OUTPUT_SAMPLES);
  next.outputs = outputs;
  const observed = p90([...outputs].sort((a, b) => a - b));
  if (observed !== null) {
    const desired = nearestRungAtOrAbove(observed * RESERVATION_P90_FACTOR);
    // Rise-only within an un-decayed window; bounded by the cap target.
    next.reservationTarget = Math.min(Math.max(current.reservationTarget, desired), current.capTarget);
  }
  return next;
}

/**
 * Observation that a MAXOUT-INITIATED compaction completed successfully.
 *
 * Two such compactions inside one window (≤ 8 observed main responses, no
 * truncation since the previous compaction) downshift both targets one rung,
 * never below the cold-start floor. The window clears after a downshift.
 */
export function observeAdaptiveCompaction(profile, observation = {}) {
  const current = normalizeAdaptiveProfile(profile);
  const nowMs = safePositiveInt(observation?.nowMs);

  const next = { ...current };
  next.seq = current.seq + 1;
  if (nowMs !== null) next.updatedAt = nowMs;

  if (current.pressureCount === 0) {
    // Fresh window: nothing can downshift on the first compaction.
    next.pressureCount = 1;
    next.windowResponses = 0;
    next.windowTruncations = 0;
    return next;
  }

  if (current.windowResponses >= COMPACTION_WINDOW_RESPONSES) {
    // Stale window expired between events: start over.
    next.pressureCount = 1;
    next.windowResponses = 0;
    next.windowTruncations = 0;
    return next;
  }

  next.pressureCount = current.pressureCount + 1;
  if (next.pressureCount >= COMPACTION_PRESSURE_THRESHOLD && current.windowTruncations === 0) {
    next.capTarget = Math.max(prevRungBelow(current.capTarget), current.capFloor);
    next.reservationTarget = Math.min(
      Math.max(prevRungBelow(current.reservationTarget), current.capFloor),
      next.capTarget,
    );
    next.pressureCount = 0;
    next.windowResponses = 0;
    next.windowTruncations = 0;
  }
  return next;
}

/**
 * Lazy, deterministic decay applied when a profile is used after time away.
 *
 * One rung toward cold start per complete 14-day period since the last
 * update; stale samples and pressure clear once decay applies. Returns `null`
 * when the profile is older than 90 days (caller may drop it) and the same
 * reference when no complete period has elapsed.
 */
export function decayAdaptiveProfile(profile, nowMs) {
  const current = normalizeAdaptiveProfile(profile);
  const now = safePositiveInt(nowMs) ?? Date.now();
  if (current.updatedAt === undefined) return current;

  // A future-dated timestamp is treated as "just updated": clamp instead of
  // producing negative ages, so hostile state can only ever delay decay.
  const reference = Math.min(current.updatedAt, now);
  const ageDays = Math.floor((now - reference) / DAY_MS);
  if (ageDays < DECAY_PERIOD_DAYS) return current;
  if (ageDays >= PROFILE_EXPIRY_DAYS) return null;

  const periods = Math.floor(ageDays / DECAY_PERIOD_DAYS);
  let capIndex = ADAPTIVE_LADDER.indexOf(current.capTarget);
  let resIndex = ADAPTIVE_LADDER.indexOf(current.reservationTarget);
  if (capIndex === -1) capIndex = ladderIndexAtOrBelow(current.capTarget);
  if (resIndex === -1) resIndex = ladderIndexAtOrBelow(current.reservationTarget);

  const floorIndex = ADAPTIVE_LADDER.indexOf(current.capFloor);
  const nextCapIndex = Math.max(capIndex - periods, floorIndex === -1 ? capIndex : floorIndex);
  const nextResIndex = Math.max(resIndex - periods, floorIndex === -1 ? resIndex : floorIndex);

  return {
    ...current,
    capTarget: ADAPTIVE_LADDER[Math.max(nextCapIndex, 0)],
    reservationTarget: Math.min(ADAPTIVE_LADDER[Math.max(nextResIndex, 0)], ADAPTIVE_LADDER[Math.max(nextCapIndex, 0)]),
    outputs: [],
    pressureCount: 0,
    windowResponses: 0,
    windowTruncations: 0,
    updatedAt: now,
  };
}
