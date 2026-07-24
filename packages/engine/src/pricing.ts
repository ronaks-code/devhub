/**
 * APPROXIMATE model pricing for cost estimates shown in the UI.
 *
 * Rates are USD per MILLION tokens (Mtok), taken from Anthropic's public pricing
 * (snapshot 2026-06). Cache rates follow Anthropic's standard formula relative to
 * the base input price: cache READ ≈ 0.1× input, cache WRITE (5-minute TTL) ≈ 1.25×
 * input. These are estimates for display only — never treat them as billed truth.
 *
 * Token counts elsewhere in the engine come straight from the transcript `usage`
 * blocks, so `costUsd` just multiplies those by the per-Mtok rate.
 */
import type { TokenUsage } from "./types.js";

/** USD per million tokens for one model. */
export interface ModelPricing {
  /** Plain (uncached) input tokens. */
  inputPerMtok: number;
  /** Output tokens. */
  outputPerMtok: number;
  /** Cache-read input tokens (~0.1× input). */
  cacheReadPerMtok: number;
  /** Cache-write input tokens (5-minute TTL, ~1.25× input). */
  cacheWritePerMtok: number;
}

const ONE_MILLION = 1_000_000;

/** Cache read/write multipliers vs. the base input rate (Anthropic standard). */
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/** Build a full pricing row from base input/output rates + standard cache multipliers. */
function row(inputPerMtok: number, outputPerMtok: number): ModelPricing {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: round(inputPerMtok * CACHE_READ_MULT),
    cacheWritePerMtok: round(inputPerMtok * CACHE_WRITE_MULT),
  };
}

/** Trim float noise from the derived cache rates (2 decimals is plenty for USD/Mtok). */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Known-model pricing (USD per Mtok). APPROXIMATE — public list prices, snapshot
 * 2026-06. Keys are the canonical model ids; lookup is prefix-tolerant (see
 * `pricingForModel`) so dated/suffixed variants still resolve.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic's most capable widely released model.
  "claude-fable-5": row(10, 50),
  "claude-opus-4-8": row(5, 25),
  "claude-sonnet-4-6": row(3, 15),
  "claude-sonnet-5": row(3, 15),
  "claude-haiku-4-5": row(1, 5),
};

/**
 * Sensible fallback when a model id isn't in the map (new/unknown model). Uses the
 * Sonnet-tier mid-range so estimates stay in a believable ballpark rather than 0.
 */
export const FALLBACK_PRICING: ModelPricing = row(3, 15);

/**
 * Resolve a model id to its pricing row. Tries an exact match first, then a prefix
 * match (so `claude-opus-4-8-20260101` or `claude-opus-4-8[1m]` resolve to the base
 * `claude-opus-4-8` row), then falls back to {@link FALLBACK_PRICING}.
 */
export function pricingForModel(model: string | null | undefined): ModelPricing {
  if (!model) return FALLBACK_PRICING;
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  for (const [id, p] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(id)) return p;
  }
  return FALLBACK_PRICING;
}

/**
 * APPROXIMATE USD cost of one usage record on a given model. Multiplies each token
 * bucket by its per-Mtok rate. Unknown models use {@link FALLBACK_PRICING}; the
 * result is an estimate for display, not a billed figure.
 */
export function costUsd(model: string | null | undefined, usage: TokenUsage): number {
  const p = pricingForModel(model);
  const cost =
    (usage.inputTokens * p.inputPerMtok +
      usage.outputTokens * p.outputPerMtok +
      usage.cacheReadTokens * p.cacheReadPerMtok +
      usage.cacheCreationTokens * p.cacheWritePerMtok) /
    ONE_MILLION;
  return cost;
}
