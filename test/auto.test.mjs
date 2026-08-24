import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TARGETS,
  computeAutoCap,
  resolveTargetTokens,
  resolveContextLimit,
  formatK,
  statusLine,
} from "../auto.mjs";

const LIMIT = 131072;

test("regression: 67347 input + 63726 requested never produces an oversized request", () => {
  // The original failure: vLLM rejected input 67347 + max_tokens 63726 = 131073 > 131072.
  const guard = computeAutoCap({
    contextLimit: LIMIT,
    inputTokens: 67347,
    targetTokens: 63726, // treat the old computed value as the "requested" amount
    marginTokens: 2048,
  });
  assert.equal(guard.exhausted, false);
  assert.ok(guard.cap >= 1);
  assert.ok(67347 + guard.cap <= LIMIT, `invariant violated: ${67347 + guard.cap} > ${LIMIT}`);
});

test("normal mode: default 16K target fits comfortably at 67347 input", () => {
  const r = computeAutoCap({
    contextLimit: LIMIT,
    inputTokens: 67347,
    targetTokens: resolveTargetTokens("low"),
    marginTokens: 2048,
  });
  assert.equal(r.cap, 16000);
  assert.equal(r.clamped, false);
  assert.ok(67347 + r.cap + 2048 <= LIMIT);
});

test("xhigh mode: 56K target succeeds at 67347 input", () => {
  const r = computeAutoCap({
    contextLimit: LIMIT,
    inputTokens: 67347,
    targetTokens: resolveTargetTokens("xhigh"),
    marginTokens: 2048,
  });
  assert.equal(r.cap, 56000);
  assert.equal(r.clamped, false);
  assert.ok(67347 + r.cap <= LIMIT);
});

test("clamps to remaining context without negative or zero budgets", () => {
  // soft room is 24 (>=1): valid request, target clamped, margin still honored
  const r = computeAutoCap({
    contextLimit: LIMIT,
    inputTokens: 129000,
    targetTokens: 56000,
    marginTokens: 2048,
  });
  assert.equal(r.cap, 24);
  assert.ok(129000 + r.cap <= LIMIT);
  assert.equal(r.clamped, true);
  assert.equal(r.degraded, false);

  // hard room 1072 < margin 2048: degrade gracefully but stay invariant-safe
  const d = computeAutoCap({
    contextLimit: LIMIT,
    inputTokens: 130000,
    targetTokens: 56000,
    marginTokens: 2048,
  });
  assert.equal(d.cap, Math.min(56000, LIMIT - 130000));
  assert.ok(d.cap >= 1);
  assert.ok(130000 + d.cap <= LIMIT);
  assert.equal(d.degraded, true);
});

test("exhausted context returns null cap so no oversized request is sent", () => {
  const r = computeAutoCap({
    contextLimit: LIMIT,
    inputTokens: LIMIT,
    targetTokens: 16384,
    marginTokens: 2048,
  });
  assert.equal(r.exhausted, true);
  assert.equal(r.cap, null);
});

test("margin floor of at least 1024 is enforced even when configured lower", () => {
  const r = computeAutoCap({
    contextLimit: LIMIT,
    inputTokens: 60000,
    targetTokens: 57344,
    marginTokens: 1,
  });
  assert.ok(60000 + r.cap + 1024 <= LIMIT, "margin below 1024 must not be honored");
});

test("provider-aware: different context limits per provider are respected", () => {
  // OpenRouter-style 200k model
  const openrouter = computeAutoCap({
    contextLimit: 200000,
    inputTokens: 150000,
    targetTokens: 56000,
    marginTokens: 2048,
  });
  assert.equal(openrouter.cap, 200000 - 150000 - 2048);
  assert.equal(openrouter.clamped, true);
  assert.ok(150000 + openrouter.cap <= 200000);

  // Anthropic-style 200k model with small prompt: full xhigh target
  const anthropic = computeAutoCap({
    contextLimit: 200000,
    inputTokens: 30000,
    targetTokens: 56000,
    marginTokens: 2048,
  });
  assert.equal(anthropic.cap, 56000);
  assert.equal(anthropic.clamped, false);

  // Small 32k local model: clamps hard but stays valid
  const small = computeAutoCap({
    contextLimit: 32768,
    inputTokens: 28000,
    targetTokens: 57344,
    marginTokens: 1024,
  });
  assert.ok(28000 + small.cap <= 32768);
  assert.ok(small.cap >= 1);
});

test("resolveContextLimit prefers saved override, then catalog value", () => {
  assert.equal(resolveContextLimit({ provider: "llama.cpp", id: "x", contextWindow: 131072 }, {}), 131072);
  // model without a usable key falls back to its catalog value
  assert.equal(resolveContextLimit({ contextWindow: 131072 }, { contextLimits: { "llama.cpp:x": 100000 } }), 131072);
  // saved override wins when the key matches
  assert.equal(
    resolveContextLimit({ provider: "llama.cpp", id: "x", contextWindow: 128000 }, { contextLimits: { "llama.cpp:x": 131072 } }),
    131072,
  );
  assert.equal(resolveContextLimit({ contextWindow: 0 }, {}), null); // unknown limit -> dynamic mode disabled
  assert.equal(resolveContextLimit(undefined, {}), null);
});

test("thinking-level targets match the recommended table", () => {
  assert.equal(resolveTargetTokens("off"), 16000);
  assert.equal(resolveTargetTokens("minimal"), 16000);
  assert.equal(resolveTargetTokens("low"), 16000);
  assert.equal(resolveTargetTokens("medium"), 16000);
  assert.equal(resolveTargetTokens("high"), 32000);
  assert.equal(resolveTargetTokens("xhigh"), 56000);
  assert.equal(resolveTargetTokens("max"), 56000);
  assert.equal(resolveTargetTokens(undefined), 16000);
  assert.equal(resolveTargetTokens("nonsense"), 16000);
  assert.equal(resolveTargetTokens("high", { high: 48000 }), 48000, "custom targets respected");
  assert.deepEqual(Object.keys(DEFAULT_TARGETS).sort(), ["high", "low", "max", "medium", "minimal", "off", "xhigh"]);
});

test("property: invariant input+cap<=limit holds across randomized shapes", () => {
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  for (let i = 0; i < 500; i++) {
    const limit = [8192, 32768, 131072, 200000][rand(4)];
    const input = rand(limit + 1);
    const target = [1024, 16000, 32000, 56000][rand(4)];
    const margin = [1024, 2048, 4096, 8192][rand(4)];
    const r = computeAutoCap({ contextLimit: limit, inputTokens: input, targetTokens: target, marginTokens: margin });
    if (r.exhausted) {
      assert.equal(r.cap, null);
      assert.ok(input > limit - 1);
    } else {
      assert.ok(r.cap >= 1, `cap must be >= 1 (got ${r.cap})`);
      assert.ok(input + r.cap <= limit, `invariant violated: ${input}+${r.cap}>${limit}`);
      if (!r.degraded) assert.ok(input + r.cap + Math.max(margin, 1024) <= limit);
    }
  }
});

test("status line formatting matches the required shape", () => {
  assert.equal(formatK(67347), "67.3K");
  assert.equal(formatK(131072), "131.1K");
  assert.equal(formatK(57344), "57.3K");
  assert.equal(formatK(999), "999");

  const line = statusLine({ inputTokens: 67347, cap: 56000, contextLimit: 131072 });
  assert.equal(line, "input 67.3K • maxout 56.0K • context 131.1K");
});
