/**
 * pi-maxout v1.0.0
 *
 * A conservative, provider-aware /maxout command for Pi.
 * It changes only the final outgoing completion cap. It does not alter reasoning
 * effort, context size, model metadata, or llama.cpp launch settings.
 */

import fs from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  formatTokens,
  modelKey,
  normalizeState,
  parseTokenSpec,
  patchMaxTokensPayload,
} from "./core.mjs";

const VERSION = "1.0.0";
const STATUS_KEY = "pi-maxout";
const STATE_PATH = path.join(getAgentDir(), "pi-maxout.json");

const sessionOverrides = new Map<string, number>();
const lastPatch = new Map<string, { cap: number; field: string | null; reason?: string }>();

type StateRead = {
  state: { version: number; defaults: Record<string, number> };
  error?: string;
};

function readState(): StateRead {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return { state: normalizeState(JSON.parse(raw)) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { state: normalizeState(undefined) };
    return {
      state: normalizeState(undefined),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeState(state: { version: number; defaults: Record<string, number> }): string | undefined {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });

  const current = readState();
  let backupPath: string | undefined;
  if (current.error && fs.existsSync(STATE_PATH)) {
    backupPath = `${STATE_PATH}.invalid-${timestampForFilename()}`;
    fs.copyFileSync(STATE_PATH, backupPath);
  }

  const tempPath = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tempPath, STATE_PATH);
    try {
      fs.chmodSync(STATE_PATH, 0o600);
    } catch {
      // Some non-POSIX filesystems do not support chmod; the atomic write still succeeded.
    }
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  return backupPath;
}

function effectiveOverride(model: ExtensionContext["model"]): {
  key: string | null;
  value: number | null;
  source: "none" | "session" | "saved" | "provider";
  stateError?: string;
} {
  const key = modelKey(model);
  if (!key) return { key: null, value: null, source: "none" };

  const sessionValue = sessionOverrides.get(key);
  if (Number.isSafeInteger(sessionValue) && (sessionValue ?? 0) > 0) {
    return { key, value: sessionValue ?? null, source: "session" };
  }

  const loaded = readState();
  const savedValue = loaded.state.defaults[key];
  if (Number.isSafeInteger(savedValue) && savedValue > 0) {
    return { key, value: savedValue, source: "saved", stateError: loaded.error };
  }

  return { key, value: null, source: "provider", stateError: loaded.error };
}

function statusLabel(ctx: ExtensionContext): string {
  const current = effectiveOverride(ctx.model);
  if (!current.value) return "maxout:auto";
  const previous = current.key ? lastPatch.get(current.key) : undefined;
  const failed = previous && previous.cap === current.value && !previous.field;
  return `maxout:${formatTokens(current.value)}${failed ? "!" : ""}`;
}

function updateStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, statusLabel(ctx));
}

function describe(ctx: ExtensionContext): string {
  const model = ctx.model;
  if (!model) return "No active model.";

  const current = effectiveOverride(model);
  const declared = Number(model.maxTokens);
  const context = Number(model.contextWindow);
  const previous = current.key ? lastPatch.get(current.key) : undefined;

  const lines = [
    `${model.provider}/${model.id}`,
    `override: ${current.value ? formatTokens(current.value) : "auto"} (${current.source})`,
    `Pi declared max-out: ${Number.isSafeInteger(declared) && declared > 0 ? formatTokens(declared) : "unknown"}`,
    `context: ${Number.isSafeInteger(context) && context > 0 ? formatTokens(context) : "unknown"}`,
  ];

  if (previous && current.value && previous.cap === current.value) {
    lines.push(
      previous.field
        ? `last request patch: ${previous.field}=${previous.cap}`
        : `last request patch: not applied (${previous.reason ?? "unsupported payload"})`,
    );
  } else {
    lines.push("last request patch: not observed for this setting yet");
  }

  if (current.value && Number.isSafeInteger(declared) && declared > 0 && current.value > declared) {
    lines.push("warning: override exceeds Pi's catalog max-out; the provider/server may clamp or reject it.");
  }
  if (current.stateError) lines.push(`state warning: ${current.stateError}`);
  lines.push(`extension: pi-maxout v${VERSION}`);

  return lines.join("\n");
}

function notifyResult(ctx: ExtensionCommandContext, backupPath?: string): void {
  updateStatus(ctx);
  const pending = ctx.isIdle() ? "" : "\nApplies to the next provider request.";
  const backup = backupPath ? `\nBacked up invalid state to: ${backupPath}` : "";
  ctx.ui.notify(`${describe(ctx)}${pending}${backup}`, "info");
}

export default function maxoutExtension(pi: ExtensionAPI): void {
  pi.registerCommand("maxout", {
    description: "Inspect or change the provider completion-token cap",
    getArgumentCompletions: (prefix) => {
      const options = [
        "status",
        "auto",
        "16k",
        "32k",
        "64k",
        "128k",
        "max",
        "save auto",
        "save 16k",
        "save 32k",
        "save 64k",
        "save 128k",
        "save max",
      ];
      const value = String(prefix ?? "").trimStart().toLowerCase();
      const matches = options.filter((option) => option.startsWith(value));
      return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null;
    },
    handler: async (args, ctx) => {
      const model = ctx.model;
      const key = modelKey(model);
      if (!model || !key) {
        ctx.ui.notify("No active model.", "warning");
        return;
      }

      const raw = String(args ?? "").trim();
      if (!raw || raw.toLowerCase() === "status") {
        updateStatus(ctx);
        ctx.ui.notify(describe(ctx), "info");
        return;
      }

      const saveMatch = raw.match(/^save(?:\s+(.+))?$/i);
      const persist = Boolean(saveMatch);
      const valueRaw = persist ? String(saveMatch?.[1] ?? "").trim() : raw;
      if (persist && !valueRaw) {
        ctx.ui.notify("Usage: /maxout save 32k  |  /maxout save auto", "warning");
        return;
      }

      const parsed = parseTokenSpec(valueRaw, model);
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }
      if (parsed.kind === "status") {
        updateStatus(ctx);
        ctx.ui.notify(describe(ctx), "info");
        return;
      }

      lastPatch.delete(key);

      if (persist) {
        const loaded = readState();
        const next = normalizeState(loaded.state);
        if (parsed.kind === "auto") delete next.defaults[key];
        else next.defaults[key] = parsed.value;
        const backupPath = writeState(next);
        sessionOverrides.delete(key);
        notifyResult(ctx, backupPath);
        return;
      }

      if (parsed.kind === "auto") sessionOverrides.delete(key);
      else sessionOverrides.set(key, parsed.value);
      notifyResult(ctx);
    },
  });

  pi.on("session_start", (event, ctx) => {
    // Session overrides survive /reload but not a new/resumed/forked session.
    if (event.reason !== "reload") {
      sessionOverrides.clear();
      lastPatch.clear();
    }
    updateStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const current = effectiveOverride(ctx.model);
    if (!current.key || !current.value) return undefined;

    const result = patchMaxTokensPayload(event.payload, current.value, ctx.model);
    lastPatch.set(current.key, {
      cap: current.value,
      field: result.field,
      reason: result.reason,
    });
    updateStatus(ctx);

    return result.changed ? result.payload : undefined;
  });
}
