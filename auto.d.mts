export const MIN_MARGIN_TOKENS: number;
export const DEFAULT_MARGIN_TOKENS: number;
export const MAX_MARGIN_BOOST_TOKENS: number;
export const MARGIN_BOOST_STEP_TOKENS: number;
export const TEMPLATE_TOKENS_PER_MESSAGE: number;
export const IMAGE_TOKENS: number;
export const DEFAULT_TARGETS: Readonly<Record<string, number>>;

export function estimatePayloadInputTokens(payload: unknown): number | null;

export function combineInputEstimates(
  usageEstimate: number | null | undefined,
  payloadEstimate: number | null | undefined,
): number | null;

export type AutoCapResult = {
  cap: number | null;
  remaining: number | null;
  clamped: boolean;
  degraded: boolean;
  exhausted: boolean;
};

export function computeAutoCap(options: {
  contextLimit: unknown;
  inputTokens: unknown;
  targetTokens: unknown;
  marginTokens: unknown;
}): AutoCapResult;

export function resolveTargetTokens(
  thinkingLevel: string | null | undefined,
  customTargets?: Record<string, unknown> | null,
): number;

export function resolveContextLimit(
  model: { provider?: string; id?: string; contextWindow?: number } | null | undefined,
  config?: { contextLimits?: Record<string, number> } | null | undefined,
): number | null;

export function nextMarginBoost(currentBoost: unknown, event: "overflow" | "success" | unknown): number;

export function effectiveMargin(baseMargin: unknown, boost: unknown, contextLimit: unknown): number;

export function shouldSkipPayload(payload: unknown, isIdle?: boolean): boolean;

export function resolveRequestCap(options: {
  mode: "auto" | "override";
  requestedOverride?: number;
  contextLimit: unknown;
  inputTokens: unknown;
  thinkingLevel?: string | null;
  marginTokens?: unknown;
  marginBoost?: unknown;
  customTargets?: Record<string, unknown> | null;
  modelMaxTokens?: unknown;
}): AutoCapResult & { margin: number; reason: string };

export function formatK(value: unknown): string;

export function statusLine(options: {
  inputTokens?: number | null;
  cap?: number | null;
  contextLimit?: number | null;
  flags?: readonly string[];
}): string;
