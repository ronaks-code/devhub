/**
 * Spend-budget REST surface: GET/PUT /api/budget
 *
 *   GET /api/budget
 *     → the current budget STATUS (cap, month-to-date spend, fraction consumed,
 *       alert level) alongside the persisted CONFIG (cap + warn threshold +
 *       enforce flag), for the dashboard's budget bar / settings panel.
 *
 *   PUT /api/budget   { capUsd: number|null, warnFraction?, enforce? }
 *     → update the budget configuration and return the recomputed status/config.
 *       `capUsd` is the soft monthly cap (USD; >= 0, or null to clear it);
 *       `warnFraction` is the 0..1 fraction at which we flag "warn"; `enforce`
 *       is a soft policy flag faces can read. Persisted through the EXISTING
 *       settings write path (engine.setSettings → SettingsStore, same JSON KV
 *       table the rest of AppSettings lives in), so the values round-trip on a
 *       later GET and are backed by the store's durable writes.
 *
 * The cap maps onto the existing `AppSettings.monthlyBudgetUsd` field (added in
 * W8); `warnFraction`/`enforce` ride alongside as additive KV keys (the settings
 * store is key-agnostic — it persists and re-reads any provided key), so this
 * lane extends the budget shape WITHOUT editing the engine package.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOL: `Engine.budgetStatus()` is being added by the engine lane
 * THIS SAME WAVE, so it is not yet declared on the exported `Engine` type. Per
 * package constraints we do NOT edit the engine or add a global `.d.ts` shim for
 * it. Instead we declare the EXPECTED signature as a narrow, in-package structural
 * type (`BudgetStatusEngine`) and probe for it at runtime: when the engine adds the
 * method we use it; until then — a MISSING method (typeof guard) or a HALF-landed
 * one that throws (try/catch) — we degrade, first to the engine's existing
 * `getBudgetStatus()` (also probed), then to a null-cap status. We never surface a
 * 500, so the route is safe to ship at any point along the engine lane's landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";

/**
 * The budget-status shape we return. Mirrors the engine's `BudgetStatus`
 * (cap / month-to-date / fraction / alert) but declared locally and loosely so we
 * don't pin the engine's exact item type from this lane — the route forwards
 * whatever the engine computes, and synthesizes this same shape for the fallback.
 */
interface BudgetStatusShape {
  monthlyBudgetUsd: number | null;
  monthToDateUsd: number;
  pct: number;
  alert: "none" | "warn" | "over";
}

/**
 * The status methods we PROBE on the engine. `budgetStatus()` is the new one the
 * engine lane adds this wave; `getBudgetStatus()` already exists today and is the
 * first fallback. Both are optional here and may be sync or async — we `await`
 * either way. Return type is loose so we don't pin the engine's exact shape.
 */
interface BudgetStatusEngine {
  budgetStatus?: () => unknown | Promise<unknown>;
  getBudgetStatus?: () => unknown | Promise<unknown>;
}

/**
 * Fastify body schema for a budget config update. `additionalProperties: false`
 * rejects unknown keys (a typo never silently lands); `capUsd` is required (>= 0
 * or null to clear), `warnFraction` is an optional 0..1 fraction, `enforce` an
 * optional flag. Mirrors the settings route's strict-shape convention.
 */
const budgetBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["capUsd"],
  properties: {
    capUsd: { type: ["number", "null"], minimum: 0 },
    warnFraction: { type: "number", minimum: 0, maximum: 1 },
    enforce: { type: "boolean" },
  },
} as const;

interface BudgetBody {
  capUsd: number | null;
  warnFraction?: number;
  enforce?: boolean;
}

/** Default warn threshold (fraction of cap) when the user hasn't set one. */
const DEFAULT_WARN_FRACTION = 0.8;

/**
 * Read the current budget status via the runtime capability guard described in the
 * header: prefer the new `budgetStatus()`, fall back to the existing
 * `getBudgetStatus()`, then to a null-cap status synthesized from the persisted cap.
 * Never throws — every branch resolves to a `BudgetStatusShape`.
 */
async function readStatus(engine: Engine, capUsd: number | null): Promise<BudgetStatusShape> {
  const probe = engine as unknown as BudgetStatusEngine;
  for (const fn of [probe.budgetStatus, probe.getBudgetStatus]) {
    if (typeof fn !== "function") continue;
    try {
      const out = await fn.call(engine);
      if (out && typeof out === "object") return out as BudgetStatusShape;
    } catch {
      // Half-landed / throwing — fall through to the next probe, then the synth.
    }
  }
  // Last resort: a null-cap status (zero spend known from here), never a 500.
  return { monthlyBudgetUsd: capUsd, monthToDateUsd: 0, pct: 0, alert: "none" };
}

/**
 * Pull the persisted budget config out of AppSettings. `monthlyBudgetUsd` is the
 * canonical cap field; `warnFraction`/`enforce` ride alongside as additive KV keys
 * the settings store round-trips even though they aren't on the typed interface.
 */
function readConfig(engine: Engine): { capUsd: number | null; warnFraction: number; enforce: boolean } {
  const s = engine.getSettings() as Record<string, unknown>;
  const cap = s.monthlyBudgetUsd;
  const warn = s.budgetWarnFraction;
  return {
    capUsd: typeof cap === "number" ? cap : null,
    warnFraction: typeof warn === "number" ? warn : DEFAULT_WARN_FRACTION,
    enforce: s.budgetEnforce === true,
  };
}

/** Wire GET/PUT /api/budget onto an app, backed by the engine store. */
export function registerBudgetRoutes(app: FastifyInstance, engine: Engine): void {
  app.get("/api/budget", async () => {
    const config = readConfig(engine);
    const status = await readStatus(engine, config.capUsd);
    return { status, config };
  });

  app.put<{ Body: BudgetBody }>(
    "/api/budget",
    { schema: { body: budgetBodySchema } },
    async (req) => {
      const body = req.body ?? ({} as BudgetBody);
      // Map the budget body onto the settings partial: the cap is the canonical
      // `monthlyBudgetUsd` field; warnFraction/enforce persist as additive KV keys.
      // Only write keys the client actually sent (partial merge, never a replace).
      const partial: Record<string, unknown> = { monthlyBudgetUsd: body.capUsd };
      if (body.warnFraction !== undefined) partial.budgetWarnFraction = body.warnFraction;
      if (body.enforce !== undefined) partial.budgetEnforce = body.enforce;
      // Persist through the EXISTING durable settings write path.
      engine.setSettings(partial as Parameters<Engine["setSettings"]>[0]);

      const config = readConfig(engine);
      const status = await readStatus(engine, config.capUsd);
      return { status, config };
    },
  );
}
