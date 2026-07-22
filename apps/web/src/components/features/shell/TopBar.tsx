import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ChevronDown,
  Command as CommandIcon,
  Folder,
  Gauge,
  History,
  Keyboard,
  MessagesSquare,
  Search,
  Settings,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoutButton } from "../../AuthGate";
import { DeckMark } from "../../DeckMark";
import { ThemeSwitcher } from "../../ThemeSwitcher";
import { Spinner } from "../../ui";
import { StatusDot } from "../../ui/StatusDot";
import { compactNumber } from "../../../lib/format";
import type { RecentSession } from "../../../hooks/useRecentSessions";
import type { PerfPreference } from "../../../hooks/useReducedMotion";
import type { ThemePreference } from "../../../hooks/useTheme";
import type { Tab } from "../../../App";
import { ChatTabs, type ChatTab } from "./ChatTabs";

/**
 * TopBar — the 44px chrome row to the RIGHT of the full-height sidebar (§3.2/§4).
 * Extracted from App.tsx so the breadcrumb, Conductor-style ChatTabs, and the
 * status/utility pills can share one row. Behavior/props are unchanged from the
 * in-App version; ChatTabs + breadcrumb are additive. The bar is a drag region
 * (§4); interactive children are automatically non-draggable in Tauri.
 */

/** Navigation destinations use page semantics, not an incomplete tabs pattern. */
export function navigationAriaCurrent(active: boolean): "page" | undefined {
  return active ? "page" : undefined;
}

/** Secondary utilities yield at the minimum desktop width so primary navigation stays bounded. */
// DEVHUB-A11Y-CONTRAST-DARK-SECONDARYNAV: zinc-500 (#71717a) on the
// zinc-900/zinc-950 top-bar surfaces measures ~3.7:1/~4.1:1 — below WCAG AA's
// 4.5:1 for normal text (see apps/web/src/lib/contrast-tokens.test.ts). Bumped
// to zinc-400 (#a1a1aa, the palette's next step up, already the app's
// `--text-muted` token) which clears 4.5:1 on both surfaces with the
// smallest available visual diff.
// No `ml-auto` here: the cluster now sits inside the shrink-0 right group, which
// the flex-1 middle spacer already pushes to the row's right edge (see TopBar).
// Revealed at ≥1360px, NOT `lg`/`xl`: with the cluster shown the right group is
// ~728px, so left(180) + right(728) + padding ≈ 964px of un-shrinkable content
// only fits once the 324px rail leaves that much frame — measured to need a
// ~1360px viewport (≈40px margin). At lower breakpoints the gear overflowed the
// viewport with no scrollbar (QA BLOCKER). Below 1360 the cluster condenses away;
// the spend/counts also live in the StatusBar, so nothing is lost.
export const TOP_BAR_SECONDARY_CLASS =
  "hidden items-center gap-3 text-[11px] text-zinc-400 min-[1360px]:flex";

/**
 * A small "Recent" jump-back dropdown in the header: the last sessions the user
 * opened, most-recent-first, reopened on click. Closes on outside-click / Escape.
 * Self-hides its button when there's no history yet, so it never adds dead chrome.
 */
function RecentMenu({
  recents,
  onOpen,
  onClear,
  onBeforeOpen,
}: {
  recents: RecentSession[];
  onOpen: (projectId: string, sessionId: string) => void;
  onClear: () => void;
  onBeforeOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing opened yet — hide the affordance entirely.
  if (recents.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          if (!open) onBeforeOpen();
          setOpen((value) => !value);
        }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2 py-1 text-[12px] ring-1 ring-zinc-800 transition",
          open ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300",
        )}
        title="Recently opened sessions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <History className="h-3.5 w-3.5" />
        <span>Recent</span>
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/50"
          role="menu"
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
            <span className="text-[10.5px] font-medium uppercase tracking-wide text-zinc-500">
              Recently opened
            </span>
            <button
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
              title="Clear recent list"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {recents.map((r) => (
              <button
                key={r.sessionId}
                onClick={() => {
                  onOpen(r.projectId, r.sessionId);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition hover:bg-zinc-800/60"
                role="menuitem"
              >
                <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-200">
                  {r.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Icon + label for each perf-mode preference, for the header toggle. */
const PERF_META: Record<PerfPreference, { label: string; title: string }> = {
  auto: { label: "Motion: auto", title: "Reduced motion follows your OS setting — click to toggle it" },
  on: { label: "Motion: off", title: "Reduced motion forced ON — click to force it off" },
  off: { label: "Motion: on", title: "Full motion forced ON — click to force reduced motion on" },
};

export interface TopBarProps {
  tab: Tab;
  onTab: (t: Tab) => void;
  onOpenSearch: () => void;
  onOpenCommands: () => void;
  onOpenShortcuts: () => void;
  perfPreference: PerfPreference;
  perfReduced: boolean;
  onCyclePerf: () => void;
  themePreference: ThemePreference;
  theme: "dark" | "light";
  onCycleTheme: () => void;
  progress: { done: number; total: number } | null;
  sessionCount: number;
  projectCount: number;
  recents: RecentSession[];
  onOpenRecent: (projectId: string, sessionId: string) => void;
  onClearRecents: () => void;
  onBeforeOpenRecent: () => void;
  projectName?: string | null;
  /** Opens the ⌘P project switcher from the breadcrumb project segment (§3.2). */
  onOpenProjectSwitcher?: () => void;
  /** Live run-status counts (from the app-root poll) for the status pills (§3.2). */
  runningCount?: number;
  needsYouCount?: number;
  /** Budget chip (§3.2): month-to-date spend and, if set, the monthly cap. */
  budgetMonthToDateUsd?: number;
  budgetMonthlyCapUsd?: number | null;
  workModeAvailable: boolean;
  workModeOpen: boolean;
  onToggleWorkMode: () => void;
  workModeTriggerRef: RefObject<HTMLButtonElement | null>;
  /** Conductor-style chat tabs (§3.2). Omit to render no tab strip. */
  chatTabs?: ChatTab[];
  activeTabId?: string | null;
  onSelectTab?: (sessionId: string) => void;
  onCloseTab?: (sessionId: string) => void;
  onNewTab?: () => void;
}

export function TopBar({
  tab,
  onTab,
  onOpenSearch,
  onOpenCommands,
  onOpenShortcuts,
  perfPreference,
  perfReduced,
  onCyclePerf,
  themePreference,
  theme,
  onCycleTheme,
  progress,
  sessionCount,
  projectCount,
  recents,
  onOpenRecent,
  onClearRecents,
  onBeforeOpenRecent,
  projectName,
  onOpenProjectSwitcher,
  runningCount = 0,
  needsYouCount = 0,
  budgetMonthToDateUsd,
  budgetMonthlyCapUsd,
  workModeAvailable,
  workModeOpen,
  onToggleWorkMode,
  workModeTriggerRef,
  chatTabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: TopBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="glass-chrome flex h-11 w-full min-w-0 items-center gap-3 px-4"
      // .glass-chrome draws a full 1px border; the top bar wants ONLY the
      // --dh-glass-border bottom seam (§3.2), so reset the box border and keep
      // the bottom edge. Inline beats the unlayered .glass-chrome rule.
      style={{
        borderWidth: 0,
        borderBottomWidth: 1,
        borderBottomStyle: "solid",
        borderBottomColor: "var(--dh-glass-border)",
      }}
    >
      <div className="flex shrink-0 items-center gap-1.5 text-sm" data-tauri-drag-region>
        <DeckMark size={18} className="shrink-0" />
        {/* ⬦ workspace / project breadcrumb (§3.2). The project segment is a
            button that opens the ⌘P project switcher, not static text. */}
        <span aria-hidden className="text-[var(--dh-text-disabled)]">⬦</span>
        <span className="font-semibold tracking-tight text-[var(--dh-text-strong)]">DevHub</span>
        {projectName ? (
          <>
            <span className="text-[var(--dh-text-disabled)]" data-tauri-drag-region>/</span>
            <button
              type="button"
              onClick={onOpenProjectSwitcher}
              disabled={!onOpenProjectSwitcher}
              className="inline-flex max-w-[180px] items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[var(--dh-text-muted)] transition hover:bg-[var(--dh-hover)] hover:text-[var(--dh-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:pointer-events-none"
              title="Switch project (⌘P)"
              aria-haspopup="dialog"
            >
              <span className="min-w-0 truncate">{projectName}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          </>
        ) : null}
      </div>

      {/*
       * Flexible middle. The Conductor-style tab strip lives here and is the ONLY
       * zone allowed to absorb horizontal squeeze — `min-w-0` lets it shrink below
       * its natural width and ChatTabs' own `dh-chattabs-scroll` scrolls the
       * overflow. Rendered even with no tabs so it always acts as the flex spacer
       * that right-aligns the controls below. This is what stops the right-hand
       * controls (spend badge + Settings gear) from being pushed off-canvas with
       * no scrollbar to recover them (QA BLOCKER: header overflow at 600–1494px).
       */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* Render whenever the handlers exist, even with zero tabs, so the
            persistent "+" new-chat affordance is ALWAYS present (§3.2) and the
            strip fills in as chats open — not gated on tab count. */}
        {onSelectTab && onCloseTab && onNewTab ? (
          <ChatTabs
            tabs={chatTabs ?? []}
            activeTabId={activeTabId}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onNew={onNewTab}
          />
        ) : null}
      </div>

      {/*
       * Right controls — `shrink-0` so they stay fully visible at every width.
       * Search / command / work are always shown; the perf/theme/shortcuts/recent/
       * spend/count cluster still condenses away below `lg` (1024px) via
       * TOP_BAR_SECONDARY_CLASS; Settings is always present (also on the rail, but
       * the header instance must never vanish).
       */}
      <div data-tauri-drag-region className="flex shrink-0 items-center gap-3">
        <button
          onClick={onOpenSearch}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
          title="Search sessions (⌘K)"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400 sm:inline">⌘K</kbd>
        </button>

        <button
          onClick={onOpenCommands}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
          title="Command palette (⌘⇧P)"
          aria-label="Command palette (⌘⇧P)"
        >
          <CommandIcon className="h-3.5 w-3.5" />
          <kbd className="hidden rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400 sm:inline">⌘⇧P</kbd>
        </button>

        {workModeAvailable ? (
          <button
            ref={workModeTriggerRef}
            type="button"
            onClick={onToggleWorkMode}
            aria-label="Work mode"
            aria-expanded={workModeOpen}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
              workModeOpen
                ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                : "text-zinc-400 hover:text-zinc-300",
            )}
          >
            <Folder className="h-3.5 w-3.5" />
            Work
          </button>
        ) : null}

        {/* When chat tabs are open the tab strip is the priority in the middle;
            the ambient spend/count/toggle cluster would otherwise collapse the
            tab middle to 0px at 1360–1500 (QA: tabs invisible at 1440). So with
            tabs open the cluster defers to ≥1560px (where there's room for BOTH);
            with no tabs it shows at ≥1360 as before. Spend/counts also live in the
            StatusBar and theme in Settings, so nothing is lost when it condenses. */}
        <div
          data-tauri-drag-region
          className={
            (chatTabs?.length ?? 0) > 0
              ? TOP_BAR_SECONDARY_CLASS.replace("min-[1360px]:flex", "min-[1560px]:flex")
              : TOP_BAR_SECONDARY_CLASS
          }
        >
          {/* Perf / reduced-motion toggle. Auto follows the OS until the first
              click, then each click flips the effective state; tinted clay
              while motion is being suppressed so the active state reads at a glance. */}
          <button
            onClick={onCyclePerf}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
              perfReduced
                ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                : "text-zinc-400 hover:text-zinc-300",
            )}
            title={PERF_META[perfPreference].title}
            aria-label={PERF_META[perfPreference].label}
            aria-pressed={perfReduced}
          >
            {perfReduced ? <Zap className="h-4 w-4" /> : <Gauge className="h-4 w-4" />}
          </button>
          {/* Theme toggle: cycles dark → light → system (system follows the OS),
              persisted in localStorage and applied via data-theme on <html>. */}
          <ThemeSwitcher
            preference={themePreference}
            theme={theme}
            onCycle={onCycleTheme}
          />
          {/* Keyboard-shortcut cheat-sheet (also opens with "?"). */}
          <button
            onClick={onOpenShortcuts}
            className="rounded-md p-1 text-zinc-400 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard className="h-4 w-4" />
          </button>
          <RecentMenu
            recents={recents}
            onOpen={onOpenRecent}
            onClear={onClearRecents}
            onBeforeOpen={onBeforeOpenRecent}
          />
          {/* Live run-status pills (§3.2) — same app-root poll the StatusBar reads. */}
          <span
            className={cn(
              "inline-flex items-center gap-1.5",
              runningCount > 0 ? "text-[var(--dh-success)]" : "text-zinc-400",
            )}
            title={`${runningCount} session${runningCount === 1 ? "" : "s"} running`}
          >
            <StatusDot status={runningCount > 0 ? "running" : "idle"} />
            {`${runningCount} running`}
          </span>
          {needsYouCount > 0 ? (
            <span
              className="inline-flex items-center rounded-md bg-[color-mix(in_srgb,var(--dh-warning)_14%,transparent)] px-1.5 py-0.5 text-[var(--dh-warning)]"
              role="status"
              title={`${needsYouCount} session${needsYouCount === 1 ? "" : "s"} waiting on you`}
            >
              {`${needsYouCount} needs review`}
            </span>
          ) : null}
          {/* Month-to-date budget chip (§3.2): "Jul $X" and "/ cap" only when a
              monthly cap is set. Number is the same stats.budget source the
              StatusBar and sidebar spend meter read — no fabricated %. */}
          {typeof budgetMonthToDateUsd === "number" ? (
            <span
              className="inline-flex items-center gap-1 font-mono tabular-nums"
              title="Month-to-date spend (all projects)"
            >
              <span className="uppercase tracking-wide text-zinc-500">
                {new Date().toLocaleString("en-US", { month: "short" })}
              </span>
              <span className="text-zinc-300">{`$${compactNumber(budgetMonthToDateUsd)}`}</span>
              {typeof budgetMonthlyCapUsd === "number" && budgetMonthlyCapUsd > 0 ? (
                <span className="text-zinc-500">{`/ $${compactNumber(budgetMonthlyCapUsd)}`}</span>
              ) : null}
            </span>
          ) : null}
          {progress ? (
            <span className="flex items-center gap-1.5 text-clay-300">
              <Spinner className="h-3 w-3" />
              indexing {progress.done}/{progress.total}
            </span>
          ) : (
            <span>{sessionCount.toLocaleString()} sessions</span>
          )}
          <span>·</span>
          <span>{projectCount} projects</span>
          {/* Clear the saved remote-access token. Self-hides when none is stored
              (the local default), so it never appears in an un-gated session. */}
          <LogoutButton />
        </div>

        {/* Settings — always visible (also on the icon rail, but the header
            instance must not vanish). No `ml-auto`: the flex-1 middle spacer
            already right-aligns this whole group. */}
        <button
          type="button"
          onClick={() => onTab("settings")}
          aria-current={navigationAriaCurrent(tab === "settings")}
          className={cn(
            "rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
            tab === "settings"
              ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
              : "text-zinc-400 hover:text-zinc-300",
          )}
          title="Settings"
          aria-label="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
