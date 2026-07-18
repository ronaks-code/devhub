/**
 * Progress / Shipped Work board data: GET /api/progress + POST /api/progress/refresh
 *
 * Plain words: this serves the "what have we actually shipped across 6thSense?"
 * board. The heavy lifting — mining ~1.6k work items out of the workflow
 * journals and tallying token/session effort straight from the raw transcripts —
 * is done AHEAD OF TIME by `scripts/gen-progress.mjs`, which writes a single
 * `progress-snapshot.json` into the DevHub data dir. This route just loads that
 * snapshot, applies an optional date window, and serves it (cached).
 *
 * WHY A SNAPSHOT (not mine-per-request): the journals are ~845 KB each and there
 * are ~1.6k items plus a full transcript scan — far too slow to redo on every
 * poll. This mirrors the automations/gen-jobs-registry pattern already in the
 * repo: expensive external data -> pre-generated snapshot -> cheap cached read.
 *
 * RESILIENCE (mirrors automations.ts): a missing/malformed snapshot degrades to
 * an empty-but-valid `{ ok: true, ..., projects: [] }` response — never a 500 —
 * so a first boot before the miner has ever run, or a half-written file, still
 * renders an empty board instead of erroring the tab.
 *
 * REFRESH: POST /api/progress/refresh spawns the miner in the background
 * (fire-and-forget, 202), guarded by an in-flight flag. The next GET picks up
 * the fresh file once the module cache expires. Cadence is also driven by a
 * launchd job (see the plist next to this repo's other ai.6thsense.* jobs),
 * which surfaces on the Scheduled Jobs board automatically.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { type Engine, paths } from "@devhub/engine";

// ────────────────────────────────────────────────────────────────────────────
// Data contract — mirrored into apps/web/src/lib/types.ts (kept in lockstep).
// Field names deliberately match the raw journal item shape so the miner is a
// near pass-through: { date, project, type, title, summary, status, evidence,
// impact }.
// ────────────────────────────────────────────────────────────────────────────

export type ProgressStatus =
  | "shipped"
  | "verified"
  | "staged"
  | "wip"
  | "in-progress"
  | "blocked"
  | "proposed"
  | (string & {});
export type ProgressType =
  | "feature"
  | "fix"
  | "docs"
  | "infra"
  | "refactor"
  | "test"
  | "research"
  | "decision"
  | (string & {});

export interface ProgressItem {
  /** stable hash(project|date|title) — dedupe key across journals. */
  id: string;
  /** YYYY-MM-DD (from item.date). */
  date: string;
  /** logical 6thSense slug: capture|nerve|devhub|company-platform|… */
  project: string;
  type: ProgressType;
  title: string;
  summary: string;
  status: ProgressStatus;
  /** path / URL from item.evidence. */
  evidence: string | null;
  impact: string | null;
  /** provenance: which workflow journal produced it. */
  source: { workflowId: string; journal: string };
}

export interface ProgressFeature {
  key: string;
  title: string;
  itemCount: number;
  statusCounts: Record<string, number>;
  firstDate: string;
  lastDate: string;
  /** leaf work items, newest-first. */
  items: ProgressItem[];
}

export interface ProgressProjectEffort {
  /** best-effort token attribution from transcripts; null when unattributable. */
  tokens: number | null;
  /** always true today — derived, not authoritative. */
  approx: boolean;
  /** the TRUSTWORTHY effort proxy. */
  itemCount: number;
}

export interface ProgressProject {
  slug: string;
  name: string;
  itemCount: number;
  statusCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  firstDate: string;
  lastDate: string;
  features: ProgressFeature[];
  effort: ProgressProjectEffort;
}

export interface HarnessEffort {
  tokens: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
}

/**
 * Transcript-derived token/session effort. APPROX + whole-corpus by design: the
 * transcripts are keyed by working directory, not by these logical sub-projects,
 * and all the 00-6thsense journals live under one Claude project dir — so
 * per-project token splits are a cwd->slug heuristic. `itemCount` on each
 * project is the trustworthy effort signal; treat these tokens as a rough scale,
 * never an exact per-project figure. NOT narrowed by the `?since/until` window
 * (it always describes the whole corpus, and is labeled that way in the UI).
 */
export interface ProgressEffort {
  approx: true;
  source: "transcripts";
  totalTokens: number;
  byHarness: { claude: HarnessEffort; codex: HarnessEffort };
  byProject: Record<string, { tokens: number; sessions: number }>;
  byDate: { date: string; tokens: number; sessions: number }[];
  generatedFrom: { claudeSessions: number; codexSessions: number };
}

export interface ProgressResponse {
  ok: true;
  /** ISO — when the snapshot was mined. */
  generatedAt: string;
  /** the applied filter window (null bounds = unbounded). */
  window: { since: string | null; until: string | null };
  totals: {
    items: number;
    projects: number;
    shipped: number;
    statusCounts: Record<string, number>;
  };
  /** sorted by itemCount desc. */
  projects: ProgressProject[];
  effort: ProgressEffort;
}

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

/** How long to serve a parsed snapshot before re-reading it from disk. */
const CACHE_MS = 30_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINER_SCRIPT = path.resolve(HERE, "..", "..", "scripts", "gen-progress.mjs");

/** Inclusive `YYYY-MM-DD` date pattern, matching routes/rollups.ts. */
const ISO_DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const progressSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    since: { type: "string", pattern: ISO_DATE },
    until: { type: "string", pattern: ISO_DATE },
  },
} as const;

interface ProgressQuery {
  since?: string;
  until?: string;
}

function snapshotPath(): string {
  return path.join(paths.appDataDir(), "progress-snapshot.json");
}

/** An empty-but-valid response — the graceful-degradation shape. */
function emptyResponse(window: { since: string | null; until: string | null }): ProgressResponse {
  return {
    ok: true,
    generatedAt: new Date(0).toISOString(),
    window,
    totals: { items: 0, projects: 0, shipped: 0, statusCounts: {} },
    projects: [],
    effort: {
      approx: true,
      source: "transcripts",
      totalTokens: 0,
      byHarness: {
        claude: { tokens: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 },
        codex: { tokens: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 },
      },
      byProject: {},
      byDate: [],
      generatedFrom: { claudeSessions: 0, codexSessions: 0 },
    },
  };
}

let cache: { at: number; snapshot: ProgressResponse } | null = null;

/**
 * Load + parse the snapshot (cached for CACHE_MS). Any read/parse failure
 * returns null so callers degrade to {@link emptyResponse} rather than 500.
 */
async function loadSnapshot(): Promise<ProgressResponse | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.snapshot;
  try {
    const raw = await readFile(snapshotPath(), "utf8");
    const parsed = JSON.parse(raw) as ProgressResponse;
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.projects)) return null;
    cache = { at: now, snapshot: parsed };
    return parsed;
  } catch {
    return null;
  }
}

/** Count helper for recomputing windowed aggregates. */
function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Apply an inclusive date window to a mined snapshot, recomputing every
 * per-feature / per-project / total aggregate from the surviving items. With no
 * bounds this is an identity pass (returns the snapshot as-is). `effort` is
 * corpus-wide by design and passes through untouched (see {@link ProgressEffort}).
 */
function applyWindow(snapshot: ProgressResponse, since?: string, until?: string): ProgressResponse {
  const window = { since: since ?? null, until: until ?? null };
  if (!since && !until) {
    return { ...snapshot, window };
  }

  const inWindow = (date: string): boolean => {
    if (!date) return false; // an undated item can't satisfy a bounded window
    if (since && date < since) return false;
    if (until && date > until) return false;
    return true;
  };

  const projects: ProgressProject[] = [];
  const totalStatus: Record<string, number> = {};
  let totalItems = 0;
  let shipped = 0;

  for (const p of snapshot.projects) {
    const features: ProgressFeature[] = [];
    const statusCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    const dates: string[] = [];

    for (const f of p.features) {
      const items = f.items.filter((it) => inWindow(it.date));
      if (items.length === 0) continue;
      const fstatus: Record<string, number> = {};
      const fdates: string[] = [];
      for (const it of items) {
        bump(fstatus, it.status);
        bump(statusCounts, it.status);
        bump(typeCounts, it.type);
        if (it.date) {
          fdates.push(it.date);
          dates.push(it.date);
        }
      }
      fdates.sort();
      features.push({
        key: f.key,
        title: f.title,
        itemCount: items.length,
        statusCounts: fstatus,
        firstDate: fdates[0] ?? "",
        lastDate: fdates[fdates.length - 1] ?? "",
        items,
      });
    }

    if (features.length === 0) continue;
    features.sort((a, b) => b.itemCount - a.itemCount || (a.lastDate < b.lastDate ? 1 : -1));
    dates.sort();
    const itemCount = features.reduce((n, f) => n + f.itemCount, 0);
    totalItems += itemCount;
    shipped += statusCounts.shipped || 0;
    for (const [k, v] of Object.entries(statusCounts)) totalStatus[k] = (totalStatus[k] || 0) + v;

    projects.push({
      slug: p.slug,
      name: p.name,
      itemCount,
      statusCounts,
      typeCounts,
      firstDate: dates[0] ?? "",
      lastDate: dates[dates.length - 1] ?? "",
      features,
      effort: { tokens: p.effort.tokens, approx: p.effort.approx, itemCount },
    });
  }

  projects.sort((a, b) => b.itemCount - a.itemCount);

  return {
    ok: true,
    generatedAt: snapshot.generatedAt,
    window,
    totals: {
      items: totalItems,
      projects: projects.length,
      shipped,
      statusCounts: totalStatus,
    },
    projects,
    effort: snapshot.effort,
  };
}

/** Module-local guard so two rapid refresh POSTs don't spawn two miners. */
let refreshInFlight = false;

/**
 * Wire the Progress board routes onto an app. `engine` is accepted (unused) to
 * keep this route's signature consistent with the rest of routes/*.ts.
 */
export function registerProgressRoutes(app: FastifyInstance, _engine: Engine): void {
  app.get<{ Querystring: ProgressQuery }>(
    "/api/progress",
    { schema: { querystring: progressSchema } },
    async (req) => {
      const { since, until } = req.query;
      const snapshot = await loadSnapshot();
      if (!snapshot) return emptyResponse({ since: since ?? null, until: until ?? null });
      return applyWindow(snapshot, since, until);
    },
  );

  app.post("/api/progress/refresh", async (_req, reply) => {
    if (refreshInFlight) {
      reply.code(202);
      return { started: true, alreadyRunning: true };
    }
    refreshInFlight = true;
    // Fire-and-forget: mining a full corpus is slow, so we do NOT await it — we
    // ack immediately and let the next GET pick up the fresh file after the
    // module cache expires. A half-landed/failed run is swallowed (logged) so
    // the endpoint never 500s.
    void Promise.resolve()
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            execFile(
              "node",
              [MINER_SCRIPT],
              { timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
              (err) => (err ? reject(err) : resolve()),
            );
          }),
      )
      .then(() => {
        cache = null; // force the next GET to re-read the freshly written file
      })
      .catch((err) => {
        console.warn("[server] progress refresh failed:", err);
      })
      .finally(() => {
        refreshInFlight = false;
      });

    reply.code(202);
    return { started: true };
  });
}
