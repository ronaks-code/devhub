import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  Check,
  Inbox,
  Pin,
  RefreshCw,
  Tag as TagIcon,
} from "lucide-react";
import type { SessionSummary } from "../lib/types";
import { displaySessionTitle } from "../lib/session-title";
import { api } from "../lib/api";
import { compactNumber, relativeTime, totalTokens } from "../lib/format";
import { cn } from "../lib/utils";
import { EmptyState, Spinner } from "./ui";

/** How many recent sessions to pull for triage (server-sorted by recent). */
const INBOX_LIMIT = 60;

/**
 * Is this session "unsorted" — i.e. needs triage? It belongs in the inbox when
 * it's NOT archived AND has no tags AND no notes. Pinned sessions are still shown
 * (a pin alone doesn't mean it's been categorized), but tagging/noting/archiving
 * clears it.
 */
function isUnsorted(s: SessionSummary): boolean {
  return !s.archived && (s.tags?.length ?? 0) === 0 && !(s.notes && s.notes.trim());
}

/** Common starter tags offered as one-click chips in the triage row. */
const QUICK_TAGS = ["keep", "review", "reference", "wip", "done"];

/** One inbox row with quick triage actions. */
function InboxRow({
  s,
  busy,
  onTag,
  onArchive,
  onPin,
  onOpen,
}: {
  s: SessionSummary;
  busy: boolean;
  onTag: (id: string, tag: string) => void;
  onArchive: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onOpen?: (projectId: string, sessionId: string) => void;
}) {
  const [tagDraft, setTagDraft] = useState("");
  const tokens = totalTokens(s.usage);

  const submitTag = () => {
    const t = tagDraft.trim();
    if (t) onTag(s.sessionId, t);
    setTagDraft("");
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 transition",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => onOpen?.(s.projectId, s.sessionId)}
          disabled={!onOpen}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
          title="Open in Browse"
        >
          <div className="truncate text-[13px] font-medium text-zinc-100">
            {displaySessionTitle(s)}
          </div>
        </button>
        {s.pinned ? <Pin className="h-3 w-3 shrink-0 fill-clay-400 text-clay-400" /> : null}
        {onOpen ? (
          <button
            onClick={() => onOpen(s.projectId, s.sessionId)}
            className="shrink-0 rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            title="Open in Browse"
            aria-label="Open session"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span>{relativeTime(s.lastTimestamp)}</span>
        <span>·</span>
        <span>{s.messageCount} msg{s.messageCount === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>{compactNumber(tokens)} tok</span>
        {s.model ? (
          <>
            <span>·</span>
            <span className="truncate" title={s.model}>{s.model}</span>
          </>
        ) : null}
      </div>

      {/* Quick triage actions. Any of these "clears" the row from the inbox on the
          next refresh (tag/note/archive remove it from the unsorted filter). */}
      <div className="flex flex-wrap items-center gap-1.5">
        {QUICK_TAGS.map((t) => (
          <button
            key={t}
            onClick={() => onTag(s.sessionId, t)}
            disabled={busy}
            className="rounded-md bg-zinc-800/70 px-2 py-0.5 text-[11px] font-medium text-zinc-400 ring-1 ring-zinc-700/60 transition hover:bg-clay-500/15 hover:text-clay-300 disabled:opacity-40"
            title={`Tag "${t}"`}
          >
            #{t}
          </button>
        ))}
        <div className="flex items-center gap-1 rounded-md bg-zinc-800/40 px-1.5 ring-1 ring-zinc-700/60">
          <TagIcon className="h-3 w-3 text-zinc-600" />
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitTag();
              }
            }}
            placeholder="tag…"
            disabled={busy}
            className="w-16 bg-transparent py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => onPin(s.sessionId, !s.pinned)}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 transition disabled:opacity-40",
              s.pinned
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30"
                : "bg-zinc-800/70 text-zinc-400 ring-zinc-700/60 hover:text-clay-300",
            )}
            title={s.pinned ? "Unpin" : "Pin"}
          >
            <Pin className={cn("h-3 w-3", s.pinned && "fill-current")} />
          </button>
          <button
            onClick={() => onArchive(s.sessionId)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-zinc-800/70 px-2 py-0.5 text-[11px] font-medium text-zinc-400 ring-1 ring-zinc-700/60 transition hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
            title="Archive (clears it from the inbox)"
          >
            <Archive className="h-3 w-3" />
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A triage / inbox view of NEW + unsorted sessions: recent sessions across all
 * projects that haven't been categorized yet (no tags, no notes, not archived).
 * Each row offers quick tag / archive / pin actions to "clear" it — once a
 * session is tagged/noted/archived it drops out of the inbox on the next refresh.
 *
 * Backed by the cross-project GET /api/all-sessions (sorted by recent); the
 * unsorted filter happens client-side so it works against any server. Actions go
 * through the session PATCH route (setTags / setArchived / setPinned).
 */
export function InboxPane({
  onOpenSession,
}: {
  /** Open a session in Browse: (projectId, sessionId). */
  onOpenSession?: (projectId: string, sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // sessionIds with an action in flight (disables the row briefly).
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  // sessionIds the user just cleared (tagged/archived) — hidden immediately for a
  // snappy "it's handled" feel, even before the next refresh confirms it.
  const [clearedIds, setClearedIds] = useState<ReadonlySet<string>>(() => new Set());
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    setRefreshing(true);
    api
      .allSessions({ sort: "recent", limit: INBOX_LIMIT })
      .then((rows) => {
        if (!aliveRef.current) return;
        setSessions(rows);
        // A real refresh re-derives the inbox from server truth, so drop the
        // optimistic "cleared" set.
        setClearedIds(new Set());
      })
      .catch(() => {
        if (aliveRef.current && sessions == null) setSessions([]);
      })
      .finally(() => {
        if (aliveRef.current) setRefreshing(false);
      });
  }, [sessions]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
    };
    // Mount-only initial load; manual Refresh re-fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withBusy = useCallback(
    async (id: string, op: () => Promise<unknown>, clears: boolean) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        await op();
        if (clears && aliveRef.current) {
          setClearedIds((prev) => new Set(prev).add(id));
        }
      } catch {
        /* leave the row in place; the user can retry */
      } finally {
        if (aliveRef.current) {
          setBusyIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }
    },
    [],
  );

  const handleTag = useCallback(
    (id: string, tag: string) => {
      const existing = sessions?.find((s) => s.sessionId === id)?.tags ?? [];
      void withBusy(id, () => api.setTags(id, [...existing, tag]), true);
    },
    [sessions, withBusy],
  );

  const handleArchive = useCallback(
    (id: string) => void withBusy(id, () => api.setArchived(id, true), true),
    [withBusy],
  );

  // Pinning does NOT clear the row (a pin isn't categorization); update in place.
  const handlePin = useCallback(
    (id: string, pinned: boolean) => {
      void withBusy(
        id,
        async () => {
          await api.setPinned(id, pinned);
          if (aliveRef.current) {
            setSessions((prev) =>
              prev ? prev.map((s) => (s.sessionId === id ? { ...s, pinned } : s)) : prev,
            );
          }
        },
        false,
      );
    },
    [withBusy],
  );

  const inbox = useMemo(() => {
    if (!sessions) return [];
    return sessions.filter((s) => isUnsorted(s) && !clearedIds.has(s.sessionId));
  }, [sessions, clearedIds]);

  const clearedCount = clearedIds.size;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">
            <Inbox className="h-4 w-4 text-clay-400" />
            Inbox
          </h1>
          {sessions ? (
            <span className="text-[12px] text-zinc-500">
              {inbox.length} to triage
              {clearedCount > 0 ? (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">
                  <Check className="h-3 w-3" />
                  {clearedCount} cleared
                </span>
              ) : null}
            </span>
          ) : null}
          <button
            onClick={load}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-200"
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>

        <p className="text-[12px] text-zinc-600">
          Recent sessions that haven't been sorted yet — no tags, no notes, not
          archived. Tag, pin, or archive them to clear the queue.
        </p>

        {sessions == null ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : inbox.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 py-14">
            <EmptyState
              icon={<Inbox className="h-10 w-10" />}
              title="Inbox zero"
              hint="Every recent session is sorted. New, untagged sessions will appear here for triage."
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {inbox.map((s) => (
              <InboxRow
                key={s.sessionId}
                s={s}
                busy={busyIds.has(s.sessionId)}
                onTag={handleTag}
                onArchive={handleArchive}
                onPin={handlePin}
                onOpen={onOpenSession}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
