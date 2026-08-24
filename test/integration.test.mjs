/**
 * Integration tests: run the real index.ts extension entry against a fake Pi
 * runtime (stubbed SDK), driving the same event sequence the agent emits.
 * Covers the goal's scenario matrix end to end.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadExtension } from "./harness.mjs";

const LIMIT = 131072;
const MODEL = {
  provider: "llama.cpp",
  id: "qwen3-next",
  api: "openai-completions",
  contextWindow: LIMIT,
  maxTokens: LIMIT,
  compat: { maxTokensField: "max_tokens" },
};

function vllmPayload({ withTools = true } = {}) {
  const p = {
    model: MODEL.id,
    stream: true,
    messages: [
      { role: "system", content: "system prompt ".repeat(500) }, // ~5.5K chars
      { role: "user", content: "user content ".repeat(2000) }, // ~26K chars
    ],
  };
  if (withTools) p.tools = [{ type: "function", function: { name: "bash", description: "x".repeat(4000) } }];
  return p;
}

let h;

beforeEach(async () => {
  h = await loadExtension({ model: MODEL });
});

test("regression scenario: usage-based input 67347 gets a safe max_tokens patch", () => {
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const payload = vllmPayload();
  const out = h.emit.before_provider_request({ payload });
  assert.ok(out, "payload must be replaced");
  assert.equal(out.max_tokens, 8000); // default thinking level -> adaptive cold start
  assert.ok(67347 + out.max_tokens <= LIMIT);
  assert.match(h.ui.status, /input 67\.3K • maxout 8\.0K • context 131\.1K/);
});

test("xhigh cold-start target requests 32.0K when it fits", () => {
  h.setThinkingLevel("xhigh");
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 32000);
  assert.match(h.ui.status, /maxout 32\.0K/);
});

test("large prompt clamps safely; compaction payload untouched; exhaustion notifies", () => {
  // near-full: clamped but valid
  h.ctx.getContextUsage = () => ({ tokens: 129000, contextWindow: LIMIT, percent: 98 });
  let out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.ok(out && out.max_tokens >= 1);
  assert.ok(129000 + out.max_tokens <= LIMIT);

  // margin cannot fit anymore: degrade to whatever hard room remains, still valid
  h.ctx.getContextUsage = () => ({ tokens: 130997, contextWindow: LIMIT, percent: 99.98 });
  out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, LIMIT - 130997);
  assert.ok(130997 + out.max_tokens <= LIMIT);

  // truly exhausted: input alone fills the window -> no oversized request is sent
  h.ctx.getContextUsage = () => ({ tokens: LIMIT, contextWindow: LIMIT, percent: 100 });
  out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out, undefined);
  assert.match(h.ui.notifies.map((n) => n.message).join(" "), /no output budget left/i);
});

test("internal summarization payloads (idle, no tools) are never patched", () => {
  h.ctx.getContextUsage = () => ({ tokens: 120000, contextWindow: LIMIT, percent: 92 });
  // Internal housekeeping runs while the agent is idle.
  h.ctx.isIdle = () => true;
  const compaction = {
    model: MODEL.id,
    stream: true,
    max_tokens: 13107,
    messages: [{ role: "system", content: "summarize" }, { role: "user", content: "transcript" }],
  };
  const before = JSON.parse(JSON.stringify(compaction));
  const out = h.emit.before_provider_request({ payload: compaction });
  assert.equal(out, undefined);
  assert.deepEqual(compaction, before);
});

test("no-tools ACTIVE main requests are sized like any other turn", () => {
  h.ctx.isIdle = () => false; // active turn
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const out = h.emit.before_provider_request({ payload: vllmPayload({ withTools: false }) });
  assert.ok(out, "tool-less main request must be patched");
  assert.equal(out.max_tokens, 8000);
  assert.ok(67347 + out.max_tokens <= LIMIT);
});

test("pre-stream 400 boosts margin for the retried request; success resets it", () => {
  h.setThinkingLevel("high"); // cold-start target 16000
  // tight enough that the clamped budget exceeds what fits after a boost
  h.ctx.getContextUsage = () => ({ tokens: 114000, contextWindow: LIMIT, percent: 87 });

  const first = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(first.max_tokens, LIMIT - 114000 - 2048); // clamped below the learned target

  // provider rejects pre-stream
  h.emit.after_provider_response({ status: 400, headers: {} });

  const second = h.emit.before_provider_request({ payload: vllmPayload() });
  // boosted margin (2048 -> 4096) shrinks soft room: 131072 - 114000 - 4096
  assert.equal(second.max_tokens, LIMIT - 114000 - 4096);
  assert.ok(second.max_tokens < first.max_tokens, "boosted margin must shrink the budget");

  // a successful assistant response resets the learner
  h.emit.message_end({
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    },
  });
  const third = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(third.max_tokens, LIMIT - 114000 - 2048);
});

test("pre-stream assistant overflow learns once and only Pi performs the retry", () => {
  globalThis.__PI_MAXOUT_TEST_OVERFLOW = true;
  h.setThinkingLevel("medium");
  h.ctx.getContextUsage = () => ({ tokens: 122000, contextWindow: LIMIT, percent: 93 });
  const first = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(first.max_tokens, LIMIT - 122000 - 2048);

  h.emit.message_end({
    message: { role: "assistant", stopReason: "error", errorMessage: "This model's maximum context length is 131072 tokens. However, you requested too many tokens." },
  });

  const second = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(second.max_tokens, LIMIT - 122000 - 4096, "boosted margin shrinks the retried budget");
  // The only provider traffic here is the patched payloads handed BACK to Pi
  // via before_provider_request (first attempt + its single pre-stream retry).
  // The extension initiates no requests of its own.
  assert.deepEqual(
    h.sends.map((p) => p.max_tokens),
    [LIMIT - 122000 - 2048, LIMIT - 122000 - 4096],
  );
  delete globalThis.__PI_MAXOUT_TEST_OVERFLOW;
});

test("explicit fixed override is still safety-clamped against remaining context", async () => {
  await h.runCommand("save 63726"); // the old poisoned request size, persisted
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.ok(out.max_tokens <= LIMIT - 67347, "override must respect the hard window invariant");
  assert.match(h.ui.status, /clamped/);
});

test("compaction frees context -> next request gets its full target back", () => {
  h.setThinkingLevel("xhigh");
  h.ctx.getContextUsage = () => ({ tokens: 100000, contextWindow: LIMIT, percent: 76 });
  const tight = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(tight.max_tokens, LIMIT - 100000 - 2048); // clamped below target

  // session_compact fires; usage collapses to a compacted summary
  h.ctx.getContextUsage = () => ({ tokens: 12000, contextWindow: LIMIT, percent: 9 });
  const freed = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(freed.max_tokens, 32000, "full xhigh cold-start target restored after compaction");
});

test("model/provider change recalculates the limit", () => {
  h.setThinkingLevel("xhigh");
  h.ctx.model = { ...MODEL, contextWindow: 32768, maxTokens: 32768 }; // small OpenRouter-style model
  h.ctx.getContextUsage = () => ({ tokens: 20000, contextWindow: 32768, percent: 61 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.ok(20000 + out.max_tokens <= 32768);
  assert.ok(out.max_tokens < 56000, "small-window provider must clamp the xhigh target");
});

test("agent_settled schedules compaction when headroom < selected target", () => {
  h.setThinkingLevel("xhigh");
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => ({ tokens: 101000, contextWindow: LIMIT, percent: 77 }); // room ~28K < 32K reservation
  h.emit.agent_settled({});
  assert.equal(h.compactions.length, 1, "compaction should be scheduled");
});

test("agent_settled does not compact when headroom is sufficient or busy", () => {
  h.setThinkingLevel("low"); // target 16K
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => ({ tokens: 90000, contextWindow: LIMIT, percent: 69 }); // room ~39K >= 16K
  h.emit.agent_settled({});
  assert.equal(h.compactions.length, 0);

  h.setThinkingLevel("xhigh");
  h.ctx.isIdle = () => false; // mid-run: must not compact
  h.emit.agent_settled({});
  assert.equal(h.compactions.length, 0);
});

test("state file persists margin/target/limit config and survives reload semantics", async () => {
  await h.runCommand("margin 4096");
  const raw = JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  assert.equal(raw.safetyMarginTokens, 4096);
  assert.equal(raw.version, 3);

  await h.runCommand("limit 100000");
  const raw2 = JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  assert.equal(raw2.contextLimits["llama.cpp:qwen3-next"], 100000);

  // limit override now drives the arithmetic
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.ok(67347 + out.max_tokens + 4096 <= 100000, "saved limit + saved margin respected");
});

// ---------------------------------------------------------------------------
// Repair coverage (retry/handoff hardening)
// ---------------------------------------------------------------------------

test("/maxout save auto deletes the saved default so dynamic mode actually engages", async () => {
  await h.runCommand("save 32k");
  let raw = JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  assert.equal(raw.defaults["llama.cpp:qwen3-next"], 32768);

  await h.runCommand("save auto");
  raw = JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  assert.equal(raw.auto, true);
  assert.equal(raw.defaults["llama.cpp:qwen3-next"], undefined, "saved default must be removed");

  // effectiveOverride no longer returns the saved value -> auto sizing applies.
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 8000, "auto cold-start applied, not the stale saved default");
});

test("/maxout off fully disables payload patching after fixed or auto mode", async () => {
  await h.runCommand("save 32k");
  const seeded = JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  seeded.defaults["other:model"] = 8192;
  fs.writeFileSync(h.agentDir + "/pi-maxout.json", JSON.stringify(seeded));
  await h.runCommand("16k");
  await h.runCommand("off");

  const raw = JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  assert.equal(raw.auto, false);
  assert.deepEqual(raw.defaults, {}, "off clears every persisted fixed cap so model switches remain off");

  h.ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: LIMIT, percent: 1 });
  assert.equal(h.emit.before_provider_request({ payload: vllmPayload() }), undefined);
  assert.match(h.ui.status, /maxout off/);
});

test("/maxout limit accepts values above the catalog window; fixed caps still reject them", async () => {
  await h.runCommand("limit 500000"); // catalog says 131072 — catalogs lie
  const raw = JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  assert.equal(raw.contextLimits["llama.cpp:qwen3-next"], 500000);
  const bad = h.ui.notifies.some((n) => /exceeds the model context window/i.test(n.message));
  assert.equal(bad, false, "limit above catalog must not error");

  // fixed caps keep the catalog guard
  h.ui.notifies.length = 0;
  await h.runCommand("256k");
  assert.ok(
    h.ui.notifies.some((n) => /exceeds the model context window/i.test(n.message)),
    "fixed caps above the catalog are still rejected",
  );
});

test("before_agent_start awaits ctx.compact; failed attempts clean up so retries stay possible", async () => {
  h.setThinkingLevel("xhigh");
  h.ctx.isIdle = () => true;

  let mode = "controlled";
  let releaseCompaction;
  let completions = 0;
  h.ctx.compact = (options) => {
    h.compactions.push(options);
    if (mode === "error") {
      options.onError(new Error("boom"));
      return;
    }
    new Promise((resolve) => {
      releaseCompaction = () => {
        completions += 1;
        options.onComplete({ ok: true });
        resolve();
      };
    });
  };

  // Tight-but-not-urgent headroom: before_agent_start schedules compaction and
  // must NOT return until it settles (otherwise the main request races it).
  h.ctx.getContextUsage = () => ({ tokens: 99000, contextWindow: LIMIT, percent: 75 }); // room ~30K < 56K target
  const pending = h.emit.before_agent_start({});
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.compactions.length, 1);
  assert.equal(settled, false, "before_agent_start must wait for compaction to settle");
  assert.equal(completions, 0);
  releaseCompaction();
  await pending;
  assert.ok(settled, "await resolves once compaction completes");
  assert.equal(completions, 1);

  // A failed attempt (onError) cleans up the `compacting` flag instead of
  // wedging it on: a later urgent pass can schedule compaction again.
  mode = "error";
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 1000, contextWindow: LIMIT, percent: 99 }); // urgent (< min margin)
  await h.emit.agent_settled({});
  assert.equal(h.compactions.length, 2, "post-error cleanup must unblock future compaction");
});

test("session_compact clears the stale input estimate and last-patch record", () => {
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  h.emit.before_provider_request({ payload: vllmPayload() });
  assert.match(h.ui.status, /input 67\.3K/);

  // After compaction the usage is unknown until the next request reports it;
  // the stale pre-compaction estimate must not keep showing.
  h.ctx.getContextUsage = () => ({ tokens: null, contextWindow: LIMIT, percent: null });
  h.emit.session_compact({});
  assert.match(h.ui.status, /input \? • maxout off/);

  // describe() no longer claims a stale last patch either.
  const described = (async () => {
    await h.runCommand("status");
    return h.ui.notifies.at(-1).message;
  })();
  return described.then((text) => {
    assert.match(text, /last request patch: not observed yet/);
  });
});

test("margin learning is capped at one boost per attempt and suppressed after streaming started", () => {
  h.setThinkingLevel("high"); // cold-start target 16K
  h.ctx.getContextUsage = () => ({ tokens: 114000, contextWindow: LIMIT, percent: 87 });
  globalThis.__PI_MAXOUT_TEST_OVERFLOW = true;

  const first = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(first.max_tokens, LIMIT - 114000 - 2048);

  // Streaming starts, then an overflow error surfaces post-stream:
  // suppression means NO margin learning from this attempt.
  h.emit.message_update({ message: { role: "assistant", content: [] } });
  h.emit.message_end({
    message: { role: "assistant", stopReason: "error", errorMessage: "maximum context length exceeded" },
  });
  let again = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(again.max_tokens, LIMIT - 114000 - 2048, "post-stream overflow must not learn");

  // Fresh attempt without streaming: pre-stream rejection boosts exactly once,
  // even if several failure events arrive for the same attempt.
  h.emit.after_provider_response({ status: 400, headers: {} });
  h.emit.message_end({
    message: { role: "assistant", stopReason: "error", errorMessage: "maximum context length exceeded" },
  }); // same attempt -> must NOT stack a second boost
  again = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(again.max_tokens, LIMIT - 114000 - 4096, "exactly one boost step applied");
  delete globalThis.__PI_MAXOUT_TEST_OVERFLOW;
});

test("post-stream HTTP errors do not learn overflow margin", () => {
  h.setThinkingLevel("high");
  h.ctx.getContextUsage = () => ({ tokens: 114000, contextWindow: LIMIT, percent: 87 });
  h.emit.before_provider_request({ payload: vllmPayload() });
  h.emit.message_update({ message: { role: "assistant", content: [] } });
  h.emit.after_provider_response({ status: 413, headers: {} });

  const next = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(next.max_tokens, LIMIT - 114000 - 2048);
});

test("successful internal summary does not reset a main-attempt margin boost", () => {
  h.setThinkingLevel("high");
  h.ctx.getContextUsage = () => ({ tokens: 114000, contextWindow: LIMIT, percent: 87 });
  h.emit.before_provider_request({ payload: vllmPayload() });
  h.emit.after_provider_response({ status: 400, headers: {} });

  h.emit.session_before_compact({});
  h.emit.message_end({
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    },
  });
  h.emit.session_compact({});

  const next = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(next.max_tokens, LIMIT - 114000 - 4096, "summary success must not erase main overflow learning");
});

test("successful response resets the boost AND its notification dedupe", () => {
  h.setThinkingLevel("high");
  h.ctx.getContextUsage = () => ({ tokens: 97000, contextWindow: LIMIT, percent: 74 });
  const notifyCount = () => h.ui.notifies.filter((n) => /larger safety margin/i.test(n.message)).length;

  h.emit.before_provider_request({ payload: vllmPayload() });
  h.emit.after_provider_response({ status: 400, headers: {} });
  assert.ok(notifyCount() >= 1, "boost notifies");

  h.emit.message_end({
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    },
  });

  // Second independent overflow after success must notify again (dedupe reset).
  h.emit.before_provider_request({ payload: vllmPayload() });
  h.emit.after_provider_response({ status: 413, headers: {} });
  assert.equal(notifyCount(), 2, "reset clears the dedupe so future boosts re-notify");
});

test("auto target honors model.maxTokens advertisement", async () => {
  await h.runCommand("save auto");
  h.ctx.model = { ...MODEL, maxTokens: 20000 };
  h.setThinkingLevel("xhigh"); // table target 56K, model serves at most 20K
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 20000);
});

test("xhigh/max rewrites an existing numeric thinking_token_budget to min(50000, cap-4096)", () => {
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });

  h.setThinkingLevel("xhigh");
  const p1 = vllmPayload();
  p1.thinking_token_budget = 60000;
  const out1 = h.emit.before_provider_request({ payload: p1 });
  assert.equal(out1.thinking_token_budget, Math.min(50000, 32000 - 4096)); // 27904
  assert.equal(out1.max_tokens, 32000);

  // clamped cap drags the budget down with it
  h.ctx.getContextUsage = () => ({ tokens: 100000, contextWindow: LIMIT, percent: 76 });
  const p2 = vllmPayload();
  p2.thinking_token_budget = 50000;
  const out2 = h.emit.before_provider_request({ payload: p2 });
  const expectedCap = LIMIT - 100000 - 2048; // soft room clamps the learned target
  assert.equal(out2.max_tokens, expectedCap);
  assert.equal(out2.thinking_token_budget, Math.min(50000, expectedCap - 4096));
});

test("absent or lower-mode thinking budgets are never touched", () => {
  h.setThinkingLevel("xhigh");
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const absent = vllmPayload();
  const outA = h.emit.before_provider_request({ payload: absent });
  assert.equal("thinking_token_budget" in outA, false, "absent budget stays absent");

  h.setThinkingLevel("low");
  const low = vllmPayload();
  low.thinking_token_budget = 60000;
  const outLow = h.emit.before_provider_request({ payload: low });
  assert.equal(outLow.thinking_token_budget, 60000, "lower modes are untouched");
});

test("failed patches store their reason in the last-patch record", async () => {
  h.ctx.model = { ...MODEL, api: "totally-unknown-api" };
  h.ctx.getContextUsage = () => ({ tokens: 67347, contextWindow: LIMIT, percent: 51 });
  const payload = vllmPayload(); // has max_tokens already... use one without any budget field
  delete payload.compat;
  const bare = { ...payload };
  delete bare.max_tokens;
  const out = h.emit.before_provider_request({ payload: bare });
  assert.equal(out, undefined, "unknown api fails open");

  await h.runCommand("status");
  const text = h.ui.notifies.at(-1).message;
  assert.match(text, /not applied \(unsupported-api:totally-unknown-api\)/);
});

// ---------------------------------------------------------------------------
// Adaptive auto feedback (v2.2.0): attribution + dual targets
// ---------------------------------------------------------------------------

function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(h.agentDir + "/pi-maxout.json", "utf8"));
  } catch {
    return {}; // nothing was ever persisted in this session
  }
}

function writeStateFile(state) {
  fs.writeFileSync(h.agentDir + "/pi-maxout.json", `${JSON.stringify(state, null, 2)}\n`);
}

function seedProfile(id, fields) {
  const s = readStateFile();
  s.adaptiveProfiles = s.adaptiveProfiles ?? {};
  s.adaptiveProfiles[id] = { seq: 0, outputs: [], pressureCount: 0, windowResponses: 0, windowTruncations: 0, ...fields };
  writeStateFile(s);
}

const KEY = "llama.cpp:qwen3-next";

test("auto mode cold-starts conservatively per thinking level and learns independently", () => {
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });

  // low -> 8000; a length stop raises ONLY the low profile
  let out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 8000);
  h.emit.message_end({
    message: { role: "assistant", stopReason: "length", usage: { input: 9000, output: 500, cacheRead: 0, cacheWrite: 0 } },
  });

  // high is untouched by low's learning (cold start 16000), and rises on ITS own length stop
  h.setThinkingLevel("high");
  out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 16000);
  h.emit.message_end({
    message: { role: "assistant", stopReason: "length", usage: { input: 9000, output: 500, cacheRead: 0, cacheWrite: 0 } },
  });

  const learned = readStateFile().adaptiveProfiles;
  assert.equal(learned[`${KEY}:low`].capTarget, 12000);
  assert.equal(learned[`${KEY}:low`].reservationTarget, 12000);
  assert.equal(learned[`${KEY}:high`].capTarget, 24000);

  // a different model starts cold even at the same thinking level
  h.setThinkingLevel("high");
  h.ctx.model = { ...MODEL, id: "other-model" };
  const otherKey = "llama.cpp:other-model";
  out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 16000, "unlearned model uses its cold start");
  assert.equal(readStateFile().adaptiveProfiles[`${KEY}:high`].capTarget, 24000);
});

test("attributable length stop raises only the next attempt's cap and persists it", () => {
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  const first = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(first.max_tokens, 8000);

  h.emit.message_end({
    message: { role: "assistant", stopReason: "length", usage: { input: 9500, output: 8000, cacheRead: 0, cacheWrite: 0 } },
  });
  assert.equal(readStateFile().adaptiveProfiles[`${KEY}:low`].capTarget, 12000);

  const second = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(second.max_tokens, 12000);
});

test("provider token-limit stop aliases trigger adaptive growth", () => {
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  h.emit.before_provider_request({ payload: vllmPayload() });
  h.emit.message_end({
    message: { role: "assistant", stopReason: "max_tokens", usage: { input: 9500, output: 8000, cacheRead: 0, cacheWrite: 0 } },
  });
  assert.equal(readStateFile().adaptiveProfiles[`${KEY}:low`].capTarget, 12000);
});

test("successful short outputs grow reservation from p90 history without raising cap", () => {
  seedProfile(`${KEY}:xhigh`, {
    capTarget: 32000,
    reservationTarget: 8000,
    capFloor: 8000,
    capCeiling: 56000,
  });
  h.setThinkingLevel("xhigh");
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  assert.equal(h.emit.before_provider_request({ payload: vllmPayload() }).max_tokens, 32000);

  // two ~7K answers lift recent p90 above 6400 -> rung(1.25 * p90) = 12000
  for (let i = 0; i < 2; i++) {
    h.emit.message_end({
      message: { role: "assistant", stopReason: "stop", usage: { input: 10000, output: 7000, cacheRead: 0, cacheWrite: 0 } },
    });
    if (i === 0) {
      h.emit.before_provider_request({ payload: vllmPayload() }); // keep an attempt open for sample two
    }
  }
  const profile = readStateFile().adaptiveProfiles[`${KEY}:xhigh`];
  assert.equal(profile.reservationTarget, 12000);
  assert.equal(profile.capTarget, 32000, "short successful answers never raise the cap");
});

test("compaction is driven by the reservation target, not the cap target", async () => {
  // 32K cap with an 8K reservation: 12K of headroom must NOT compact.
  seedProfile(`${KEY}:high`, {
    capTarget: 32000,
    reservationTarget: 8000,
    capFloor: 8000,
    capCeiling: 56000,
  });
  h.setThinkingLevel("high");
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 2048 - 12000, contextWindow: LIMIT, percent: 89 });
  await h.emit.agent_settled({});
  assert.equal(h.compactions.length, 0, "12K remaining >= 8K reservation: no compaction despite 32K cap");

  // Same cap but a large reservation: less room now justifies compacting.
  seedProfile(`${KEY}:high`, {
    capTarget: 32000,
    reservationTarget: 32000,
    capFloor: 8000,
    capCeiling: 56000,
  });
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 2048 - 30000, contextWindow: LIMIT, percent: 75 });
  await h.emit.agent_settled({});
  assert.equal(h.compactions.length, 1, "30K remaining < 32K reservation: compaction scheduled");
});

test("provider ceiling bounds both the patched cap and the effective reservation", async () => {
  h.ctx.model = { ...MODEL, maxTokens: 20000 };
  h.setThinkingLevel("xhigh"); // cold target 32000 > provider ceiling
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 2048 - 25000, contextWindow: LIMIT, percent: 79 });
  await h.emit.agent_settled({});
  assert.equal(h.compactions.length, 0, "25K room serves a 20K provider ceiling without compacting");

  h.ctx.isIdle = () => false;
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 20000);
});

test("two successful maxout compactions inside eight responses downshift one rung", async () => {
  seedProfile(`${KEY}:xhigh`, {
    capTarget: 24000,
    reservationTarget: 24000,
    capFloor: 8000,
    capCeiling: 56000,
  });
  h.setThinkingLevel("xhigh");
  h.ctx.isIdle = () => true;

  // Compaction #1 completes (pressure opens).
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 2048 - 10000, contextWindow: LIMIT, percent: 91 });
  await h.emit.agent_settled({});
  assert.equal(h.compactions.length, 1);
  let profile = readStateFile().adaptiveProfiles[`${KEY}:xhigh`];
  assert.equal(profile.capTarget, 24000, "one compaction alone never downshifts");

  // One observed main response between compactions keeps the window alive.
  h.ctx.isIdle = () => false;
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 2048 - 10000, contextWindow: LIMIT, percent: 91 });
  h.emit.before_provider_request({ payload: vllmPayload() });
  h.emit.message_end({
    message: { role: "assistant", stopReason: "stop", usage: { input: 100000, output: 400, cacheRead: 0, cacheWrite: 0 } },
  });
  h.ctx.isIdle = () => true;

  // Compaction #2 arrives urgent (near-full context bypasses the cooldown)...
  globalThis.__PI_MAXOUT_TEST_OVERFLOW = false;
  h.ctx.compact = (options) => {
    h.compactions.push(options);
    options.onComplete({ ok: true });
  };
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 2048 - 500, contextWindow: LIMIT, percent: 99 });
  await h.emit.agent_settled({});
  assert.equal(h.compactions.length, 2);

  profile = readStateFile().adaptiveProfiles[`${KEY}:xhigh`];
  assert.equal(profile.capTarget, 16000, "second compaction downshifts one rung");
  assert.equal(profile.reservationTarget, 16000);
  assert.equal(profile.pressureCount, 0, "window clears after the downshift");
  delete globalThis.__PI_MAXOUT_TEST_OVERFLOW;
});

test("failed maxout compactions and Pi-core compactions never create pressure", async () => {
  seedProfile(`${KEY}:xhigh`, {
    capTarget: 24000,
    reservationTarget: 24000,
    capFloor: 8000,
    capCeiling: 56000,
  });
  h.setThinkingLevel("xhigh");
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 2048 - 10000, contextWindow: LIMIT, percent: 91 });

  // failed maxout compaction: onError instead of onComplete
  h.ctx.compact = (options) => {
    h.compactions.push(options);
    options.onError(new Error("boom"));
  };
  await h.emit.agent_settled({});
  let profile = readStateFile().adaptiveProfiles[`${KEY}:xhigh`];
  assert.equal(profile.capTarget, 24000);
  assert.equal(profile.pressureCount ?? 0, 0, "failed compactions add no pressure");

  // Pi-core overflow compaction goes through session hooks, not ctx.compact
  h.emit.session_before_compact({ reason: "overflow" });
  h.emit.session_compact({ reason: "overflow" });
  profile = readStateFile().adaptiveProfiles[`${KEY}:xhigh`];
  assert.equal(profile.pressureCount ?? 0, 0, "core compactions are not maxout pressure");
});

test("fixed overrides bypass adaptive learning entirely", async () => {
  await h.runCommand("save 16384");
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 16384, "fixed cap behavior unchanged");

  // even an explicit length stop teaches nothing in fixed mode
  h.emit.message_end({
    message: { role: "assistant", stopReason: "length", usage: { input: 9000, output: 15000, cacheRead: 0, cacheWrite: 0 } },
  });
  const profiles = readStateFile().adaptiveProfiles ?? {};
  assert.deepEqual(Object.keys(profiles), [], "no profile may be created while a fixed override is active");
});

test("unsupported payload APIs create no attempt and learn nothing", async () => {
  h.ctx.model = { ...MODEL, api: "totally-unknown-api" };
  delete h.ctx.model.compat;
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  const bare = vllmPayload();
  delete bare.max_tokens;
  const out = h.emit.before_provider_request({ payload: bare });
  assert.equal(out, undefined, "fails open like v2.1");

  h.emit.message_end({
    message: { role: "assistant", stopReason: "length", usage: { input: 9000, output: 9000, cacheRead: 0, cacheWrite: 0 } },
  });
  const profiles = readStateFile().adaptiveProfiles ?? {};
  assert.deepEqual(Object.keys(profiles), [], "an unpatched request cannot attribute learning");
});

test("learned profiles survive session reload and fresh sessions", () => {
  seedProfile(`${KEY}:low`, { capTarget: 24000, reservationTarget: 24000, capFloor: 8000, capCeiling: 16000 });
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });

  h.emit.session_start({ reason: "reload" });
  let out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 16000, "reload keeps learning (ceiling-clamped cap)");

  // a brand-new session must not wipe persisted learning either
  h.emit.session_start({ reason: "new" });
  out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 16000);

  // one attributable observation persists a NORMALIZED copy of the entry
  h.emit.message_end({
    message: { role: "assistant", stopReason: "length", usage: { input: 9000, output: 2000, cacheRead: 0, cacheWrite: 0 } },
  });
  const storedProfile = readStateFile().adaptiveProfiles[`${KEY}:low`];
  assert.equal(storedProfile.capTarget, 16000, "ceiling-clamped learned values are what get persisted");
});

test("lazy decay persists before the next response observation", () => {
  seedProfile(`${KEY}:low`, {
    capTarget: 16000,
    reservationTarget: 16000,
    capFloor: 8000,
    capCeiling: 16000,
    outputs: [9000],
    updatedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
  });
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 12000, "request uses one-rung decay");
  h.emit.message_end({
    message: { role: "assistant", stopReason: "stop", usage: { input: 9000, output: 500, cacheRead: 0, cacheWrite: 0 } },
  });
  assert.equal(readStateFile().adaptiveProfiles[`${KEY}:low`].capTarget, 12000, "observation must not resurrect stale pre-decay cap");
});

// ---------------------------------------------------------------------------
// User controls & status (v2.2.0)
// ---------------------------------------------------------------------------

test("/maxout status reports the active learned profile", async () => {
  seedProfile(`${KEY}:low`, {
    capTarget: 12000,
    reservationTarget: 8000,
    capFloor: 8000,
    capCeiling: 16000,
    outputs: [4000, 6000],
    pressureCount: 1,
  });
  await h.runCommand("status");
  const text = h.ui.notifies.at(-1).message;
  assert.match(text, /auto-adaptive \(cap 12\.0K @ low\)/);
  assert.match(text, /learning: reserve 8\.0K • 2 recent outputs • compaction pressure 1/);
});

test("unlearned models report the real cold cap without claiming learned history", async () => {
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  const out = h.emit.before_provider_request({ payload: vllmPayload() });
  assert.equal(out.max_tokens, 8000);
  await h.runCommand("status");
  const text = h.ui.notifies.at(-1).message;
  assert.match(text, /auto-adaptive \(cap 8\.0K @ low\)/);
  assert.doesNotMatch(text, /learning:/, "a cold-start-only profile is not 'learned'");
});

test("/maxout learn reset clears only learning data", async () => {
  // other settings that must survive the reset
  await h.runCommand("margin 4096");
  await h.runCommand("limit 100000");

  seedProfile(`${KEY}:low`, { capTarget: 12000, reservationTarget: 12000, capFloor: 8000, capCeiling: 16000 });
  seedProfile(`${KEY}:high`, { capTarget: 24000, reservationTarget: 24000, capFloor: 8000, capCeiling: 32000 });

  await h.runCommand("learn reset");
  let raw = readStateFile();
  assert.deepEqual(raw.adaptiveProfiles, {}, "reset must clear every learned profile");
  assert.equal(raw.safetyMarginTokens, 4096, "margin survives");
  assert.equal(raw.contextLimits[KEY], 100000, "context-limit override survives");
  assert.equal(raw.auto, true, "auto stays enabled");
  assert.equal(raw.defaults[KEY], undefined, "no fixed default invented");

  // the next request restarts from the cold start
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  assert.equal(h.emit.before_provider_request({ payload: vllmPayload() }).max_tokens, 8000);

  // bare /maxout learn reports usage without destroying anything
  seedProfile(`${KEY}:low`, { capTarget: 12000 });
  await h.runCommand("learn");
  raw = readStateFile();
  assert.ok(raw.adaptiveProfiles[`${KEY}:low`], "bare 'learn' must not clear anything");

  await h.runCommand("learn nonsense");
  assert.ok(h.ui.notifies.some((n) => n.severity === "warning" && /Usage: \/maxout learn reset/.test(n.message)));
});
