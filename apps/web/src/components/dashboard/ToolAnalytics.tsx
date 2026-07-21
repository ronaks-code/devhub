import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, Wrench } from "lucide-react";
import type { ToolStat } from "../../lib/api";
import { api, asToolStatArray } from "../../lib/api";
import { compactNumber } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/** Error rate at/above this is "high" and gets the loud amber/red treatment. */
const HIGH_ERROR_RATE = 0.1;

/** Title-case a `snake_case`/space-separated tool-name fragment, e.g. "browser_click" -> "Browser Click". */
function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Collapse an exact repeated segment (e.g. "playwright_playwright" -> "playwright"),
 * a common MCP server-id artifact, then turn separators into spaces. */
function humanizeServerId(id: string): string {
  const stripped = id.replace(/^plugin_/, "");
  const collapsed = stripped.replace(/^(.+)_\1$/, "$1");
  return collapsed.replace(/[_-]+/g, " ").trim();
}

/**
 * Friendly label for a tool id (QA P2). MCP tool ids come through as the raw
 * `mcp__<server>__<tool>` wire format (e.g. `mcp__plugin_playwright_playwright__
 * browser_click`), which reads as internal plumbing, not a tool name. Native
 * tools (Bash, Read, Edit, …) already read fine and pass through unchanged.
 * The raw id is never lost — callers keep it in a `title` attribute.
 */
function friendlyToolName(tool: string): string {
  if (!tool.startsWith("mcp__")) return tool;
  const parts = tool.split("__").filter(Boolean);
  if (parts.length < 2) return tool;
  const server = parts[1]!;
  const toolTitle = titleCase(parts.slice(2).join(" ") || server);
  const serverLabel = humanizeServerId(server);
  return serverLabel ? `${toolTitle} (${serverLabel})` : toolTitle;
}

/** Format a duration in ms compactly: 850ms / 1.4s / 2m. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  return `${Math.round(sec / 60)}m`;
}

/** One tool's usage, normalized from the tolerant {@link ToolStat} server shape. */
interface ToolRow {
  tool: string;
  count: number;
  /** Error rate in [0,1], derived from a precomputed rate or errors/count. */
  errorRate: number | null;
  /** Average duration (ms), if the server reported one. */
  avgMs: number | null;
}

/**
 * Defensively normalize a raw {@link ToolStat} into a {@link ToolRow}. Tolerates
 * the field-spelling variants the lane might land (`toolName` vs. `tool`;
 * `errorCount` vs. `errors`; precomputed `errorRate`; `avgMs` vs. `avgDurationMs`)
 * and clamps the rate to [0,1]. Returns null for an entry with no usable
 * name/count so a malformed row never renders a blank bar.
 */
function normalize(s: ToolStat): ToolRow | null {
  const tool = typeof s.toolName === "string" ? s.toolName : typeof s.tool === "string" ? s.tool : "";
  const count = typeof s.count === "number" && Number.isFinite(s.count) ? s.count : 0;
  if (!tool || count <= 0) return null;
  // Prefer an explicit errorRate; else derive an error count / count. Clamp to [0,1].
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

/**
 * Dashboard widget: per-tool usage analytics (GET /api/stats/tools). Each row is
 * one tool with a usage bar (relative to the busiest tool), its invocation count,
 * an error-rate chip (loud amber/red once it crosses {@link HIGH_ERROR_RATE}), and
 * its average duration when the server reports one. Sorted by invocation count
 * descending so the workhorses lead.
 *
 * Plain words: a quick "which tools does Claude lean on, and which ones keep
 * failing or running slow?" read across your sessions.
 *
 * Self-loads its own data and is resilient: the route is wired ahead of the
 * engine/server lane that implements it, so a 404/501 surfaces a graceful "not
 * available yet" state (via api.statsTools' NotImplementedError mapping) rather
 * than a hard error, and an empty/[] response shows a friendly empty state. The
 * server shape is read tolerantly through {@link normalize}.
 */
export function ToolAnalytics() {
  // null = still loading; [] = loaded with nothing to show.
  const [tools, setTools] = useState<ToolStat[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .statsTools()
      .then((res) => {
        // Unwrap the { tools } envelope (or a bare array) defensively → [] on a
        // body we don't recognize, so an odd shape shows the empty state.
        if (!cancelled) setTools(asToolStatArray(res));
      })
      .catch(() => {
        // NotImplementedError (route not shipped) or any failure → graceful state.
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Normalize + rank by invocation count (desc); break ties by name for stability.
  const rows = useMemo<ToolRow[]>(() => {
    if (!tools) return [];
    return tools
      .map(normalize)
      .filter((r): r is ToolRow => r !== null)
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  }, [tools]);

  if (error) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-[12px] text-zinc-600">
        Tool analytics aren't available on this server yet.
      </div>
    );
  }
  if (tools === null) {
    return (
      <div className="flex h-24 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/30">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="text-[12px] text-zinc-600">No tool usage to show yet.</div>;
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
                <Wrench className="h-3 w-3 shrink-0 text-violet-400" />
                <span className="truncate font-medium text-zinc-200" title={r.tool}>
                  {friendlyToolName(r.tool)}
                </span>
                {/* Error-rate chip. Loud amber/red once it crosses the "high"
                    threshold so failing tools jump out; a quiet zinc otherwise.
                    When the server reported NO error signal (older un-reindexed
                    data returns count only), show a muted "—" so a missing rate
                    reads as "not yet available" rather than a real 0%. */}
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
                {/* Avg duration. Shows a muted "—" when the server didn't report
                    one (older un-reindexed data is count-only) so it reads as "not
                    yet available" rather than implying an instant tool. */}
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
            {/* Usage bar relative to the busiest tool. Tinted red when the tool's
                error rate is high so the bar itself reads the warning. */}
            <div className="h-2 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-zinc-800">
              <div
                className={cn("h-full rounded-full", high ? "bg-red-500/80" : "bg-violet-500")}
                style={{ width: `${(r.count / maxCount) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
