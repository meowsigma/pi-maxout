export type ModelLike = {
  provider?: string;
  id?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
};

export type MaxoutState = {
  version: number;
  defaults: Record<string, number>;
};

export type TokenSpec =
  | { kind: "status" }
  | { kind: "auto" }
  | { kind: "value"; value: number }
  | { kind: "error"; message: string };

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
export function parseTokenSpec(raw: unknown, model: ModelLike | null | undefined): TokenSpec;
export function normalizeState(value: unknown): MaxoutState;
export function patchMaxTokensPayload(
  payload: unknown,
  cap: number,
  model: ModelLike | null | undefined,
): PatchResult;
