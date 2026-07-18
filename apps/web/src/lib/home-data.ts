import { api, codexApi } from "./api";
import type { CodexSession, CodexStats, SessionSummary, Stats } from "./types";

export interface HomeDataDependencies {
  allSessions: (opts: { sort: "recent"; limit: number }) => Promise<SessionSummary[]>;
  stats: () => Promise<Pick<Stats, "totalSessions" | "activity">>;
  codexSessions: () => Promise<CodexSession[] | Error>;
  codexStats: () => Promise<CodexStats | Error>;
}

export interface HomeData {
  claudeSessions: SessionSummary[];
  claudeTotal: number;
  claudeLast30Days: number;
  codexSessions: CodexSession[];
  codexStats: CodexStats | null;
}

const defaultDependencies: HomeDataDependencies = {
  allSessions: api.allSessions,
  stats: api.stats,
  codexSessions: codexApi.sessions,
  codexStats: codexApi.stats,
};

/** Load the Home summary with a fixed request count and a bounded recent page. */
export async function loadHomeData(
  deps: HomeDataDependencies = defaultDependencies,
): Promise<HomeData> {
  const [sessionsResult, statsResult, codexSessionsResult, codexStatsResult] =
    await Promise.allSettled([
      deps.allSessions({ sort: "recent", limit: 20 }),
      deps.stats(),
      deps.codexSessions(),
      deps.codexStats(),
    ]);
  const stats = statsResult.status === "fulfilled" ? statsResult.value : null;
  const codexSessions = codexSessionsResult.status === "fulfilled" &&
      !(codexSessionsResult.value instanceof Error)
    ? codexSessionsResult.value
    : [];
  const codexStats = codexStatsResult.status === "fulfilled" &&
      !(codexStatsResult.value instanceof Error)
    ? codexStatsResult.value
    : null;

  return {
    claudeSessions: sessionsResult.status === "fulfilled" ? sessionsResult.value : [],
    claudeTotal: stats?.totalSessions ?? 0,
    claudeLast30Days: stats?.activity.reduce((sum, day) => sum + day.sessions, 0) ?? 0,
    codexSessions,
    codexStats,
  };
}
