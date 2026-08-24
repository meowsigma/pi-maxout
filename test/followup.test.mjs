import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadExtension } from "./harness.mjs";

const LIMIT = 131072;
const MODEL = {
  provider: "llama.cpp",
  id: "followup",
  api: "openai-completions",
  contextWindow: LIMIT,
  maxTokens: LIMIT,
  compat: { maxTokensField: "max_tokens" },
};

function payload(extra = {}) {
  return {
    model: MODEL.id,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "bash" } }],
    ...extra,
  };
}

let h;
beforeEach(async () => {
  globalThis.__PI_MAXOUT_TEST_OVERFLOW = true;
  h = await loadExtension({ model: { ...MODEL } });
});

test("real 200 -> stream update -> overflow does not learn a margin boost", () => {
  h.setThinkingLevel("high");
  h.ctx.getContextUsage = () => ({ tokens: 97000, contextWindow: LIMIT, percent: 74 });
  assert.equal(h.emit.before_provider_request({ payload: payload() }).max_tokens, 32000);
  h.emit.after_provider_response({ status: 200, headers: {} });
  h.emit.message_update({ message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
  h.emit.message_end({
    message: { role: "assistant", stopReason: "error", errorMessage: "maximum context length exceeded" },
  });
  assert.equal(h.emit.before_provider_request({ payload: payload() }).max_tokens, 32000);
});

test("active auto-compaction request is suspended even though agent is not idle", () => {
  h.ctx.isIdle = () => false;
  h.ctx.getContextUsage = () => ({ tokens: 100000, contextWindow: LIMIT, percent: 76 });
  h.emit.session_before_compact({ reason: "overflow", willRetry: true });
  const summary = {
    model: MODEL.id,
    stream: true,
    max_tokens: 13107,
    messages: [{ role: "system", content: "summary" }],
  };
  const before = structuredClone(summary);
  assert.equal(h.emit.before_provider_request({ payload: summary }), undefined);
  assert.deepEqual(summary, before);

  h.emit.session_compact({ reason: "overflow", willRetry: true });
  const main = h.emit.before_provider_request({ payload: payload() });
  assert.ok(main?.max_tokens > 0, "main sizing resumes after compaction");
});

test("urgent before-agent compaction is awaited", async () => {
  h.setThinkingLevel("xhigh");
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => ({ tokens: LIMIT - 500, contextWindow: LIMIT, percent: 99 });
  let release;
  h.ctx.compact = (options) => {
    h.compactions.push(options);
    release = () => options.onComplete({ ok: true });
  };
  const pending = h.emit.before_agent_start({});
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.compactions.length, 1);
  assert.equal(settled, false);
  release();
  await pending;
  assert.equal(settled, true);
});

test("status and proactive compaction honor model.maxTokens", async () => {
  h.ctx.model = { ...MODEL, maxTokens: 8192 };
  h.ctx.getContextUsage = () => ({ tokens: 110000, contextWindow: LIMIT, percent: 84 });
  h.ctx.isIdle = () => true;
  h.setThinkingLevel("xhigh");
  assert.match(h.ui.status, /maxout 8\.2K/);
  await h.emit.before_agent_start({});
  assert.equal(h.compactions.length, 0, "~19K safe room is enough for an 8K provider ceiling");
});

test("unsupported max-token API is untouched even with thinking_token_budget", () => {
  h.ctx.model = { ...MODEL, api: "unsupported-api" };
  h.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: LIMIT, percent: 8 });
  h.setThinkingLevel("xhigh");
  const request = payload({ thinking_token_budget: 16000 });
  const before = structuredClone(request);
  assert.equal(h.emit.before_provider_request({ payload: request }), undefined);
  assert.deepEqual(request, before);
  h.emit.after_provider_response({ status: 400, headers: {} });
});

test("failed nonurgent compaction can retry immediately", async () => {
  h.setThinkingLevel("xhigh");
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => ({ tokens: 99000, contextWindow: LIMIT, percent: 75 });
  h.ctx.compact = (options) => {
    h.compactions.push(options);
    options.onError(new Error("boom"));
  };
  await h.emit.before_agent_start({});
  await h.emit.before_agent_start({});
  assert.equal(h.compactions.length, 2);
});
