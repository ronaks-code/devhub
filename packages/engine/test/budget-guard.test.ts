import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/index.js";
import { TranscriptIndex } from "../src/index-db.js";
import { budgetGuardStatus, guardTurn, DEFAULT_WARN_FRACTION } from "../src/budget-guard.js";
import type { DailyUsage } from "../src/rollups.js";

/**
 * Hermetic tests for the pre-turn budget guard + spend projection. The pure functions
 * ({@link budgetGuardStatus} / {@link guardTurn}) are driven with synthetic DailyUsage
 * rows and an injected `now`, so they're deterministic with no DB; a final block wires
 * a TEMP-index Engine (its own DB + transcript dir — nothing touches ~/.claude) to prove
 * the methods read the live `monthlyBudgetUsd` setting + the bounded daily rollup.
 *
 * Covered: ok/warn/over grading across cap thresholds; null-cap -> ok + projection still
 * computed; the linear projection math (half the period spent -> ~2x projection; full
 * period -> projection == spend); and guardTurn allow/block logic (under, warn, over,
 * estimate-pushes-over, enforce=false advisory, null cap).
 */

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-budgetguard-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

/** A synthetic daily-usage row (only `date` + `costUsd` matter to the guard). */
function day(date: string, costUsd: number): DailyUsage {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    sessions: 1,
  };
}

// A fixed "now" mid-month in a 30-day month: 2026-06-16 is the 16th day of June (30 days),
// so ~half the period has elapsed (16/30 ≈ 0.533 of the month is gone).
const MID_JUNE = new Date("2026-06-16T00:00:00.000Z");

describe("budgetGuardStatus (cap grading + projection)", () => {
  it("state 'ok' well under the warn threshold", () => {
    const s = budgetGuardStatus(100, [day("2026-06-05", 10)], { now: MID_JUNE });
    expect(s.capUsd).toBe(100);
    expect(s.spentUsd).toBeCloseTo(10, 6);
    expect(s.remainingUsd).toBeCloseTo(90, 6);
    expect(s.fraction).toBeCloseTo(0.1, 6);
    expect(s.state).toBe("ok");
    expect(s.periodStart).toBe("2026-06-01T00:00:00.000Z");
    expect(s.periodEnd).toBe("2026-07-01T00:00:00.000Z");
  });

  it("state 'warn' at the 0.8 default threshold (and not below it)", () => {
    const under = budgetGuardStatus(100, [day("2026-06-05", 79)], { now: MID_JUNE });
    expect(under.state).toBe("ok");
    const at = budgetGuardStatus(100, [day("2026-06-05", 80)], { now: MID_JUNE });
    expect(at.fraction).toBeCloseTo(DEFAULT_WARN_FRACTION, 6);
    expect(at.state).toBe("warn");
    expect(at.remainingUsd).toBeCloseTo(20, 6);
  });

  it("state 'over' when spend reaches/exceeds the cap; remaining floors at 0", () => {
    const s = budgetGuardStatus(100, [day("2026-06-05", 120)], { now: MID_JUNE });
    expect(s.state).toBe("over");
    expect(s.fraction).toBeCloseTo(1.2, 6);
    expect(s.remainingUsd).toBe(0);
  });

  it("a custom warnFraction shifts the warn band (clamped to [0,1])", () => {
    const lower = budgetGuardStatus(100, [day("2026-06-05", 55)], { now: MID_JUNE, warnFraction: 0.5 });
    expect(lower.state).toBe("warn");
    // Out-of-range warnFraction is clamped; 2 -> 1, so warn only AT the cap (== over).
    const clamped = budgetGuardStatus(100, [day("2026-06-05", 80)], { now: MID_JUNE, warnFraction: 2 });
    expect(clamped.state).toBe("ok");
  });

  it("null cap -> state 'ok', no remaining/fraction, but projection still computed", () => {
    const s = budgetGuardStatus(null, [day("2026-06-05", 40)], { now: MID_JUNE });
    expect(s.capUsd).toBeNull();
    expect(s.remainingUsd).toBeNull();
    expect(s.fraction).toBe(0);
    expect(s.state).toBe("ok");
    expect(s.spentUsd).toBeCloseTo(40, 6);
    // ~half the period elapsed -> projection ~2x spend (see math test for the bound).
    expect(s.projectedUsd).toBeGreaterThan(s.spentUsd);
  });

  it("a non-positive cap is treated like no cap (state 'ok')", () => {
    const s = budgetGuardStatus(0, [day("2026-06-05", 40)], { now: MID_JUNE });
    expect(s.state).toBe("ok");
    expect(s.fraction).toBe(0);
    expect(s.remainingUsd).toBeNull();
  });

  it("only the current UTC month contributes to spend (other months ignored)", () => {
    const s = budgetGuardStatus(
      100,
      [day("2026-05-31", 999), day("2026-06-10", 25), day("2026-07-01", 999)],
      { now: MID_JUNE },
    );
    expect(s.spentUsd).toBeCloseTo(25, 6);
  });

  describe("linear projection math", () => {
    it("half the period elapsed -> ~2x projection", () => {
      // 2026-06-15T12:00Z: 14.5 days of a 30-day month elapsed (period start is day 1
      // at 00:00Z) -> elapsed fraction ≈ 14.5/30, so projection ≈ spend * 30/14.5 ≈ 2.07x.
      const now = new Date("2026-06-15T12:00:00.000Z");
      const s = budgetGuardStatus(null, [day("2026-06-05", 50)], { now });
      expect(s.projectedUsd / s.spentUsd).toBeCloseTo(30 / 14.5, 2);
    });

    it("near the period end -> projection converges to spend (period almost complete)", () => {
      // Late on the last day: almost the whole period has elapsed, so the linear
      // projection adds only a sliver to spend (>= spend, within ~0.1%).
      const now = new Date("2026-06-30T23:59:59.000Z");
      const s = budgetGuardStatus(null, [day("2026-06-10", 60)], { now });
      expect(s.projectedUsd).toBeGreaterThanOrEqual(s.spentUsd);
      expect(s.projectedUsd).toBeCloseTo(s.spentUsd, 2);
    });

    it("early in the period the elapsed window is floored at one day (no blow-up)", () => {
      const now = new Date("2026-06-01T01:00:00.000Z"); // 1 hour in
      const s = budgetGuardStatus(null, [day("2026-06-01", 5)], { now });
      // Elapsed floored to 1 day of a 30-day month -> projection ≈ spend * 30, finite.
      expect(Number.isFinite(s.projectedUsd)).toBe(true);
      expect(s.projectedUsd).toBeCloseTo(5 * 30, 4);
    });
  });
});

describe("guardTurn (advisory pre-turn gate)", () => {
  it("allows with no reason when comfortably under the cap", () => {
    const d = guardTurn(100, [day("2026-06-05", 10)], { now: MID_JUNE });
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
    expect(d.status.state).toBe("ok");
  });

  it("allows but surfaces a reason in the warn band", () => {
    const d = guardTurn(100, [day("2026-06-05", 85)], { now: MID_JUNE });
    expect(d.allow).toBe(true);
    expect(d.status.state).toBe("warn");
    expect(d.reason).toMatch(/85%|budget cap/);
  });

  it("blocks when already over and enforcement is on (default)", () => {
    const d = guardTurn(100, [day("2026-06-05", 120)], { now: MID_JUNE });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/budget cap/);
    expect(d.status.state).toBe("over");
  });

  it("allows (advisory only) when over but enforcement is off", () => {
    const d = guardTurn(100, [day("2026-06-05", 120)], { now: MID_JUNE, enforce: false });
    expect(d.allow).toBe(true);
    expect(d.reason).toMatch(/budget cap/);
  });

  it("estimatedUsd that would push spend over the cap blocks the turn", () => {
    // Under the cap now ($90/$100), but a $20 estimate would cross it -> blocked.
    const d = guardTurn(100, [day("2026-06-05", 90)], { now: MID_JUNE, estimatedUsd: 20 });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/budget cap/);
  });

  it("a null cap always allows (projection still in status)", () => {
    const d = guardTurn(null, [day("2026-06-05", 500)], { now: MID_JUNE });
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
    expect(d.status.capUsd).toBeNull();
    expect(d.status.projectedUsd).toBeGreaterThan(0);
  });
});

describe("Engine.budgetStatus / Engine.guardTurn (live settings + bounded rollup)", () => {
  const asst = (cwd: string, model: string, tokens: number) => ({
    type: "assistant",
    cwd,
    message: {
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: tokens, output_tokens: 0 },
    },
  });

  /** Seed one opus session whose 1M input tokens cost exactly $5, dated `lastTs`. */
  const seed = async (dir: string, lastTs: string) => {
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwd = "/home/me/proj";
    const p = path.join(proj, "s1.jsonl");
    writeFileSync(
      p,
      jl({ type: "user", cwd, timestamp: lastTs, message: { role: "user", content: "hi" } }) +
        jl({ ...asst(cwd, "claude-opus-4-8", 1_000_000), timestamp: lastTs }),
    );
    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(p);
    idx.close();
  };

  it("reads the configured cap + month-to-date spend from the index", async () => {
    const dir = tmp();
    // Date the session in the CURRENT calendar month so it lands in the period window.
    const month = new Date().toISOString().slice(0, 7);
    await seed(dir, `${month}-10T08:00:00.000Z`);
    const engine = new Engine(path.join(dir, "i.db"));
    engine.setSettings({ monthlyBudgetUsd: 4 }); // cap below the $5 spend -> over

    const s = engine.budgetStatus();
    expect(s.capUsd).toBe(4);
    expect(s.spentUsd).toBeCloseTo(5, 5); // 1M opus input @ $5/Mtok
    expect(s.state).toBe("over");

    const blocked = engine.guardTurn();
    expect(blocked.allow).toBe(false);
    engine.close();
  });

  it("null cap (default) -> ok, projection computed, turn allowed", async () => {
    const dir = tmp();
    const month = new Date().toISOString().slice(0, 7);
    await seed(dir, `${month}-10T08:00:00.000Z`);
    const engine = new Engine(path.join(dir, "i.db"));
    // No monthlyBudgetUsd set -> default null.
    const s = engine.budgetStatus();
    expect(s.capUsd).toBeNull();
    expect(s.state).toBe("ok");
    expect(s.spentUsd).toBeCloseTo(5, 5);
    expect(s.projectedUsd).toBeGreaterThanOrEqual(s.spentUsd);

    expect(engine.guardTurn().allow).toBe(true);
    engine.close();
  });

  it("a generous cap keeps state ok and allows the turn", async () => {
    const dir = tmp();
    const month = new Date().toISOString().slice(0, 7);
    await seed(dir, `${month}-10T08:00:00.000Z`);
    const engine = new Engine(path.join(dir, "i.db"));
    engine.setSettings({ monthlyBudgetUsd: 1000 });
    const s = engine.budgetStatus();
    expect(s.state).toBe("ok");
    expect(s.remainingUsd).toBeCloseTo(995, 4);
    expect(engine.guardTurn().allow).toBe(true);
    engine.close();
  });
});
