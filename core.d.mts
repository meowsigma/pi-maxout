export type ModelLike = {
  provider?: string;
  id?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  // Provider compat objects are structurally heterogeneous unions in pi-ai;
  // runtime code only ever probes them with isRecord-style checks.
  compat?: unknown;
};

export type MaxoutState = {
  version: number;
  defaults: Record<string, number>;
  auto: boolean;
  safetyMarginTokens: number;
  targets: Record<string, number>;
  contextLimits: Record<string, number>;
};

export type TokenSpec =
  | { kind: "status" }
  | { kind: "auto" }
  | { kind: "value"; value: number }
  | { kind: "error"; message: string };

export type ParseTokenSpecOptions = {
  allowAboveCatalogContext?: boolean;
};

export type PatchResult = {
  payload: unknown;
  changed: boolean;
  field: string | null;
  reason?: string;
};

export const STATE_VERSION: number;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function modelKey(model: ModelLike | null | undefined): string | null;
export function formatTokens(value: number): string;
export function parseTokenSpec(
  raw: unknown,
  model: ModelLike | null | undefined,
  options?: ParseTokenSpecOptions,
): TokenSpec;
export function normalizeState(value: unknown): MaxoutState;
export const MAX_THINKING_BUDGET_TOKENS: number;
export const THINKING_BUDGET_HEADROOM_TOKENS: number;

export function patchThinkingBudgetPayload(
  payload: unknown,
  cap: number,
  thinkingLevel: string | null | undefined,
): PatchResult;

export function patchMaxTokensPayload(
  payload: unknown,
  cap: number,
  model: ModelLike | null | undefined,
): PatchResult;
