import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTokens,
  modelKey,
  normalizeState,
  parseTokenSpec,
  patchMaxTokensPayload,
} from "../core.mjs";

const localModel = {
  provider: "llamacpp",
  id: "qwen.gguf",
  api: "openai-completions",
  contextWindow: 131072,
  maxTokens: 16384,
};

test("state normalization emits the v3 schema with an empty adaptive table", () => {
  assert.deepEqual(normalizeState({ version: 999, defaults: { "a:b": 32768, bad: -1, nope: "32k" } }), {
    version: 3,
    defaults: { "a:b": 32768 },
    auto: true,
    safetyMarginTokens: 2048,
    targets: {},
    contextLimits: {},
    adaptiveProfiles: {},
  });
});

test("modelKey is provider-scoped", () => {
  assert.equal(modelKey(localModel), "llamacpp:qwen.gguf");
  assert.equal(modelKey(undefined), null);
  assert.equal(modelKey({ provider: "llamacpp" }), null);
});

test("token formatting uses binary units", () => {
  assert.equal(formatTokens(32768), "32k");
  assert.equal(formatTokens(1048576), "1m");
  assert.equal(formatTokens(12345), "12345");
});

test("parses explicit, decimal, auto, and declared max values", () => {
  assert.deepEqual(parseTokenSpec("32k", localModel), { kind: "value", value: 32768 });
  assert.deepEqual(parseTokenSpec("1.5k", localModel), { kind: "value", value: 1536 });
  assert.deepEqual(parseTokenSpec("auto", localModel), { kind: "auto" });
  assert.deepEqual(parseTokenSpec("max", localModel), { kind: "value", value: 16384 });
});

test("rejects values beyond context and max without metadata", () => {
  assert.equal(parseTokenSpec("256k", localModel).kind, "error");
  assert.equal(parseTokenSpec("max", { contextWindow: 131072 }).kind, "error");
});

test("normalizes state and drops malformed entries", () => {
  assert.equal(normalizeState({ version: 999, defaults: { "a:b": 32768, bad: -1, nope: "32k" } }).version, 3);
});

test("patches an existing OpenRouter/llama.cpp max_tokens field without mutation", () => {
  const input = { model: "x", max_tokens: 100, messages: [] };
  const result = patchMaxTokensPayload(input, 32768, localModel);
  assert.equal(result.changed, true);
  assert.equal(result.field, "max_tokens");
  assert.equal(result.payload.max_tokens, 32768);
  assert.equal(input.max_tokens, 100);
});

test("honors an existing max_completion_tokens field", () => {
  const result = patchMaxTokensPayload({ max_completion_tokens: 123 }, 4096, localModel);
  assert.equal(result.field, "max_completion_tokens");
  assert.equal(result.payload.max_completion_tokens, 4096);
});

test("adds max_output_tokens for Responses APIs", () => {
  const model = { ...localModel, api: "openai-responses" };
  const result = patchMaxTokensPayload({ model: "gpt" }, 8192, model);
  assert.equal(result.field, "max_output_tokens");
  assert.equal(result.payload.max_output_tokens, 8192);
});

test("does not invent max_output_tokens for Codex when its adapter omitted the field", () => {
  const input = { model: "gpt-5.6-terra", input: [] };
  const model = { ...localModel, api: "openai-codex-responses" };
  const result = patchMaxTokensPayload(input, 8192, model);
  assert.equal(result.changed, false);
  assert.equal(result.field, null);
  assert.equal(result.reason, "adapter-omitted-max-output-tokens");
  assert.equal(result.payload, input);
});

test("patches Google nested generationConfig without losing sibling fields", () => {
  const model = { ...localModel, api: "google-generative-ai" };
  const input = { generationConfig: { temperature: 0.2 } };
  const result = patchMaxTokensPayload(input, 8192, model);
  assert.equal(result.field, "generationConfig.maxOutputTokens");
  assert.deepEqual(result.payload.generationConfig, { temperature: 0.2, maxOutputTokens: 8192 });
  assert.deepEqual(input, { generationConfig: { temperature: 0.2 } });
});

test("patches Bedrock nested inferenceConfig", () => {
  const model = { ...localModel, api: "bedrock-converse-stream" };
  const result = patchMaxTokensPayload({ inferenceConfig: { temperature: 0.1 } }, 4096, model);
  assert.equal(result.field, "inferenceConfig.maxTokens");
  assert.equal(result.payload.inferenceConfig.maxTokens, 4096);
});

test("uses model compat maxTokensField for OpenAI-compatible APIs", () => {
  const model = {
    ...localModel,
    compat: { maxTokensField: "max_completion_tokens" },
  };
  const result = patchMaxTokensPayload({ model: "x" }, 4096, model);
  assert.equal(result.field, "max_completion_tokens");
  assert.equal(result.payload.max_completion_tokens, 4096);
});

test("unknown APIs fail open instead of guessing", () => {
  const input = { model: "x", messages: [] };
  const result = patchMaxTokensPayload(input, 4096, { ...localModel, api: "custom-mystery-api" });
  assert.equal(result.changed, false);
  assert.equal(result.field, null);
  assert.equal(result.payload, input);
  assert.match(result.reason, /unsupported-api/);
});
