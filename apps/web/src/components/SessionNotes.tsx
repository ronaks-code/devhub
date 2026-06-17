import { useEffect, useRef, useState } from "react";
import { Check, Eye, Loader2, Pencil, StickyNote, X } from "lucide-react";
import { api } from "../lib/api";
import { Markdown } from "./Markdown";
import { cn } from "../lib/utils";

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Freeform markdown notes for one session, loaded from the session's `notes`
 * (the web-widened SessionSummaryWithNotes field) and saved via
 * PATCH /api/sessions/:id { notes } (api.setNotes). Edit in a plain textarea or
 * flip to a rendered markdown Preview (reusing the shared Markdown component).
 *
 * Saving is explicit (a Save button) plus an auto-save on close, so a quick note
 * is never lost — but we never spam the server per keystroke. A per-turn server
 * that doesn't persist `notes` still ACKs the PATCH (it forwards present keys),
 * so the editor degrades to in-memory until the engine lane lands `notes`.
 *
 * Presentational + self-contained: it owns its draft, and reports the saved
 * value back via `onSaved` so the host can refresh its session list if it wants.
 */
export function SessionNotes({
  sessionId,
  initialNotes,
  onClose,
  onSaved,
}: {
  sessionId: string;
  /** The session's persisted notes (from SessionSummaryWithNotes.notes). */
  initialNotes?: string | null;
  /** Close the notes panel (auto-saves first if the draft is dirty). */
  onClose?: () => void;
  /** Notified with the saved notes after a successful PATCH. */
  onSaved?: (notes: string) => void;
}) {
  const [draft, setDraft] = useState(initialNotes ?? "");
  // The last value we know is persisted, so we can tell "dirty" from "clean" and
  // skip a no-op save on close.
  const [saved, setSaved] = useState(initialNotes ?? "");
  const [preview, setPreview] = useState(false);
  const [state, setState] = useState<SaveState>("idle");
  // Mirror the draft for the unmount auto-save (the effect's cleanup runs with a
  // stale closure otherwise).
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  draftRef.current = draft;
  savedRef.current = saved;

  // Re-seed when switching to a different session (the panel is reused across
  // sessions). Resets the dirty baseline + view.
  useEffect(() => {
    setDraft(initialNotes ?? "");
    setSaved(initialNotes ?? "");
    setPreview(false);
    setState("idle");
  }, [sessionId, initialNotes]);

  const dirty = draft !== saved;

  const persist = async (value: string) => {
    setState("saving");
    try {
      // The route's `notes` field is a plain string — clearing sends "" (the
      // server treats an empty string as "no notes"), never null.
      await api.setNotes(sessionId, value);
      setSaved(value);
      savedRef.current = value;
      setState("saved");
      onSaved?.(value);
      window.setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1600);
    } catch {
      setState("error");
    }
  };

  // Auto-save the latest draft on unmount when it diverged from the saved value,
  // so closing the panel never silently drops a note.
  useEffect(() => {
    return () => {
      if (draftRef.current !== savedRef.current) {
        void api.setNotes(sessionId, draftRef.current).catch(() => {});
      }
    };
  }, [sessionId]);

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-900/30">
      <div className="flex items-center gap-2 px-5 py-2">
        <StickyNote className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-[12px] font-medium text-zinc-300">Notes</span>
        {dirty ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            unsaved
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setPreview((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 transition",
              preview
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={preview ? "Edit notes" : "Preview rendered markdown"}
          >
            {preview ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {preview ? "Edit" : "Preview"}
          </button>
          <button
            onClick={() => void persist(draft)}
            disabled={!dirty || state === "saving"}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 transition disabled:opacity-40",
              state === "error"
                ? "bg-red-500/15 text-red-300 ring-red-500/30"
                : state === "saved"
                  ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                  : "bg-clay-500/15 text-clay-200 ring-clay-500/30 hover:bg-clay-500/25",
            )}
            title="Save notes (PATCH /api/sessions/:id)"
          >
            {state === "saving" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {state === "saving"
              ? "Saving"
              : state === "saved"
                ? "Saved"
                : state === "error"
                  ? "Retry"
                  : "Save"}
          </button>
          {onClose ? (
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
              title="Close notes"
              aria-label="Close notes"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="px-5 pb-3">
        {preview ? (
          <div className="max-h-64 overflow-auto rounded-lg bg-zinc-950/60 px-3 py-2 ring-1 ring-zinc-800">
            {draft.trim() ? (
              <Markdown text={draft} />
            ) : (
              <div className="text-[12px] italic text-zinc-600">Nothing to preview yet.</div>
            )}
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck
            rows={6}
            placeholder="Jot notes about this session — markdown supported. Saved per session."
            className="max-h-64 min-h-[6rem] w-full resize-y rounded-lg bg-zinc-950/60 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
          />
        )}
        {state === "error" ? (
          <div className="mt-1 text-[11px] text-red-400">
            Couldn't save notes — the server may not support notes yet. Your draft is kept here.
          </div>
        ) : null}
      </div>
    </div>
  );
}
