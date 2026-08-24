import { test } from "node:test";
import assert from "node:assert/strict";

import { nextMarginBoost, effectiveMargin, shouldSkipPayload, resolveRequestCap } from "../auto.mjs";
import { patchThinkingBudgetPayload, MAX_THINKING_BUDGET_TOKENS } from "../core.mjs";

test("margin boost grows on overflow and resets on success", () => {
  let boost = 0;
  boost = nextMarginBoost(boost, "overflow");
  assert.equal(boost, 2048);
  boost = nextMarginBoost(boost, "overflow");
  assert.equal(boost, 4096);
  boost = nextMarginBoost(boost, "overflow");
  assert.equal(boost, 8192);
  boost = nextMarginBoost(boost, "overflow");
  assert.equal(boost, 16384);
  // capped at MAX_MARGIN_BOOST
  boost = nextMarginBoost(boost, "overflow");
  assert.equal(boost, 16384);
  boost = nextMarginBoost(boost, "success");
  assert.equal(boost, 0);
});

test("effective margin never exceeds a quarter of the context window", () => {
  assert.equal(effectiveMargin(2048, 16384, 131072), Math.min(2048 + 16384, Math.floor(131072 / 4)));
  assert.equal(effectiveMargin(2048, 0, 8192), Math.floor(8192 / 4));
});

test("compaction/summarization payloads are skipped (no tools present)", () => {
  const compactionPayload = {
    model: "local-model",
    stream: true,
    max_tokens: 13107,
    messages: [
      { role: "system", content: "Summarize this conversation." },
      { role: "user", content: "[conversation transcript]" },
    ],
  };
  assert.equal(shouldSkipPayload(compactionPayload), true);

  const mainPayload = { ...compactionPayload, tools: [{ type: "function", function: { name: "bash" } }] };
  assert.equal(shouldSkipPayload(mainPayload), false);

  assert.equal(shouldSkipPayload(null), true);
  assert.equal(shouldSkipPayload({ messages: [] }), true);
});

test("shouldSkipPayload: no-tools ACTIVE main requests size; idle internal requests skip", () => {
  const toolLess = { messages: [{ role: "user", content: "hi" }] };
  // Active turn (not idle): even without tools this is a real main request.
  assert.equal(shouldSkipPayload(toolLess, false), false);
  // Idle + no tools = internal housekeeping (summary/compaction).
  assert.equal(shouldSkipPayload(toolLess, true), true);
  // Tools present always sizes regardless of idle state.
  const withTools = { ...toolLess, tools: [{ type: "function", function: { name: "bash" } }] };
  assert.equal(shouldSkipPayload(withTools, true), false);
  assert.equal(shouldSkipPayload(withTools, false), false);
});

test("resolveRequestCap: auto target honors model.maxTokens advertisement", () => {
  const r = resolveRequestCap({
    mode: "auto",
    contextLimit: 131072,
    inputTokens: 10000,
    thinkingLevel: "xhigh",
    marginTokens: 2048,
    modelMaxTokens: 20000,
  });
  assert.equal(r.cap, 20000, "target must be clamped to what the model serves");
  assert.equal(r.clamped, false, "model-max clamp is not a context clamp");

  // larger advertisement never raises the target above the table value
  const r2 = resolveRequestCap({
    mode: "auto",
    contextLimit: 131072,
    inputTokens: 10000,
    thinkingLevel: "high",
    marginTokens: 2048,
    modelMaxTokens: 999999,
  });
  assert.equal(r2.cap, 32000);

  // override mode stays user-authoritative
  const r3 = resolveRequestCap({
    mode: "override",
    requestedOverride: 64000,
    contextLimit: 131072,
    inputTokens: 10000,
    marginTokens: 2048,
    modelMaxTokens: 20000,
  });
  assert.equal(r3.cap, 64000);
});

test("patchThinkingBudgetPayload: only existing numeric budgets in xhigh/max are rewritten", () => {
  const cap = 32000;
  const expected = Math.min(MAX_THINKING_BUDGET_TOKENS, Math.max(0, cap - 4096)); // 27904

  // xhigh with an existing numeric budget -> rewritten (original untouched)
  const p1 = { messages: [], thinking_token_budget: 60000 };
  const r1 = patchThinkingBudgetPayload(p1, cap, "xhigh");
  assert.equal(r1.changed, true);
  assert.equal(r1.payload.thinking_token_budget, expected);
  assert.notEqual(r1.payload, p1, "payload must be copied, not mutated");
  assert.equal(p1.thinking_token_budget, 60000);

  // max level behaves identically
  const r2 = patchThinkingBudgetPayload({ thinking_token_budget: 60000 }, 56000, "max");
  assert.equal(r2.changed, true);
  assert.equal(r2.payload.thinking_token_budget, MAX_THINKING_BUDGET_TOKENS); // min(50000, 51904)

  // tiny final caps floor at 0 instead of going negative
  const r3 = patchThinkingBudgetPayload({ thinking_token_budget: 100 }, 1000, "xhigh");
  assert.equal(r3.changed, true);
  assert.equal(r3.payload.thinking_token_budget, 0);

  // absent budget stays absent
  const absent = { messages: [] };
  const r4 = patchThinkingBudgetPayload(absent, cap, "xhigh");
  assert.equal(r4.changed, false);
  assert.deepEqual(r4.payload, absent);

  // non-numeric garbage is ignored
  const junk = { thinking_token_budget: "big" };
  const r5 = patchThinkingBudgetPayload(junk, cap, "max");
  assert.equal(r5.changed, false);

  // lower modes untouched entirely
  const lower = { thinking_token_budget: 60000 };
  for (const level of ["off", "minimal", "low", "medium", "high", null, undefined]) {
    const r6 = patchThinkingBudgetPayload(lower, cap, level);
    assert.equal(r6.changed, false, `level ${level} must be untouched`);
    assert.equal(r6.payload.thinking_token_budget, 60000);
  }
});

test("resolveRequestCap: dynamic auto mode computes target-based cap", () => {
  const r = resolveRequestCap({
    payload: { messages: [{ role: "user", content: "hi" }], tools: [1] },
    contextLimit: 131072,
    inputTokens: 67347,
    thinkingLevel: "xhigh",
    marginTokens: 2048,
    mode: "auto",
  });
  assert.equal(r.cap, 56000);
  assert.equal(r.reason, "target:xhigh");
});

test("resolveRequestCap: explicit override is safety-clamped against remaining context", () => {
  const r = resolveRequestCap({
    payload: { messages: [], tools: [1] },
    contextLimit: 131072,
    inputTokens: 67347,
    requestedOverride: 63726,
    marginTokens: 2048,
    mode: "override",
  });
  // hard room is 63725; the old buggy request asked for 63726 -> must be reduced
  assert.ok(r.cap <= 131072 - 67347);
  assert.equal(r.clamped, true);
  assert.equal(r.reason, "override:clamped");
});

test("resolveRequestCap: boosted margin shrinks the cap after an overflow", () => {
  const base = resolveRequestCap({
    payload: { tools: [1], messages: [] },
    contextLimit: 131072,
    inputTokens: 70000,
    thinkingLevel: "xhigh",
    marginTokens: 2048,
    marginBoost: 0,
    mode: "auto",
  });
  const boosted = resolveRequestCap({
    payload: { tools: [1], messages: [] },
    contextLimit: 131072,
    inputTokens: 70000,
    thinkingLevel: "xhigh",
    marginTokens: 2048,
    marginBoost: 8192,
    mode: "auto",
  });
  if (!base.exhausted && !boosted.exhausted) {
    assert.ok(boosted.cap < base.cap, "larger margin must reduce the requested cap when near the limit");
  }
  assert.ok(boosted.margin >= base.margin);
});
