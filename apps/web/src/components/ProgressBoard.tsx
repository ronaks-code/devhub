import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FolderGit2,
  Layers,
  RefreshCw,
  Rocket,
} from "lucide-react";
import type {
  ProgressFeature,
  ProgressItem,
  ProgressProject,
  ProgressResponse,
} from "../lib/types";
import { api } from "../lib/api";
import { compactNumber, relativeTime } from "../lib/format";
import { cn } from "../lib/utils";
import { PeriodSelector, type PeriodRange } from "./dashboard/PeriodSelector";
import { Badge, EmptyState, Spinner } from "./ui";

/** How often to re-poll /api/progress (paused while the tab is hidden). The
 * server caches the parsed snapshot for 30s, so faster polling just re-serves
 * the same payload. */
const POLL_MS = 30_000;

/**
 * Status dot + text styling, mirroring AutomationsBoard.statusStyle:
 * shipped/verified=emerald, in-progress/wip=clay (pulsing), staged=amber,
 * blocked=red, proposed/unknown=zinc.
 */
function statusStyle(status: string): { dot: string; text: string; pill: string } {
  switch (status) {
    case "shipped":
    case "verified":
      return {
        dot: "bg-emerald-500",
        text: "text-emerald-300",
        pill: "bg-emerald-500/15 text-emerald-300",
      };
    case "in-progress":
    case "wip":
      return {
        dot: "bg-clay-500 animate-pulse",
        text: "text-clay-300",
        pill: "bg-clay-500/15 text-clay-300",
      };
    case "staged":
      return { dot: "bg-amber-400", text: "text-amber-300", pill: "bg-amber-400/15 text-amber-300" };
    case "blocked":
      return { dot: "bg-red-500", text: "text-red-300", pill: "bg-red-500/15 text-red-300" };
    default:
      return { dot: "bg-zinc-500", text: "text-zinc-400", pill: "bg-zinc-700/40 text-zinc-400" };
  }
}

/** Canonical order for status filter chips (unknown statuses tack on after). */
const STATUS_ORDER = [
  "shipped",
  "verified",
  "staged",
  "in-progress",
  "wip",
  "blocked",
  "proposed",
];

/** Order a status→count map by STATUS_ORDER, unknowns last (by count desc). */
function orderedStatuses(counts: Record<string, number>): string[] {
  const known = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  const extra = Object.keys(counts)
    .filter((s) => (counts[s] ?? 0) > 0 && !STATUS_ORDER.includes(s))
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
  return [...known, ...extra];
}

/**
 * Filter every project's features/items to the active status set, recomputing
 * itemCount/statusCounts/typeCounts so the displayed rollups stay honest.
 * Empty set = no filter (return input unchanged). Projects/features with no
 * matching items are dropped.
 */
function filterProjects(projects: ProgressProject[], active: Set<string>): ProgressProject[] {
  if (active.size === 0) return projects;
  const out: ProgressProject[] = [];
  for (const p of projects) {
    const features: ProgressFeature[] = [];
    for (const f of p.features) {
      const items = f.items.filter((it) => active.has(it.status));
      if (items.length === 0) continue;
      const statusCounts: Record<string, number> = {};
      for (const it of items) statusCounts[it.status] = (statusCounts[it.status] ?? 0) + 1;
      features.push({ ...f, items, itemCount: items.length, statusCounts });
    }
    if (features.length === 0) continue;
    const allItems = features.flatMap((f) => f.items);
    const statusCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    for (const it of allItems) {
      statusCounts[it.status] = (statusCounts[it.status] ?? 0) + 1;
      typeCounts[it.type] = (typeCounts[it.type] ?? 0) + 1;
    }
    out.push({ ...p, features, itemCount: allItems.length, statusCounts, typeCounts });
  }
  return out;
}

/** Local StatCard (matches DashboardPane's card style; that one isn't exported). */
function StatCard({
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
    <div className="flex flex-1 flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        <span className="text-clay-400">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums text-zinc-100">{value}</div>
      {hint ? <div className="text-[11px] text-zinc-600">{hint}</div> : null}
    </div>
  );
}

/** Small pill list of status -> count, colored by status. */
function StatusPills({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {entries.map(([status, n]) => {
        const s = statusStyle(status);
        return (
          <span
            key={status}
            className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", s.pill)}
            title={`${n} ${status}`}
          >
            {n} {status}
          </span>
        );
      })}
    </div>
  );
}

/** A shipped-vs-total progress bar (emerald fill). */
function ShippedBar({ shipped, total }: { shipped: number; total: number }) {
  const pct = total > 0 ? Math.round((shipped / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-500">{pct}%</span>
    </div>
  );
}

/** Render one leaf work item: status dot, title, meta, evidence, impact. */
function ItemRow({ item }: { item: ProgressItem }) {
  const s = statusStyle(item.status);
  const isUrl = !!item.evidence && /^https?:\/\//.test(item.evidence);
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-zinc-800/70 bg-zinc-900/20 px-3 py-2">
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", s.dot)} title={item.status} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-zinc-100">{item.title}</div>
          {item.summary ? (
            <div className="mt-0.5 text-[11.5px] leading-snug text-zinc-400">{item.summary}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge title={`type: ${item.type}`}>{item.type}</Badge>
          <span className={cn("text-[10.5px] font-medium capitalize", s.text)}>{item.status}</span>
        </div>
      </div>
      {item.impact ? (
        <div className="pl-4 text-[11px] italic leading-snug text-zinc-500">{item.impact}</div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-[10.5px] text-zinc-600">
        <span title={item.date}>{item.date || "undated"}</span>
        {item.evidence ? (
          isUrl ? (
            <a
              href={item.evidence}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-[60%] items-center gap-1 truncate text-zinc-500 hover:text-clay-300"
              title={item.evidence}
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{item.evidence}</span>
            </a>
          ) : (
            <span className="max-w-[60%] truncate font-mono text-zinc-600" title={item.evidence}>
              {item.evidence}
            </span>
          )
        ) : null}
        <span className="text-zinc-700" title={`workflow ${item.source.workflowId}`}>
          {item.source.workflowId}
        </span>
      </div>
    </div>
  );
}

/** A collapsible feature/epic bucket inside a project. */
function FeatureRow({ feature, defaultOpen = false }: { feature: ProgressFeature; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-zinc-800/30"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-200" title={feature.title}>
          {feature.title}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-500">
          {feature.itemCount} {feature.itemCount === 1 ? "item" : "items"}
        </span>
        <StatusPills counts={feature.statusCounts} />
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 px-3 pb-3 pt-1">
          {feature.items.map((it) => (
            <ItemRow key={it.id} item={it} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A collapsible per-project section: header stats + expandable feature list. */
function ProjectSection({
  project,
  defaultOpen = false,
}: {
  project: ProgressProject;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shipped =
    (project.statusCounts.shipped || 0) + (project.statusCounts.verified || 0);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-zinc-800/20"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-4 w-4 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")}
        />
        <FolderGit2 className="h-4 w-4 shrink-0 text-clay-400" />
        <div className="min-w-0 flex-[1.4]">
          <div className="truncate text-[13.5px] font-semibold text-zinc-100">{project.name}</div>
          <div className="text-[10.5px] text-zinc-600">
            {project.itemCount} items · {project.features.length} features
            {project.firstDate ? ` · ${project.firstDate} → ${project.lastDate}` : ""}
          </div>
        </div>
        <div className="hidden min-w-0 flex-1 sm:block">
          <ShippedBar shipped={shipped} total={project.itemCount} />
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-0.5 md:flex">
          <span className="text-[11px] font-medium tabular-nums text-zinc-300">
            {compactNumber(project.itemCount)}
          </span>
          {project.effort.tokens != null ? (
            <span
              className="text-[10px] tabular-nums text-zinc-600"
              title="Approx tokens from transcripts (heuristic, whole-corpus attribution)"
            >
              ~{compactNumber(project.effort.tokens)} tok
            </span>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-zinc-800/60 px-4 py-3">
          <StatusPills counts={project.statusCounts} />
          {project.features.map((f) => (
            <FeatureRow key={f.key} feature={f} defaultOpen={defaultOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Progress / Shipped Work board. Reads the pre-mined snapshot served at
 * /api/progress, grouped project -> feature -> item, with a PeriodSelector
 * window over the work items and a corpus-wide (approx) token/effort banner.
 * Auto-refreshes on an interval (paused while the tab is hidden), and a manual
 * Refresh button re-mines the snapshot server-side. Does NOT touch the existing
 * usage/cost Dashboard — this is an additive board.
 */
export function ProgressBoard(_props?: {
  onOpenSession?: (pid: string, sid: string) => void;
  onOpenProject?: (id: string) => void;
}) {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [period, setPeriod] = useState<PeriodRange>({ id: "all" });
  const [refreshing, setRefreshing] = useState(false);
  // Active status filter (empty = show all). Toggling a chip narrows the board
  // to items with that status, recomputing counts client-side.
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const aliveRef = useRef(true);
  const periodRef = useRef(period);
  periodRef.current = period;

  const load = useCallback(() => {
    setRefreshing(true);
    const p = periodRef.current;
    api
      .progress(p.since, p.until)
      .then((r) => {
        if (aliveRef.current) setData(r);
      })
      .catch(() => {
        // The server degrades to an empty-but-valid payload itself, so a reject
        // here means the route is genuinely unreachable — keep any prior data.
        if (aliveRef.current) setData((prev) => prev);
      })
      .finally(() => {
        if (aliveRef.current) setRefreshing(false);
      });
  }, []);

  // Re-query when the period window changes.
  useEffect(() => {
    load();
  }, [period, load]);

  // Poll on an interval, paused while the tab is hidden (AutomationsBoard pattern).
  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      load();
    };
    const start = () => {
      if (timer != null) return;
      timer = setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.hidden) stop();
      else start();
    };
    if (typeof document === "undefined" || !document.hidden) start();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      aliveRef.current = false;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    api
      .refreshProgress()
      .catch(() => undefined)
      .finally(() => {
        // Give the miner a moment, then re-read. The server clears its cache on
        // completion so a slightly-early read still gets the fresh file soon.
        setTimeout(load, 1500);
      });
  }, [load]);

  const totals = data?.totals;
  const blocked = totals?.statusCounts.blocked ?? 0;
  const effort = data?.effort;
  // A missing/epoch-0 `generatedAt` (no snapshot mined yet) rendered as "mined
  // 57y ago" — technically correct math over a zero timestamp, but reads as a
  // bug. Only show the relative time once it's a real, positive timestamp.
  const generatedAtMs = data ? Date.parse(data.generatedAt) : NaN;
  const hasGeneratedAt = Number.isFinite(generatedAtMs) && generatedAtMs > 0;

  // Status chips are data-driven from the corpus-wide status counts, ordered
  // canonically (shipped/staged/blocked first). This adapts if the miner emits
  // new statuses without a code change.
  const statusChips = useMemo(
    () => orderedStatuses(totals?.statusCounts ?? {}),
    [totals],
  );

  const filterActive = statusFilter.size > 0;
  const visibleProjects = useMemo(
    () => filterProjects(data?.projects ?? [], statusFilter),
    [data, statusFilter],
  );
  const visibleItemCount = useMemo(
    () => visibleProjects.reduce((sum, p) => sum + p.itemCount, 0),
    [visibleProjects],
  );

  const toggleStatus = useCallback((status: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  // Drop any active filter values that no longer exist in the current dataset
  // (e.g. after a period change or refresh), so stale chips don't hide everything.
  useEffect(() => {
    if (statusFilter.size === 0) return;
    const present = new Set(statusChips);
    let changed = false;
    for (const s of statusFilter) {
      if (!present.has(s)) {
        changed = true;
        break;
      }
    }
    if (changed) {
      setStatusFilter((prev) => {
        const next = new Set([...prev].filter((s) => present.has(s)));
        return next.size === prev.size ? prev : next;
      });
    }
  }, [statusChips, statusFilter]);

  const harnessLine = useMemo(() => {
    if (!effort) return null;
    const c = effort.byHarness.claude;
    const x = effort.byHarness.codex;
    return `Claude ${c.sessions} sessions · ~${compactNumber(c.tokens)} tok  ·  Codex ${x.sessions} sessions · ~${compactNumber(x.tokens)} tok`;
  }, [effort]);

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">
            <Rocket className="h-4 w-4 text-clay-400" />
            Progress
          </h1>
          {data && hasGeneratedAt ? (
            <span className="text-[12px] text-zinc-500" title={`snapshot mined ${data.generatedAt}`}>
              mined {relativeTime(data.generatedAt)}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <PeriodSelector value={period.id} onChange={setPeriod} />
            <button
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-200"
              title="Re-mine the progress snapshot"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>
        </div>

        {data == null ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : totals && totals.items === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 py-14">
            <EmptyState
              icon={<Rocket className="h-10 w-10" />}
              title="No progress items yet"
              hint="Work items are mined from the workflow journals. Hit Refresh once a Workflow run has produced results."
            />
          </div>
        ) : (
          <>
            {/* Top-line stats */}
            <div className="flex flex-wrap gap-3">
              <StatCard
                icon={<Layers className="h-4 w-4" />}
                label="Total items"
                value={compactNumber(totals?.items ?? 0)}
              />
              <StatCard
                icon={<CheckCircle2 className="h-4 w-4" />}
                label="Shipped"
                value={compactNumber(totals?.shipped ?? 0)}
              />
              <StatCard
                icon={<Blocks className="h-4 w-4" />}
                label="Projects"
                value={compactNumber(totals?.projects ?? 0)}
              />
              <StatCard
                icon={<CircleDot className="h-4 w-4" />}
                label="Blocked"
                value={compactNumber(blocked)}
              />
            </div>

            {/* Effort banner — corpus-wide, approximate (see honesty note). */}
            {effort ? (
              <div className="flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900/20 px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    Effort
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-zinc-100">
                    ~{compactNumber(effort.totalTokens)} tokens
                  </span>
                  <span className="text-[10.5px] text-zinc-600">
                    approx · whole 6thSense corpus · from transcripts
                  </span>
                </div>
                {harnessLine ? (
                  <div className="text-[11.5px] tabular-nums text-zinc-500">{harnessLine}</div>
                ) : null}
              </div>
            ) : null}

            {/* Status filters (shipped/staged/blocked/…) — client-side, over the
                already-fetched snapshot. */}
            {statusChips.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10.5px] font-medium uppercase tracking-wide text-zinc-600">
                  Status
                </span>
                {statusChips.map((status) => {
                  const active = statusFilter.has(status);
                  const s = statusStyle(status);
                  const n = totals?.statusCounts[status] ?? 0;
                  return (
                    <button
                      key={status}
                      onClick={() => toggleStatus(status)}
                      aria-pressed={active}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition",
                        active
                          ? cn("border-transparent", s.pill)
                          : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
                      )}
                      title={`${active ? "Hide" : "Show only"} ${status} items`}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                      {status}
                      <span className="tabular-nums text-zinc-500">{n}</span>
                    </button>
                  );
                })}
                {filterActive ? (
                  <button
                    onClick={() => setStatusFilter(new Set())}
                    className="ml-1 rounded-full px-2 py-1 text-[11px] text-zinc-500 transition hover:text-zinc-200"
                    title="Clear status filter"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Per-project sections (filtered) */}
            {visibleProjects.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 py-10">
                <EmptyState
                  icon={<Rocket className="h-8 w-8" />}
                  title="No items match this filter"
                  hint="No work items match the selected status in this timeframe. Clear the filter or widen the period."
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {filterActive ? (
                  <div className="text-[11px] text-zinc-500">
                    {compactNumber(visibleItemCount)} item{visibleItemCount === 1 ? "" : "s"} across{" "}
                    {visibleProjects.length} project{visibleProjects.length === 1 ? "" : "s"}
                  </div>
                ) : null}
                {visibleProjects.map((p) => (
                  <ProjectSection
                    key={filterActive ? `${p.slug}-filtered` : p.slug}
                    project={p}
                    defaultOpen={filterActive}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
