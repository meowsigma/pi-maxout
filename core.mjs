export const STATE_VERSION = 3;

/** Default safety margin (tokens) when unconfigured. Must stay >= MIN_MARGIN_TOKENS. */
const DEFAULT_STATE_MARGIN = 2048;
const MIN_STATE_MARGIN = 1024;
const KNOWN_TARGET_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

import { normalizeAdaptiveProfile } from "./adaptive.mjs";

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function modelKey(model) {
  if (!model || typeof model !== "object") return null;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!provider || !id) return null;
  return `${provider}:${id}`;
}

export function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "auto";
  const n = Math.floor(value);
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}m`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  return String(n);
}

/**
 * Parse a user-provided token spec.
 *
 * options.allowAboveCatalogContext — permit values above the model's catalog
 * context window. Needed by `/maxout limit`, whose whole purpose is correcting
 * catalogs that lie about the real window (local vLLM servers especially).
 * Fixed caps (`/maxout 32k`) keep the catalog guard.
 */
export function parseTokenSpec(raw, model, options = {}) {
  const text = String(raw ?? "").trim().toLowerCase().replaceAll("_", "");

  if (!text || text === "status") return { kind: "status" };
  if (["auto", "default", "clear", "off"].includes(text)) return { kind: "auto" };

  if (text === "max") {
    const declared = Number(model?.maxTokens);
    if (!Number.isSafeInteger(declared) || declared <= 0) {
      return {
        kind: "error",
        message: 'The current model does not advertise maxTokens. Use an explicit value such as "32k" or "65536".',
      };
    }
    return { kind: "value", value: declared };
  }

  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(k|m)?$/);
  if (!match) {
    return {
      kind: "error",
      message: 'Use a token count such as 16384, 32k, 64k, 128k, "max", or "auto".',
    };
  }

  let value = Number(match[1]);
  if (match[2] === "k") value *= 1024;
  if (match[2] === "m") value *= 1024 * 1024;
  value = Math.floor(value);

  if (!Number.isSafeInteger(value) || value < 1) {
    return { kind: "error", message: "The token cap must be a positive safe integer." };
  }

  const allowAboveCatalog = options?.allowAboveCatalogContext === true;
  const contextWindow = Number(model?.contextWindow);
  if (
    !allowAboveCatalog &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0 &&
    value > contextWindow
  ) {
    return {
      kind: "error",
      message: `Requested ${formatTokens(value)} exceeds the model context window (${formatTokens(contextWindow)}).`,
    };
  }

  return { kind: "value", value };
}

/**
 * Normalize persisted state to the v3 schema.
 *
 * Shape:
 *   {
 *     version: 3,
 *     defaults: { "provider:model": fixedMaxTokens },   // legacy v1 overrides
 *     auto: boolean,                                    // dynamic budgeting on/off
 *     safetyMarginTokens: number,                       // >= 1024
 *     targets: { level: tokens },                       // per-thinking-level targets
 *     contextLimits: { "provider:model": tokens },      // per-model context-limit fixes
 *     adaptiveProfiles: { "provider:model:level": profile } // learned auto budgets
 *   }
 *
 * Accepts v1/v2 files and arbitrary garbage; output is always safe and
 * complete. Profile validation/repair is delegated to the pure controller in
 * adaptive.mjs (no filesystem dependencies there).
 */
export function normalizeState(value) {
  const src = isRecord(value) ? value : {};

  const defaults = {};
  if (isRecord(src.defaults)) {
    for (const [key, candidate] of Object.entries(src.defaults)) {
      if (typeof key !== "string" || key.length === 0 || UNSAFE_KEYS.has(key)) continue;
      if (Number.isSafeInteger(candidate) && candidate > 0) defaults[key] = candidate;
    }
  }

  const auto = typeof src.auto === "boolean" ? src.auto : true;

  let safetyMarginTokens = DEFAULT_STATE_MARGIN;
  if (Number.isSafeInteger(src.safetyMarginTokens)) {
    safetyMarginTokens = Math.max(MIN_STATE_MARGIN, src.safetyMarginTokens);
  }

  const targets = {};
  if (isRecord(src.targets)) {
    for (const [key, candidate] of Object.entries(src.targets)) {
      if (!KNOWN_TARGET_LEVELS.has(key)) continue;
      if (Number.isSafeInteger(candidate) && candidate > 0) targets[key] = candidate;
    }
  }

  const contextLimits = {};
  if (isRecord(src.contextLimits)) {
    for (const [key, candidate] of Object.entries(src.contextLimits)) {
      if (typeof key !== "string" || key.length === 0 || UNSAFE_KEYS.has(key)) continue;
      if (Number.isSafeInteger(candidate) && candidate > 0) contextLimits[key] = candidate;
    }
  }

  const adaptiveProfiles = {};
  if (isRecord(src.adaptiveProfiles)) {
    for (const [key, candidate] of Object.entries(src.adaptiveProfiles)) {
      if (!isRecord(candidate)) continue;
      if (typeof key !== "string" || key.length === 0 || UNSAFE_KEYS.has(key)) continue;
      // Entries without a single recognizable learned field are junk, not
      // merely corrupt: drop them instead of materializing empty profiles.
      const hasLearnedSignal =
        (Number.isSafeInteger(candidate.capTarget) && candidate.capTarget > 0) ||
        (Number.isSafeInteger(candidate.reservationTarget) && candidate.reservationTarget > 0) ||
        (Number.isSafeInteger(candidate.updatedAt) && candidate.updatedAt > 0) ||
        Array.isArray(candidate.outputs);
      if (!hasLearnedSignal) continue;
      // The thinking level is the key's last colon-separated segment.
      const level = key.slice(key.lastIndexOf(":") + 1);
      adaptiveProfiles[key] = normalizeAdaptiveProfile(candidate, { level });
    }
  }

  return {
    version: STATE_VERSION,
    defaults,
    auto,
    safetyMarginTokens,
    targets,
    contextLimits,
    adaptiveProfiles,
  };
}

function cloneRoot(payload) {
  return { ...payload };
}

function patchRoot(payload, field, cap) {
  const next = cloneRoot(payload);
  next[field] = cap;
  return { payload: next, changed: true, field };
}

function patchNested(payload, parentField, childField, cap) {
  const parent = isRecord(payload[parentField]) ? payload[parentField] : {};
  const next = cloneRoot(payload);
  next[parentField] = { ...parent, [childField]: cap };
  return { payload: next, changed: true, field: `${parentField}.${childField}` };
}

function compatMaxTokensField(model) {
  const compat = isRecord(model?.compat) ? model.compat : null;
  const value = compat?.maxTokensField;
  return value === "max_completion_tokens" || value === "max_tokens" ? value : null;
}

// ---------------------------------------------------------------------------
// Thinking-budget passthrough (xhigh/max reasoning models)
// ---------------------------------------------------------------------------

/** Hard ceiling for an already-present numeric thinking_token_budget. */
export const MAX_THINKING_BUDGET_TOKENS = 50000;
/** Headroom kept between the thinking budget and the final completion cap. */
export const THINKING_BUDGET_HEADROOM_TOKENS = 4096;

/**
 * Rewrite an EXISTING numeric `thinking_token_budget` for xhigh/max requests:
 *   budget = min(50000, max(0, finalCap - 4096))
 * Keeps the advertised reasoning budget consistent with the (possibly clamped)
 * completion cap so reasoning + answer still fit together. Payloads without a
 * pre-existing numeric budget are never touched, and lower thinking modes are
 * left alone entirely (their budgets belong to smaller targets).
 */
export function patchThinkingBudgetPayload(payload, cap, thinkingLevel) {
  const level = typeof thinkingLevel === "string" ? thinkingLevel : "off";
  if (level !== "xhigh" && level !== "max") {
    return { payload, changed: false, field: null, reason: "thinking-mode-not-xhigh" };
  }
  if (!isRecord(payload)) {
    return { payload, changed: false, field: null, reason: "invalid-payload" };
  }
  const existing = payload.thinking_token_budget;
  if (!Number.isSafeInteger(existing) || existing <= 0) {
    // Absent budgets stay absent — we never invent provider-specific fields.
    return { payload, changed: false, field: null, reason: "no-existing-thinking-budget" };
  }
  const finalCap = Number.isSafeInteger(cap) ? cap : 0;
  const budget = Math.min(
    MAX_THINKING_BUDGET_TOKENS,
    Math.max(0, finalCap - THINKING_BUDGET_HEADROOM_TOKENS),
  );
  if (budget === existing) {
    return { payload, changed: false, field: null, reason: "thinking-budget-unchanged" };
  }
  return { payload: { ...payload, thinking_token_budget: budget }, changed: true, field: "thinking_token_budget" };
}

/**
 * Patch a final provider payload without mutating it.
 *
 * Existing payload shape wins. If the provider omitted the field, only known Pi
 * API shapes receive a new field. Unknown APIs fail open instead of guessing.
 */
export function patchMaxTokensPayload(payload, cap, model) {
  if (!isRecord(payload) || !Number.isSafeInteger(cap) || cap < 1) {
    return { payload, changed: false, field: null, reason: "invalid-payload-or-cap" };
  }

  // Preserve the provider adapter's chosen field whenever it is already present.
  if (Object.hasOwn(payload, "max_output_tokens")) return patchRoot(payload, "max_output_tokens", cap);
  if (Object.hasOwn(payload, "max_completion_tokens")) return patchRoot(payload, "max_completion_tokens", cap);
  if (Object.hasOwn(payload, "max_tokens")) return patchRoot(payload, "max_tokens", cap);

  if (isRecord(payload.generationConfig) && Object.hasOwn(payload.generationConfig, "maxOutputTokens")) {
    return patchNested(payload, "generationConfig", "maxOutputTokens", cap);
  }
  if (isRecord(payload.generation_config) && Object.hasOwn(payload.generation_config, "max_output_tokens")) {
    return patchNested(payload, "generation_config", "max_output_tokens", cap);
  }
  if (isRecord(payload.inferenceConfig) && Object.hasOwn(payload.inferenceConfig, "maxTokens")) {
    return patchNested(payload, "inferenceConfig", "maxTokens", cap);
  }

  const api = typeof model?.api === "string" ? model.api : "";

  switch (api) {
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
      return patchRoot(payload, "max_output_tokens", cap);

    case "google-generative-ai":
    case "google-vertex":
      return patchNested(payload, "generationConfig", "maxOutputTokens", cap);

    case "bedrock-converse-stream":
      return patchNested(payload, "inferenceConfig", "maxTokens", cap);

    case "openai-completions": {
      const field = compatMaxTokensField(model) ?? "max_tokens";
      return patchRoot(payload, field, cap);
    }

    case "anthropic-messages":
    case "mistral-conversations":
      return patchRoot(payload, "max_tokens", cap);

    default:
      return { payload, changed: false, field: null, reason: api ? `unsupported-api:${api}` : "unknown-api" };
  }
}
