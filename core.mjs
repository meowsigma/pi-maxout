export const STATE_VERSION = 1;

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

export function parseTokenSpec(raw, model) {
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

  const contextWindow = Number(model?.contextWindow);
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0 && value > contextWindow) {
    return {
      kind: "error",
      message: `Requested ${formatTokens(value)} exceeds the model context window (${formatTokens(contextWindow)}).`,
    };
  }

  return { kind: "value", value };
}

export function normalizeState(value) {
  const defaults = {};
  if (isRecord(value) && isRecord(value.defaults)) {
    for (const [key, candidate] of Object.entries(value.defaults)) {
      if (typeof key !== "string" || key.length === 0) continue;
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      if (Number.isSafeInteger(candidate) && candidate > 0) defaults[key] = candidate;
    }
  }
  return { version: STATE_VERSION, defaults };
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
