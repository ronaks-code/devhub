import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Pin,
  PinOff,
  Pencil,
  MessageSquare,
  Coins,
  DollarSign,
  GitBranch,
  Check,
  X,
  Tag,
  CheckSquare,
  LayoutDashboard,
} from "lucide-react";
import type { ProjectSummary, SessionSummary } from "../lib/types";
import { cn } from "../lib/utils";
import { compactNumber, formatUsd, relativeTime, totalTokens } from "../lib/format";
import { costUsd } from "../lib/pricing";
import { IconButton } from "./ui";
import { ListSkeleton } from "./Skeleton";
import { useListKeyboardNav } from "../hooks/useListKeyboardNav";
import { TagFilterBar, filterByTags } from "./TagFilterBar";
import { displaySessionTitle } from "../lib/session-title";

export function SessionsPane({
  project,
  sessions,
  loading = false,
  selectedId,
  onSelect,
  onRename,
  onTogglePin,
  onBulkPin,
  onBulkAddTag,
  overviewActive = false,
  onToggleOverview,
}: {
  project: ProjectSummary | null;
  sessions: SessionSummary[];
  /** True while the session list is being fetched; shows a skeleton placeholder. */
  loading?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string | null) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  /** Bulk pin/unpin the given sessions (PATCH each). */
  onBulkPin?: (ids: string[], pinned: boolean) => void | Promise<void>;
  /** Union a tag onto each given session (PATCH each with merged tags). */
  onBulkAddTag?: (ids: string[], tag: string) => void | Promise<void>;
  /** True when the per-project Overview is showing in the transcript area. */
  overviewActive?: boolean;
  /** Toggle the per-project Overview. Self-hides the button when omitted (e.g. an
   *  older server without the /overview endpoint). */
  onToggleOverview?: () => void;
}) {
  const [q, setQ] = useState("");
  // Tag filter selection (client-side AND): a session must carry every tag here.
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Multi-select: the set of checked session ids + the last index toggled (the
  // shift-click range anchor). Distinct from the single "open" selection so the
  // existing click-to-open behavior is preserved unchanged.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<number | null>(null);
  // Inline "add tag" input shown from the bulk bar. Null = closed.
  const [tagDraft, setTagDraft] = useState<string | null>(null);

  const filtered = useMemo(() => {
    // Tag filter first (AND across selected tags), then the title text filter.
    const byTag = filterByTags(sessions, tagFilter);
    const s = q.trim().toLowerCase();
    if (!s) return byTag;
    return byTag.filter((x) => x.title.toLowerCase().includes(s));
  }, [sessions, q, tagFilter]);

  // Drop any selected tag no longer present on any session (e.g. project switch),
  // so a stale filter never hides the whole list with no way to see why.
  useEffect(() => {
    setTagFilter((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set<string>();
      for (const s of sessions) for (const t of s.tags) live.add(t);
      let changed = false;
      const next = new Set<string>();
      for (const t of prev) {
        if (live.has(t)) next.add(t);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  // Drop any selected ids that are no longer in the (filtered or full) list, so
  // a project switch / filter never leaves the bulk bar acting on stale ids.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(sessions.map((s) => s.sessionId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const selectedIds = useMemo(() => [...selected], [selected]);

  // Toggle one row's selection. Shift extends a contiguous range from the anchor
  // so a click-then-shift-click selects everything between (mouse-friendly).
  const toggleAt = useCallback(
    (index: number, shift: boolean) => {
      const target = filtered[index];
      if (!target) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (shift && anchorRef.current != null) {
          const [lo, hi] =
            anchorRef.current <= index
              ? [anchorRef.current, index]
              : [index, anchorRef.current];
          // The anchor's current membership decides whether the range adds or
          // removes — matches the OS file-list convention closely enough.
          const adding = !prev.has(target.sessionId);
          for (let i = lo; i <= hi; i++) {
            const id = filtered[i]?.sessionId;
            if (!id) continue;
            if (adding) next.add(id);
            else next.delete(id);
          }
        } else if (next.has(target.sessionId)) {
          next.delete(target.sessionId);
        } else {
          next.add(target.sessionId);
        }
        return next;
      });
      anchorRef.current = index;
    },
    [filtered],
  );

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setTagDraft(null);
    anchorRef.current = null;
  }, []);

  // j/k + arrow + Enter navigation. Enter opens the highlighted session; the
  // inline rename input is guarded inside the hook so typing isn't hijacked.
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const nav = useListKeyboardNav({
    count: filtered.length,
    onSelect: (i) => {
      const s = filtered[i];
      if (s) onSelect(s.sessionId);
    },
    getItemElement: (i) => itemRefs.current[i],
  });

  // Keyboard multi-select: `x` toggles the focused row's checkbox; Escape clears
  // the whole selection. Runs alongside the nav hook (which owns j/k/Enter/Space)
  // — `x` isn't claimed there, so the two never fight. Skipped while typing.
  const onContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      if (!typing) {
        if (e.key === "x" || e.key === "X") {
          if (nav.focusedIndex >= 0) {
            e.preventDefault();
            toggleAt(nav.focusedIndex, e.shiftKey);
          }
          return;
        }
        if (e.key === "Escape" && selected.size > 0) {
          e.preventDefault();
          clearSelection();
          return;
        }
      }
      // Delegate everything else to the list navigator.
      nav.containerProps.onKeyDown(e);
    },
    [nav, toggleAt, selected.size, clearSelection],
  );

  function startEdit(s: SessionSummary) {
    setEditingId(s.sessionId);
    setDraft(s.title);
  }
  function commit(s: SessionSummary) {
    const t = draft.trim();
    onRename(s.sessionId, t.length ? t : null);
    setEditingId(null);
  }

  // How many of the selected rows are pinned, so the bulk bar can offer the
  // sensible primary action (pin if any unpinned, unpin if all pinned).
  const selectedPinnedCount = useMemo(() => {
    let n = 0;
    for (const s of sessions) if (selected.has(s.sessionId) && s.pinned) n++;
    return n;
  }, [sessions, selected]);
  const allSelectedPinned = selected.size > 0 && selectedPinnedCount === selected.size;

  const commitTag = useCallback(() => {
    const t = (tagDraft ?? "").trim();
    if (t && onBulkAddTag) void onBulkAddTag(selectedIds, t);
    setTagDraft(null);
  }, [tagDraft, onBulkAddTag, selectedIds]);

  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950">
      <div className="px-4 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-200">
            {project ? project.name : "Sessions"}
          </h2>
          {/* Per-project Overview toggle — flips the transcript area to a read-only
              project deep-dive. Self-hides when the host wired no handler (e.g. an
              older server without the /overview endpoint). */}
          {project && onToggleOverview ? (
            <button
              onClick={onToggleOverview}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
                overviewActive
                  ? "bg-clay-500/15 text-clay-300 ring-clay-500/30"
                  : "bg-zinc-900/60 text-zinc-500 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-300",
              )}
              title={overviewActive ? "Hide the project overview" : "Show a project overview"}
              aria-pressed={overviewActive}
            >
              <LayoutDashboard className="h-3 w-3" />
              Overview
            </button>
          ) : null}
        </div>
        {project && (
          <div className="truncate text-[11px] text-zinc-600" title={project.cwd} dir="rtl">
            {project.cwd}
          </div>
        )}
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 ring-1 ring-zinc-800 focus-within:ring-clay-500/40">
          <Search className="h-3.5 w-3.5 text-zinc-600" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter sessions"
            className="w-full bg-transparent text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>
      </div>

      {/* Tag chip filter — narrows the visible sessions client-side (AND across
          selected tags). Renders nothing until some session carries a tag. */}
      <TagFilterBar sessions={sessions} selected={tagFilter} onChange={setTagFilter} />

      {/* Bulk action bar — appears once one or more sessions are checked. Pin /
          unpin and add-a-tag fan out PATCH /api/sessions/:id per selected id. */}
      {selected.size > 0 && (
        <div className="mx-3 mb-2 rounded-lg bg-clay-500/10 px-2.5 py-2 ring-1 ring-clay-500/25">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-clay-200">
              {selected.size} selected
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => onBulkPin?.(selectedIds, !allSelectedPinned)}
                className="inline-flex items-center gap-1 rounded-md bg-zinc-900/60 px-2 py-1 text-[11px] font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-800"
                title={allSelectedPinned ? "Unpin selected" : "Pin selected"}
              >
                {allSelectedPinned ? (
                  <PinOff className="h-3 w-3" />
                ) : (
                  <Pin className="h-3 w-3" />
                )}
                {allSelectedPinned ? "Unpin" : "Pin"}
              </button>
              <button
                onClick={() => setTagDraft((v) => (v == null ? "" : null))}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 transition",
                  tagDraft != null
                    ? "bg-clay-500/20 text-clay-100 ring-clay-500/40"
                    : "bg-zinc-900/60 text-zinc-200 ring-zinc-700 hover:bg-zinc-800",
                )}
                title="Add a tag to the selected sessions"
              >
                <Tag className="h-3 w-3" />
                Tag
              </button>
              <IconButton
                className="p-1 text-zinc-400 hover:text-zinc-100"
                title="Clear selection (Esc)"
                onClick={clearSelection}
              >
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>
          {tagDraft != null && (
            <div className="mt-2 flex items-center gap-1">
              <input
                autoFocus
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTag();
                  if (e.key === "Escape") setTagDraft(null);
                }}
                placeholder="Tag name…"
                className="w-full rounded bg-zinc-900 px-1.5 py-1 text-[12px] text-zinc-100 ring-1 ring-clay-500/40 focus:outline-none"
              />
              <IconButton
                className="p-1 text-emerald-400"
                onClick={commitTag}
                title="Apply tag"
              >
                <Check className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          )}
        </div>
      )}

      {/*
       * `role="grid"`, not `listbox` — deliberate ARIA pattern switch
       * (DEVHUB-A11Y-NESTED-INTERACTIVE; see evidence/m8/a11y/a11y.md for the
       * axe `nested-interactive` violation this fixes). Each row's per-item
       * actions (select checkbox, pin, rename) are real buttons alongside the
       * "open session" control — a listbox's `option` items must be leaves
       * (any real focusable descendant is `nested-interactive`; axe also
       * requires listbox's children be `option`/`group` ONLY, which a "row +
       * several buttons" shape can't satisfy either — `aria-required-children`
       * fires the moment any button is even an indirect descendant). A grid's
       * `row` > `gridcell` structure is built for exactly this: each `gridcell`
       * legitimately hosts one focusable widget, so nothing here nests two
       * interactive roles. `useListKeyboardNav`'s j/k/Home/End/Enter model is
       * unchanged (it never depended on the `listbox`/`option` role names —
       * only on `focusedIndex` + the container's own onKeyDown).
       */}
      <div
        {...nav.containerProps}
        role="grid"
        aria-label="Sessions"
        onKeyDown={onContainerKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 outline-none"
      >
        {filtered.map((s, i) => {
          const active = s.sessionId === selectedId;
          const editing = s.sessionId === editingId;
          const focused = i === nav.focusedIndex;
          const checked = selected.has(s.sessionId);
          const itemProps = nav.getItemProps(i);
          return (
            // Row: `role="row"`, a valid direct child of `role="grid"`. Each
            // action below lives in its own `role="gridcell"` — a gridcell is
            // explicitly meant to host exactly one focusable widget, so none of
            // these trigger `nested-interactive` (unlike nesting a `<button>`
            // inside a `role="option"`/`listbox` leaf).
            <div
              key={s.sessionId}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="row"
              aria-selected={itemProps["aria-selected"]}
              data-focused={itemProps["data-focused"]}
              onMouseEnter={itemProps.onMouseEnter}
              className={cn(
                "group mb-0.5 rounded-lg px-2.5 py-2 transition",
                checked
                  ? "bg-clay-500/15 ring-1 ring-clay-500/40"
                  : active
                    ? "bg-clay-500/10 ring-1 ring-clay-500/30"
                    : focused
                      ? "bg-zinc-900 ring-1 ring-zinc-700"
                      : "hover:bg-zinc-900",
              )}
            >
              <div className="flex items-start gap-1.5">
                {/* Selection checkbox — always visible once any selection is
                    active, otherwise reveal on hover so it stays unobtrusive. */}
                <div role="gridcell" className="contents">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAt(i, e.shiftKey);
                    }}
                    className={cn(
                      "-ml-0.5 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
                      checked
                        ? "border-clay-500 bg-clay-500 text-white"
                        : "border-zinc-700 text-transparent hover:border-zinc-500",
                      !checked &&
                        selected.size === 0 &&
                        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    )}
                    title={checked ? "Deselect (x)" : "Select (x, shift to range)"}
                    aria-pressed={checked}
                    aria-label={checked ? "Deselect session" : "Select session"}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                </div>

                <div role="gridcell" className="contents">
                  <IconButton
                    className={cn(
                      "mt-0.5 p-1",
                      s.pinned
                        ? "text-clay-400 hover:text-clay-300"
                        : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    )}
                    title={s.pinned ? "Unpin" : "Pin"}
                    onClick={() => onTogglePin(s.sessionId, !s.pinned)}
                  >
                    <Pin className={cn("h-3.5 w-3.5", s.pinned && "fill-current")} />
                  </IconButton>
                </div>

                {editing ? (
                  <div role="gridcell" className="contents">
                    <div className="flex flex-1 items-center gap-1">
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commit(s);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full rounded bg-zinc-800 px-1.5 py-0.5 text-[13px] text-zinc-100 ring-1 ring-clay-500/40 focus:outline-none"
                      />
                      <IconButton className="p-1 text-emerald-400" onClick={() => commit(s)} title="Save">
                        <Check className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton className="p-1" onClick={() => setEditingId(null)} title="Cancel">
                        <X className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  </div>
                ) : (
                  <div role="gridcell" className="contents min-w-0 flex-1">
                    <button
                      data-testid="session"
                      onClick={() => onSelect(s.sessionId)}
                      className="min-w-0 flex-1 text-left"
                    >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "truncate text-[13px] font-medium leading-snug",
                          active ? "text-clay-100" : "text-zinc-200",
                        )}
                      >
                        {displaySessionTitle(s, project?.name)}
                      </span>
                      {s.titleSource === "custom" && (
                        <span className="text-[9px] text-zinc-600">renamed</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2.5 text-[10.5px] text-zinc-600">
                      <span className="shrink-0">{relativeTime(s.lastTimestamp)}</span>
                      <span className="flex shrink-0 items-center gap-0.5">
                        <MessageSquare className="h-3 w-3" />
                        {s.messageCount}
                      </span>
                      {totalTokens(s.usage) > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          <Coins className="h-3 w-3" />
                          {compactNumber(totalTokens(s.usage))}
                        </span>
                      )}
                      {/* APPROXIMATE per-session spend, priced from the session's
                          model + token usage (same estimate the dashboard uses).
                          Only shown once there's nonzero usage to price. */}
                      {totalTokens(s.usage) > 0 && (
                        <span
                          className="flex shrink-0 items-center gap-0.5 text-emerald-500/80"
                          title="Approximate cost (estimated from list price)"
                        >
                          <DollarSign className="h-3 w-3" />
                          {formatUsd(costUsd(s.model, s.usage)).replace(/^\$/, "")}
                        </span>
                      )}
                      {/* shrink-0 + bounded max-w: the ref never collapses to 0 (was
                          min-w-0, which let the 4 shrink-0 siblings starve it down to
                          "H"/"HE" on high-cost rows — QA). Short refs like "HEAD"/"main"
                          show in full; only a long branch truncates (ellipsis on the
                          inner block, full name in the title tooltip). */}
                      {s.gitBranch ? (
                        <span
                          className="flex max-w-[7rem] shrink-0 items-center gap-0.5"
                          title={s.gitBranch}
                        >
                          <GitBranch className="h-3 w-3 shrink-0" />
                          <span className="truncate">{s.gitBranch}</span>
                        </span>
                      ) : null}
                    </div>
                    {s.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {s.tags.map((t) => (
                          <span
                            key={t}
                            className="inline-flex items-center gap-0.5 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[9.5px] font-medium text-zinc-400"
                          >
                            <Tag className="h-2.5 w-2.5" />
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    </button>
                  </div>
                )}

                {!editing && (
                  <div role="gridcell" className="contents">
                    <IconButton
                      className="p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      title="Rename"
                      onClick={() => startEdit(s)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {/* Initial load with nothing yet → content-shaped skeleton instead of a
            "No sessions" flash. A refresh that already has rows keeps showing
            them (no skeleton) so the list doesn't blink on project re-select. */}
        {project && filtered.length === 0 && loading && <ListSkeleton />}
        {project && filtered.length === 0 && !loading && (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">
            {tagFilter.size > 0 || q.trim()
              ? "No sessions match the current filter"
              : "No sessions"}
          </div>
        )}
        {!project && (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">Select a project</div>
        )}
      </div>

      {/* Subtle hint footer for the multi-select affordance. */}
      {project && filtered.length > 0 && selected.size === 0 && (
        <div className="flex items-center gap-1.5 border-t border-zinc-900/80 px-3 py-1.5 text-[10px] text-zinc-700">
          <CheckSquare className="h-3 w-3" />
          <span>Hover a row's checkbox (or press x) to multi-select</span>
        </div>
      )}
    </div>
  );
}
