import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Clock,
  Coins,
  Cpu,
  Download,
  Folder,
  FolderOpen,
  MessagesSquare,
  Tag,
  Wrench,
} from "lucide-react";
import type {
  ModelStat,
  ProjectOverview as ProjectOverviewData,
  ProjectOverviewTool,
} from "../lib/types";
import { api, exportArchiveUrl, NotImplementedError } from "../lib/api";
import { compactNumber, formatUsd, relativeTime, totalTokens } from "../lib/format";
import { costUsd } from "../lib/pricing";
import { cn } from "../lib/utils";
import { ModelBreakdown } from "./dashboard/ModelBreakdown";
import { OpenInEditor } from "./OpenInEditor";
import { EmptyState, Spinner } from "./ui";

/** Error rate at/above this is "high" and gets the loud amber/red treatment. */
const HIGH_ERROR_RATE = 0.1;

/** Sum of the four token buckets for one rolled-up day. */
function dayTokens(d: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens;
}

/** Format a duration in ms compactly: 850ms / 1.4s / 2m. Mirrors ToolAnalytics. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  return `${Math.round(sec / 60)}m`;
}

/** One tool's usage, normalized from the tolerant server shape (like ToolAnalytics). */
interface ToolRow {
  tool: string;
  count: number;
  /** Error rate in [0,1], derived from a precomputed rate or errors/count. */
  errorRate: number | null;
  /** Average duration (ms), if the server reported one. */
  avgMs: number | null;
}

/**
 * Defensively normalize a raw {@link ProjectOverviewTool} into a {@link ToolRow}.
 * Tolerates the field-spelling variants the engine/server lane might land
 * (`toolName` vs. `tool`; `errorCount` vs. `errors`; precomputed `errorRate`;
 * `avgMs` vs. `avgDurationMs`) and clamps the rate to [0,1]. Returns null for an
 * entry with no usable name/count so a malformed row never renders a blank bar.
 * Kept in lockstep with the dashboard ToolAnalytics normalizer.
 */
function normalizeTool(s: ProjectOverviewTool): ToolRow | null {
  const tool = typeof s.toolName === "string" ? s.toolName : typeof s.tool === "string" ? s.tool : "";
  const count = typeof s.count === "number" && Number.isFinite(s.count) ? s.count : 0;
  if (!tool || count <= 0) return null;
  let errorRate: number | null = null;
  if (typeof s.errorRate === "number" && Number.isFinite(s.errorRate)) {
    errorRate = Math.min(1, Math.max(0, s.errorRate));
  } else {
    const errs = s.errorCount ?? s.errors;
    if (typeof errs === "number" && Number.isFinite(errs)) {
      errorRate = Math.min(1, Math.max(0, errs / count));
    }
  }
  const avg = s.avgMs ?? s.avgDurationMs;
  const avgMs = typeof avg === "number" && Number.isFinite(avg) && avg > 0 ? avg : null;
  return { tool, count, errorRate, avgMs };
}

/** A labelled headline stat tile (mirrors the dashboard StatCard, denser). */
function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-1 flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3.5">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-zinc-500">
        <span className="text-clay-400">{icon}</span>
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums text-zinc-100" title={hint}>
        {value}
      </div>
    </div>
  );
}

/** Section heading inside the overview, matching the dashboard's SectionTitle. */
function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-zinc-400">
      <span className="text-clay-400">{icon}</span>
      {children}
    </h2>
  );
}

/**
 * A compact daily token/cost bar chart (oldest→newest), heights scaled to the
 * busiest day. Pure presentation over the project's per-day series — a lighter
 * cousin of the dashboard's ActivityChart (no per-day drill-down here; the
 * Overview is a read-only summary).
 */
function DailyBars({ days }: { days: ProjectOverviewData["daily"] }) {
  const maxTokens = Math.max(1, ...days.map(dayTokens));
  return (
    <div className="flex h-24 items-end gap-0.5 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
      {days.map((d) => {
        const t = dayTokens(d);
        const tip = `${d.date}: ${compactNumber(t)} tokens · ${formatUsd(d.costUsd)} · ${d.sessions} session${d.sessions === 1 ? "" : "s"}`;
        return (
          <div
            key={d.date}
            className="group flex h-full min-w-0 flex-1 items-end"
            title={tip}
            aria-label={tip}
          >
            <div
              className="w-full rounded-sm bg-clay-500/70 transition group-hover:bg-clay-400"
              style={{ height: `${Math.max(t > 0 ? 6 : 2, (t / maxTokens) * 100)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Top-tools list — count + error-rate chip + avg duration, busiest first. */
function TopTools({ tools }: { tools: ProjectOverviewTool[] }) {
  const rows = useMemo<ToolRow[]>(
    () =>
      tools
        .map(normalizeTool)
        .filter((r): r is ToolRow => r !== null)
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    [tools],
  );

  if (rows.length === 0) {
    return <div className="text-[12px] text-zinc-600">No tool usage in this project yet.</div>;
  }

  const maxCount = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const high = r.errorRate != null && r.errorRate >= HIGH_ERROR_RATE;
        return (
          <div key={r.tool} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <Wrench className="h-3 w-3 shrink-0 text-clay-400" />
                <span className="truncate font-medium text-zinc-200" title={r.tool}>
                  {r.tool}
                </span>
                {/* Error-rate chip — loud once it crosses the "high" threshold; a
                    muted "—" when the server reported no error signal (older,
                    un-reindexed data is count-only). Matches ToolAnalytics. */}
                {r.errorRate != null ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                      high
                        ? "bg-red-500/15 text-red-300"
                        : r.errorRate > 0
                          ? "bg-amber-500/10 text-amber-300/90"
                          : "bg-zinc-800/70 text-zinc-500",
                    )}
                    title={`${(r.errorRate * 100).toFixed(1)}% of invocations errored`}
                  >
                    {high ? <AlertTriangle className="h-2.5 w-2.5" /> : null}
                    {(r.errorRate * 100).toFixed(r.errorRate < 0.1 ? 1 : 0)}% err
                  </span>
                ) : (
                  <span
                    className="inline-flex shrink-0 items-center rounded-md bg-zinc-800/40 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-600"
                    title="Error rate not yet available — rebuild the index (Settings) to backfill it"
                  >
                    — err
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-baseline gap-2 tabular-nums text-zinc-500">
                <span
                  className="flex items-baseline gap-1"
                  title={
                    r.avgMs != null
                      ? "average duration per invocation"
                      : "Average duration not yet available — rebuild the index (Settings) to backfill it"
                  }
                >
                  <Clock className="h-2.5 w-2.5 self-center text-zinc-600" />
                  {r.avgMs != null ? formatDuration(r.avgMs) : <span className="text-zinc-600">—</span>}
                </span>
                <span title="invocation count">{compactNumber(r.count)}</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-zinc-800">
              <div
                className={cn("h-full rounded-full", high ? "bg-red-500/80" : "bg-clay-500")}
                style={{ width: `${(r.count / maxCount) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A tag cloud: each distinct tag carried by the project's sessions, sized by how
 * many sessions use it (the busiest tags read larger). Pure presentation over the
 * `{ tag, count }` tally the server returns.
 */
function TagCloud({ tags }: { tags: ProjectOverviewData["tags"] }) {
  const clean = useMemo(
    () =>
      tags
        .filter((t) => typeof t.tag === "string" && t.tag.trim().length > 0)
        .map((t) => ({ tag: t.tag, count: typeof t.count === "number" && t.count > 0 ? t.count : 1 }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    [tags],
  );

  if (clean.length === 0) {
    return <div className="text-[12px] text-zinc-600">No tags on this project's sessions yet.</div>;
  }

  const max = Math.max(1, ...clean.map((t) => t.count));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {clean.map((t) => {
        // Scale the chip's text size with usage so heavier tags read larger.
        const ratio = t.count / max;
        const sizeCls =
          ratio > 0.66 ? "text-[13px]" : ratio > 0.33 ? "text-[12px]" : "text-[11px]";
        return (
          <span
            key={t.tag}
            className={cn(
              "inline-flex items-center gap-1 rounded-full bg-clay-500/10 px-2 py-0.5 font-medium text-clay-200/90 ring-1 ring-clay-500/20",
              sizeCls,
            )}
            title={`${t.count} session${t.count === 1 ? "" : "s"} tagged "${t.tag}"`}
          >
            <Tag className="h-2.5 w-2.5 text-clay-400" />
            {t.tag}
            <span className="tabular-nums text-clay-300/60">{t.count}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * A per-project deep-dive view. Fetches GET /api/projects/:id/overview and renders
 * a read-only summary: a header (name + cwd + session count + last activity),
 * headline stats (total cost, total tokens, date range), a BY MODEL breakdown
 * (reusing the dashboard's {@link ModelBreakdown}), a daily token/cost mini bar
 * chart, a TOP TOOLS list (count + error rate), and a tag cloud — plus quick
 * actions: export this project's archive (the same streamed `<a download>` the W32
 * ArchiveTransfer uses) and open the project in the editor.
 *
 * Plain words: a one-screen "what is this project, how much has it cost, what
 * models/tools/tags does it lean on" read, reachable from the Browse view without
 * opening a single session.
 *
 * Resilient by design: the route is wired ahead of the engine/server lane that
 * implements it (via api.projectOverview's NotImplementedError mapping), so an
 * older server's 404 calls `onUnavailable` — the host then hides the Overview
 * affordance entirely rather than leaving a button that 404s. Every field beyond
 * the project header is read defensively, so a partial/odd body still renders.
 */
export function ProjectOverview({
  projectId,
  /** Fallback header fields from the already-loaded ProjectSummary, shown instantly
   *  while the richer overview loads (and if the server omits them). */
  fallbackName,
  fallbackCwd,
  /** Called once if the endpoint 404s (older server) so the host hides the affordance. */
  onUnavailable,
}: {
  projectId: string;
  fallbackName?: string;
  fallbackCwd?: string;
  onUnavailable?: () => void;
}) {
  // null = still loading; the data once it lands.
  const [data, setData] = useState<ProjectOverviewData | null>(null);
  // "error" = a real failure (network/5xx); "unavailable" = route not on this
  // server (404/501 → NotImplementedError). Distinct so we show the right state.
  const [status, setStatus] = useState<"idle" | "error" | "unavailable">("idle");

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setStatus("idle");
    api
      .projectOverview(projectId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof NotImplementedError) {
          setStatus("unavailable");
          onUnavailable?.();
        } else {
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, onUnavailable]);

  // Older server (no route): a quiet "not available" state. The host also hides
  // the affordance on the same signal, so this is mostly a belt-and-braces note.
  if (status === "unavailable") {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
        <div className="flex h-full items-center justify-center px-8">
          <EmptyState
            icon={<Folder className="h-10 w-10" />}
            title="Project overview isn't available on this server"
            hint="This server predates the per-project overview endpoint. Pick a session to view its transcript instead."
          />
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
        <div className="flex h-full items-center justify-center px-8">
          <EmptyState
            icon={<Folder className="h-10 w-10" />}
            title="Couldn't load the project overview"
            hint="Something went wrong fetching this project's summary. Try selecting it again."
          />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-zinc-950">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  // Header fields — prefer the server's, fall back to the host-supplied summary.
  const name = data.project?.name || fallbackName || "Project";
  const cwd = data.project?.cwd || fallbackCwd || "";
  const sessionCount =
    typeof data.project?.sessionCount === "number" ? data.project.sessionCount : 0;
  const lastActivity = data.project?.lastActivity ?? null;

  const usage = data.totalUsage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const tokens = totalTokens(usage);
  // Prefer the server's total cost; otherwise estimate from aggregate usage at the
  // fallback tier (the same APPROXIMATE basis the dashboard / project header use).
  const cost =
    typeof data.totalCostUsd === "number" && Number.isFinite(data.totalCostUsd)
      ? data.totalCostUsd
      : costUsd(null, usage);

  // Date range: firstActivity → lastActivity, when both are present.
  const dateRange =
    data.firstActivity && lastActivity
      ? `${relativeTime(data.firstActivity)} → ${relativeTime(lastActivity)}`
      : lastActivity
        ? relativeTime(lastActivity)
        : "—";

  // ModelBreakdown consumes ModelStat[]; ProjectOverviewModel is structurally
  // identical, so the cast is purely nominal (no runtime change).
  const models = (data.byModel ?? []) as ModelStat[];
  const daily = data.daily ?? [];
  const tools = data.topTools ?? [];
  const tags = data.tags ?? [];

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-6 py-6">
        {/* Header: name + cwd + session count + last activity. */}
        <header className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-clay-500/10 p-2 text-clay-400 ring-1 ring-clay-500/20">
            <Folder className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold text-zinc-100">{name}</h1>
            {cwd ? (
              <div className="truncate text-[11.5px] text-zinc-600" title={cwd} dir="rtl">
                {cwd}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1">
                <MessagesSquare className="h-3 w-3" />
                {sessionCount.toLocaleString()} session{sessionCount === 1 ? "" : "s"}
              </span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {relativeTime(lastActivity)}
              </span>
            </div>
          </div>

          {/* Quick actions: export this project's archive + open in editor. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/* A plain anchor download streams the archive straight from the server
                — the bundle never lives in browser memory — exactly like the W32
                ArchiveTransfer button. Scoped to this project via projectId. */}
            <a
              href={exportArchiveUrl(projectId)}
              download
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-800 hover:text-zinc-100"
              title="Download this project's portable archive (.json)"
            >
              <Download className="h-3.5 w-3.5" />
              Export archive
            </a>
            {/* Opens the project root in the user's editor on the server machine.
                Self-hides when no cwd, or degrades to a quiet "unavailable" if the
                server hasn't shipped POST /api/open. */}
            {cwd ? (
              <OpenInEditor
                cwd={cwd}
                file={cwd}
                label
                className="rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[12px] ring-1 ring-zinc-700 hover:bg-zinc-800"
              />
            ) : null}
          </div>
        </header>

        {/* Headline stats: total cost, total tokens, date range. */}
        <section className="flex flex-col gap-3 sm:flex-row">
          <StatTile
            icon={<Coins className="h-3.5 w-3.5" />}
            label="Total tokens"
            value={compactNumber(tokens)}
            hint={`${tokens.toLocaleString()} tokens`}
          />
          <StatTile
            icon={<Coins className="h-3.5 w-3.5" />}
            label="Est. cost"
            value={formatUsd(cost)}
            hint="APPROXIMATE spend (display estimate)"
          />
          <StatTile
            icon={<Calendar className="h-3.5 w-3.5" />}
            label="Active"
            value={dateRange}
          />
        </section>

        {/* By model — reuses the dashboard ModelBreakdown widget verbatim. */}
        <section>
          <SectionTitle icon={<Cpu className="h-3.5 w-3.5" />}>By model</SectionTitle>
          <ModelBreakdown models={models} />
        </section>

        {/* Daily usage — a compact token/cost bar chart over the project's days. */}
        <section>
          <SectionTitle icon={<Calendar className="h-3.5 w-3.5" />}>Daily usage</SectionTitle>
          {daily.length > 0 ? (
            <DailyBars days={daily} />
          ) : (
            <div className="text-[12px] text-zinc-600">No daily usage recorded yet.</div>
          )}
        </section>

        {/* Top tools — count + error rate, busiest first. */}
        <section>
          <SectionTitle icon={<Wrench className="h-3.5 w-3.5" />}>Top tools</SectionTitle>
          <TopTools tools={tools} />
        </section>

        {/* Tag cloud — sized by how many sessions carry each tag. */}
        <section>
          <SectionTitle icon={<Tag className="h-3.5 w-3.5" />}>Tags</SectionTitle>
          <TagCloud tags={tags} />
        </section>

        {/* Footer hint: this is a read-only summary; sessions live in the pane left. */}
        <p className="flex items-center gap-1.5 text-[11px] text-zinc-600">
          <FolderOpen className="h-3 w-3" />
          Pick a session on the left to read its transcript.
        </p>
      </div>
    </div>
  );
}
