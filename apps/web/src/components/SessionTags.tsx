import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Sparkles, Tag, X } from "lucide-react";
import { api, NotImplementedError } from "../lib/api";
import { cn } from "../lib/utils";

/**
 * "Suggest tags" affordance for one session, shown in the transcript header rail
 * next to Notes.
 *
 * Plain words: tags are little labels (like "typescript" or "branch:my-feature")
 * that make a session easy to find later. This panel shows the tags a session
 * already has, and a button that ASKS the server what tags it would suggest from
 * the project's files + git branch. The suggestions show up as preview chips; an
 * "Apply" button then SAVES the new ones onto the session. If there's nothing new
 * to add, it just says so.
 *
 * Wiring:
 *  - Suggestions come from GET /api/sessions/:id/autotag/suggest (api.autotagSuggest) —
 *    a PURE suggestion that never persists.
 *  - Apply persists via POST /api/sessions/:id/autotag (api.autotagApply), which the
 *    server UNIONS onto the existing tags (idempotent), then returns the resulting set.
 *
 * Sidecar-only: tags live in the index's session_meta, never in the raw transcript —
 * the apply call reuses the engine's normalized auto-tag path, like the existing
 * setTags writes.
 *
 * Resilient: an older server without the autotag routes 404s, which the api.autotag*
 * *Maybe helpers map to a NotImplementedError — we catch it and hide the whole
 * affordance rather than offering a button that can't work (exactly like
 * RebuildIndex / IntegrityPanel degrade on a server missing their route).
 *
 * Presentational + self-contained: it seeds from the session's persisted `tags`,
 * tracks the applied set locally, and reports the saved tags back via `onApplied`
 * so the host can refresh its displayed tags.
 */
export function SessionTags({
  sessionId,
  initialTags,
  onApplied,
  onToast,
  onClose,
}: {
  sessionId: string;
  /** The session's persisted tags (from SessionSummary.tags). */
  initialTags?: string[];
  /** Notified with the resulting tag set after a successful apply. */
  onApplied?: (tags: string[]) => void;
  /** Surface a transient toast (e.g. "Added 2 tags") via the app's ToastStack. */
  onToast?: (toast: { title: string; body?: string; level?: "success" | "error" }) => void;
  /** Close the panel. */
  onClose?: () => void;
}) {
  // True once a route has answered 404/501 — hides the suggest control on older servers.
  const [unavailable, setUnavailable] = useState(false);
  // The session's current tags, seeded from the page and updated after an apply so
  // the display reflects the new set without waiting on a host refresh.
  const [tags, setTags] = useState<string[]>(initialTags ?? []);
  // The latest suggestion from the server, or null before the first fetch. Includes
  // tags the session may already have — we diff against `tags` for the "new" preview.
  const [suggested, setSuggested] = useState<string[] | null>(null);
  // In-flight states for the two actions, kept separate so each button reflects
  // only its own work.
  const [suggesting, setSuggesting] = useState(false);
  const [applying, setApplying] = useState(false);
  // A non-NotImplemented failure message, shown inline so a transient error is
  // visible without nuking the panel.
  const [error, setError] = useState<string | null>(null);

  // Re-seed when switching to a different session (the panel is reused across
  // sessions): forget the prior suggestion + error, adopt the new tags.
  useEffect(() => {
    setTags(initialTags ?? []);
    setSuggested(null);
    setError(null);
  }, [sessionId, initialTags]);

  // The suggested tags NOT already on the session — the actual delta an apply adds.
  const newTags = useMemo(() => {
    if (!suggested) return [];
    const have = new Set(tags);
    return suggested.filter((t) => !have.has(t));
  }, [suggested, tags]);

  const runSuggest = async () => {
    if (suggesting) return;
    setSuggesting(true);
    setError(null);
    try {
      const s = await api.autotagSuggest(sessionId);
      setSuggested(s);
    } catch (err) {
      // Older server without the route → hide the affordance entirely. Any other
      // failure → surface it inline and let the user retry.
      if (err instanceof NotImplementedError) setUnavailable(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggesting(false);
    }
  };

  const runApply = async () => {
    if (applying || newTags.length === 0) return;
    setApplying(true);
    setError(null);
    // How many we expect to add, captured before the call for the toast count.
    const added = newTags.length;
    try {
      const resulting = await api.autotagApply(sessionId);
      // The server returns the resulting (unioned) set; adopt it as the truth.
      setTags(resulting);
      setSuggested(resulting);
      onApplied?.(resulting);
      onToast?.({
        title: `Added ${added} ${added === 1 ? "tag" : "tags"}`,
        body: newTags.join(", "),
        level: "success",
      });
    } catch (err) {
      if (err instanceof NotImplementedError) {
        // The route vanished between the suggest and now → hide the affordance.
        setUnavailable(true);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onToast?.({ title: "Couldn't add tags", body: msg, level: "error" });
    } finally {
      setApplying(false);
    }
  };

  // Server without the autotag routes → render nothing.
  if (unavailable) return null;

  // After a suggest, did we find anything new to add?
  const suggestedNothingNew = suggested != null && newTags.length === 0;

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-900/30">
      <div className="flex flex-wrap items-center gap-2 px-5 py-2">
        <Tag className="h-3.5 w-3.5 text-clay-400" />
        <span className="text-[12px] font-medium text-zinc-300">Tags</span>

        {/* The session's current tags. Empty state reads as a quiet hint. */}
        {tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-0.5 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300"
              >
                <Tag className="h-2.5 w-2.5" />
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[11px] italic text-zinc-600">No tags yet</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={runSuggest}
            disabled={suggesting || applying}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 transition disabled:opacity-40",
              "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title="Suggest tags from this session's project files + git branch"
          >
            {suggesting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {suggesting ? "Suggesting" : suggested ? "Re-suggest" : "Suggest tags"}
          </button>
          {onClose ? (
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
              title="Close tags"
              aria-label="Close tags"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Preview of the NEW suggested tags (those not already on the session) +
          Apply. Only shown once a suggestion has come back with something to add. */}
      {newTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          <span className="text-[11px] text-zinc-500">Suggested:</span>
          <div className="flex flex-wrap items-center gap-1">
            {newTags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-0.5 rounded bg-clay-500/15 px-1.5 py-0.5 text-[10px] font-medium text-clay-200 ring-1 ring-clay-500/30"
              >
                <Tag className="h-2.5 w-2.5" />
                {t}
              </span>
            ))}
          </div>
          <button
            onClick={runApply}
            disabled={applying}
            className={cn(
              "ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 transition disabled:opacity-40",
              "bg-clay-500/15 text-clay-200 ring-clay-500/30 hover:bg-clay-500/25",
            )}
            title="Add the suggested tags to this session"
          >
            {applying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {applying
              ? "Applying"
              : `Apply ${newTags.length} ${newTags.length === 1 ? "tag" : "tags"}`}
          </button>
        </div>
      ) : null}

      {/* Nothing new to add — say so plainly (the existing tags already cover it). */}
      {suggestedNothingNew ? (
        <div className="px-5 pb-3 text-[11px] text-zinc-500">
          No new tags to add — this session already has everything we'd suggest.
        </div>
      ) : null}

      {error ? (
        <div className="mx-5 mb-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <X className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}
    </div>
  );
}
