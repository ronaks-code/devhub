/**
 * Dashboard cost reconciliation: the stat card once read a non-existent
 * `stats.costUsd` and fell back to a blended default-price estimate, so the
 * "all-time" figure could show LESS than the per-model-priced 30-day rollup sum.
 * `totalCostUsd` must prefer the server's per-model `totalCostUsd`, and every
 * figure carries a scope label (`periodScopeLabel`).
 */
import { describe, expect, it } from "vitest";
import type { Stats } from "../lib/types";
import { periodScopeLabel, totalCostUsd } from "./DashboardPane";

function stats(over: Partial<Stats>): Stats {
  return {
    totalSessions: 10,
    totalProjects: 2,
    totalUsage: {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    byModel: [],
    topProjects: [],
    activity: [],
    ...over,
  } as Stats;
}

describe("totalCostUsd", () => {
  it("prefers the server's per-model totalCostUsd over any estimate", () => {
    expect(totalCostUsd(stats({ totalCostUsd: 26_704.22 }))).toBe(26_704.22);
  });

  it("falls back to the legacy costUsd spelling when totalCostUsd is absent", () => {
    const s = stats({}) as Stats & { costUsd?: number };
    s.costUsd = 123.45;
    expect(totalCostUsd(s)).toBe(123.45);
  });

  it("estimates from aggregate usage only when the server provides no figure", () => {
    // 1M input @ $3 + 1M output @ $15 (fallback Sonnet-tier pricing) = $18.
    expect(totalCostUsd(stats({}))).toBeCloseTo(18, 5);
  });

  it("ignores a non-finite server figure", () => {
    expect(totalCostUsd(stats({ totalCostUsd: Number.NaN }))).toBeCloseTo(18, 5);
  });
});

describe("periodScopeLabel", () => {
  it("labels the fixed windows verbatim and names the open-ended scopes", () => {
    expect(periodScopeLabel("30d")).toBe("30d");
    expect(periodScopeLabel("7d")).toBe("7d");
    expect(periodScopeLabel("90d")).toBe("90d");
    expect(periodScopeLabel("all")).toBe("all-time");
    expect(periodScopeLabel("custom")).toBe("custom range");
  });
});
