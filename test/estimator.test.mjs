import { test } from "node:test";
import assert from "node:assert/strict";

import { estimatePayloadInputTokens, combineInputEstimates } from "../auto.mjs";

const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk. ".repeat(40),
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

function openAiPayload({ withTools = true, bigUserText = "hello world ".repeat(100) } = {}) {
  const payload = {
    model: "local-model",
    stream: true,
    messages: [
      { role: "system", content: "You are a coding agent. ".repeat(50) },
      { role: "user", content: bigUserText },
      { role: "assistant", content: "Working on it." },
      { role: "user", content: "Thanks, continue." },
    ],
  };
  if (withTools) payload.tools = CHAT_TOOLS;
  return payload;
}

test("estimator: exact hand-counted formula on a minimal payload", () => {
  // walk counts: keys ("role"=4, "content"=7) + string values ("user"=4, "abcd"=4) = 19 chars
  const payload = { messages: [{ role: "user", content: "abcd" }] };
  const expected = Math.ceil(19 / 4) + 24 * 1;
  assert.equal(estimatePayloadInputTokens(payload), expected);
});

test("estimator is deterministic and grows with content", () => {
  const a = estimatePayloadInputTokens(openAiPayload({ withTools: false }));
  const b = estimatePayloadInputTokens(openAiPayload({ withTools: false }));
  assert.equal(a, b);
  const bigger = estimatePayloadInputTokens(openAiPayload({ withTools: false, bigUserText: "x".repeat(10_000) }));
  assert.ok(bigger > a + 2000);
});

test("tool schemas are included in accounting", () => {
  const without = estimatePayloadInputTokens(openAiPayload({ withTools: false }));
  const withT = estimatePayloadInputTokens(openAiPayload({ withTools: true }));
  // walk counts the tool's string content (~984 chars ≈ ~246 tokens); use a
  // conservative lower bound well above structural noise.
  assert.ok(withT - without >= 200, `tool schema tokens must be counted (diff=${withT - without})`);
  assert.ok(withT - without <= 400, "but not double-counted");
});

test("anthropic-style payloads count system + tools + messages", () => {
  const payload = {
    system: "sys prompt ".repeat(100),
    tools: [{ name: "bash", description: "x".repeat(400), input_schema: { type: "object" } }],
    max_tokens: 4096,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] },
    ],
  };
  const est = estimatePayloadInputTokens(payload);
  // lower bound from pure text content alone (keys add a little more)
  const textChars =
    payload.system.length +
    400 +
    payload.messages.reduce((acc, m) => {
      if (typeof m.content === "string") return acc + m.content.length;
      return (
        acc +
        m.content.reduce((a, b) => a + (b.text?.length ?? 0) + (b.input ? JSON.stringify(b.input).length : 0), 0)
      );
    }, 0);
  assert.ok(est >= Math.ceil(textChars / 4) + 24 * payload.messages.length);
  assert.ok(est < Math.ceil((textChars * 1.5) / 4) + 24 * payload.messages.length);
});

test("base64 images are counted at a fixed image cost, not as raw characters", () => {
  const base64 = "A".repeat(200_000); // would be ~50K tokens if counted as chars
  const blockMsg = (url) => [
    { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url } }] },
  ];
  const baseline = estimatePayloadInputTokens({ tools: CHAT_TOOLS, messages: blockMsg("https://example.invalid/x.png") });
  const est = estimatePayloadInputTokens({ tools: CHAT_TOOLS, messages: blockMsg(`data:image/png;base64,${base64}`) });
  // fixed image cost minus the tiny URL string that no longer counts as chars
  assert.ok(est >= baseline + IMAGE_COST_FLOOR, `expected ~+2K, got +${est - baseline}`);
  assert.ok(est <= baseline + IMAGE_COST_CEIL, `must not count raw base64 chars (got +${est - baseline})`);
});

const IMAGE_COST_FLOOR = 2048 - 32;
const IMAGE_COST_CEIL = 2048 + 32;

test("combineInputEstimates takes the conservative maximum", () => {
  assert.equal(combineInputEstimates(null, null), null);
  assert.equal(combineInputEstimates(5000, null), 5000);
  assert.equal(combineInputEstimates(null, 7000), 7000);
  assert.equal(combineInputEstimates(5000, 7000), 7000);
});

test("usage-based estimate is preferred when larger (server ground truth)", () => {
  const payload = openAiPayload();
  const payloadEst = estimatePayloadInputTokens(payload);
  const combined = combineInputEstimates(payloadEst + 3000, payloadEst);
  assert.equal(combined, payloadEst + 3000);
});
