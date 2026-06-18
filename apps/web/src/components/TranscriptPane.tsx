import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  MessagesSquare,
  GitBranch,
  Coins,
  MessageSquare,
  HardDrive,
  Users,
  ArrowUp,
  ArrowDown,
  ListTree,
  FileDiff,
  Map as MapIcon,
  MessageSquarePlus,
  AlertCircle,
  ChevronUp,
  ChevronDown,
  BookOpen,
  StickyNote,
  GitCompareArrows,
  Film,
  Bookmark,
} from "lucide-react";
import type { SessionMessagesPage } from "../lib/types";
import { MessageView } from "./MessageView";
import { GitPanel } from "./GitPanel";
import { FindBar } from "./FindBar";
import { SessionNotes } from "./SessionNotes";
import { SessionTimeline } from "./SessionTimeline";
import { BookmarksPanel, useTranscriptBookmarks } from "./TranscriptBookmarks";
import { TranscriptOutline } from "./TranscriptOutline";
import { TranscriptMinimap } from "./TranscriptMinimap";
import { SubagentProvider } from "./tools/TaskCard";
import { CwdProvider } from "./OpenInEditor";
import { TranscriptSkeleton } from "./Skeleton";
import { FileChangeSummary } from "./FileChangeSummary";
import { useErrorNav } from "../hooks/useErrorNav";
import { useReadingMode } from "../hooks/useReadingMode";
import {
  TranscriptFilters,
  applyFilters,
  EMPTY_FILTERS,
  type TranscriptFilterState,
} from "./TranscriptFilters";
import { Badge, EmptyState, Spinner } from "./ui";
import { compactNumber, formatBytes, totalTokens } from "../lib/format";
import { pairToolResults } from "../lib/transcript";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useMessagePermalink } from "../hooks/useMessagePermalink";
import { cn } from "../lib/utils";

export function TranscriptPane({
  page,
  loading,
  onLoadMore,
  onContinue,
  onCompare,
  jumpTarget,
}: {
  page: SessionMessagesPage | null;
  loading: boolean;
  onLoadMore: () => void;
  /** Hand off to the Chat tab to resume this session (--resume). */
  onContinue?: (sessionId: string, cwd: string) => void;
  /**
   * Open the side-by-side comparison modal seeded with THIS session as the left
   * column. When set, a "Compare" affordance shows in the header. Read-only.
   */
  onCompare?: (sessionId: string) => void;
  /**
   * A search-pick request to scroll to + briefly highlight one message by its
   * `seq`. The `nonce` changes per pick so re-picking the same hit re-fires the
   * jump. Null = no pending jump (normal "follow the tail" behavior).
   */
  jumpTarget?: { seq: number; nonce: number } | null;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const lastSession = useRef<string | undefined>(undefined);
  // Pair tool_use ⇄ tool_result so each tool call renders as one card.
  const paired = useMemo(
    () => pairToolResults(page?.messages ?? []),
    [page?.messages],
  );
  // Client-side filter chips (role / tool / errors-only / hide-thinking). Applied
  // after pairing so the virtualizer, find bar, and outline all index the same
  // visible list and their positions stay in sync.
  const [filters, setFilters] = useState<TranscriptFilterState>(EMPTY_FILTERS);
  // "Reading mode": strip the transcript to user + assistant prose for a clean
  // read (hides tool cards, thinking, system/meta). Applied after the chip
  // filters so the virtualizer, find bar, outline, and minimap all index the
  // same visible list. When off, `apply` returns the input unchanged.
  const reading = useReadingMode();
  // The full visible list after pairing + chip filters + reading mode. Replay
  // mode (below) slices THIS into the rendered `messages`; everything else
  // (virtualizer, find, outline, minimap, error nav) indexes the rendered slice
  // so positions stay in sync, while the timeline scrubber spans the full list.
  const fullMessages = useMemo(
    () => reading.apply(applyFilters(paired, filters)),
    [paired, filters, reading],
  );
  // Per-session markdown notes panel toggle (header affordance). The session's
  // saved notes come straight from SessionSummary.notes.
  const [notesOpen, setNotesOpen] = useState(false);

  // The subagent files for this session, threaded to any Task cards in the
  // transcript so their "view subagent transcript" expander can load them.
  // Stable per (session, refs) so the context value doesn't churn each render.
  const subagentSource = useMemo(
    () => ({ sessionId: page?.session.sessionId ?? null, refs: page?.subagents ?? [] }),
    [page?.session.sessionId, page?.subagents],
  );

  // In-transcript find (Cmd/Ctrl-F): the bar owns its query/cursor and reports
  // the active match's message index + live query back up here for scroll+highlight.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState<number | null>(null);
  // Collapsible outline (TOC) side-rail listing user turns + major tool actions.
  const [outlineOpen, setOutlineOpen] = useState(false);
  // Collapsible "what changed" side-rail: files touched by edits with +/- counts.
  // Mutually exclusive with the outline so two rails never crowd the viewer.
  const [changesOpen, setChangesOpen] = useState(false);
  // In-transcript bookmarks: per-session marks (persisted in localStorage) with a
  // jump-list rail and [ / ] keyboard stepping. The rail is mutually exclusive
  // with the outline/changes rails so only one side panel shows at a time.
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const bookmarks = useTranscriptBookmarks(page?.session.sessionId ?? null);
  // The bookmark the [ / ] stepper last landed on, briefly highlighted in the rail.
  const [activeBookmark, setActiveBookmark] = useState<string | null>(null);
  // Thin minimap/overview scrollbar beside the transcript (message density +
  // role color ticks, click-to-scroll). On by default; toggleable from the header.
  const [minimapOpen, setMinimapOpen] = useState(true);
  // Replay/timeline mode: a turn-by-turn scrubber that progressively reveals the
  // transcript. Off by default (full view). `revealCount` is a 1-based count of
  // messages shown; `replayPlaying` drives the auto-advance. The rendered list is
  // sliced to `revealCount` only while this mode is on, so the normal full view is
  // preserved untouched when it's off.
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [revealCount, setRevealCount] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  // The rendered list: the full visible set, sliced to the replay playhead while
  // timeline mode is on (and clamped, so a shrinking filter never overshoots).
  const messages = useMemo(
    () =>
      timelineOpen
        ? fullMessages.slice(0, Math.max(0, Math.min(revealCount, fullMessages.length)))
        : fullMessages,
    [fullMessages, timelineOpen, revealCount],
  );
  const onFindQueryChange = useCallback((q: string) => setFindQuery(q), []);
  const onActiveMatchChange = useCallback((i: number | null) => setActiveMatch(i), []);

  // The list index of a search-driven jump target, briefly highlighted after we
  // scroll to it. Null = nothing highlighted. Set by the jump effect below and
  // auto-cleared on a timer.
  const [jumpIndex, setJumpIndex] = useState<number | null>(null);
  // Remembers which jump nonce we've already handled, so the jump effect fires
  // exactly once per search pick (and once the matching page has loaded).
  const handledJumpRef = useRef<number | null>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 10,
  });

  // Live transcripts (the open session is still running) grow as new lines land.
  // Follow the tail only while the user is parked at the bottom; if they scrolled
  // up to read history, stop and show a "jump to latest" pill instead.
  const stick = useStickToBottom(parentRef);

  // Toggle replay/timeline mode. Opening it seeds the playhead at the END (full
  // transcript shown) so nothing blanks out — the user scrubs back to replay —
  // and stops following the live tail so the scrubber owns the scroll. Closing it
  // halts playback and restores the normal full view.
  const toggleTimeline = useCallback(() => {
    setTimelineOpen((open) => {
      const next = !open;
      if (next) {
        stick.unpin();
        setRevealCount(fullMessages.length);
      } else {
        setReplayPlaying(false);
      }
      return next;
    });
  }, [fullMessages.length, stick]);

  // Keep the playhead seeded at the end as the full list grows WHILE replay mode
  // is open but the user hasn't scrubbed yet (revealCount tracks the end). This
  // lets a live session keep showing everything until the user takes the scrubber.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!timelineOpen) {
      seededRef.current = false;
      return;
    }
    if (!seededRef.current) {
      seededRef.current = true;
      setRevealCount(fullMessages.length);
    }
  }, [timelineOpen, fullMessages.length]);

  // Scroll the virtualizer to a given message (used by the outline rail).
  const jumpToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "start" }),
    [virtualizer],
  );

  // Timer handle for the error-nav highlight, so a rapid next/prev replaces the
  // prior fade instead of stacking timers.
  const errorHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scroll to + briefly highlight an error message (drives the same clay glow as
  // a search jump). Stops following the live tail so the view rests on the error.
  const highlightError = useCallback(
    (index: number) => {
      stick.unpin();
      virtualizer.scrollToIndex(index, { align: "center" });
      setJumpIndex(index);
      if (errorHighlightTimer.current) clearTimeout(errorHighlightTimer.current);
      errorHighlightTimer.current = setTimeout(() => setJumpIndex(null), 2200);
    },
    [stick, virtualizer],
  );
  useEffect(
    () => () => {
      if (errorHighlightTimer.current) clearTimeout(errorHighlightTimer.current);
    },
    [],
  );

  // Collect error messages in the (paired + filtered) transcript and drive
  // next/prev navigation over them. Keyboard: Alt+E / Alt+Shift+E. Enabled only
  // when a transcript is loaded.
  const errorNav = useErrorNav(messages, highlightError, !!page);

  // Deep-link support: #<uuid> | #seq-<n> scrolls to + flashes a message. The
  // hook does the DOM scroll/flash, but the transcript is virtualized — so we
  // first scroll the virtualizer to the hashed message's index (mounting its
  // node) whenever the loaded set changes; the hook then finds + flashes it.
  const { copyPermalink } = useMessagePermalink([messages.length, page?.session.sessionId]);
  useEffect(() => {
    if (messages.length === 0) return;
    const raw = window.location.hash.replace(/^#/, "").trim();
    if (!raw) return;
    const idx = /^(seq-)?\d+$/.test(raw)
      ? Number(raw.replace(/^seq-/, ""))
      : messages.findIndex((m) => m.uuid === raw);
    if (idx == null || idx < 0 || idx >= messages.length) return;
    stick.unpin(); // rest on the linked message rather than chasing the tail
    const raf = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(idx, { align: "center" }),
    );
    return () => cancelAnimationFrame(raf);
    // Re-run when the loaded set or the active session changes (fresh-tab deep
    // link). `stick.unpin` is a stable useCallback, so depending on it (not the
    // whole `stick` object, which is a fresh literal each render) avoids looping.
  }, [messages, page?.session.sessionId, virtualizer, stick.unpin]);

  // Cmd/Ctrl-F opens the find bar (preventing the browser's native find), and
  // Escape closes it. Scoped to when a transcript is loaded.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.key === "Escape" && findOpen) {
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findOpen]);

  // Closing the find bar clears the highlight/cursor state.
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setActiveMatch(null);
  }, []);

  // Bookmark jump: scroll the viewer to a marked message (by its index in the
  // rendered list), stop following the live tail, and briefly clay-flash it —
  // reusing the same `jumpIndex` highlight as search/error nav. Also records the
  // active bookmark so the rail can highlight the current step.
  const jumpToBookmark = useCallback(
    (index: number, uuid: string | null) => {
      stick.unpin();
      setActiveBookmark(uuid);
      setJumpIndex(index);
      virtualizer.scrollToIndex(index, { align: "center" });
      if (errorHighlightTimer.current) clearTimeout(errorHighlightTimer.current);
      errorHighlightTimer.current = setTimeout(() => setJumpIndex(null), 2200);
    },
    [stick, virtualizer],
  );

  // Forget the active-bookmark highlight when the session changes (its uuid no
  // longer refers to anything in the newly-loaded transcript).
  useEffect(() => {
    setActiveBookmark(null);
  }, [page?.session.sessionId]);

  // The rendered-list indices of bookmarked messages, in transcript order — the
  // sequence the [ / ] stepper walks.
  const bookmarkIndices = useMemo(() => {
    const out: { index: number; uuid: string }[] = [];
    messages.forEach((m, index) => {
      if (m.uuid && bookmarks.set.has(m.uuid)) out.push({ index, uuid: m.uuid });
    });
    return out;
  }, [messages, bookmarks.set]);

  // Keyboard: "]" jumps to the next bookmark, "[" to the previous (wrapping).
  // Skipped while typing in a field so the literal bracket still types. No mod
  // key required; the brackets are otherwise unbound in the transcript.
  useEffect(() => {
    if (bookmarkIndices.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) {
        return;
      }
      e.preventDefault();
      // Find where we are relative to the marks: the index of the active mark, or
      // the nearest one to the current playhead, defaulting to the first/last.
      const curPos = activeBookmark
        ? bookmarkIndices.findIndex((b) => b.uuid === activeBookmark)
        : -1;
      const n = bookmarkIndices.length;
      const nextPos =
        e.key === "]"
          ? curPos < 0
            ? 0
            : (curPos + 1) % n
          : curPos < 0
            ? n - 1
            : (curPos - 1 + n) % n;
      const target = bookmarkIndices[nextPos]!;
      jumpToBookmark(target.index, target.uuid);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bookmarkIndices, activeBookmark, jumpToBookmark]);

  // Scroll the virtualizer to the active match's message whenever it changes.
  useEffect(() => {
    if (activeMatch == null) return;
    const id = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(activeMatch, { align: "center" }),
    );
    return () => cancelAnimationFrame(id);
  }, [activeMatch, virtualizer]);

  // Whether a search-driven jump is still pending for the current pick. When so,
  // the jump effect (not the bottom-snap) should own the first scroll.
  const jumpPending =
    jumpTarget != null && handledJumpRef.current !== jumpTarget.nonce;

  // Jump to the latest message when a NEW session opens (not on load-more).
  // Opening a session re-pins so live updates follow until the user scrolls up.
  // Skipped when a search pick wants us to land on a specific message instead.
  useEffect(() => {
    if (!page || messages.length === 0) return;
    if (lastSession.current === page.session.sessionId) return;
    lastSession.current = page.session.sessionId;
    if (jumpPending) return; // the jump effect will scroll + highlight instead
    stick.pin();
    const id = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" }),
    );
    return () => cancelAnimationFrame(id);
  }, [page, messages.length, virtualizer, stick.pin, jumpPending]);

  // Scroll to + briefly highlight a search-picked message once its session's
  // page has loaded. Matches by `seq` (stable within the window) against the
  // paired+filtered list. If the target was filtered out (or isn't in the loaded
  // window), we fall back to the bottom so the session still opens sensibly.
  useEffect(() => {
    if (!jumpTarget || !page || messages.length === 0) return;
    if (handledJumpRef.current === jumpTarget.nonce) return;
    // Wait until the loaded page is the session the pick targeted (a project/
    // session switch loads asynchronously; lastSession tracks the active one).
    if (lastSession.current !== page.session.sessionId) return;
    handledJumpRef.current = jumpTarget.nonce;
    const idx = messages.findIndex((m) => m.seq === jumpTarget.seq);
    if (idx < 0) return; // target not in the visible/loaded set — leave as-is
    // The match is (usually) above the live tail, so stop following the tail
    // and let the view rest on the match instead.
    stick.unpin();
    setJumpIndex(idx);
    const raf = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(idx, { align: "center" }),
    );
    const clear = setTimeout(() => setJumpIndex(null), 2200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(clear);
    };
  }, [jumpTarget, page, messages, virtualizer, stick]);

  // Follow live growth (same session gains messages) only while pinned. The new
  // session jump above owns the first paint; this handles subsequent updates.
  // Suspended during replay so the scrubber, not the live tail, owns the scroll.
  useEffect(() => {
    if (timelineOpen) return;
    if (messages.length === 0) return;
    if (lastSession.current !== page?.session.sessionId) return;
    return stick.followToIndex(() =>
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" }),
    );
  }, [messages.length, page?.session.sessionId, virtualizer, stick.followToIndex, timelineOpen]);

  // During replay, keep the freshly-revealed message in view so the scrubber +
  // play read like a progressive reveal. Aligns the playhead message to the end.
  useEffect(() => {
    if (!timelineOpen || messages.length === 0) return;
    const raf = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" }),
    );
    return () => cancelAnimationFrame(raf);
  }, [timelineOpen, messages.length, virtualizer]);

  if (!page) {
    return (
      <div className="flex-1 bg-zinc-950">
        {loading ? (
          <TranscriptSkeleton />
        ) : (
          <EmptyState
            icon={<MessagesSquare className="h-12 w-12" />}
            title="Select a session"
            hint="Pick a project, then a chat to read its full transcript — rendered the way Claude Code shows it."
          />
        )}
      </div>
    );
  }

  const s = page.session;
  return (
    <SubagentProvider value={subagentSource}>
    <CwdProvider value={s.cwd}>
    <div className="relative flex min-w-0 flex-1 flex-col bg-zinc-950">
      <FindBar
        open={findOpen}
        messages={messages}
        onClose={closeFind}
        onQueryChange={onFindQueryChange}
        onActiveMatchChange={onActiveMatchChange}
      />
      <div className="border-b border-zinc-800/80 px-5 py-3">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold text-zinc-100">{s.title}</h1>
          {loading && <Spinner className="h-3.5 w-3.5" />}

          {/* Error navigator: jump to / step through tool errors in this
              transcript. Hidden when the (filtered) transcript has none. */}
          {errorNav.count > 0 ? (
            <div
              className="ml-auto inline-flex shrink-0 items-center rounded-lg bg-red-500/10 text-red-300 ring-1 ring-red-500/25"
              title="Errors in this transcript — click to jump, ↑↓ to step (Alt+E / Alt+Shift+E)"
            >
              <button
                onClick={errorNav.first}
                className="inline-flex items-center gap-1.5 rounded-l-lg px-2.5 py-1 text-[12px] font-medium transition hover:bg-red-500/15"
              >
                <AlertCircle className="h-3.5 w-3.5" />
                {errorNav.position > 0 ? `${errorNav.position}/${errorNav.count}` : errorNav.count}
                <span className="text-red-300/70">error{errorNav.count === 1 ? "" : "s"}</span>
              </button>
              <button
                onClick={errorNav.prev}
                title="Previous error (Alt+Shift+E)"
                aria-label="Previous error"
                className="border-l border-red-500/20 px-1.5 py-1 transition hover:bg-red-500/15"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={errorNav.next}
                title="Next error (Alt+E)"
                aria-label="Next error"
                className="rounded-r-lg border-l border-red-500/20 px-1.5 py-1 transition hover:bg-red-500/15"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {/* Bookmarks rail toggle — shows a count badge once any mark exists.
              Mutually exclusive with the outline/changes rails. */}
          <button
            onClick={() => {
              setBookmarksOpen((v) => !v);
              setOutlineOpen(false);
              setChangesOpen(false);
            }}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
              errorNav.count === 0 && "ml-auto",
              bookmarksOpen
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={bookmarksOpen ? "Hide bookmarks" : "Bookmarks (jump between marked messages)"}
            aria-pressed={bookmarksOpen}
          >
            <Bookmark className="h-3.5 w-3.5" />
            {bookmarks.ids.length > 0 ? bookmarks.ids.length : "Marks"}
          </button>
          <button
            onClick={() => {
              setChangesOpen((v) => !v);
              setOutlineOpen(false);
              setBookmarksOpen(false);
            }}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
              changesOpen
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={changesOpen ? "Hide changes" : "Show what changed"}
          >
            <FileDiff className="h-3.5 w-3.5" />
            Changes
          </button>
          <button
            onClick={() => {
              setOutlineOpen((v) => !v);
              setChangesOpen(false);
              setBookmarksOpen(false);
            }}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
              outlineOpen
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={outlineOpen ? "Hide outline" : "Show outline"}
          >
            <ListTree className="h-3.5 w-3.5" />
            Outline
          </button>
          <button
            onClick={() => setMinimapOpen((v) => !v)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
              minimapOpen
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={minimapOpen ? "Hide minimap" : "Show minimap"}
            aria-label={minimapOpen ? "Hide minimap" : "Show minimap"}
          >
            <MapIcon className="h-3.5 w-3.5" />
          </button>

          {/* Reading mode: hide tool cards / thinking / system, show only the
              user + assistant prose for a clean, article-like read. */}
          <button
            onClick={reading.toggle}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
              reading.enabled
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={reading.enabled ? "Exit reading mode" : "Reading mode — prose only"}
            aria-pressed={reading.enabled}
          >
            <BookOpen className="h-3.5 w-3.5" />
            Read
          </button>

          {/* Replay mode: a turn-by-turn scrubber that progressively reveals the
              transcript. Toggling it on shows the timeline bar below the header. */}
          <button
            onClick={toggleTimeline}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
              timelineOpen
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={timelineOpen ? "Exit replay" : "Replay this session turn by turn"}
            aria-pressed={timelineOpen}
          >
            <Film className="h-3.5 w-3.5" />
            Replay
          </button>

          {/* Per-session markdown notes. */}
          <button
            onClick={() => setNotesOpen((v) => !v)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
              notesOpen
                ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
                : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
            )}
            title={notesOpen ? "Hide notes" : "Notes for this session"}
            aria-pressed={notesOpen}
          >
            <StickyNote className="h-3.5 w-3.5" />
            Notes
          </button>
          {/* Open a side-by-side comparison with another session (read-only). */}
          {onCompare ? (
            <button
              onClick={() => onCompare(s.sessionId)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-zinc-400 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-200"
              title="Compare this session with another"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              Compare
            </button>
          ) : null}
          {onContinue && s.cwd ? (
            <button
              onClick={() => onContinue(s.sessionId, s.cwd!)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-clay-500/15 px-2.5 py-1 text-[12px] font-medium text-clay-300 ring-1 ring-clay-500/30 transition hover:bg-clay-500/25 hover:text-clay-200"
              title="Resume this session in the Chat tab"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Continue this chat
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {s.cwd && (
            <Badge title={s.cwd} className="max-w-[28rem]">
              <span className="truncate">{s.cwd}</span>
            </Badge>
          )}
          {s.gitBranch ? (
            <Badge>
              <GitBranch className="h-3 w-3" />
              {s.gitBranch}
            </Badge>
          ) : null}
          <Badge>
            <MessageSquare className="h-3 w-3" />
            {s.messageCount} msgs
          </Badge>
          <Badge title="input + output + cache tokens">
            <Coins className="h-3 w-3" />
            {compactNumber(totalTokens(s.usage))} tok
          </Badge>
          <Badge>
            <HardDrive className="h-3 w-3" />
            {formatBytes(s.sizeBytes)}
          </Badge>
          {page.subagents.length > 0 && (
            <Badge title="subagent transcripts">
              <Users className="h-3 w-3" />
              {page.subagents.length} subagents
            </Badge>
          )}
        </div>
      </div>

      {/* Replay scrubber (toggled from the header). Spans the FULL visible list so
          every turn is reachable; the host slices `messages` to its playhead. */}
      {timelineOpen && fullMessages.length > 0 ? (
        <SessionTimeline
          messages={fullMessages}
          value={revealCount}
          onChange={setRevealCount}
          playing={replayPlaying}
          onPlayingChange={setReplayPlaying}
          onClose={toggleTimeline}
        />
      ) : null}

      {/* Per-session markdown notes editor (toggled from the header). Loaded from
          the session's `notes`, saved via PATCH /api/sessions/:id { notes }. */}
      {notesOpen ? (
        <SessionNotes
          key={s.sessionId}
          sessionId={s.sessionId}
          initialNotes={s.notes}
          onClose={() => setNotesOpen(false)}
        />
      ) : null}

      {/* Read-only git panel for the session's working directory (collapsed by
          default; fetches on expand). Only shown when we know the cwd. */}
      {s.cwd ? <GitPanel cwd={s.cwd} /> : null}

      {/* Filter chips. Derived from the FULL paired list (so toggling a filter
          never hides the chips themselves) and applied to produce `messages`. */}
      {paired.length > 0 ? (
        <TranscriptFilters messages={paired} value={filters} onChange={setFilters} />
      ) : null}

      {page.truncatedFromStart && (
        <button
          onClick={onLoadMore}
          className="flex items-center justify-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 py-2 text-xs text-zinc-400 transition hover:bg-zinc-900 hover:text-clay-300"
        >
          <ArrowUp className="h-3.5 w-3.5" />
          Showing recent messages — load older history
        </button>
      )}

      <div className="flex min-h-0 flex-1">
      <div className="relative min-h-0 flex-1">
        <div ref={parentRef} onScroll={stick.onScroll} className="h-full overflow-y-auto">
          {messages.length === 0 && paired.length > 0 ? (
            <EmptyState
              icon={reading.enabled ? <BookOpen className="h-10 w-10" /> : <MessagesSquare className="h-10 w-10" />}
              title={
                reading.enabled
                  ? "No prose to read here"
                  : "No messages match these filters"
              }
              hint={
                reading.enabled
                  ? "This session is all tool calls — turn off reading mode to see them."
                  : "Adjust or clear the filter chips above to see the rest of the transcript."
              }
            />
          ) : null}
          <div
            style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
                className={cn(
                  "border-b border-zinc-900/70 transition-colors duration-500",
                  findOpen && activeMatch === vi.index && "bg-amber-500/5 ring-1 ring-inset ring-amber-500/30",
                  jumpIndex === vi.index && "bg-clay-500/10 ring-1 ring-inset ring-clay-500/40",
                )}
              >
                <MessageView
                  m={messages[vi.index]!}
                  highlight={findOpen ? findQuery : ""}
                  prevTimestamp={messages[vi.index - 1]?.timestamp ?? null}
                  onCopyLink={copyPermalink}
                  bookmarked={
                    messages[vi.index]!.uuid
                      ? bookmarks.set.has(messages[vi.index]!.uuid!)
                      : false
                  }
                  onToggleBookmark={(uuid) => bookmarks.toggle(uuid)}
                />
              </div>
            ))}
          </div>
        </div>

        {/* "Jump to latest" pill — surfaced when the user scrolled up. Re-pins
            and snaps to the newest message so live updates resume following. */}
        {stick.showJumpToLatest && messages.length > 0 ? (
          <button
            onClick={() =>
              stick.scrollToLatest(() =>
                virtualizer.scrollToIndex(messages.length - 1, { align: "end" }),
              )
            }
            className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-clay-500 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg ring-1 ring-clay-400/50 transition hover:bg-clay-600"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
          </button>
        ) : null}
      </div>

      {outlineOpen ? (
        <TranscriptOutline
          messages={messages}
          onJump={jumpToIndex}
          onClose={() => setOutlineOpen(false)}
          activeIndex={findOpen ? activeMatch : null}
        />
      ) : null}

      {changesOpen ? (
        <FileChangeSummary
          messages={messages}
          onJump={(i) => {
            // Stop following the live tail so the view rests on the edit card.
            stick.unpin();
            jumpToIndex(i);
          }}
          onClose={() => setChangesOpen(false)}
        />
      ) : null}

      {/* Bookmarks rail: the session's marked messages with click-to-jump (and
          the same clay highlight the [ / ] stepper uses). */}
      {bookmarksOpen ? (
        <BookmarksPanel
          messages={messages}
          bookmarkedSet={bookmarks.set}
          activeUuid={activeBookmark}
          onJump={(i) => jumpToBookmark(i, messages[i]?.uuid ?? null)}
          onRemove={bookmarks.remove}
          onClear={bookmarks.clear}
          onClose={() => setBookmarksOpen(false)}
        />
      ) : null}

      {/* Thin overview minimap. Click a tick to jump; tracks the active find
          match. Hidden while an outline/changes/bookmarks rail is open (they'd
          crowd the viewer) and toggleable from the header. */}
      {minimapOpen && !outlineOpen && !changesOpen && !bookmarksOpen ? (
        <TranscriptMinimap
          messages={messages}
          activeIndex={findOpen ? activeMatch : jumpIndex}
          onJump={(i) => {
            stick.unpin();
            jumpToIndex(i);
          }}
        />
      ) : null}
      </div>
    </div>
    </CwdProvider>
    </SubagentProvider>
  );
}
