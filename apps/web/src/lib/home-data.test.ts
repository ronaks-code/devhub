import { describe, expect, it, vi } from "vitest";
import { loadHomeData } from "./home-data";

describe("loadHomeData", () => {
  it("uses fixed-size aggregate/list calls instead of one request per project", async () => {
    const allSessions = vi.fn().mockResolvedValue([]);
    const stats = vi.fn().mockResolvedValue({
      totalSessions: 319,
      activity: [{ date: "2026-07-18", sessions: 7 }],
    });
    const codexSessions = vi.fn().mockResolvedValue([]);
    const codexStats = vi.fn().mockResolvedValue({
      totalSessions: 1070,
      last30Days: 42,
      last7Days: 12,
      topCwds: [],
    });

    const result = await loadHomeData({ allSessions, stats, codexSessions, codexStats });

    expect(allSessions).toHaveBeenCalledOnce();
    expect(allSessions).toHaveBeenCalledWith({ sort: "recent", limit: 20 });
    expect(result.claudeTotal).toBe(319);
    expect(result.claudeLast30Days).toBe(7);
    expect(codexSessions).toHaveBeenCalledOnce();
    expect(codexStats).toHaveBeenCalledOnce();
  });
});
