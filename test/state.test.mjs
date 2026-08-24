import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeState, STATE_VERSION, parseTokenSpec } from "../core.mjs";

const MODEL = { provider: "llama.cpp", id: "gpt-oss", contextWindow: 131072, maxTokens: 131072 };

test("v1 state files migrate cleanly to the v2 schema", () => {
  const v1 = { version: 1, defaults: { "llama.cpp:gpt-oss": 32768 } };
  const s = normalizeState(v1);
  assert.equal(s.version, STATE_VERSION);
  assert.equal(STATE_VERSION, 2);
  assert.deepEqual(s.defaults, { "llama.cpp:gpt-oss": 32768 });
  assert.equal(s.auto, true); // dynamic auto is the default
  assert.equal(s.safetyMarginTokens, 2048);
  assert.deepEqual(s.targets, {});
  assert.deepEqual(s.contextLimits, {});
});

test("garbage/missing state yields safe defaults", () => {
  for (const input of [undefined, null, "junk", 42, [], {}]) {
    const s = normalizeState(input);
    assert.equal(s.version, 2);
    assert.deepEqual(s.defaults, {});
    assert.equal(s.auto, true);
    assert.equal(s.safetyMarginTokens, 2048);
  }
});

test("safety margin below 1024 is coerced to the floor", () => {
  assert.equal(normalizeState({ safetyMarginTokens: 1 }).safetyMarginTokens, 1024);
  assert.equal(normalizeState({ safetyMarginTokens: 4096 }).safetyMarginTokens, 4096);
  assert.equal(normalizeState({ safetyMarginTokens: "big" }).safetyMarginTokens, 2048);
});

test("targets keep only known levels with positive integer values", () => {
  const s = normalizeState({ targets: { high: 40000, nonsense: 999, xhigh: -5, off: "x" } });
  assert.deepEqual(s.targets, { high: 40000 });
});

test("context limits reject prototype pollution and bad values", () => {
  const s = normalizeState({
    contextLimits: { "llama.cpp:x": 131072, __proto__: { evil: 1 }, evil2: 0 },
  });
  assert.deepEqual(s.contextLimits, { "llama.cpp:x": 131072 });
  const s2 = normalizeState({ defaults: { __proto__: 1, constructor: 5, ok: 12 } });
  assert.deepEqual(s2.defaults, { ok: 12 });
});

test("normalizeState is idempotent", () => {
  const once = normalizeState({
    defaults: { "a:b": 1024 },
    auto: false,
    safetyMarginTokens: 8192,
    targets: { xhigh: 60000 },
    contextLimits: { "p:m": 200000 },
  });
  assert.deepEqual(normalizeState(once), once);
});

test("legacy explicit-override parsing still works alongside v2 fields", () => {
  assert.equal(parseTokenSpec("32k", MODEL).value, 32768);
  assert.equal(parseTokenSpec("auto", MODEL).kind, "auto");
  assert.equal(parseTokenSpec("max", MODEL).value, 131072);
});

test("parseTokenSpec: above-catalog values allowed only with allowAboveCatalogContext", () => {
  // fixed caps keep the catalog guard
  const blocked = parseTokenSpec("256k", MODEL);
  assert.equal(blocked.kind, "error");

  // /maxout limit exists to correct lying catalogs -> allowed above catalog
  const limit = parseTokenSpec("500k", MODEL, { allowAboveCatalogContext: true });
  assert.deepEqual(limit, { kind: "value", value: 512000 });

  // garbage is still rejected even with the bypass
  const junk = parseTokenSpec("abc", MODEL, { allowAboveCatalogContext: true });
  assert.equal(junk.kind, "error");
});
