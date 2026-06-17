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
  MessageSquarePlus,
} from "lucide-react";
import type { SessionMessagesPage } from "../lib/types";
import { MessageView } from "./MessageView";
import { GitPanel } from "./GitPanel";
import { FindBar } from "./FindBar";
import { TranscriptOutline } from "./TranscriptOutline";
import { FileChangeSummary } from "./FileChangeSummary";
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
import { cn } from "../lib/utils";

export function TranscriptPane({
  page,
  loading,
  onLoadMore,
  onContinue,
  jumpTarget,
}: {
  page: SessionMessagesPage | null;
  loading: boolean;
  onLoadMore: () => void;
  /** Hand off to the Chat tab to resume this session (--resume). */
  onContinue?: (sessionId: string, cwd: string) => void;
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
  const messages = useMemo(() => applyFilters(paired, filters), [paired, filters]);

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

  // Scroll the virtualizer to a given message (used by the outline rail).
  const jumpToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "start" }),
    [virtualizer],
  );

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
  useEffect(() => {
    if (messages.length === 0) return;
    if (lastSession.current !== page?.session.sessionId) return;
    return stick.followToIndex(() =>
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" }),
    );
  }, [messages.length, page?.session.sessionId, virtualizer, stick.followToIndex]);

  if (!page) {
    return (
      <div className="flex-1 bg-zinc-950">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
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
          <button
            onClick={() => {
              setChangesOpen((v) => !v);
              setOutlineOpen(false);
            }}
            className={cn(
              "ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 transition",
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
              icon={<MessagesSquare className="h-10 w-10" />}
              title="No messages match these filters"
              hint="Adjust or clear the filter chips above to see the rest of the transcript."
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
                <MessageView m={messages[vi.index]!} highlight={findOpen ? findQuery : ""} />
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
      </div>
    </div>
  );
}
