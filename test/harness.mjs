/** Fake Pi runtime + extension loader for integration tests. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./stub-loader.mjs", import.meta.url);

export async function loadExtension({ model }) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-maxout-test-"));
  globalThis.__PI_MAXOUT_TEST_AGENT_DIR = agentDir;

  const handlers = new Map();
  let commandHandler = null;
  const sends = [];
  const compactions = [];

  /** @type any */
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(_name, def) {
      commandHandler = def.handler;
    },
  };

  /** @type any */
  const ctx = {
    model,
    thinkingLevel: "low",
    hasUI: true,
    isIdle: () => false,
    getContextUsage: () => ({ tokens: null, contextWindow: model?.contextWindow ?? 0, percent: null }),
    compact(options) {
      compactions.push(options);
      options?.onComplete?.({ ok: true });
    },
    ui: {
      status: "",
      notifies: [],
      setStatus(_key, value) {
        this.status = value;
      },
      notify(message, severity) {
        this.notifies.push({ message, severity });
      },
    },
  };

  // Load the real extension entry (TS type-stripping enabled via the
  // --experimental-strip-types flag in the npm test script).
  const mod = await import("../index.ts");
  mod.default(pi);

  const emit = {
    before_provider_request: (event) => {
      const out = handlers.get("before_provider_request")(event, ctx);
      if (out) sends.push(out);
      return out;
    },
    before_agent_start: async (event) => {
      const handler = handlers.get("before_agent_start");
      if (!handler) return;
      await handler(event, ctx); // mirrors Pi: the agent awaits this hook
    },
    after_provider_response: (event) => handlers.get("after_provider_response")?.(event, ctx),
    message_update: (event) => handlers.get("message_update")?.(event, ctx),
    message_end: (event) => handlers.get("message_end")?.(event, ctx),
    session_before_compact: (event) => handlers.get("session_before_compact")?.(event, ctx),
    session_compact: (event) => handlers.get("session_compact")?.(event, ctx),
    agent_settled: async (event) => {
      await handlers.get("agent_settled")?.(event, ctx);
      // settle any fire-and-forget compaction started by the handler
      await new Promise((resolve) => setImmediate(resolve));
    },
    session_start: (event) => handlers.get("session_start")?.(event, ctx),
    thinking_level_select: (event) => handlers.get("thinking_level_select")?.(event, ctx),
  };

  // Fresh session semantics: clears module-level session maps between tests.
  emit.session_start({ reason: "new" });

  return {
    ctx,
    emit,
    sends,
    compactions,
    ui: ctx.ui,
    agentDir,
    setThinkingLevel(level) {
      ctx.thinkingLevel = level;
      emit.thinking_level_select({ level });
    },
    runCommand: async (args) => {
      if (!commandHandler) throw new Error("command not registered");
      await commandHandler(args, { ...ctx });
    },
  };
}
