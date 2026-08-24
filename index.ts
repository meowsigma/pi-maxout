/**
 * pi-maxout v2.2.0
 *
 * Provider-aware dynamic output-budget control for Pi.
 *
 * In dynamic auto mode every provider request gets:
 *
 *   safe_max_output = context_limit - conservative_input_estimate - safety_margin
 *   max_tokens      = min(thinking_level_target, safe_max_output)   [>= 1, never negative]
 *
 * Guarantees:
 *   input + requested <= context_limit for every patched request (fixed user
 *   overrides included), so the local vLLM 131072-token rejection class cannot
 *   happen again. Targets: normal 16K, high 32K, xhigh 56K (clamped to what
 *   actually fits — xhigh reasoning may legitimately use ~50K).
 *
 * Overflow handling: a pre-stream 400/413 (or an assistant-level context-
 * overflow error) doubles a per-model margin boost so Pi's built-in single
 * compact-and-retry re-runs with a larger margin. Nothing is ever re-sent by
 * this extension itself; no retry happens after streaming started.
 */

import fs from "node:fs";
import path from "node:path";

import { isContextOverflow } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  formatTokens,
  modelKey,
  normalizeState,
  parseTokenSpec,
  patchMaxTokensPayload,
  patchThinkingBudgetPayload,
} from "./core.mjs";
import {
  decayAdaptiveProfile,
  normalizeAdaptiveProfile,
  observeAdaptiveCompaction,
  observeAdaptiveOutput,
  profileKey,
} from "./adaptive.mjs";
import type { AdaptiveProfile } from "./adaptive.mjs";
import {
  MAX_MARGIN_BOOST_TOKENS,
  MIN_MARGIN_TOKENS,
  combineInputEstimates,
  estimatePayloadInputTokens,
  effectiveMargin,
  formatK,
  nextMarginBoost,
  resolveContextLimit,
  resolveRequestCap,
  resolveTargetTokens,
  shouldSkipPayload,
  statusLine,
} from "./auto.mjs";

const VERSION = "2.2.0";
const STATUS_KEY = "pi-maxout";

/** Resolved lazily so test harnesses and /reload cycles pick up the right dir. */
function statePath(): string {
  return path.join(getAgentDir(), "pi-maxout.json");
}

/** Minimum gap between proactive compaction attempts per model. */
const COMPACTION_COOLDOWN_MS = 5 * 60 * 1000;

type StateShape = ReturnType<typeof normalizeState>;

const sessionOverrides = new Map<string, number>();
const lastPatch = new Map<
  string,
  { cap: number; field: string | null; reason?: string; clamped?: boolean; degraded?: boolean }
>();
const lastInputEstimate = new Map<string, number>();
const marginBoosts = new Map<string, number>();
const lastCompactionAttempt = new Map<string, number>();
let compacting = false;
/** Prevent sizing Pi's own compaction-summary provider request. */
let providerSizingSuspended = false;
type SizedAttempt = {
  key: string;
  learned: boolean;
  streamStarted: boolean;
  /** Set only for successfully patched AUTO requests; fixed overrides never learn. */
  adaptive?: { profileId: string };
};
/** The main request currently awaiting/consuming a provider response. */
let currentAttempt: SizedAttempt | null = null;

type StateRead = {
  state: StateShape;
  error?: string;
};

function readState(): StateRead {
  const stateFile = statePath();
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    return { state: normalizeState(JSON.parse(raw)) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { state: normalizeState(undefined) };
    return {
      state: normalizeState(undefined),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeState(state: StateShape): string | undefined {
  const stateFile = statePath();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const current = readState();
  let backupPath: string | undefined;
  if (current.error && fs.existsSync(stateFile)) {
    backupPath = `${stateFile}.invalid-${timestampForFilename()}`;
    fs.copyFileSync(stateFile, backupPath);
  }

  const tempPath = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tempPath, stateFile);
    try {
      fs.chmodSync(stateFile, 0o600);
    } catch {
      // Some non-POSIX filesystems do not support chmod; the atomic write still succeeded.
    }
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  return backupPath;
}

function effectiveOverride(key: string | null, state: StateShape): number | null {
  if (!key) return null;
  const sessionValue = sessionOverrides.get(key);
  if (Number.isSafeInteger(sessionValue) && (sessionValue ?? 0) > 0) {
    return sessionValue ?? null;
  }
  const savedValue = state.defaults[key];
  if (Number.isSafeInteger(savedValue) && savedValue > 0) {
    return savedValue;
  }
  return null;
}

function desiredOutputTarget(
  model: ExtensionContext["model"],
  key: string,
  state: StateShape,
  thinkingLevel: ExtensionContext["thinkingLevel"],
): number {
  const override = effectiveOverride(key, state);
  if (override) return override;
  const target = resolveTargetTokens(thinkingLevel, state.targets);
  const declared = Number(model?.maxTokens);
  return Number.isSafeInteger(declared) && declared > 0 ? Math.min(target, declared) : target;
}

// ---------------------------------------------------------------------------
// Adaptive auto learning (schema v3 profiles)
// ---------------------------------------------------------------------------

type LoadedAdaptive = {
  id: string;
  profile: AdaptiveProfile;
};

/**
 * Resolve (and lazily decay) the active auto profile for this model+level.
 * Returns null outside dynamic auto mode — fixed overrides never participate.
 * Callers persist via persistAdaptiveProfile only when something changed.
 */
function loadAdaptiveProfile(
  key: string,
  state: StateShape,
  thinkingLevel: string | null | undefined,
): LoadedAdaptive | null {
  if (!state.auto || effectiveOverride(key, state)) return null;
  const id = profileKey(key, thinkingLevel);
  const stored = state.adaptiveProfiles[id];
  let profile = normalizeAdaptiveProfile(stored, { level: thinkingLevel });
  const decayed = decayAdaptiveProfile(profile, Date.now());
  if (decayed === null) {
    // Profiles older than 90 days are dropped entirely (cold-start restart).
    profile = normalizeAdaptiveProfile(undefined, { level: thinkingLevel });
  } else if (decayed !== profile) {
    profile = decayed;
  }
  return { id, profile };
}

function sameProfile(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Persist the profile atomically, but only when its content actually changed. */
function persistAdaptiveProfile(state: StateShape, loaded: LoadedAdaptive): void {
  persistObservedProfile(state, loaded.id, state.adaptiveProfiles[loaded.id], loaded.profile);
}

/** A profile with no observations yet carries no information — don't materialize it. */
function isEmptyLearning(profile: AdaptiveProfile): boolean {
  return (
    profile.seq === 0 &&
    profile.outputs.length === 0 &&
    profile.pressureCount === 0 &&
    profile.windowResponses === 0 &&
    profile.capTarget === profile.capFloor
  );
}

function persistObservedProfile(
  state: StateShape,
  id: string,
  previousStored: unknown,
  next: AdaptiveProfile,
): void {
  if (previousStored !== undefined && sameProfile(previousStored, next)) return;
  if (previousStored === undefined && isEmptyLearning(next)) return;
  writeState({ ...state, adaptiveProfiles: { ...state.adaptiveProfiles, [id]: next } });
}

/** Record downshift pressure after a SUCCESSFUL maxout-initiated compaction. */
function recordCompactionPressure(
  _ctx: ExtensionContext,
  key: string,
  thinkingLevel: string | null | undefined,
): void {
  try {
    const { state } = readState();
    if (!state.auto || effectiveOverride(key, state)) return; // fixed mode never learns
    const id = profileKey(key, thinkingLevel);
    const stored = state.adaptiveProfiles[id];
    const profile = normalizeAdaptiveProfile(stored, { level: thinkingLevel });
    const next = observeAdaptiveCompaction(profile, { nowMs: Date.now() });
    persistObservedProfile(state, id, stored, next);
  } catch {
    /* pressure bookkeeping must never break compaction cleanup */
  }
}

function notifyOnce(
  ctx: ExtensionContext,
  dedupeKey: string,
  message: string,
  severity: "info" | "warning" = "warning",
): void {
  const seen = notified.get(dedupeKey);
  if (seen === message) return;
  notified.set(dedupeKey, message);
  ctx.ui.notify(`pi-maxout: ${message}`, severity);
}
const notified = new Map<string, string>();

/** Drop every boost notification for a model — used when its boost resets. */
function clearBoostNotifications(key: string): void {
  const prefix = `boost:${key}:`;
  for (const dedupeKey of [...notified.keys()]) {
    if (dedupeKey.startsWith(prefix)) notified.delete(dedupeKey);
  }
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function refreshStatus(ctx: ExtensionContext): void {
  const model = ctx.model;
  const key = modelKey(model);
  if (!model || !key) {
    ctx.ui.setStatus(STATUS_KEY, "");
    return;
  }

  const { state } = readState();
  const overrideValue = effectiveOverride(key, state);
  const contextLimit = resolveContextLimit(model, state);
  const loadedAdaptive = overrideValue ? null : loadAdaptiveProfile(key, state, ctx.thinkingLevel);

  // Preview of what the next request would request (same math as the live path).
  let cap: number | null = null;
  const flags: string[] = [];
  if (!overrideValue && !state.auto) cap = null;

  const usage = ctx.getContextUsage();
  const inputEstimate = combineInputEstimates(usage?.tokens ?? null, lastInputEstimate.get(key) ?? null);

  if ((overrideValue || state.auto) && contextLimit && inputEstimate !== null) {
    const decision = resolveRequestCap({
      mode: overrideValue ? "override" : "auto",
      requestedOverride: overrideValue ?? undefined,
      contextLimit,
      inputTokens: inputEstimate,
      thinkingLevel: ctx.thinkingLevel,
      marginTokens: state.safetyMarginTokens,
      marginBoost: marginBoosts.get(key) ?? 0,
      customTargets: state.targets,
      modelMaxTokens: model.maxTokens,
      adaptiveTarget: loadedAdaptive?.profile.capTarget,
    });
    cap = decision.exhausted ? null : decision.cap;
    if (decision.clamped) flags.push("clamped");
    if (decision.degraded) flags.push("low-room");
  }
  if ((marginBoosts.get(key) ?? 0) > 0) flags.push(`+margin ${formatK(marginBoosts.get(key) ?? 0)}`);
  const patch = lastPatch.get(key);
  if (patch?.field == null && patch) flags.push("unapplied!");

  ctx.ui.setStatus(
    STATUS_KEY,
    statusLine({ inputTokens: inputEstimate, cap, contextLimit, flags }),
  );
}

function describe(ctx: ExtensionContext): string {
  const model = ctx.model;
  if (!model) return "No active model.";
  const key = modelKey(model);
  const { state, error } = readState();

  const lines: string[] = [];
  if (key) lines.push(`${model.provider}/${model.id}`);
  else lines.push(`${model.provider}/${model.id} (unkeyed)`);

  const overrideValue = key ? effectiveOverride(key, state) : null;
  const activeAdaptive =
    key && !overrideValue && state.auto ? loadAdaptiveProfile(key, state, ctx.thinkingLevel) : null;
  const learnedProfile = activeAdaptive
    ? (state.adaptiveProfiles[activeAdaptive.id] ?? null)
    : null;
  const hasLearnedData =
    learnedProfile !== null && (learnedProfile.seq > 0 || learnedProfile.outputs.length > 0);
  const declaredMax = Number(model.maxTokens);
  const effectiveProviderMax =
    Number.isSafeInteger(declaredMax) && declaredMax > 0 ? declaredMax : Infinity;
  const autoCap = Math.min(
    activeAdaptive?.profile.capTarget ?? desiredOutputTarget(model, key ?? "", state, ctx.thinkingLevel),
    effectiveProviderMax,
  );
  const modeLabel = overrideValue
    ? `fixed ${formatTokens(overrideValue)} (${sessionOverrides.has(key ?? "") ? "session" : "saved"})`
    : state.auto
      ? `auto-adaptive (cap ${formatK(autoCap)} @ ${ctx.thinkingLevel})`
      : "provider default (dynamic off)";
  lines.push(`mode: ${modeLabel}`);

  if (hasLearnedData) {
    const p = learnedProfile;
    const declaredMax = Number(model.maxTokens);
    const reserve = Number.isSafeInteger(declaredMax) && declaredMax > 0 ? Math.min(p.reservationTarget, declaredMax) : p.reservationTarget;
    lines.push(
      `learning: reserve ${formatK(reserve)} • ${p.outputs.length} recent outputs` +
        (p.pressureCount > 0 ? ` • compaction pressure ${p.pressureCount}` : ""),
    );
  }

  const limit = resolveContextLimit(model, state);
  lines.push(
    `context limit: ${
      limit ? formatK(limit) : "unknown"
    }${key && state.contextLimits[key] ? " (override)" : ""}`,
  );
  const boost = key ? (marginBoosts.get(key) ?? 0) : 0;
  lines.push(
    `margin: ${formatK(effectiveMargin(state.safetyMarginTokens, boost, limit ?? Number.MAX_SAFE_INTEGER))}${
      boost > 0 ? ` (base ${formatK(state.safetyMarginTokens)} + boost ${formatK(boost)}, max ${formatK(MAX_MARGIN_BOOST_TOKENS)})` : ""
    }`,
  );

  if (key) {
    const previous = lastPatch.get(key);
    const input = lastInputEstimate.get(key);
    if (previous && previous.field) {
      lines.push(
        `last request: ${previous.field}=${formatK(previous.cap)}${
          previous.clamped ? " (clamped)" : ""
        }${previous.degraded ? " (margin degraded)" : ""}`,
      );
    } else if (previous) {
      lines.push(`last request patch: not applied (${previous.reason ?? "unsupported payload"})`);
    } else {
      lines.push("last request patch: not observed yet");
    }
    if (input != null) lines.push(`last input estimate: ${formatK(input)}`);
  }

  if (error) lines.push(`state warning: ${error}`);
  lines.push(`extension: pi-maxout v${VERSION}`);
  return lines.join("\n");
}

function notifyResult(ctx: ExtensionCommandContext, backupPath?: string): void {
  refreshStatus(ctx);
  const pending = ctx.isIdle() ? "" : "\nApplies to the next provider request.";
  const backup = backupPath ? `\nBacked up invalid state to: ${backupPath}` : "";
  ctx.ui.notify(`${describe(ctx)}${pending}${backup}`, "info");
}

// ---------------------------------------------------------------------------
// Margin learning (overflow → larger margin for the retried request)
// ---------------------------------------------------------------------------

function boostMargin(ctx: ExtensionContext, key: string): void {
  if (!currentAttempt || currentAttempt.key !== key || currentAttempt.learned) return;
  const before = marginBoosts.get(key) ?? 0;
  const after = nextMarginBoost(before, "overflow");
  if (after === before) return;
  currentAttempt.learned = true;
  marginBoosts.set(key, after);
  notifyOnce(
    ctx,
    `boost:${key}:${after}`,
    `context overflow detected — retry will use a larger safety margin (+${formatK(after)} tokens).`,
  );
}

// ---------------------------------------------------------------------------
// Proactive compaction when headroom is too small for the selected mode
// ---------------------------------------------------------------------------

/**
 * Proactively compact when headroom is too small for the selected mode.
 *
 * Awaitable on purpose: before_agent_start awaits it so Pi's compaction fully
 * settles BEFORE the agent loop issues its first provider request — otherwise
 * the main request and the summarizer race for the same context window and
 * both fail. The cooldown timestamp is recorded up front (so concurrent
 * callers cannot double-schedule), and `compacting` is always cleaned up —
 * including on errors — so a failed attempt can never wedge the flag on.
 */
async function maybeCompactForHeadroom(ctx: ExtensionContext): Promise<void> {
  const model = ctx.model;
  const key = modelKey(model);
  if (!model || !key || compacting || !ctx.isIdle()) return;

  const { state } = readState();
  const overrideValue = effectiveOverride(key, state);
  if (!state.auto && !overrideValue) return;
  const contextLimit = resolveContextLimit(model, state);
  if (!contextLimit) return;

  const usage = ctx.getContextUsage();
  const tokens = usage?.tokens;
  if (!tokens) return; // unknown (fresh/just-compacted) — nothing to act on

  // Dual targets: fixed overrides keep their cap as the compaction trigger;
  // dynamic auto mode justifies compaction against the learned RESERVATION,
  // never the (larger) learned cap.
  let target: number;
  let learnOnComplete = false;
  let loadedAdaptive: LoadedAdaptive | null = null;
  if (overrideValue) {
    target = overrideValue;
  } else {
    loadedAdaptive = loadAdaptiveProfile(key, state, ctx.thinkingLevel);
    if (!loadedAdaptive) return;
    persistAdaptiveProfile(state, loadedAdaptive);
    const declaredMax = Number(model.maxTokens);
    const ceiling =
      Number.isSafeInteger(declaredMax) && declaredMax > 0 ? declaredMax : Number.MAX_SAFE_INTEGER;
    target = Math.min(loadedAdaptive.profile.reservationTarget, ceiling);
    learnOnComplete = true;
  }
  const margin = effectiveMargin(state.safetyMarginTokens, marginBoosts.get(key) ?? 0, contextLimit);
  const remaining = contextLimit - tokens - margin;

  if (remaining >= target) return; // enough headroom for the selected mode

  const now = Date.now();
  const lastAttempt = lastCompactionAttempt.get(key) ?? 0;
  const urgent = remaining < MIN_MARGIN_TOKENS + 1024; // can't fit even a tiny answer
  if (!urgent && now - lastAttempt < COMPACTION_COOLDOWN_MS) return;

  lastCompactionAttempt.set(key, now);
  compacting = true;
  notifyOnce(
    ctx,
    `compact:${key}:${Math.floor(now / COMPACTION_COOLDOWN_MS)}`,
    `only ${formatK(Math.max(remaining, 0))} of headroom left but ${ctx.thinkingLevel} wants ${formatK(
      target,
    )} — auto-compaction scheduled.`,
    urgent ? "warning" : "info",
  );
  let completed = false;
  try {
    await new Promise<void>((resolve) => {
      try {
        ctx.compact({
          onComplete: () => {
            completed = true;
            resolve();
          },
          onError: () => resolve(),
        });
      } catch {
        resolve(); // synchronous throw from the runtime must not wedge us either
      }
    });
  } finally {
    if (!completed) lastCompactionAttempt.delete(key); // failed compaction may retry immediately
    else if (learnOnComplete) recordCompactionPressure(ctx, key, ctx.thinkingLevel);
    compacting = false;
    providerSizingSuspended = false;
    refreshStatus(ctx);
  }
}

/**
 * Apply at most one adaptive output transition per attempt, attributed only
 * to the successfully patched AUTO request that just completed.
 */
function isTokenLimitStop(stopReason: unknown): boolean {
  return (
    typeof stopReason === "string" &&
    ["length", "max_tokens", "max_output_tokens", "token_limit"].includes(stopReason.toLowerCase())
  );
}

function learnAdaptiveOutcome(
  ctx: ExtensionContext,
  key: string,
  message: { stopReason?: unknown; usage?: unknown },
): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.key !== key || attempt.learned || !attempt.adaptive) return;
  attempt.learned = true;

  const truncated = isTokenLimitStop(message.stopReason);
  const rawOutput = Number((message.usage as { output?: unknown } | undefined)?.output);
  const outputTokens = Number.isSafeInteger(rawOutput) && rawOutput > 0 ? rawOutput : null;
  // Missing usage still processes a trustworthy length stop (no history update).
  if (!truncated && outputTokens === null) return;

  try {
    const { state } = readState();
    const id = attempt.adaptive.profileId;
    const stored = state.adaptiveProfiles[id];
    const profile = normalizeAdaptiveProfile(stored, {
      level: id.slice(id.lastIndexOf(":") + 1),
    });
    const next = observeAdaptiveOutput(profile, { outputTokens, truncated, nowMs: Date.now() });
    persistObservedProfile(state, id, stored, next);
  } catch {
    /* learning must never break the response lifecycle */
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function maxoutExtension(pi: ExtensionAPI): void {
  pi.registerCommand("maxout", {
    description: "Inspect or change the provider completion-token budget",
    getArgumentCompletions: (prefix) => {
      const options = [
        "status",
        "auto",
        "off",
        "16k",
        "32k",
        "64k",
        "128k",
        "max",
        "save auto",
        "save 16k",
        "save 32k",
        "save 64k",
        "save 128k",
        "save max",
        "margin",
        "limit",
        "limit clear",
        "learn",
        "learn reset",
      ];
      const value = String(prefix ?? "").trimStart().toLowerCase();
      const matches = options.filter((option) => option.startsWith(value));
      return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null;
    },
    handler: async (args, ctx) => {
      const model = ctx.model;
      const key = modelKey(model);
      if (!model || !key) {
        ctx.ui.notify("No active model.", "warning");
        return;
      }

      const raw = String(args ?? "").trim();

      if (/^margin(?:\s+\S+)?$/i.test(raw)) {
        const valueRaw = raw.split(/\s+/)[1];
        if (!valueRaw) {
          const { state } = readState();
          ctx.ui.notify(
            `pi-maxout: safety margin ${state.safetyMarginTokens} tokens (min ${MIN_MARGIN_TOKENS}). Usage: /maxout margin 4096`,
            "info",
          );
          return;
        }
        const parsed = parseTokenSpec(valueRaw, model);
        if (parsed.kind !== "value") {
          ctx.ui.notify(parsed.kind === "error" ? parsed.message : "Provide a token count, e.g. /maxout margin 4096", "warning");
          return;
        }
        const loaded = readState();
        const next = normalizeState(loaded.state);
        next.safetyMarginTokens = Math.max(MIN_MARGIN_TOKENS, parsed.value);
        writeState(next);
        notifyResult(ctx);
        return;
      }

      if (/^limit(?:\s+\S+)?$/i.test(raw)) {
        const valueRaw = raw.split(/\s+/)[1];
        const loaded = readState();
        const next = normalizeState(loaded.state);
        if (!valueRaw) {
          const current = next.contextLimits[key];
          ctx.ui.notify(
            `pi-maxout: context limit for ${key}: ${current ? formatK(current) : "catalog default"}. Usage: /maxout limit 131072 | /maxout limit clear`,
            "info",
          );
          return;
        }
        if (valueRaw.toLowerCase() === "clear") delete next.contextLimits[key];
        else {
          // Limit overrides exist precisely to correct lying catalogs, so they
          // are allowed above the advertised context window (fixed caps are not).
          const parsed = parseTokenSpec(valueRaw, model, { allowAboveCatalogContext: true });
          if (parsed.kind !== "value") {
            ctx.ui.notify(parsed.kind === "error" ? parsed.message : "Provide a token count or 'clear'.", "warning");
            return;
          }
          next.contextLimits[key] = parsed.value;
        }
        writeState(next);
        notifyResult(ctx);
        return;
      }

      if (/^learn(?:\s+\S+)?$/i.test(raw)) {
        const sub = raw.split(/\s+/)[1];
        if (!sub) {
          const { state } = readState();
          const count = Object.keys(state.adaptiveProfiles).length;
          ctx.ui.notify(
            `pi-maxout: ${count} learned auto budget(s). Usage: /maxout learn reset`,
            "info",
          );
          return;
        }
        if (sub.toLowerCase() !== "reset") {
          ctx.ui.notify(
            "Usage: /maxout learn reset — clears learned auto budgets; fixed caps, limits, and margins are untouched.",
            "warning",
          );
          return;
        }
        const loaded = readState();
        const next = normalizeState(loaded.state);
        const cleared = Object.keys(next.adaptiveProfiles).length;
        next.adaptiveProfiles = {};
        writeState(next);
        lastPatch.delete(key);
        ctx.ui.notify(
          cleared > 0
            ? `pi-maxout: cleared ${cleared} learned auto budget(s). Auto mode restarts from cold-start targets.`
            : "pi-maxout: no learned auto budgets to clear.",
          "info",
        );
        refreshStatus(ctx);
        return;
      }

      if (!raw || raw.toLowerCase() === "status") {
        refreshStatus(ctx);
        ctx.ui.notify(describe(ctx), "info");
        return;
      }

      const saveMatch = raw.match(/^save(?:\s+(.+))?$/i);
      const persist = Boolean(saveMatch);
      const valueRaw = persist ? String(saveMatch?.[1] ?? "").trim() : raw;
      if (persist && !valueRaw) {
        ctx.ui.notify("Usage: /maxout save 32k  |  /maxout save auto", "warning");
        return;
      }

      // Full disable. Clear all persisted and session fixed caps so `off`
      // remains off across model switches and cannot patch via an override.
      // State is shared by all loaded copies, which also makes this fail-safe
      // if an obsolete duplicate extension was discovered before reload.
      if (valueRaw.toLowerCase() === "off") {
        const loaded = readState();
        const next = normalizeState(loaded.state);
        next.auto = false;
        next.defaults = {};
        writeState(next);
        sessionOverrides.clear();
        currentAttempt = null;
        lastPatch.delete(key);
        lastInputEstimate.delete(key);
        ctx.ui.notify("pi-maxout: off; provider payloads are untouched for every model.", "info");
        refreshStatus(ctx);
        return;
      }

      // Dynamic auto toggle (also the meaning of a bare "auto"). Enabling it
      // must remove any saved fixed default for this model — otherwise the
      // saved default would keep winning in effectiveOverride and "auto"
      // would silently stay off. `/maxout save auto` lands here too.
      if (valueRaw.toLowerCase() === "auto") {
        const loaded = readState();
        const next = normalizeState(loaded.state);
        next.auto = true;
        delete next.defaults[key];
        writeState(next);
        sessionOverrides.delete(key);
        lastPatch.delete(key);
        notified.delete(`boost:${key}:0`);
        clearBoostNotifications(key);
        notifyResult(ctx);
        return;
      }

      const parsed = parseTokenSpec(valueRaw, model);
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }
      if (parsed.kind === "status") {
        refreshStatus(ctx);
        ctx.ui.notify(describe(ctx), "info");
        return;
      }
      if (parsed.kind === "auto") return; // handled by the dynamic toggle branch above

      lastPatch.delete(key);

      if (persist) {
        const loaded = readState();
        const next = normalizeState(loaded.state);
        next.defaults[key] = parsed.value;
        const backupPath = writeState(next);
        sessionOverrides.delete(key);
        notifyResult(ctx, backupPath);
        return;
      }

      sessionOverrides.set(key, parsed.value);
      notifyResult(ctx);
    },
  });

  pi.on("session_start", (event, ctx) => {
    // Transient request/compaction state never survives a reload or session switch.
    currentAttempt = null;
    providerSizingSuspended = false;
    compacting = false;
    // Session-scoped settings survive /reload but not new/resumed/forked sessions.
    if (event.reason !== "reload") {
      sessionOverrides.clear();
      lastPatch.clear();
      lastInputEstimate.clear();
      marginBoosts.clear();
      lastCompactionAttempt.clear();
      notified.clear();
    }
    refreshStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    refreshStatus(ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    refreshStatus(ctx);
  });

  pi.on("session_before_compact", (_event, _ctx) => {
    // Auto/overflow compaction can happen while the agent is active, so idle
    // state alone cannot identify its summary request.
    providerSizingSuspended = true;
    currentAttempt = null;
  });

  pi.on("session_compact", (_event, ctx) => {
    providerSizingSuspended = false;
    // Compaction changed the context: discard stale pre-compaction status data.
    const key = modelKey(ctx.model);
    if (key) {
      lastInputEstimate.delete(key);
      lastPatch.delete(key);
    }
    refreshStatus(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshStatus(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    currentAttempt = null;
    providerSizingSuspended = false;
    maybeCompactForHeadroom(ctx)
      .catch(() => {
        /* compaction failures must not crash the settled handler */
      })
      .finally(() => refreshStatus(ctx));
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Await compaction for any selected-mode headroom shortfall, urgent or not,
    // so the summary request cannot race the main provider request.
    try {
      await maybeCompactForHeadroom(ctx);
    } catch {
      /* never block the turn on compaction housekeeping */
    }
    refreshStatus(ctx);
  });

  // Per-request dynamic budgeting. Runs after Pi built the final payload, so
  // tool schemas and all message content are observable here.
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    const key = modelKey(model);
    if (!model || !key) return undefined;

    const { state } = readState();
    const overrideValue = effectiveOverride(key, state);
    if (!overrideValue && !state.auto) return undefined; // fully manual/provider default

    const payload: unknown = event.payload;
    // Tool-less active main requests are sized. Idle summaries and active
    // auto/overflow-compaction summaries retain Pi core's own budgets.
    if (providerSizingSuspended || shouldSkipPayload(payload, ctx.isIdle())) return undefined;

    const contextLimit = resolveContextLimit(model, state);
    if (!contextLimit) return undefined; // unknown window → fail open like v1

    const usageEstimate = ctx.getContextUsage()?.tokens ?? null;
    const payloadEstimate = estimatePayloadInputTokens(payload as Record<string, unknown>);
    const inputEstimate = combineInputEstimates(usageEstimate, payloadEstimate);
    if (inputEstimate === null) return undefined;
    lastInputEstimate.set(key, inputEstimate);

    const adaptiveLoaded = overrideValue ? null : loadAdaptiveProfile(key, state, ctx.thinkingLevel);
    if (adaptiveLoaded) persistAdaptiveProfile(state, adaptiveLoaded);

    const decision = resolveRequestCap({
      mode: overrideValue ? "override" : "auto",
      requestedOverride: overrideValue ?? undefined,
      contextLimit,
      inputTokens: inputEstimate,
      thinkingLevel: ctx.thinkingLevel,
      marginTokens: state.safetyMarginTokens,
      marginBoost: marginBoosts.get(key) ?? 0,
      customTargets: state.targets,
      modelMaxTokens: model.maxTokens,
      adaptiveTarget: adaptiveLoaded?.profile.capTarget,
    });

    if (decision.exhausted || decision.cap === null) {
      currentAttempt = null;
      lastPatch.delete(key);
      notifyOnce(
        ctx,
        `exhausted:${key}`,
        `input ~${formatK(inputEstimate)} already fills the ${formatK(contextLimit)}-token window — no output budget left. Compaction needed; request left untouched.`,
      );
      refreshStatus(ctx);
      return undefined;
    }

    const result = patchMaxTokensPayload(payload, decision.cap, model);
    let finalPayload: unknown = result.payload;
    let field = result.field;

    // A thinking budget is meaningful only after the completion cap itself was
    // patched. Never turn an unsupported max-token API into a partially sized
    // request by changing only thinking_token_budget.
    if (result.changed) {
      const thinkingResult = patchThinkingBudgetPayload(finalPayload, decision.cap, ctx.thinkingLevel);
      if (thinkingResult.changed) finalPayload = thinkingResult.payload;
      field = field ?? thinkingResult.field;
    }

    // Only successfully max-token-patched requests participate in learning.
    const adaptiveAttempt = result.changed && !overrideValue ? adaptiveLoaded : null;
    currentAttempt = result.changed
      ? {
          key,
          learned: false,
          streamStarted: false,
          ...(adaptiveAttempt ? { adaptive: { profileId: adaptiveAttempt.id } } : {}),
        }
      : null;
    lastPatch.set(key, {
      cap: decision.cap,
      field: result.changed ? field : null,
      reason: result.changed ? decision.reason : result.reason ?? "unsupported-payload",
      clamped: decision.clamped,
      degraded: decision.degraded,
    });

    if (decision.degraded) {
      notifyOnce(
        ctx,
        `degraded:${key}`,
        `context nearly full: maxout reduced to ${formatK(decision.cap)} (full safety margin could not fit).`,
      );
    } else if (decision.clamped) {
      notifyOnce(
        ctx,
        `clamped:${key}:${decision.cap}`,
        `${ctx.thinkingLevel} target exceeded available headroom — clamped maxout to ${formatK(decision.cap)}.`,
        "info",
      );
    }

    refreshStatus(ctx);
    return result.changed ? finalPayload : undefined;
  });

  // Keep the attempt alive across the 200 response event; streaming begins
  // only when message_update arrives.
  pi.on("message_update", (_event, ctx) => {
    const key = modelKey(ctx.model);
    if (key && currentAttempt?.key === key) currentAttempt.streamStarted = true;
  });

  // A pre-stream HTTP rejection can teach one larger margin. The later
  // assistant error for the same attempt sees learned=true and cannot stack it.
  pi.on("after_provider_response", (event, ctx) => {
    const key = modelKey(ctx.model);
    if (!key || currentAttempt?.key !== key) return;
    if (!currentAttempt.streamStarted && (event.status === 400 || event.status === 413)) {
      boostMargin(ctx, key);
      refreshStatus(ctx);
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const key = modelKey(ctx.model);
    if (!key) return;

    if (
      currentAttempt?.key === key &&
      message.stopReason === "error" &&
      typeof message.errorMessage === "string" &&
      isContextOverflow(message as Parameters<typeof isContextOverflow>[0], ctx.model?.contextWindow ?? 0)
    ) {
      if (!currentAttempt.streamStarted) boostMargin(ctx, key);
    } else if (message.stopReason !== "error") {
      const usage = message.usage;
      // Only a successful response attributable to the main request we sized
      // may reset its learned overflow margin. Summary/title responses have no
      // currentAttempt and must not erase main-request learning.
      if (currentAttempt?.key === key && usage) {
        const usageTokens =
          usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (usageTokens > 0 && (marginBoosts.get(key) ?? 0) !== 0) {
          marginBoosts.set(key, 0);
          clearBoostNotifications(key);
        }
      }
      learnAdaptiveOutcome(ctx, key, message);
    }

    if (currentAttempt?.key === key) currentAttempt = null;
    refreshStatus(ctx);
  });
}
