/**
 * pi-maxout auto-budget arithmetic.
 *
 * Pure, dependency-free functions. Everything here is unit-testable without the
 * Pi runtime; index.ts is only thin glue that feeds runtime values in.
 *
 * Core invariant (enforced by computeAutoCap / resolveRequestCap):
 *   inputTokens + cap <= contextLimit
 * i.e. we never ask a provider for a completion that cannot possibly fit.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard floor for the safety margin (goal requirement: >= 1024). */
export const MIN_MARGIN_TOKENS = 1024;
/** Default safety margin when nothing is configured. */
export const DEFAULT_MARGIN_TOKENS = 2048;
/** Upper bound for adaptive margin boosts (learned after overflow errors). */
export const MAX_MARGIN_BOOST_TOKENS = 16384;
/** First boost step applied when an overflow error is observed. */
export const MARGIN_BOOST_STEP_TOKENS = 2048;

/**
 * Estimated prompt tokens added per message by chat-template glue
 * (role markers, special tokens, separators). Deliberately generous.
 */
export const TEMPLATE_TOKENS_PER_MESSAGE = 24;
/** Fixed token cost assumed per image content block. */
export const IMAGE_TOKENS = 2048;
/** Strings longer than this that look like data URIs are treated as images. */
const IMAGE_DATA_PREFIXES = ["data:image/", "data:application/pdf"];

/**
 * Automatic output targets per thinking level (tokens).
 * Goal anchors: normal=16K, high=32K, xhigh=56K (~50K reasoning + answer).
 * xhigh/max reasoning may legitimately consume ~50K tokens — never blindly cap them lower.
 */
export const DEFAULT_TARGETS = Object.freeze({
  off: 16000,
  minimal: 16000,
  low: 16000,
  medium: 16000,
  high: 32000,
  xhigh: 56000,
  max: 56000,
});

const MIN_CAP_TOKENS = 1;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Input estimation
// ---------------------------------------------------------------------------

function looksLikeImageData(text) {
  if (text.length < 1024) return false;
  const lower = text.slice(0, 64).toLowerCase();
  return IMAGE_DATA_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Estimate how many prompt tokens the final provider payload will consume.
 * Walks the *serialized* payload generically so every API shape is covered:
 * messages, system prompts, and crucially tool schemas (which pi-ai's own
 * estimator misses on continuation turns — the root cause of the original
 * 131,073-token rejection).
 *
 * - text: chars/4 (same heuristic as pi-ai)
 * - data-URI/base64 blobs: fixed IMAGE_TOKENS each instead of raw chars
 * - +TEMPLATE_TOKENS_PER_MESSAGE per message for chat-template glue
 */
export function estimatePayloadInputTokens(payload) {
  if (!isRecord(payload)) return null;

  let chars = 0;
  let images = 0;

  const walk = (value) => {
    if (typeof value === "string") {
      if (looksLikeImageData(value)) images += 1;
      else chars += value.length;
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      chars += String(value).length;
      return;
    }
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      chars += key.length;
      walk(item);
    }
  };

  // Only the fields that end up in the server-side prompt matter.
  for (const key of ["messages", "tools", "system", "systemPrompt", "instruction"]) {
    if (key in payload) walk(payload[key]);
  }

  const messageCount = Array.isArray(payload.messages) ? payload.messages.length : 0;
  const textTokens = Math.ceil(chars / 4);
  return textTokens + images * IMAGE_TOKENS + messageCount * TEMPLATE_TOKENS_PER_MESSAGE;
}

/**
 * Combine estimates conservatively: take the maximum of what we know.
 * - payloadEstimate: derived from the exact outgoing payload.
 * - usageEstimate:   server-reported usage of prior turns plus trailing
 *                    message estimates (ctx.getContextUsage()).
 * Either alone can under-count; their maximum very rarely does.
 */
export function combineInputEstimates(usageEstimate, payloadEstimate) {
  const a = safeInt(usageEstimate);
  const b = safeInt(payloadEstimate);
  if (a === null && b === null) return null;
  return Math.max(a ?? 0, b ?? 0);
}

// ---------------------------------------------------------------------------
// Core arithmetic
// ---------------------------------------------------------------------------

/**
 * Compute the output budget.
 *
 * Returns one of:
 *   { cap, clamped, degraded, exhausted:false } — cap >= 1, invariant holds
 *   { cap:null, exhausted:true }                — even 1 token cannot fit
 *
 * `clamped`  — target was reduced to fit the window (status line shows it)
 * `degraded` — even the full safety margin did not fit; margin was sacrificed
 *              to keep at least a minimal valid request (still invariant-safe)
 */
export function computeAutoCap({ contextLimit, inputTokens, targetTokens, marginTokens }) {
  const limit = safeInt(contextLimit);
  const input = Math.max(0, Math.floor(Number(inputTokens) || 0));
  const target = Math.max(MIN_CAP_TOKENS, Math.floor(Number(targetTokens) || 0));
  if (limit === null || limit <= 0) {
    return { cap: null, remaining: null, clamped: false, degraded: false, exhausted: true };
  }

  const hardRoom = limit - input; // absolute provider constraint
  if (hardRoom < MIN_CAP_TOKENS) {
    return { cap: null, remaining: hardRoom, clamped: true, degraded: true, exhausted: true };
  }

  const margin = Math.max(MIN_MARGIN_TOKENS, Math.floor(Number(marginTokens) || 0));
  const softRoom = hardRoom - margin;

  if (softRoom >= MIN_CAP_TOKENS) {
    const cap = Math.min(target, softRoom);
    return { cap, remaining: softRoom, clamped: cap < target, degraded: false, exhausted: false };
  }

  // Not enough room for the full margin — degrade gracefully but stay valid.
  const cap = Math.min(target, hardRoom);
  return { cap, remaining: hardRoom, clamped: cap < target, degraded: true, exhausted: false };
}

// ---------------------------------------------------------------------------
// Targets & limits
// ---------------------------------------------------------------------------

/** Resolve the automatic target for a thinking level (custom table wins). */
export function resolveTargetTokens(thinkingLevel, customTargets) {
  const level = typeof thinkingLevel === "string" ? thinkingLevel : "off";
  const table = { ...DEFAULT_TARGETS };
  if (isRecord(customTargets)) {
    for (const [key, value] of Object.entries(customTargets)) {
      const v = safeInt(value);
      if (v !== null && Object.hasOwn(table, key)) table[key] = v;
    }
  }
  return Object.hasOwn(table, level) ? table[level] : table.off;
}

/**
 * Effective context limit for a model: saved per-model override first
 * (catalogs can lie about local servers), otherwise the catalog value.
 * Returns null when unknown — dynamic mode then stays off for the model.
 */
export function resolveContextLimit(model, config = {}) {
  if (!isRecord(model)) return null;
  const overrides = isRecord(config.contextLimits) ? config.contextLimits : {};
  const key = modelKeyOf(model);
  if (key && Object.hasOwn(overrides, key)) {
    const v = safeInt(overrides[key]);
    if (v !== null) return v;
  }
  return safeInt(model.contextWindow);
}

function modelKeyOf(model) {
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  return provider && id ? `${provider}:${id}` : null;
}

// ---------------------------------------------------------------------------
// Adaptive safety margin (learned from overflow rejections)
// ---------------------------------------------------------------------------

/**
 * Pure transition for the per-model margin boost.
 * - "overflow": double the current boost (first step = MARGIN_BOOST_STEP_TOKENS),
 *   capped at MAX_MARGIN_BOOST_TOKENS.
 * - "success": reset — the conservative estimate was good enough.
 */
export function nextMarginBoost(currentBoost, event) {
  if (event === "success") return 0;
  if (event !== "overflow") return Math.max(0, Math.floor(Number(currentBoost) || 0));
  const cur = Math.max(0, Math.floor(Number(currentBoost) || 0));
  if (cur === 0) return MARGIN_BOOST_STEP_TOKENS;
  return Math.min(cur * 2, MAX_MARGIN_BOOST_TOKENS);
}

/** Margin actually used: configured base + learned boost, bounded sanely. */
export function effectiveMargin(baseMargin, boost, contextLimit) {
  const base = Math.max(MIN_MARGIN_TOKENS, Math.floor(Number(baseMargin) || 0));
  const b = Math.max(0, Math.floor(Number(boost) || 0));
  const ceiling = Math.max(MIN_MARGIN_TOKENS, Math.floor((safeInt(contextLimit) ?? Infinity) / 4));
  return Math.min(base + b, ceiling);
}

// ---------------------------------------------------------------------------
// Request-level decision (glue logic, still pure)
// ---------------------------------------------------------------------------

/**
 * Decide whether a payload should be patched at all.
 *
 * Compaction/branch-summarization requests go through streamSimple without
 * tools and carry carefully-sized budgets of their own; patching those would
 * shrink the summarizer's budget to nearly zero.
 *
 * But a no-tools payload is NOT automatically internal: main agent turns can
 * legitimately run without tools. The reliable discriminator is the runtime
 * state: internal housekeeping (summaries, compaction) runs while the agent is
 * idle, while an active main turn is by definition not idle. So:
 *   - tools present            → active main request → size it
 *   - no tools + not idle      → tool-less main request → size it
 *   - no tools + idle          → internal summary/compaction → skip
 * Callers that cannot observe idleness may omit `isIdle`; we then stay with
 * the conservative v1 behavior (skip all no-tools payloads).
 */
export function shouldSkipPayload(payload, isIdle) {
  if (!isRecord(payload)) return true;
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return isIdle === undefined ? true : Boolean(isIdle);
  }
  return false;
}

/**
 * Full per-request resolution used by before_provider_request.
 *
 * mode:
 *   "auto"     — dynamic target-based budget for the current thinking level
 *   "override" — user-pinned fixed cap, still safety-clamped against the
 *                remaining context (the goal's unconditional invariant)
 */
export function resolveRequestCap({
  mode,
  requestedOverride,
  contextLimit,
  inputTokens,
  thinkingLevel,
  marginTokens,
  marginBoost = 0,
  customTargets,
  modelMaxTokens,
}) {
  const limit = safeInt(contextLimit);
  if (limit === null) {
    return { cap: null, reason: "unknown-context-limit", exhausted: true };
  }

  const margin = effectiveMargin(marginTokens, marginBoost, limit);
  let target =
    mode === "override"
      ? Math.max(MIN_CAP_TOKENS, Math.floor(Number(requestedOverride) || 0))
      : resolveTargetTokens(thinkingLevel, customTargets);

  // Auto targets honor what the model actually advertises for output; catalogs
  // sometimes advertise larger targets than the deployment serves.
  if (mode !== "override") {
    const declaredMax = safeInt(modelMaxTokens);
    if (declaredMax !== null && declaredMax < target) target = declaredMax;
  }

  const r = computeAutoCap({ contextLimit: limit, inputTokens, targetTokens: target, marginTokens: margin });
  if (r.exhausted) {
    return { ...r, margin, reason: "exhausted" };
  }
  if (mode === "override") {
    return { ...r, margin, reason: r.clamped ? "override:clamped" : "override" };
  }
  return { ...r, margin, reason: r.clamped ? "target:clamped" : `target:${thinkingLevel ?? "off"}` };
}

// ---------------------------------------------------------------------------
// Status formatting
// ---------------------------------------------------------------------------

/** Decimal K/M formatting for the status line ("67.3K", "1.2M"). */
export function formatK(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.floor(n));
}

/**
 * Required status shape:
 *   `input 67.3K • maxout 56.0K • context 131.1K`
 * Optional flags appended for clamp/degrade/boost states.
 */
export function statusLine({ inputTokens, cap, contextLimit, flags = [] }) {
  const parts = [
    `input ${inputTokens == null ? "?" : formatK(inputTokens)}`,
    `maxout ${cap == null ? "off" : formatK(cap)}`,
    `context ${contextLimit == null ? "?" : formatK(contextLimit)}`,
  ];
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return parts.join(" • ") + suffix;
}
