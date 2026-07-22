import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  Download,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";
import {
  api,
  archiveAvailable,
  BadArchiveError,
  exportArchiveUrl,
  importArchive,
  NotImplementedError,
  type ImportArchiveResult,
} from "../../lib/api";
import type { ProjectSummary } from "../../lib/types";
import { cn } from "../../lib/utils";

/**
 * Settings control: EXPORT / IMPORT the portable archive — the UI for W25's
 * portable engine (packages/engine/src/portable.ts), which had no face until now.
 *
 * Plain words: Claude Code throws away its transcripts after about 30 days. The
 * archive is a single .json file holding everything THIS app owns about your
 * history — the indexed session metadata, the searchable text we mirror, plus your
 * tags / notes / pins / saved folders. Export it to keep a permanent, shareable
 * backup that survives the auto-delete; import it on another machine (or after a
 * reset) to get all of that back. It is NEVER your raw ~/.claude transcripts, and
 * importing only writes our own local index — it never touches ~/.claude.
 *
 * EXPORT triggers a real file download: a plain `<a download>` to
 * GET /api/export/archive (a project dropdown narrows it to one project via
 * `?projectId=`). The download streams from the server, so a 100+-session archive
 * never has to live in the browser's memory.
 *
 * IMPORT reads a chosen .json with a two-step confirm (explaining it restores into
 * the local index and never touches ~/.claude), POSTs it to /api/import/archive,
 * shows an in-progress state, and reports "Imported N sessions" via the host toast.
 * A 400 (bad/incompatible bundle) shows a precise error inline; a parse failure of
 * the picked file is caught before we ever hit the network.
 *
 * Resilient: an older server that predates the routes 404s, so we probe once on
 * mount ({@link archiveAvailable}) and hide the whole control rather than offering
 * buttons that can't work — exactly like RebuildIndex / IntegrityPanel degrade.
 *
 * `onToast` (optional) surfaces the result through the app's existing ToastStack;
 * the control is fully usable without it (it also mirrors the outcome inline).
 */
export function ArchiveTransfer({
  projects: projectsProp,
  onToast,
}: {
  /**
   * Known projects, for the "export one project" dropdown. Optional: when the host
   * doesn't pass them (SettingsPane doesn't thread the list), we fetch them once
   * ourselves so the picker still works.
   */
  projects?: ProjectSummary[];
  /** Surface a transient toast (e.g. "Imported 42 sessions") via the app's ToastStack. */
  onToast?: (toast: { title: string; body?: string; level?: "success" | "error" }) => void;
}) {
  // null = still probing; false = routes missing (hide); true = available.
  const [available, setAvailable] = useState<boolean | null>(null);
  // Self-fetched project list (used only when the host didn't pass one).
  const [fetchedProjects, setFetchedProjects] = useState<ProjectSummary[]>([]);
  // Which project to scope the export to ("" = the full archive).
  const [exportProjectId, setExportProjectId] = useState("");
  // True from the moment we POST an import until it resolves.
  const [importing, setImporting] = useState(false);
  // Two-step confirm for import: the first pick arms it, the second runs it. We hold
  // the picked file's parsed bundle between the two clicks.
  const [pending, setPending] = useState<{ name: string; bundle: unknown } | null>(null);
  // The last import outcome, mirrored inline (toast is the primary surface).
  const [result, setResult] = useState<ImportArchiveResult | null>(null);
  // A non-NotImplemented failure (bad bundle / parse / network), shown inline.
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  // Prefer the host's project list; otherwise use the one we fetched.
  const projects = projectsProp ?? fetchedProjects;

  // Probe once: hide the whole section on a server without the archive routes.
  useEffect(() => {
    let cancelled = false;
    archiveAvailable()
      .then((ok) => {
        if (!cancelled) setAvailable(ok);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Self-fetch projects for the export dropdown when the host didn't supply them.
  // Best-effort: a failure just leaves the picker hidden (export still works for the
  // full archive). Skipped entirely when the host passed a list.
  useEffect(() => {
    if (projectsProp) return;
    let cancelled = false;
    api
      .projects()
      .then((ps) => {
        if (!cancelled) setFetchedProjects(ps);
      })
      .catch(() => {
        /* non-fatal — the picker just won't appear */
      });
    return () => {
      cancelled = true;
    };
  }, [projectsProp]);

  // Open the OS file picker; the change handler reads + parses the chosen file.
  const onPickFile = () => {
    setError(null);
    setResult(null);
    fileRef.current?.click();
  };

  // Read the picked .json, parse it locally (so a non-JSON file fails BEFORE any
  // network call), and arm the confirm step. We keep the parsed object — not the
  // raw text — so the confirm path serializes exactly once.
  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again re-fires `change`.
    e.target.value = "";
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as unknown;
      setPending({ name: file.name, bundle });
    } catch {
      setPending(null);
      setError("That file isn't valid JSON — pick an archive exported from this app.");
    }
  };

  const cancelPending = () => {
    setPending(null);
    setError(null);
  };

  // The confirmed import: POST the parsed bundle, report the count, then refresh the
  // app's data (best-effort) so the restored sessions show up without a reload.
  const runImport = async () => {
    if (!pending || importing) return;
    setImporting(true);
    setError(null);
    try {
      const res = await importArchive(pending.bundle);
      setResult(res);
      setPending(null);
      onToast?.({
        title: `Imported ${res.sessions.toLocaleString()} ${res.sessions === 1 ? "session" : "sessions"}`,
        body: "Restored into your local index. Your ~/.claude transcripts were not touched.",
        level: "success",
      });
    } catch (err) {
      if (err instanceof NotImplementedError) {
        // The route vanished between our probe and now → hide the control.
        setAvailable(false);
        return;
      }
      const msg =
        err instanceof BadArchiveError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setError(msg);
      onToast?.({ title: "Import failed", body: msg, level: "error" });
    } finally {
      setImporting(false);
    }
  };

  // Still probing, or no archive routes on this server → render nothing.
  if (available !== true) return null;

  const hasProjects = (projects?.length ?? 0) > 0;

  return (
    <section className="mt-6 space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
      <div className="flex items-center gap-2">
        <Archive className="h-4 w-4 text-zinc-500" />
        <h2 className="text-[13px] font-semibold text-zinc-200">Backup &amp; transfer</h2>
      </div>
      <p className="-mt-1 text-[11.5px] leading-relaxed text-zinc-600">
        Claude Code auto-deletes its transcripts after about 30 days. The{" "}
        <span className="text-zinc-400">archive</span> is a single portable{" "}
        <code className="text-zinc-500">.json</code> file holding everything this app
        indexed — session metadata, the searchable text we mirror, and your{" "}
        <span className="text-zinc-400">tags, notes, pins, and saved folders</span>.
        It's a permanent backup that survives the auto-delete and can be imported on
        another machine. It is never your raw{" "}
        <code className="text-zinc-500">~/.claude</code> transcripts, and importing
        only writes this app's local index.
      </p>

      {/* EXPORT — a real file download. The dropdown narrows it to one project. */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Export
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {hasProjects ? (
            <select
              value={exportProjectId}
              onChange={(e) => setExportProjectId(e.target.value)}
              className="dh-settings-select"
              aria-label="Scope the export to a project"
            >
              <option value="">All projects (full archive)</option>
              {projects!.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
          {/* A plain anchor download streams straight from the server — the big
              archive never has to be held in browser memory. `download` hints the
              browser to save rather than navigate. */}
          <a
            href={exportArchiveUrl(exportProjectId || undefined)}
            download
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-1.5 text-[13px] font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Download className="h-3.5 w-3.5" />
            {exportProjectId ? "Download project archive" : "Download full archive"}
          </a>
        </div>
      </div>

      {/* IMPORT — file picker -> confirm -> POST, with an in-progress state. */}
      <div className="space-y-2 border-t border-zinc-800/60 pt-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Import
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onFileChosen}
        />

        {pending ? (
          // Armed confirm: explain exactly what import does before committing.
          <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              Import <span className="font-medium text-amber-100">{pending.name}</span>?
              This restores its sessions, tags, notes, pins, and saved folders into
              your local index here. It is idempotent (re-importing the same file adds
              nothing new) and{" "}
              <span className="font-medium">never touches your ~/.claude transcripts</span>.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={runImport}
                disabled={importing}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[13px] font-medium ring-1 transition",
                  importing
                    ? "cursor-not-allowed bg-zinc-900 text-zinc-500 ring-zinc-800"
                    : "bg-amber-500/15 text-amber-100 ring-amber-500/40 hover:bg-amber-500/25",
                )}
              >
                {importing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {importing ? "Importing…" : "Confirm import"}
              </button>
              {!importing ? (
                <button
                  onClick={cancelPending}
                  className="text-[12px] text-zinc-500 transition hover:text-zinc-300"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={onPickFile}
              disabled={importing}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-1.5 text-[13px] font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              <Upload className="h-3.5 w-3.5" />
              Choose archive file…
            </button>
            {/* Inline success mirror — the toast is the primary surface. */}
            {result ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                Imported {result.sessions.toLocaleString()}{" "}
                {result.sessions === 1 ? "session" : "sessions"}
              </span>
            ) : null}
          </div>
        )}

        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        ) : null}
      </div>
    </section>
  );
}
