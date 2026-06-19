/**
 * Per-project deep-dive aggregate: GET /api/projects/:id/overview
 *
 *   GET /api/projects/:id/overview
 *     → one rolled-up snapshot of a single project: session count, total
 *       tokens/cost, a per-model breakdown, and the project's top tools — the
 *       payload behind a "project detail" view (one panel, one request).
 *
 * The whole-corpus dashboard already has `/api/stats`; this is the same idea
 * scoped to ONE project, addressed by its stable projectId.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOL: the engine lane adds `Engine.projectOverview(id)` THIS
 * SAME WAVE, so it is not yet declared on the exported `Engine` type. Per package
 * constraints we do NOT edit the engine or add a global `.d.ts` shim for it.
 * Instead we probe for it at runtime (typeof guard + try/catch): when the engine
 * exposes it we forward its result verbatim; until then — or if a half-landed
 * wrapper throws — we COMPOSE a minimal-but-correct overview from methods that
 * are already published (`getProjectSessions`, `toolStats`, each computed with a
 * bounded index aggregate). Either path returns a well-formed 200 (an unknown
 * project yields zeros, never a 404/500), so the route is safe to ship at any
 * point along the engine lane's landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import type { Engine, SessionSummary } from "@devhub/engine";

/**
 * The deep-dive method we expect the engine to expose. We keep the return type
 * deliberately loose (`unknown`, sync or async) so we don't pin the engine's
 * exact shape from this lane — the route just forwards whatever it returns. The
 * locally-composed fallback below is what defines the shape until then.
 */
interface ProjectOverviewEngine {
  projectOverview(projectId: string): unknown | Promise<unknown>;
}

/**
 * The composed fallback intentionally mirrors the engine's PUBLISHED
 * `ProjectOverview` field names (projectId / cwd / name / sessionCount /
 * totalCostUsd / totalTokens / firstTs / lastTs / byModel / topTools /
 * dailyCost / tagCloud) so the two code paths return ONE uniform contract —
 * consumers can't tell which path served them, and the tests stay stable
 * regardless of whether the engine method has landed at run time. The buckets we
 * can't cheaply reconstruct from the published session list (`dailyCost`,
 * `tagCloud`) come back empty in the fallback; the engine fills them when present.
 */
interface OverviewModel {
  model: string;
  /** Number of this project's sessions that ran on this model. */
  sessions: number;
  /** Sum of all token buckets (input + output + cache read + cache write). */
  tokens: number;
  /** APPROXIMATE USD spend on this model in this project. */
  costUsd: number;
}

/** One ranked tool in the composed fallback's `topTools`. */
interface OverviewTool {
  toolName: string;
  count: number;
}

/** The shape the composed fallback returns — a subset-compatible mirror of the engine's. */
interface ProjectOverview {
  projectId: string;
  /** True cwd of the project, or null when not derivable from the session list. */
  cwd: string | null;
  /** Display name (last cwd segment), or null when unknown. */
  name: string | null;
  sessionCount: number;
  /** APPROXIMATE total USD spend across the project's sessions. Display-only estimate. */
  totalCostUsd: number;
  /** Sum of all token buckets across the project's sessions. */
  totalTokens: number;
  /** Earliest session first-activity ISO timestamp, or null. */
  firstTs: string | null;
  /** Latest session last-activity ISO timestamp, or null. */
  lastTs: string | null;
  /** Per-model usage rollup for this project, cost descending. */
  byModel: OverviewModel[];
  /** The project's most-used tools, ranked best-first (capped). */
  topTools: OverviewTool[];
  /** Per-day spend/tokens — empty in the fallback; the engine fills it when present. */
  dailyCost: unknown[];
  /** Tag cloud — empty in the fallback; the engine fills it when present. */
  tagCloud: unknown[];
}

/** How many tools the composed-fallback's `topTools` keeps. */
const TOP_TOOLS = 10;

/** Sum a session's four token buckets into a single total. */
function totalTokens(s: SessionSummary): number {
  const u = s.usage;
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * Compose a minimal overview from already-published engine methods. Uses the same
 * index-backed helpers the rest of the server leans on — `getProjectSessions`
 * (one indexed read, no transcript scan) for the count/cost/token/model rollup,
 * and `toolStats({ projectId })` (one GROUP BY aggregate) for the tool ranking.
 * An unknown project just yields an empty session list → an all-zeros overview.
 * The tool ranking is best-effort: if `toolStats` is absent or throws (it's an
 * engine-lane method too), `topTools` degrades to [] rather than failing.
 */
function composeOverview(engine: Engine, projectId: string): ProjectOverview {
  const sessions = engine.getProjectSessions(projectId);

  let totalTokensSum = 0;
  let totalCostUsd = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  // True cwd isn't on the projectId; recover it from the first session that carries
  // one (all of a project's sessions share a cwd). Name is its last path segment.
  let cwd: string | null = null;
  // Per-model rollup, keyed by the session's model ("unknown" when null) — mirrors
  // the corpus-wide byModel buckets in getStats, scoped to this project's sessions.
  const byModel = new Map<string, OverviewModel>();

  for (const s of sessions) {
    const t = totalTokens(s);
    totalTokensSum += t;
    totalCostUsd += s.costUsd;
    if (s.firstTimestamp && (!firstTs || s.firstTimestamp < firstTs)) {
      firstTs = s.firstTimestamp;
    }
    if (s.lastTimestamp && (!lastTs || s.lastTimestamp > lastTs)) {
      lastTs = s.lastTimestamp;
    }
    if (!cwd && s.cwd) cwd = s.cwd;
    const model = s.model ?? "unknown";
    const bucket = byModel.get(model);
    if (bucket) {
      bucket.tokens += t;
      bucket.costUsd += s.costUsd;
      bucket.sessions += 1;
    } else {
      byModel.set(model, { model, sessions: 1, tokens: t, costUsd: s.costUsd });
    }
  }

  // Name = last non-empty path segment of the cwd (matches the project list's naming).
  const name = cwd ? (cwd.split("/").filter(Boolean).pop() ?? null) : null;

  // Top tools for this project — one bounded GROUP BY via the engine's toolStats.
  // It's an engine-lane method, so guard it (typeof + try/catch); degrade to [].
  let topTools: OverviewTool[] = [];
  const toolStats = (engine as unknown as Partial<{ toolStats: (opts: { projectId?: string; limit?: number }) => unknown }>).toolStats;
  if (typeof toolStats === "function") {
    try {
      const res = toolStats.call(engine, { projectId, limit: TOP_TOOLS }) as
        | { tools?: Array<{ toolName?: string; count?: number }> }
        | undefined;
      const tools = res?.tools;
      if (Array.isArray(tools)) {
        topTools = tools
          .filter((t): t is { toolName: string; count: number } =>
            typeof t?.toolName === "string" && typeof t?.count === "number",
          )
          .map((t) => ({ toolName: t.toolName, count: t.count }));
      }
    } catch {
      topTools = [];
    }
  }

  return {
    projectId,
    cwd,
    name,
    sessionCount: sessions.length,
    totalCostUsd,
    totalTokens: totalTokensSum,
    firstTs,
    lastTs,
    // Cost descending, then by name, matching getStats' byModel ordering intent.
    byModel: [...byModel.values()].sort(
      (a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model),
    ),
    topTools,
    // Re-deriving the daily series / tag cloud would need extra per-session work
    // beyond what this fallback aims for; the engine's own overview fills them.
    dailyCost: [],
    tagCloud: [],
  };
}

/**
 * Wire GET /api/projects/:id/overview onto an app, backed by the engine. The
 * engine's `projectOverview` may not exist at runtime yet (it lands this same
 * wave); when absent — or when a half-landed wrapper throws — we compose the
 * overview from published methods instead, so the route is well-formed and never
 * 500s, at any point along the engine lane's landing.
 */
export function registerProjectOverviewRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/overview",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      // Prefer the engine's own deep-dive when present; forward it verbatim.
      const fn = (engine as unknown as Partial<ProjectOverviewEngine>).projectOverview;
      if (typeof fn === "function") {
        try {
          const result = await fn.call(engine, id);
          if (result) return result;
        } catch {
          // Half-landed engine (wrapper present, backing not ready): fall through
          // to the locally-composed overview rather than surface a 500.
        }
      }
      return composeOverview(engine, id);
    },
  );
}
