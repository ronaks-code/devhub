import { useCallback, useEffect, useMemo, useState } from "react";
import { Bookmark, BookmarkCheck, X, ChevronUp, ChevronDown } from "lucide-react";
import type { NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";
import { readCompat, writeCompat } from "../lib/compat-storage";

/**
 * In-transcript bookmarks / jump markers. Mark any message (a small bookmark on
 * hover, like the copy affordance), then jump between your marks from a side
 * list or with a keyboard shortcut. Marks persist PER SESSION in localStorage, so
 * they survive reloads and re-opening the session.
 *
 * Plain words: little flags you can stick on messages so you can hop back to the
 * important bits later — the moment a bug was found, the prompt that worked, the
 * command you'll want to copy. They stay put after you close the tab.
 *
 * Storage shape: a single JSON object under {@link STORAGE_KEY} mapping
 * sessionId → ordered list of message uuids. Bookmarking keys off a message's
 * uuid (stable across reloads); messages with no uuid can't be bookmarked (the
 * affordance is simply hidden for them), matching the permalink hook's behavior.
 *
 * The hook ({@link useTranscriptBookmarks}) owns the persisted set + add/remove;
 * {@link BookmarkToggle} is the per-message affordance (threaded into MessageView
 * like `onCopyLink`); {@link BookmarksPanel} is the jump list rail.
 */

const STORAGE_KEY = "devhub:bookmarks";

/** The full persisted map: sessionId → bookmarked message uuids (insertion order). */
type BookmarkMap = Record<string, string[]>;

function readMap(): BookmarkMap {
  try {
    const raw = readCompat(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    // Keep only well-formed string[] entries so a corrupt blob can't poison reads.
    const out: BookmarkMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: BookmarkMap): void {
  writeCompat(STORAGE_KEY, JSON.stringify(map));
}

export interface TranscriptBookmarks {
  /** The bookmarked uuids for the active session (insertion order). */
  ids: string[];
  /** A Set view for O(1) membership checks in the render path. */
  set: Set<string>;
  /** Toggle a message's bookmark by uuid (no-op for a null uuid). */
  toggle: (uuid: string | null) => void;
  /** Remove a single bookmark by uuid. */
  remove: (uuid: string) => void;
  /** Clear every bookmark for the active session. */
  clear: () => void;
}

/**
 * Owns the bookmark set for ONE session, persisted in localStorage. Re-reads when
 * the session id changes so switching transcripts loads that session's marks.
 */
export function useTranscriptBookmarks(sessionId: string | null): TranscriptBookmarks {
  const [ids, setIds] = useState<string[]>(() =>
    sessionId ? (readMap()[sessionId] ?? []) : [],
  );

  // Re-load when the session changes (a different transcript has its own marks).
  useEffect(() => {
    setIds(sessionId ? (readMap()[sessionId] ?? []) : []);
  }, [sessionId]);

  // Persist a new list for this session into the shared map (merge, don't clobber
  // other sessions' marks). Empty lists are dropped so the blob stays tidy.
  const persist = useCallback(
    (next: string[]) => {
      if (!sessionId) return;
      const map = readMap();
      if (next.length === 0) delete map[sessionId];
      else map[sessionId] = next;
      writeMap(map);
    },
    [sessionId],
  );

  const toggle = useCallback(
    (uuid: string | null) => {
      if (!uuid || !sessionId) return;
      setIds((prev) => {
        const next = prev.includes(uuid) ? prev.filter((x) => x !== uuid) : [...prev, uuid];
        persist(next);
        return next;
      });
    },
    [sessionId, persist],
  );

  const remove = useCallback(
    (uuid: string) => {
      setIds((prev) => {
        if (!prev.includes(uuid)) return prev;
        const next = prev.filter((x) => x !== uuid);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const clear = useCallback(() => {
    setIds([]);
    persist([]);
  }, [persist]);

  const set = useMemo(() => new Set(ids), [ids]);

  return useMemo(
    () => ({ ids, set, toggle, remove, clear }),
    [ids, set, toggle, remove, clear],
  );
}

/**
 * Per-message bookmark affordance, threaded into MessageView's hover row exactly
 * like {@link CopyMessage} / the copy-link button (inherits the row's `group` so
 * it fades in on hover; stays solid + clay once marked).
 */
export function BookmarkToggle({
  bookmarked,
  onToggle,
  className,
}: {
  bookmarked: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition",
        bookmarked
          ? "text-clay-300 opacity-100 hover:bg-zinc-800"
          : "text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100",
        className,
      )}
      title={bookmarked ? "Remove bookmark" : "Bookmark this message"}
      aria-label={bookmarked ? "Remove bookmark" : "Bookmark this message"}
      aria-pressed={bookmarked}
    >
      {bookmarked ? <BookmarkCheck className="h-3 w-3" /> : <Bookmark className="h-3 w-3" />}
      {bookmarked ? "Saved" : "Bookmark"}
    </button>
  );
}

/** A short preview of a message's prose, for the bookmark list rows. */
function previewText(m: NormalizedMessage): string {
  for (const b of m.blocks) {
    if (b.type === "text" && b.text.trim()) return b.text.trim();
    if (b.type === "thinking" && b.text.trim()) return b.text.trim();
  }
  // Fall back to the first tool name when there's no prose (e.g. a tool-only turn).
  for (const b of m.blocks) {
    if (b.type === "tool_use") return `↳ ${(b as { name?: string }).name ?? "tool"}`;
  }
  return "(no preview)";
}

/**
 * The bookmarks rail: a list of the session's marked messages (in transcript
 * order) with a role chip + prose preview, click-to-jump, and per-row remove.
 * Mirrors the TranscriptOutline / FileChangeSummary side-rail chrome so it sits
 * naturally beside the viewer.
 */
export function BookmarksPanel({
  messages,
  bookmarkedSet,
  activeUuid,
  onJump,
  onRemove,
  onClear,
  onClose,
}: {
  /** The rendered (paired + filtered) list, so jump indices match the viewer. */
  messages: NormalizedMessage[];
  bookmarkedSet: Set<string>;
  /** The bookmark the keyboard nav last landed on, highlighted in the list. */
  activeUuid: string | null;
  /** Jump the viewer to a message by its index in `messages`. */
  onJump: (index: number) => void;
  onRemove: (uuid: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  // The marked messages in transcript order (so the rail reads top-to-bottom),
  // paired with their index in the rendered list for the jump.
  const rows = useMemo(() => {
    const out: { m: NormalizedMessage; index: number }[] = [];
    messages.forEach((m, index) => {
      if (m.uuid && bookmarkedSet.has(m.uuid)) out.push({ m, index });
    });
    return out;
  }, [messages, bookmarkedSet]);

  return (
    <div className="flex w-72 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <Bookmark className="h-3.5 w-3.5 text-clay-400" />
        <span className="text-[12px] font-semibold text-zinc-200">Bookmarks</span>
        <span className="text-[10.5px] text-zinc-600">{rows.length}</span>
        {rows.length > 0 ? (
          <button
            onClick={onClear}
            className="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
            title="Clear all bookmarks for this session"
          >
            Clear
          </button>
        ) : null}
        <button
          onClick={onClose}
          className={cn(
            "rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200",
            rows.length > 0 ? "" : "ml-auto",
          )}
          title="Hide bookmarks"
          aria-label="Hide bookmarks"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-zinc-600">
            No bookmarks yet. Hover a message and click the bookmark to mark it, then
            jump between marks here (or with <kbd className="rounded bg-zinc-800 px-1 text-zinc-400">[</kbd>
            {" / "}
            <kbd className="rounded bg-zinc-800 px-1 text-zinc-400">]</kbd>).
          </div>
        ) : (
          rows.map(({ m, index }) => (
            <div
              key={m.uuid ?? index}
              className={cn(
                "group/bk mx-1.5 mb-0.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5 transition",
                activeUuid && m.uuid === activeUuid
                  ? "bg-clay-500/10 ring-1 ring-clay-500/30"
                  : "hover:bg-zinc-900",
              )}
            >
              <button onClick={() => onJump(index)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-clay-300/80">
                    {m.role}
                  </span>
                  <span className="text-[9.5px] text-zinc-600">#{m.seq}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-zinc-400">
                  {previewText(m)}
                </div>
              </button>
              {m.uuid ? (
                <button
                  onClick={() => onRemove(m.uuid!)}
                  className="mt-0.5 rounded p-0.5 text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-300 group-hover/bk:opacity-100"
                  title="Remove bookmark"
                  aria-label="Remove bookmark"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
      {rows.length > 1 ? (
        <div className="flex items-center gap-1.5 border-t border-zinc-900/80 px-3 py-1.5 text-[10px] text-zinc-700">
          <ChevronUp className="h-3 w-3" />
          <ChevronDown className="h-3 w-3" />
          <span>
            Press <kbd className="rounded bg-zinc-800 px-1 text-zinc-500">[</kbd> /{" "}
            <kbd className="rounded bg-zinc-800 px-1 text-zinc-500">]</kbd> to step
          </span>
        </div>
      ) : null}
    </div>
  );
}
