/**
 * APPROXIMATE per-model cost estimates for the dashboard, mirrored from the
 * engine's pure `packages/engine/src/pricing.ts`. We replicate it here (rather
 * than import the engine root, which bundles Node-only code) to keep the web
 * build server-free — the same pattern used for the git/MCP type mirrors.
 *
 * Rates are USD per MILLION tokens (snapshot 2026-06). Cache rates follow the
 * standard formula relative to base input: read ≈ 0.1×, write (5-min TTL) ≈ 1.25×.
 * These are display estimates only — never billed truth.
 *
 * Kept in lockstep with packages/engine/src/pricing.ts.
 */
import type { TokenUsage } from "./types";

/** USD per million tokens for one model. */
export interface ModelPricing {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

const ONE_MILLION = 1_000_000;
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function row(inputPerMtok: number, outputPerMtok: number): ModelPricing {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: round(inputPerMtok * CACHE_READ_MULT),
    cacheWritePerMtok: round(inputPerMtok * CACHE_WRITE_MULT),
  };
}

/** Known-model pricing (USD per Mtok). APPROXIMATE — public list prices, 2026-06. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": row(10, 50),
  "claude-opus-4-8": row(5, 25),
  "claude-sonnet-4-6": row(3, 15),
  "claude-sonnet-5": row(3, 15),
  "claude-haiku-4-5": row(1, 5),
};

/** Sensible fallback for unknown models — mid-range Sonnet tier. */
export const FALLBACK_PRICING: ModelPricing = row(3, 15);

/** Resolve a model id to pricing: exact, then prefix, then fallback. */
export function pricingForModel(model: string | null | undefined): ModelPricing {
  if (!model) return FALLBACK_PRICING;
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  for (const [id, p] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(id)) return p;
  }
  return FALLBACK_PRICING;
}

/** APPROXIMATE USD cost of one usage record on a given model (display estimate). */
export function costUsd(model: string | null | undefined, usage: TokenUsage): number {
  const p = pricingForModel(model);
  return (
    (usage.inputTokens * p.inputPerMtok +
      usage.outputTokens * p.outputPerMtok +
      usage.cacheReadTokens * p.cacheReadPerMtok +
      usage.cacheCreationTokens * p.cacheWritePerMtok) /
    ONE_MILLION
  );
}
