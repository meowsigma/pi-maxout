/**
 * Public types for the pure adaptive auto controller (adaptive.mjs).
 */

/** Discrete decimal-token ladder every learned target must land on. */
export const ADAPTIVE_LADDER: readonly number[];

export const MAX_OUTPUT_SAMPLES: number;
export const COMPACTION_PRESSURE_THRESHOLD: number;
export const COMPACTION_WINDOW_RESPONSES: number;
export const DECAY_PERIOD_DAYS: number;
export const PROFILE_EXPIRY_DAYS: number;
export const RESERVATION_P90_FACTOR: number;

/** A validated, learned auto-budget profile for one model+thinking level. */
export type AdaptiveProfile = {
  /** Completion ceiling patched into provider requests (ladder-aligned). */
  capTarget: number;
  /** Completion room worth compacting history for (ladder-aligned, <= capTarget). */
  reservationTarget: number;
  /** Ladder-aligned lower bound for transitions (cold start of the level). */
  capFloor: number;
  /** Ladder-aligned upper bound for transitions (configured/provider ceiling). */
  capCeiling: number;
  /** Latest positive output-token samples, oldest first, at most 12 entries. */
  outputs: number[];
  /** Successful maxout compactions observed in the open pressure window. */
  pressureCount: number;
  /** Main responses observed while the pressure window is open. */
  windowResponses: number;
  /** Explicit length stops observed while the pressure window is open. */
  windowTruncations: number;
  /** Monotonic observation counter (diagnostics). */
  seq: number;
  /** Epoch ms of the last update; absent until first observation. */
  updatedAt?: number;
};

export type NormalizeAdaptiveProfileOptions = {
  level?: string | null;
  customTargets?: Record<string, unknown> | null;
  modelMaxTokens?: unknown;
};

export function profileKey(modelKeyString: string | null | undefined, thinkingLevel: string | null | undefined): string;

export function coldStartTarget(thinkingLevel: string | null | undefined): number;

export function resolveProfileCeiling(
  thinkingLevel: string | null | undefined,
  customTargets?: Record<string, unknown> | null,
  modelMaxTokens?: unknown,
): number;

export function normalizeAdaptiveProfile(
  value: unknown,
  options?: NormalizeAdaptiveProfileOptions,
): AdaptiveProfile;

export function observeAdaptiveOutput(
  profile: AdaptiveProfile,
  observation: {
    outputTokens?: number | null;
    truncated?: boolean;
    nowMs?: number | null;
  },
): AdaptiveProfile;

export function observeAdaptiveCompaction(
  profile: AdaptiveProfile,
  observation?: { nowMs?: number | null },
): AdaptiveProfile;

/** Returns the same reference when no complete period elapsed, or null once expired. */
export function decayAdaptiveProfile(profile: AdaptiveProfile, nowMs?: number): AdaptiveProfile | null;
