import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeState, STATE_VERSION, parseTokenSpec } from "../core.mjs";

const MODEL = { provider: "llama.cpp", id: "gpt-oss", contextWindow: 131072, maxTokens: 131072 };

test("v1 state files migrate cleanly to the current schema", () => {
  const v1 = { version: 1, defaults: { "llama.cpp:gpt-oss": 32768 } };
  const s = normalizeState(v1);
  assert.equal(s.version, STATE_VERSION);
  assert.equal(STATE_VERSION, 3);
  assert.deepEqual(s.defaults, { "llama.cpp:gpt-oss": 32768 });
  assert.equal(s.auto, true); // dynamic auto is the default
  assert.equal(s.safetyMarginTokens, 2048);
  assert.deepEqual(s.targets, {});
  assert.deepEqual(s.contextLimits, {});
  assert.deepEqual(s.adaptiveProfiles, {});
});

test("v2 state files migrate to v3 preserving every prior setting", () => {
  const v2 = {
    version: 2,
    defaults: { "a:b": 1024 },
    auto: false,
    safetyMarginTokens: 8192,
    targets: { high: 40000 },
    contextLimits: { "p:m": 200000 },
  };
  const s = normalizeState(v2);
  assert.equal(s.version, 3);
  assert.equal(s.defaults["a:b"], 1024);
  assert.equal(s.auto, false);
  assert.equal(s.safetyMarginTokens, 8192);
  assert.deepEqual(s.targets, { high: 40000 });
  assert.deepEqual(s.contextLimits, { "p:m": 200000 });
  assert.deepEqual(s.adaptiveProfiles, {});
});

test("garbage/missing state yields safe defaults", () => {
  for (const input of [undefined, null, "junk", 42, [], {}]) {
    const s = normalizeState(input);
    assert.equal(s.version, STATE_VERSION);
    assert.deepEqual(s.adaptiveProfiles, {});
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

test("adaptive profiles round-trip valid learning and drop hostile data", () => {
  const good = {
    capTarget: 12000,
    reservationTarget: 8000,
    capFloor: 8000,
    capCeiling: 16000,
    outputs: Array.from({ length: 20 }, (_, i) => i + 1), // oversized history
    pressureCount: 1,
    windowResponses: 2,
    windowTruncations: 0,
    seq: 7,
    updatedAt: 1700000000000,
  };
  const s = normalizeState({
    adaptiveProfiles: {
      "llama.cpp:gpt-oss:low": good,
      "llama.cpp:evil:high": { capTarget: { evil: true } }, // junk value object
      __proto__: { injected: 1 }, // prototype pollution attempt
      constructor: 42, // unsafe key with junk scalar
      "llama.cpp:xhigh": "not-an-object",
      "p:m:not-a-level": { capTarget: 12000 },
      "p:m:low:extra": { capTarget: 12000 },
    },
  });
  assert.deepEqual(Object.keys(s.adaptiveProfiles).sort(), ["llama.cpp:gpt-oss:low"]);
  const learned = s.adaptiveProfiles["llama.cpp:gpt-oss:low"];
  assert.equal(learned.capTarget, 12000);
  assert.equal(learned.reservationTarget, 8000);
  assert.equal(Object.hasOwn(s.adaptiveProfiles, "__proto__"), false);
  assert.equal(Object.hasOwn(s.adaptiveProfiles, "constructor"), false);
  assert.equal(Object.getPrototypeOf(s.adaptiveProfiles), Object.prototype);
  assert.ok(Array.isArray(learned.outputs));
  assert.ok(learned.outputs.length <= 12, "history must be truncated to twelve samples");
  assert.deepEqual(learned.outputs.slice(-3), [18, 19, 20], "the LATEST twelve samples are kept");
});

test("future-dated adaptive timestamps are discarded without dropping valid targets", () => {
  const s = normalizeState({
    adaptiveProfiles: {
      "p:m:low": {
        capTarget: 12000,
        reservationTarget: 8000,
        updatedAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      },
    },
  });
  assert.equal(s.adaptiveProfiles["p:m:low"].capTarget, 12000);
  assert.equal(s.adaptiveProfiles["p:m:low"].updatedAt, undefined);
});

test("normalizeState stays idempotent with adaptive profiles present", () => {
  const once = normalizeState({
    adaptiveProfiles: {
      "p:m:high": { capTarget: 32000, reservationTarget: 24000, outputs: [500, 700] },
    },
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
