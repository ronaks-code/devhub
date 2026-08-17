import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  CalendarDays,
  Clock,
  Coins,
  Cpu,
  FolderGit2,
  MessagesSquare,
  Radio,
  TrendingUp,
  Wrench,
} from "lucide-react";
import type { BudgetStatus, DailyUsage, RunningSession, Stats } from "../lib/types";
import { api } from "../lib/api";
import { compactNumber, formatUsd, relativeTime, totalTokens } from "../lib/format";
import { costUsd } from "../lib/pricing";
import { cn } from "../lib/utils";
import { useStatsPolling } from "../hooks/useStatsPolling";
import { PeriodSelector, resolvePresetRange, type PeriodRange } from "./dashboard/PeriodSelector";
import { CalendarHeatmap, type HeatmapMetric } from "./dashboard/CalendarHeatmap";
import { ActivityChart } from "./dashboard/ActivityChart";
import { HourHeatmap } from "./dashboard/HourHeatmap";
import { TopSpenders } from "./dashboard/TopSpenders";
import { CostForecast, projectEndOfPeriod } from "./dashboard/CostForecast";
import { addDaysYmd, formatDayLabel, ymdSpanDays } from "./dashboard/dateMath";
import { ProjectLeaderboard } from "./dashboard/ProjectLeaderboard";
import { DirtyRepos } from "./dashboard/DirtyRepos";
import { ToolAnalytics } from "./dashboard/ToolAnalytics";
import { Badge, EmptyState, LoadErrorState, Spinner } from "./ui";
import { DashboardSkeleton } from "./Skeleton";
import { resolveOpsTitle } from "./features/ops/opsHelpers";

/** `YYYY-MM-DD` exactly one year ago (local), for the heatmap's rollups window. */
function oneYearAgoYmd(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Sum of the four token buckets for one rolled-up day. */
function dayTokens(d: DailyUsage): number {
  return d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens;
}

/**
 * Estimated all-time $ for the stats window. Prefers the server's per-model
 * `totalCostUsd` (the engine prices each model's usage individually — this is the
 * accurate figure and the one every other panel derives from), then a legacy
 * `costUsd` spelling, and only then a client-side estimate from the aggregate
 * token usage. The fallback has no per-model breakdown, so it prices everything
 * at the default (Sonnet-tier) rate — which UNDERSTATES Opus/Fable-heavy usage.
 * That mismatch is exactly what made the "all-time" stat card show LESS than the
 * 30-day rollup sum (rollups are priced per-model server-side).
 */
export function totalCostUsd(stats: Stats): number {
  const perModel = (stats as { totalCostUsd?: number }).totalCostUsd;
  if (typeof perModel === "number" && Number.isFinite(perModel)) return perModel;
  const provided = (stats as { costUsd?: number }).costUsd;
  if (typeof provided === "number" && Number.isFinite(provided)) return provided;
  return costUsd(undefined, stats.totalUsage);
}

/** Human scope label for a period range, e.g. "30d" / "all-time" / "custom range". */
export function periodScopeLabel(id: PeriodRange["id"]): string {
  if (id === "all") return "all-time";
  if (id === "custom") return "custom range";
  return id;
}

/** How often to re-poll running/stats/rollups (paused while the tab is hidden). */
const DASH_POLL_MS = 5000;

/** This month's short label (e.g. "JUL"), used in the MTD scope tags. */
function monthLabel(): string {
  return new Date().toLocaleString(undefined, { month: "short" }).toUpperCase();
}

/** The last day of the current UTC month, as "Jul 31" — the pacing line's target.
 * UTC to match `projectEndOfPeriod`'s elapsed-month math and the engine's
 * UTC-calendar budget window. */
function monthEndLabel(): string {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return end.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The current window's spend vs the immediately-prior equal-length window, both
 * summed from the SAME daily rollup series (the year-long fetch the heatmap
 * already loads). Returns null — render nothing, never a fabricated delta — when:
 * the window is open-ended ("All": no prior window exists), the year series
 * hasn't loaded, the prior window isn't fully covered by the fetched year, or
 * prior spend is $0 (a % of zero is undefined).
 */
export function priorWindowDelta(
  currentCost: number,
  period: PeriodRange,
  year: { since: string; days: DailyUsage[] } | null,
): { pct: number; priorCost: number; priorSince: string; priorUntil: string; windowDays: number } | null {
  if (!period.since || !period.until || !year) return null;
  const windowDays = ymdSpanDays(period.since, period.until);
  if (windowDays <= 0) return null;
  const priorUntil = addDaysYmd(period.since, -1);
  const priorSince = addDaysYmd(period.since, -windowDays);
  // The prior window must sit fully inside the fetched year, or "0 spend" could
  // just mean "days we never fetched".
  if (priorSince < year.since) return null;
  let priorCost = 0;
  for (const d of year.days) {
    if (d.date >= priorSince && d.date <= priorUntil) priorCost += d.costUsd;
  }
  if (priorCost <= 0) return null;
  return { pct: ((currentCost - priorCost) / priorCost) * 100, priorCost, priorSince, priorUntil, windowDays };
}

/**
 * Provider identity from a model id — coral for Claude, mint for Codex/OpenAI.
 * Pure name inspection; anything unrecognized stays neutral violet (never guessed
 * from behavior). Paired ALWAYS with the model text, so color is never the only signal.
 */
function providerOfModel(model: string): "anthropic" | "openai" | "unknown" {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return "anthropic";
  if (/gpt|codex|openai|^o1|^o3|^o4/.test(m)) return "openai";
  return "unknown";
}

/** Categorical palette for the cost-by-model donut (§3.6): Nebula-anchored but hue-distinct
 * (indigo → magenta → mint → amber → coral → sky → lime → deep indigo), so adjacent legend
 * swatches never read as the same color (QA P4). */
const DONUT_PALETTE = ["#818cf8", "#e879f9", "#5eead4", "#fbbf24", "#fb7185", "#60a5fa", "#a3e635", "#4f46e5"];

/**
 * Cost-by-model rows always show 2 decimals, matching every other $ figure on the
 * dashboard. `formatUsd` intentionally keeps 3-4 decimals for very small amounts
 * (so a sub-cent turn doesn't round to $0.00) — the right call for a per-turn
 * badge, but it made a cheap model like `<synthetic>` show "$0.111" next to
 * every other row's 2-decimal figure (QA P5). This donut is a coarse per-model
 * breakdown, not a precision instrument, so it rounds like the rest of the page.
 */
function formatModelCost(n: number): string {
  return `$${Math.max(0, n).toFixed(2)}`;
}

/** True for a pseudo-model identifier that's internals, not a real billable
 * model: the engine's own "unknown" bucket, or a bracket-wrapped marker like
 * `<synthetic>`. No real model id looks like either shape, so this is a narrow
 * rejection, never a guess about which name is "right" (QA m7). */
function isPseudoModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "unknown" || (m.startsWith("<") && m.endsWith(">"));
}

/**
 * Merge pseudo-model rows into one honest "Other" slice (summed cost/tokens/
 * sessions) instead of letting internals like "unknown"/"<synthetic>" leak into
 * the donut legend as if they were models. Real rows pass through unchanged.
 * Returns the raw pseudo names too, so the caller can still surface them in a
 * tooltip rather than hiding them outright.
 */
function bucketPseudoModels(models: Stats["byModel"]): { rows: Stats["byModel"]; otherRawNames: string[] } {
  const real: Stats["byModel"] = [];
  const pseudo: Stats["byModel"] = [];
  for (const m of models) {
    (isPseudoModel(m.model) ? pseudo : real).push(m);
  }
  if (pseudo.length === 0) return { rows: real, otherRawNames: [] };
  const merged = pseudo.reduce(
    (acc, m) => ({ costUsd: acc.costUsd + m.costUsd, tokens: acc.tokens + m.tokens, sessions: acc.sessions + m.sessions }),
    { costUsd: 0, tokens: 0, sessions: 0 },
  );
  return { rows: [...real, { model: "Other", ...merged }], otherRawNames: pseudo.map((m) => m.model) };
}

/** Trailing "-<2 hex chars>" machine/worktree suffix some running-session names
 * carry (e.g. "00-6thsense-1e") — real identity, but noise on this glance card,
 * which (unlike Live Ops) has no session index here to join a cleaner title
 * from (QA m13). Only strips the exact pattern; never invents a name. */
function dropMachineSuffix(name: string): string {
  return name.replace(/-[0-9a-f]{2}$/i, "");
}

/** Map a running-session status to a dot/text color (violet-family, clay retired). */
function statusColor(status: string): { dot: string; text: string } {
  const s = status.toLowerCase();
  if (s === "busy") return { dot: "bg-violet-500", text: "text-violet-300" };
  if (s === "waiting") return { dot: "bg-amber-400", text: "text-amber-300" };
  if (s === "idle") return { dot: "bg-zinc-500", text: "text-zinc-400" };
  return { dot: "bg-sky-400", text: "text-sky-300" };
}

// ── Shared Prism-Glass primitives ──────────────────────────────────────────────

/** A glass card — the dashboard's one surface grade (§3.6). Dense inside, 14px grid gaps. */
function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("glass-card flex min-w-0 flex-col gap-3 p-4", className)}>{children}</div>;
}

/** The Prism-Glass scope-tag pill — every card carries one so numbers can't be misread. */
function ScopeTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-[var(--dh-glass-border)] bg-[var(--dh-accent-soft)] px-2 py-[3px] text-[9px] font-bold uppercase leading-none tracking-[0.12em] text-[var(--dh-text-muted)]">
      {children}
    </span>
  );
}

/** One h2 + optional scope tag, the standard card header row. */
function CardHead({ icon, title, scope }: { icon?: ReactNode; title: string; scope?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="dh-label flex items-center gap-1.5">
        {icon ? <span className="text-violet-400">{icon}</span> : null}
        {title}
      </h2>
      {scope ? <ScopeTag>{scope}</ScopeTag> : null}
    </div>
  );
}

function RunningCard({ s }: { s: RunningSession }) {
  const { dot, text } = statusColor(s.status);
  // D2: same fix as Ops Grid/Board/Drive — never trust a raw `name` that's really
  // a bare index; no session index is loaded here, so this only clears the "1"
  // case and falls back to the cwd basename (there's nothing richer to join to).
  const rawTitle = resolveOpsTitle(s, undefined);
  // The raw name can still carry a worktree/machine suffix resolveOpsTitle has
  // no way to know about (QA m13) — drop it for display, keep the full value
  // one hover away rather than silently discarding it.
  const project = dropMachineSuffix(rawTitle);
  return (
    <div className="glass-card flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100"
          title={rawTitle !== project ? rawTitle : undefined}
        >
          {project}
        </span>
        <span className={cn("text-[11px] font-medium capitalize", text)}>{s.status}</span>
      </div>
      {s.cwd ? (
        <div className="truncate text-[11px] text-zinc-600" title={s.cwd} dir="rtl">
          {s.cwd}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {s.model ? <Badge title="Model">{s.model}</Badge> : null}
        {s.startedAt ? (
          <span className="text-[11px] text-zinc-500">started {relativeTime(new Date(s.startedAt).toISOString())}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Month-to-date budget burn bar (§3.6 hero). Renders a track only when a cap is set. */
function BudgetBar({ budget }: { budget: BudgetStatus }) {
  const cap = budget.monthlyBudgetUsd;
  const pct = Math.max(0, Math.min(1, budget.pct || 0));
  if (!cap || cap <= 0) {
    return (
      <div className="text-[11px] text-[color:var(--dh-text-muted)]">
        <span className="dh-nums font-semibold text-[color:var(--dh-text)]">{formatUsd(budget.monthToDateUsd)}</span> this
        month · no cap set
      </div>
    );
  }
  const fillBg =
    budget.alert === "over"
      ? "var(--dh-danger)"
      : budget.alert === "warn"
        ? "var(--dh-warning)"
        : "linear-gradient(90deg, var(--dh-violet), var(--dh-coral))";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--dh-control)]">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct * 100)}%`, background: fillBg }} />
      </div>
      <div className="flex items-baseline justify-between text-[11px] text-[color:var(--dh-text-muted)]">
        <span>
          <span className="dh-nums font-semibold text-[color:var(--dh-text)]">{formatUsd(budget.monthToDateUsd)}</span> of{" "}
          <span className="dh-nums">{formatUsd(cap)}</span>
        </span>
        <span className="dh-nums">{Math.round(pct * 100)}%</span>
      </div>
    </div>
  );
}

/** Cost-by-model conic donut (§3.6) over `stats.byModel`, cost-descending, with a legend. */
function CostDonut({ models }: { models: Stats["byModel"] }) {
  const { rows, otherRawNames } = bucketPseudoModels(models);
  const withCost = rows.filter((m) => m.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd);
  const total = withCost.reduce((n, m) => n + m.costUsd, 0);

  if (withCost.length === 0 || total <= 0) {
    return <div className="text-[12px] text-[color:var(--dh-text-dim)]">No model spend in range yet.</div>;
  }

  let acc = 0;
  const stops = withCost.map((m, i) => {
    const start = (acc / total) * 100;
    acc += m.costUsd;
    const end = (acc / total) * 100;
    return `${DONUT_PALETTE[i % DONUT_PALETTE.length]} ${start}% ${end}%`;
  });
  const gradient = `conic-gradient(${stops.join(", ")})`;

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[116px] w-[116px] shrink-0">
        <div className="h-full w-full rounded-full" style={{ background: gradient }} />
        <div
          className="absolute inset-[19px] flex flex-col items-center justify-center rounded-full"
          style={{ background: "var(--dh-surface)" }}
        >
          <span className="dh-nums text-[15px] font-semibold text-[color:var(--dh-text-strong)]">{formatModelCost(total)}</span>
          <span className="dh-label" style={{ fontSize: "8px", letterSpacing: "0.14em" }}>
            total
          </span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {withCost.map((m, i) => {
          const provider = providerOfModel(m.model);
          const providerDot =
            provider === "anthropic"
              ? "var(--dh-provider-anthropic)"
              : provider === "openai"
                ? "var(--dh-provider-openai)"
                : "var(--dh-text-dim)";
          // "Other" folds in the pseudo-model rows (QA m7) — keep the raw
          // names one hover away instead of dropping them outright.
          const title = m.model === "Other" && otherRawNames.length > 0 ? `Other (${otherRawNames.join(", ")})` : m.model;
          return (
            <li key={m.model} className="flex flex-col gap-0.5 text-[11px]">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ background: DONUT_PALETTE[i % DONUT_PALETTE.length] }}
                />
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: providerDot }} title={provider} />
                <span className="min-w-0 flex-1 truncate text-[color:var(--dh-text)]" title={title}>
                  {m.model}
                </span>
              </div>
              <div className="dh-nums flex items-center gap-1.5 pl-[18px] text-[color:var(--dh-text-dim)]">
                {/* Provider label per spec (swatch · model · provider · $amt · pct),
                    derived from the model id. Skipped for the unknown/"Other" bucket
                    so a real provider is never guessed. */}
                {provider !== "unknown" ? (
                  <>
                    <span className="tracking-[0.06em] text-[color:var(--dh-text-muted)]">{provider}</span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                <span className="text-[color:var(--dh-text-muted)]">{formatModelCost(m.costUsd)}</span>
                <span aria-hidden>·</span>
                <span>{Math.round((m.costUsd / total) * 100)}%</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DashboardPane({
  onOpenSession,
  onOpenProject,
}: {
  /** Open a session in the Browse view: (projectId, sessionId). From the App. */
  onOpenSession?: (projectId: string, sessionId: string) => void;
  /** Open a project in the Browse view by id. From the App. */
  onOpenProject?: (projectId: string) => void;
} = {}) {
  const [period, setPeriod] = useState<PeriodRange>(() => resolvePresetRange("30d"));
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>("sessions");

  const { stats, statsError, running, rollups, rollupsError, refresh } = useStatsPolling({
    intervalMs: DASH_POLL_MS,
    since: period.since,
    until: period.until,
  });

  // The heatmap always wants ~1 year of daily activity, independent of the period
  // selector above. Fetched once (and on tab return) rather than polled tightly.
  // The fetch's lower bound rides along so consumers (the hero card's
  // prior-window delta) can tell "fetched and $0" from "never fetched".
  const [yearRollups, setYearRollups] = useState<{ since: string; days: DailyUsage[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const since = oneYearAgoYmd();
      api
        .rollups(since)
        .then((r) => {
          if (!cancelled) setYearRollups({ since, days: r });
        })
        .catch(() => {
          // Keep the heatmap's loaded-empty behavior. The prior-window delta
          // still omits itself here (an empty series sums to $0 prior spend).
          if (!cancelled) setYearRollups({ since, days: [] });
        });
    };
    load();
    const onVisible = () => {
      if (typeof document === "undefined" || !document.hidden) load();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      cancelled = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);

  if (!stats) {
    return (
      <div className="dh-aurora-bg--soft min-w-0 flex-1 overflow-y-auto">
        {statsError ? (
          <div className="mx-auto max-w-3xl px-6 py-6">
            <LoadErrorState message="Couldn't load dashboard." onRetry={refresh} />
          </div>
        ) : (
          <DashboardSkeleton />
        )}
      </div>
    );
  }

  const tokens = totalTokens(stats.totalUsage);
  const estTotalCost = totalCostUsd(stats);
  // Per-project cost estimate. Stats gives only a token count per project, so we
  // apportion the total estimated cost by each project's share of total tokens.
  const totalProjectTokens = stats.topProjects.reduce((n, p) => n + p.tokens, 0);
  const projectCost = (projTokens: number): number =>
    totalProjectTokens > 0 ? estTotalCost * (projTokens / totalProjectTokens) : 0;
  const maxProjectTokens = Math.max(1, ...stats.topProjects.map((p) => p.tokens));
  const liveSessions = running ?? [];

  return (
    <DashboardBody
      stats={stats}
      tokens={tokens}
      estTotalCost={estTotalCost}
      projectCost={projectCost}
      maxProjectTokens={maxProjectTokens}
      liveSessions={liveSessions}
      period={period}
      onPeriod={setPeriod}
      rollups={rollups}
      rollupsError={rollupsError}
      yearRollups={yearRollups}
      heatmapMetric={heatmapMetric}
      onHeatmapMetric={setHeatmapMetric}
      onOpenSession={onOpenSession}
      onOpenProject={onOpenProject}
    />
  );
}

/**
 * The Prism-Glass dashboard layout (§3.6): spend front and center, dense glass cards
 * in a scannable grid, a scope-tag on every card, single-violet daily series (rollups
 * aren't provider-split, so no fake two-provider chart), and a real cost-by-model donut.
 * Pure presentation over the props it's given.
 */
function DashboardBody({
  stats,
  tokens,
  estTotalCost,
  maxProjectTokens,
  liveSessions,
  period,
  onPeriod,
  rollups,
  rollupsError,
  yearRollups,
  heatmapMetric,
  onHeatmapMetric,
  onOpenSession,
  onOpenProject,
}: {
  stats: Stats;
  tokens: number;
  estTotalCost: number;
  projectCost: (projTokens: number) => number;
  maxProjectTokens: number;
  liveSessions: RunningSession[];
  period: PeriodRange;
  onPeriod: (range: PeriodRange) => void;
  rollups: DailyUsage[] | null;
  rollupsError: boolean;
  yearRollups: { since: string; days: DailyUsage[] } | null;
  heatmapMetric: HeatmapMetric;
  onHeatmapMetric: (m: HeatmapMetric) => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onOpenProject?: (projectId: string) => void;
}) {
  // Period totals: sum the in-range days client-side. Oldest→newest for the chart.
  const usage = useMemo(() => {
    const days = rollups ? [...rollups].sort((a, b) => a.date.localeCompare(b.date)) : [];
    let tk = 0;
    let cost = 0;
    let sessions = 0;
    for (const d of days) {
      tk += dayTokens(d);
      cost += d.costUsd;
      sessions += d.sessions;
    }
    return { days, tokens: tk, cost, sessions };
  }, [rollups]);

  const windowLabel = periodScopeLabel(period.id).toUpperCase();
  // Window spend comes from the per-model-priced rollups. When rollups aren't
  // available on this server we fall back to the all-time estimate rather than
  // showing a misleading $0 — flagged honestly by the scope tag.
  const heroSpend = rollupsError ? estTotalCost : usage.cost;
  const heroScope = rollupsError ? "ALL-TIME · ALL PROJECTS" : `${windowLabel} · ALL PROJECTS`;
  const heroSessions = rollupsError ? stats.totalSessions : usage.sessions;
  const mtdScope = `${monthLabel()} MTD · ALL PROJECTS`;
  // Pacing = the SAME projection the Cost-forecast card renders (one shared
  // function over the same polled budget status — never two "projected" numbers).
  const projectedUsd = projectEndOfPeriod(stats.budget as BudgetStatus);

  // ▲/▼ vs the immediately-prior equal-length window, from the same rollup
  // series (year fetch). Null (rendered as nothing) whenever the prior window
  // isn't honestly derivable. Skipped when the hero fell back to all-time.
  const delta = useMemo(
    () => (rollupsError ? null : priorWindowDelta(usage.cost, period, yearRollups)),
    [rollupsError, usage.cost, period, yearRollups],
  );

  return (
    <div className="dh-aurora-bg--soft min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-3.5 px-6 py-6">
        {/* Page head — spend title + period scope controls */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[17px] font-[680] tracking-[-0.01em] text-[color:var(--dh-text-strong)]">
            Usage &amp; Cost
          </h1>
          <PeriodSelector value={period.id} onChange={onPeriod} />
        </div>

        {/* KPI row — spend front and center */}
        <div className="grid grid-cols-1 gap-3.5 md:[grid-template-columns:1.25fr_1fr_1fr]">
          {/* HERO: window spend + budget burn */}
          <Card>
            <CardHead icon={<Coins className="h-3.5 w-3.5" />} title="Window spend" scope={heroScope} />
            <div
              className="dh-nums dh-kpi-num leading-none"
              style={{
                fontSize: "38px",
                fontWeight: 600,
                letterSpacing: "-1px",
                background: "var(--dh-grad-brand)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              {formatUsd(heroSpend)}
            </div>
            <div className="text-[11px] text-[color:var(--dh-text-muted)]">
              <span className="dh-nums">{heroSessions.toLocaleString()}</span> sessions
              {delta ? (
                <>
                  {" · "}
                  <span
                    className={cn(
                      "dh-nums font-medium",
                      // Spend UP reads as bad (rose), DOWN as good (mint/teal).
                      delta.pct > 0 ? "text-rose-300" : delta.pct < 0 ? "text-teal-300" : "text-[color:var(--dh-text-muted)]",
                    )}
                    title={`prior ${delta.windowDays}d (${formatDayLabel(delta.priorSince)} – ${formatDayLabel(delta.priorUntil)}): ${formatUsd(delta.priorCost)}`}
                  >
                    {delta.pct > 0 ? "▲" : delta.pct < 0 ? "▼" : ""}{" "}
                    {`${Math.abs(delta.pct) >= 10 ? Math.round(Math.abs(delta.pct)) : Math.abs(delta.pct).toFixed(1)}%`} vs
                    prior {delta.windowDays}d
                  </span>
                </>
              ) : null}
            </div>
            <BudgetBar budget={stats.budget} />
          </Card>

          {/* Month-to-date + pacing */}
          <Card>
            <CardHead icon={<TrendingUp className="h-3.5 w-3.5" />} title="Month to date" scope={mtdScope} />
            <div className="dh-nums dh-kpi-num text-[26px] font-semibold leading-none text-[color:var(--dh-text-strong)]">
              {formatUsd(stats.budget.monthToDateUsd)}
            </div>
            {stats.budget.monthToDateUsd > 0 ? (
              <div className="text-[11px] text-[color:var(--dh-text-muted)]">
                pacing <span className="dh-nums text-[color:var(--dh-text)]">{formatUsd(projectedUsd)}</span> by{" "}
                {monthEndLabel()}
              </div>
            ) : null}
          </Card>

          {/* All-time */}
          <Card>
            <CardHead icon={<Activity className="h-3.5 w-3.5" />} title="All time" scope="ALL-TIME · ALL PROJECTS" />
            <div className="dh-nums dh-kpi-num text-[26px] font-semibold leading-none text-[color:var(--dh-text-strong)]">
              {formatUsd(estTotalCost)}
            </div>
            <dl className="mt-0.5 flex flex-col gap-1 text-[11px] text-[color:var(--dh-text-muted)]">
              <div className="flex items-baseline justify-between gap-2">
                <dt>Total sessions</dt>
                <dd className="dh-nums text-[color:var(--dh-text)]">{stats.totalSessions.toLocaleString()}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt>Projects</dt>
                <dd className="dh-nums text-[color:var(--dh-text)]">{stats.totalProjects.toLocaleString()}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt>Tokens</dt>
                <dd className="dh-nums text-[color:var(--dh-text)]">{compactNumber(tokens)}</dd>
              </div>
            </dl>
          </Card>
        </div>

        {/* Mid grid — daily spend area + cost-by-model donut. `items-start` (same
            rationale as row 5): the donut card is taller than the daily-spend chart,
            so without it the grid stretches Daily spend to match and leaves an empty
            band under the chart. Top-align each card to its own content height. */}
        <div className="grid grid-cols-1 items-start gap-3.5 lg:[grid-template-columns:1fr_330px]">
          <Card>
            <CardHead
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              title="Daily spend"
              scope={rollupsError ? "UNAVAILABLE" : windowLabel}
            />
            {rollupsError ? (
              <div className="py-6 text-center text-[12px] text-[color:var(--dh-text-dim)]">
                Usage rollups aren't available on this server yet.
              </div>
            ) : rollups === null ? (
              <div className="flex h-28 items-center justify-center">
                <Spinner className="h-5 w-5" />
              </div>
            ) : usage.days.length > 0 ? (
              <ActivityChart days={usage.days} onOpenSession={onOpenSession} />
            ) : (
              <div className="py-6 text-center text-[12px] text-[color:var(--dh-text-dim)]">No usage in this period.</div>
            )}
          </Card>

          <Card>
            <CardHead icon={<Cpu className="h-3.5 w-3.5" />} title="Cost by model" scope="ALL-TIME" />
            <CostDonut models={stats.byModel} />
          </Card>
        </div>

        {/* Row 3 — project leaderboard + top spenders */}
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <Card>
            <CardHead icon={<FolderGit2 className="h-3.5 w-3.5" />} title="Project leaderboard" scope="ALL-TIME" />
            {stats.topProjects.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                {/* Rank by SPEND (the prominent violet cost figure), not tokens —
                    the row reads as a cost leaderboard, so it sorts by cost desc.
                    Bar width still scales on tokens; costUsd===0 ("—") sinks last. */}
                {[...stats.topProjects].sort((a, b) => b.costUsd - a.costUsd).map((p) => (
                  <div key={p.projectId} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3 text-[12px]">
                      <span className="min-w-0 truncate font-medium text-[color:var(--dh-text)]">{p.name}</span>
                      <span className="dh-nums flex shrink-0 items-baseline gap-2 text-[color:var(--dh-text-muted)]">
                        {/* REAL per-project costUsd (same source the Project-detail
                            table + the rest of the app use), NOT a projectCost(tokens)
                            re-estimate — the estimate diverged from the real figure, so
                            the two dashboard widgets showed different $ for the same
                            project (QA MAJOR: spend surface must reconcile). */}
                        <span className="text-violet-300" title="estimated cost">
                          {p.costUsd > 0 ? formatUsd(p.costUsd) : "—"}
                        </span>
                        <span>{compactNumber(p.tokens)}</span>
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--dh-control)]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(p.tokens / maxProjectTokens) * 100}%`,
                          background: "linear-gradient(90deg, var(--dh-violet-deep), var(--dh-violet))",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-[color:var(--dh-text-dim)]">No project usage yet.</div>
            )}
          </Card>

          <Card>
            <CardHead icon={<Coins className="h-3.5 w-3.5" />} title="Top spenders" />
            <TopSpenders onOpenSession={onOpenSession} />
          </Card>
        </div>

        {/* Row 4 — activity heatmap + when-you-work */}
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <Card>
            <div className="flex items-center justify-between gap-2">
              <h2 className="dh-label flex items-center gap-1.5">
                <span className="text-violet-400">
                  <CalendarDays className="h-3.5 w-3.5" />
                </span>
                Activity heatmap
              </h2>
              <div className="inline-flex items-center rounded-lg bg-[var(--dh-control)] p-0.5 ring-1 ring-[var(--dh-border)]">
                {(["sessions", "tokens"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => onHeatmapMetric(m)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition",
                      heatmapMetric === m
                        ? "bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30"
                        : "text-[color:var(--dh-text-muted)] hover:text-[color:var(--dh-text)]",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {yearRollups === null ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner className="h-5 w-5" />
              </div>
            ) : (
              <CalendarHeatmap days={yearRollups.days} metric={heatmapMetric} />
            )}
          </Card>

          <Card>
            <CardHead icon={<Clock className="h-3.5 w-3.5" />} title="When you work" />
            <HourHeatmap />
          </Card>
        </div>

        {/* Row 5 — tool analytics + dirty repos. `items-start` (P1): the two
            cards routinely differ a lot in content height (a long tool list vs.
            a short dirty-repo list); without it CSS grid stretches both to the
            taller card's height, leaving a big dead void under the shorter one. */}
        <div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-2">
          <Card>
            <CardHead icon={<Wrench className="h-3.5 w-3.5" />} title="By tool" />
            <ToolAnalytics />
          </Card>
          <Card>
            <CardHead icon={<FolderGit2 className="h-3.5 w-3.5" />} title="Uncommitted changes" />
            <DirtyRepos onOpenProject={onOpenProject} />
          </Card>
        </div>

        {/* Row 6 — cost forecast + project detail table */}
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <Card>
            <CardHead icon={<TrendingUp className="h-3.5 w-3.5" />} title="Cost forecast" />
            <CostForecast onOpenSession={onOpenSession} budget={stats.budget} />
          </Card>
          <Card>
            <CardHead icon={<FolderGit2 className="h-3.5 w-3.5" />} title="Project detail" />
            <ProjectLeaderboard onOpenProject={onOpenProject} />
          </Card>
        </div>

        {/* Running now — live sessions (Live Ops owns the full board; this is the glance) */}
        <Card>
          <CardHead icon={<Radio className="h-3.5 w-3.5" />} title="Running now" />
          {liveSessions.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {liveSessions.map((s) => (
                <RunningCard key={`${s.pid}:${s.sessionId}`} s={s} />
              ))}
            </div>
          ) : (
            <div className="py-8">
              <EmptyState
                icon={<MessagesSquare className="h-10 w-10" />}
                title="No sessions running right now"
                hint="Live Claude Code sessions will show up here as they start."
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
