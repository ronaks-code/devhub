import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { api, NotImplementedError, type IntegrityIssue, type IntegrityReport } from "../../lib/api";
import { cn } from "../../lib/utils";

/**
 * Settings control: audit + repair the SEARCH INDEX (our own DB) — never the
 * user's ~/.claude transcripts.
 *
 * Plain words: over time our index DB can drift from what's on disk (a stale row, a
 * session that lost its project, a missing tokens column). "Check index health"
 * asks the server to look (GET /api/maintenance/integrity) and shows either an "all
 * good" badge or a list of issues with how serious each one is. When there ARE
 * issues, a "Repair" button appears (POST /api/maintenance/repair) — the server
 * fixes them SAFELY by preferring re-derivation (a targeted reindex) over deleting
 * anything, so no transcript is ever touched. After a repair we re-check so the
 * report reflects the new state, and a brief toast confirms it ran.
 *
 * Resilient: an older server that hasn't shipped the routes 404s, which the
 * api.maintenance* *Maybe helpers map to a NotImplementedError — we catch it and
 * hide the whole control rather than leaving a button that can't work. Mirrors how
 * RebuildIndex / PluginsView degrade on a server missing their route.
 *
 * `onToast` (optional) lets the host surface a "Repair complete" toast through the
 * app's existing ToastStack; the control is fully usable without it.
 */
export function IntegrityPanel({
  onToast,
}: {
  /** Surface a transient toast (e.g. "Repair complete") via the app's ToastStack. */
  onToast?: (toast: { title: string; body?: string; level?: "success" | "error" }) => void;
}) {
  // True once a route has answered 404/501 — hides the control on older servers.
  const [unavailable, setUnavailable] = useState(false);
  // The latest health report, or null before the first check. `ok` with an empty
  // issue list is a clean bill of health.
  const [report, setReport] = useState<IntegrityReport | null>(null);
  // In-flight states for the two actions, kept separate so each button reflects
  // only its own work.
  const [checking, setChecking] = useState(false);
  const [repairing, setRepairing] = useState(false);
  // A non-NotImplemented failure message, shown inline so a transient error is
  // visible without nuking the control.
  const [error, setError] = useState<string | null>(null);
  // Two-step confirm for Repair: the first click arms it, the second runs it. Reset
  // after a run or when a fresh check changes the picture.
  const [confirmRepair, setConfirmRepair] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmConfirm = () => {
    setConfirmRepair(false);
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
  };

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    disarmConfirm();
    try {
      const r = await api.maintenanceIntegrity();
      setReport(r);
    } catch (err) {
      // Older server without the route → hide the control entirely. Any other
      // failure → surface it inline and let the user retry.
      if (err instanceof NotImplementedError) setUnavailable(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const onRepairClick = async () => {
    if (repairing) return;
    // First click arms a confirm; auto-disarm after a few seconds so a stray click
    // never leaves it primed forever.
    if (!confirmRepair) {
      setConfirmRepair(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmRepair(false), 5000);
      return;
    }
    disarmConfirm();
    setRepairing(true);
    setError(null);
    try {
      // The repair ack carries the post-repair report; adopt it, then re-check so
      // the panel reflects the server's authoritative state.
      const after = await api.maintenanceRepair();
      setReport(after);
      onToast?.({
        title: "Index repair complete",
        body: after.ok ? "No remaining issues." : "Re-checking the index…",
        level: "success",
      });
      // Re-check (best-effort) so a partial repair shows what's left.
      await runCheck();
    } catch (err) {
      if (err instanceof NotImplementedError) {
        setUnavailable(true);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onToast?.({ title: "Index repair failed", body: msg, level: "error" });
      }
    } finally {
      setRepairing(false);
    }
  };

  if (unavailable) return null;

  const issues = report?.issues ?? [];
  const hasIssues = issues.length > 0;
  // The worst severity present, for the headline badge tone.
  const worst: IntegrityIssue["severity"] | null = hasIssues
    ? issues.some((i) => i.severity === "error")
      ? "error"
      : issues.some((i) => i.severity === "warning")
        ? "warning"
        : "info"
    : null;
  // Repair only makes sense for real problems (error/warning), not info notes.
  const repairable = issues.some((i) => i.severity === "error" || i.severity === "warning");

  return (
    <section className="mt-6 space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-zinc-500" />
        <h2 className="text-[13px] font-semibold text-zinc-200">Index health</h2>
      </div>
      <p className="-mt-1 text-[11.5px] leading-relaxed text-zinc-600">
        Audits the <span className="text-zinc-400">search index</span> for drift —
        stale rows, sessions that lost their project, missing columns. Repair fixes
        any issues SAFELY by re-deriving from your transcripts (a targeted reindex),
        never by deleting your <code className="text-zinc-500">~/.claude</code>{" "}
        transcripts.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={runCheck}
          disabled={checking || repairing}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[13px] font-medium ring-1 transition",
            checking || repairing
              ? "cursor-not-allowed bg-zinc-900 text-zinc-500 ring-zinc-800"
              : "bg-zinc-900 text-zinc-200 ring-zinc-700 hover:bg-zinc-800 hover:text-zinc-100",
          )}
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          {checking ? "Checking…" : report ? "Re-check" : "Check index health"}
        </button>

        {/* Repair only surfaces once a check found fixable problems. */}
        {repairable ? (
          <button
            onClick={onRepairClick}
            disabled={repairing || checking}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[13px] font-medium ring-1 transition",
              repairing || checking
                ? "cursor-not-allowed bg-zinc-900 text-zinc-500 ring-zinc-800"
                : confirmRepair
                  ? "bg-amber-500/15 text-amber-200 ring-amber-500/40 hover:bg-amber-500/25"
                  : "bg-zinc-900 text-zinc-200 ring-zinc-700 hover:bg-zinc-800 hover:text-zinc-100",
            )}
            title="Re-derive the affected index rows from your transcripts"
          >
            {repairing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wrench className="h-3.5 w-3.5" />
            )}
            {repairing ? "Repairing…" : confirmRepair ? "Click to confirm repair" : "Repair"}
          </button>
        ) : null}

        {/* Headline status — a clean bill of health or the worst-severity badge. */}
        {report && !hasIssues ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Index healthy
          </span>
        ) : null}
        {report && hasIssues ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[12px]",
              worst === "error"
                ? "text-red-400"
                : worst === "warning"
                  ? "text-amber-400"
                  : "text-sky-400",
            )}
          >
            {worst === "error" ? (
              <XCircle className="h-3.5 w-3.5" />
            ) : worst === "warning" ? (
              <AlertTriangle className="h-3.5 w-3.5" />
            ) : (
              <Info className="h-3.5 w-3.5" />
            )}
            {issues.length} {issues.length === 1 ? "issue" : "issues"} found
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {/* The per-issue list, colored by severity. Only shown when there are issues. */}
      {hasIssues ? (
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue, i) => (
            <IssueRow key={`${issue.kind ?? "issue"}:${i}`} issue={issue} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One issue row — a severity icon, the message, and an optional affected-count chip. */
function IssueRow({ issue }: { issue: IntegrityIssue }) {
  const tone =
    issue.severity === "error"
      ? { icon: <XCircle className="h-3.5 w-3.5" />, text: "text-red-300", ring: "ring-red-500/25", bg: "bg-red-500/5" }
      : issue.severity === "warning"
        ? { icon: <AlertTriangle className="h-3.5 w-3.5" />, text: "text-amber-300", ring: "ring-amber-500/25", bg: "bg-amber-500/5" }
        : { icon: <Info className="h-3.5 w-3.5" />, text: "text-sky-300", ring: "ring-sky-500/25", bg: "bg-sky-500/5" };
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] ring-1",
        tone.text,
        tone.ring,
        tone.bg,
      )}
    >
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <span className="min-w-0 flex-1 leading-relaxed">{issue.message}</span>
      {issue.count != null ? (
        <span className="shrink-0 rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-400">
          {issue.count.toLocaleString()}
        </span>
      ) : null}
    </li>
  );
}
