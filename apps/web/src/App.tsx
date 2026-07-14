import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  Bot,
  Command as CommandIcon,
  Cpu,
  DatabaseZap,
  Folder,
  Gauge,
  Hexagon,
  History,
  Home,
  Inbox,
  Keyboard,
  LayoutDashboard,
  MessageSquarePlus,
  MessagesSquare,
  Moon,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Zap,
} from "lucide-react";
import {
  api,
  codexApi,
  exportArchiveUrl,
  NotImplementedError,
  subscribeEvents,
  type AppSettings,
} from "./lib/api";
import type { CodexSession } from "./lib/types";
import type {
  ProjectSummary,
  SearchHitWithSeq,
  SessionMessagesPage,
  SessionSummary,
} from "./lib/types";
import type { PermissionMode } from "@devhub/engine/driver";
import { ProjectsPane } from "./components/ProjectsPane";
import { SessionsPane } from "./components/SessionsPane";
import { ProjectDetailHeader } from "./components/ProjectDetailHeader";
import { TranscriptPane } from "./components/TranscriptPane";
import { ChatPane } from "./components/ChatPane";
import { LiveOpsBoard } from "./components/LiveOpsBoard";
import { InboxPane } from "./components/InboxPane";
import { SearchPalette } from "./components/SearchPalette";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ToastStack, type ToastItem } from "./components/Toast";
import { AuthGate, LogoutButton } from "./components/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SessionCostBadge } from "./components/SessionCostBadge";
import { ResponsiveShell, useResponsiveShell } from "./components/ResponsiveShell";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { FirstRun, EmptyIndexHint, hasSeenOnboarding, markOnboardingSeen } from "./components/FirstRun";
import { EmptyState, Spinner } from "./components/ui";
import { DashboardSkeleton } from "./components/Skeleton";
import { useRecentSessions, type RecentSession } from "./hooks/useRecentSessions";
import { useFetchErrorToasts } from "./hooks/useFetchErrorToasts";
import { useReducedMotion, type PerfPreference } from "./hooks/useReducedMotion";
import { useTheme, type ThemePreference } from "./hooks/useTheme";
import { useUrlRouter, type RouteState, type RouteTab } from "./lib/router";
import { cn } from "./lib/utils";

// Heavier, non-initial surfaces are code-split: each loads its own chunk the
// first time the user opens it, so the initial Browse load stays lean. The Browse
// view (the default tab) keeps its imports static so it renders without a fetch.
// Tab views — Dashboard (charts/heatmaps) and Settings (config panels):
const DashboardPane = lazy(() =>
  import("./components/DashboardPane").then((m) => ({ default: m.DashboardPane })),
);
const SettingsPane = lazy(() =>
  import("./components/SettingsPane").then((m) => ({ default: m.SettingsPane })),
);
// The Ops "grid" sub-view (watch/drive several live sessions) — only the board is
// the Ops default, so the grid loads when first switched to:
const MultiSessionGrid = lazy(() =>
  import("./components/MultiSessionGrid").then((m) => ({ default: m.MultiSessionGrid })),
);
// The per-project Overview deep-dive — only shown when toggled on in Browse, so it
// loads its own chunk on first open (and pulls the dashboard ModelBreakdown with it):
const ProjectOverview = lazy(() =>
  import("./components/ProjectOverview").then((m) => ({ default: m.ProjectOverview })),
);
// Home tab — unified dashboard for Claude + Codex activity:
const HomePane = lazy(() =>
  import("./components/HomePane").then((m) => ({ default: m.HomePane })),
);
// OpenAI chat pane — lazy so its chunk doesn't inflate the initial load:
const OpenAIPane = lazy(() =>
  import("./components/OpenAIPane").then((m) => ({ default: m.OpenAIPane })),
);
// Native Codex is both feature-gated and lazy: when the resolved server flag is
// false, the browser keeps using the small legacy read-only history surface and
// never downloads the native task client/pane chunk.
const CodexNativePane = lazy(() =>
  import("./components/CodexNativePane")
    .then((m) => ({ default: m.CodexNativePane }))
    .catch(() => ({ default: CodexNativeLoadFailure })),
);
// Modal-only views — never in the initial paint, so loaded on first open:
const SessionCompare = lazy(() =>
  import("./components/SessionCompare").then((m) => ({ default: m.SessionCompare })),
);
const ShortcutOverlay = lazy(() =>
  import("./components/ShortcutOverlay").then((m) => ({ default: m.ShortcutOverlay })),
);

/** Centered, named status for a lazy view whose chunk is still loading. */
export function PaneFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950"
    >
      <Spinner aria-hidden="true" className="h-5 w-5" />
      <span className="sr-only">Loading view…</span>
    </div>
  );
}

const BASE_TAIL = 2 * 1024 * 1024;

const CHAT_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

type Tab = "home" | "browse" | "chat" | "ops" | "inbox" | "dashboard" | "settings" | "openai-chat" | "codex-history";

// Lightweight UI-state persistence: remembers the active tab and selected
// project across reloads. Guarded for SSR (no window) and malformed JSON.
const UI_STATE_KEY = "claude-ui:ui";

interface PersistedUiState {
  tab?: Tab;
  projectId?: string | null;
  // Reserved for future use; persisted only when present so existing config survives.
  theme?: string;
  density?: string;
}

function readUiState(): PersistedUiState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PersistedUiState) : {};
  } catch {
    return {};
  }
}

function writeUiState(state: PersistedUiState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable or quota exceeded — non-fatal */
  }
}

const VALID_TABS: readonly Tab[] = ["home", "browse", "chat", "ops", "inbox", "dashboard", "settings", "openai-chat", "codex-history"];

export type CodexShellMode = "native" | "history";
export type ClaudeShellMode = "native" | "legacy";

/** Only a server-resolved true flag may expose the native provider surface. */
export function resolveCodexShellMode(settings: AppSettings | null): CodexShellMode {
  return settings?.devHubFeatures?.nativeCodex === true ? "native" : "history";
}

/** Preserve the legacy chat path unless the server resolves the native runtime gate. */
export function resolveClaudeShellMode(settings: AppSettings | null): ClaudeShellMode {
  return settings?.devHubFeatures?.persistentClaude === true ? "native" : "legacy";
}

/** Only the most recently issued settings request may change shell state. */
export function isLatestSettingsResponse(
  requestVersion: number,
  latestVersion: number,
): boolean {
  return requestVersion === latestVersion;
}

/** Keep the preserved route id stable while making its presentation truthful. */
export function codexNavPresentation(
  mode: CodexShellMode,
): { label: "Codex" | "History"; icon: "bot" | "history" } {
  return mode === "native"
    ? { label: "Codex", icon: "bot" }
    : { label: "History", icon: "history" };
}

type NativePaneProvider = "openai" | "anthropic";

/** A provider change must remount the native pane instead of reusing provider-owned state. */
export function nativePaneRouteKey(provider: NativePaneProvider): string {
  return `native-provider:${provider}`;
}

/** Carry the exact legacy Claude session requested by Continue into native selection. */
export function nativeClaudePreferredTaskId(
  seed: { readonly sessionId: string } | null,
): string | undefined {
  return seed?.sessionId;
}

/** Navigation destinations use page semantics, not an incomplete tabs pattern. */
export function navigationAriaCurrent(active: boolean): "page" | undefined {
  return active ? "page" : undefined;
}

/** Keep a native chunk failure truthful for the route that requested it. */
export function nativeLoadFailureMessage(provider: NativePaneProvider): string {
  return provider === "anthropic"
    ? "Native Claude could not load. Showing the preserved Claude chat instead."
    : "Native Codex could not load. Showing read-only Codex history instead.";
}

/** Secondary utilities yield at the minimum desktop width so primary navigation stays bounded. */
export const TOP_BAR_SECONDARY_CLASS =
  "ml-auto hidden items-center gap-3 text-[11px] text-zinc-500 lg:flex";

/**
 * A small "Recent" jump-back dropdown in the header: the last sessions the user
 * opened, most-recent-first, reopened on click. Closes on outside-click / Escape.
 * Self-hides its button when there's no history yet, so it never adds dead chrome.
 */
function RecentMenu({
  recents,
  onOpen,
  onClear,
}: {
  recents: RecentSession[];
  onOpen: (projectId: string, sessionId: string) => void;
  onClear: () => void;
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
        onClick={() => setOpen((v) => !v)}
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

/**
 * Inline Codex session history list. Fetches from /api/codex/sessions and
 * renders a simple chronological list: date, cwd, turn count. No heavy deps —
 * intentionally kept small since all the rich analytics live in HomePane.
 */
function CodexHistoryPane() {
  const [sessions, setSessions] = useState<CodexSession[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    codexApi.sessions()
      .then((s) => setSessions(s ?? []))
      .catch(() => setError(true));
  }, []);

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950">
        <p className="text-sm text-zinc-500">Codex history unavailable (server may not support it yet).</p>
      </div>
    );
  }

  if (sessions === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950">
        <EmptyState
          icon={<History className="h-12 w-12" />}
          title="No Codex sessions yet"
          hint="Run the Codex CLI in a project to see your session history here."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950">
      <div className="border-b border-zinc-800/80 px-6 py-3">
        <h2 className="text-sm font-semibold text-zinc-200">Codex Session History</h2>
        <p className="mt-0.5 text-[11px] text-zinc-500">{sessions.length} sessions</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((s) => {
          const date = new Date(s.startedAt);
          const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
          const timeStr = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
          const dirName = s.cwd ? s.cwd.split("/").filter(Boolean).pop() ?? s.cwd : "—";
          return (
            <div
              key={s.id}
              className="flex items-start gap-3 border-b border-zinc-800/50 px-6 py-3 hover:bg-zinc-900/40"
            >
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-zinc-200" title={s.cwd ?? undefined}>
                    {dirName}
                  </span>
                  {s.model ? (
                    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      {s.model}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span>{dateStr} · {timeStr}</span>
                  <span>·</span>
                  <span>{s.turnCount} {s.turnCount === 1 ? "turn" : "turns"}</span>
                  {s.cwd ? (
                    <>
                      <span>·</span>
                      <span className="truncate" title={s.cwd}>{s.cwd}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A failed native chunk stays local to its provider route and preserves its fallback. */
function CodexNativeLoadFailure({
  fallback,
  provider = "openai",
}: {
  fallback?: ReactNode;
  provider?: NativePaneProvider;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950">
      <div role="alert" className="border-b border-amber-900/40 bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
        {nativeLoadFailureMessage(provider)}
      </div>
      {fallback ?? <CodexHistoryPane />}
    </div>
  );
}

/** Icon + label for each perf-mode preference, for the header toggle. */
const PERF_META: Record<PerfPreference, { label: string; title: string }> = {
  auto: { label: "Motion: auto", title: "Reduced motion follows your OS setting — click to force it on" },
  on: { label: "Motion: off", title: "Reduced motion forced ON — click to force it off" },
  off: { label: "Motion: on", title: "Full motion forced ON — click to follow your OS setting" },
};

function TopBar({
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
  projectSessions,
  projectName,
}: {
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
  projectSessions: SessionSummary[];
  projectName?: string | null;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800/80 bg-zinc-950 px-4">
      <div className="flex items-center gap-2">
        <Hexagon className="h-4 w-4 fill-clay-500/20 text-clay-500" />
        <span className="text-sm font-semibold tracking-tight text-zinc-100">DevHub</span>
      </div>

      <nav
        aria-label="Primary views"
        className="ml-3 inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800"
      >
        {(["home", "browse", "chat", "ops", "inbox", "dashboard"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-current={navigationAriaCurrent(tab === t)}
            onClick={() => onTab(t)}
            className={cn(
              "rounded-md px-3 py-1 text-[12px] font-medium capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
              tab === t
                ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {t}
          </button>
        ))}
      </nav>

      <button
        onClick={onOpenSearch}
        className="ml-2 inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-500 ring-1 ring-zinc-800 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
        title="Search sessions (⌘K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search</span>
        <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">⌘K</kbd>
      </button>

      <button
        onClick={onOpenCommands}
        className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-500 ring-1 ring-zinc-800 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
        title="Command palette (⌘⇧P)"
        aria-label="Command palette (⌘⇧P)"
      >
        <CommandIcon className="h-3.5 w-3.5" />
        <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">⌘⇧P</kbd>
      </button>

      <div className={TOP_BAR_SECONDARY_CLASS}>
        {/* Perf / reduced-motion toggle. Cycles auto → on → off; tinted clay
            while motion is being suppressed so the active state reads at a glance. */}
        <button
          onClick={onCyclePerf}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
            perfReduced
              ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
              : "text-zinc-500 hover:text-zinc-300",
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
          className="rounded-md p-1 text-zinc-500 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard className="h-4 w-4" />
        </button>
        <RecentMenu
          recents={recents}
          onOpen={onOpenRecent}
          onClear={onClearRecents}
        />
        {/* Running total of the active project's loaded-session spend (est.). */}
        <SessionCostBadge projectSessions={projectSessions} projectName={projectName} />
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
        <button
          type="button"
          onClick={() => onTab("settings")}
          aria-current={navigationAriaCurrent(tab === "settings")}
          className={cn(
            "rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
            tab === "settings"
              ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
              : "text-zinc-500 hover:text-zinc-300",
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

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => readUiState().projectId ?? null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // True while the selected project's session list is being (re)fetched, so the
  // SessionsPane can show a content-shaped skeleton instead of a bare "No
  // sessions" flash before the data lands.
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tailBytes, setTailBytes] = useState<number | undefined>(undefined);
  const [page, setPage] = useState<SessionMessagesPage | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [sessionCount, setSessionCount] = useState(0);
  const [tab, setTab] = useState<Tab>(() => {
    const t = readUiState().tab;
    return t && VALID_TABS.includes(t) ? t : "home";
  });
  const [searchOpen, setSearchOpen] = useState(false);
  // Ops tab view: the at-a-glance running-sessions "board", or the "grid" of
  // compact live panels that watch/drive several sessions at once. Local to the
  // tab; the board stays the default so the existing view is untouched.
  const [opsMode, setOpsMode] = useState<"board" | "grid">("board");
  const [commandOpen, setCommandOpen] = useState(false);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  // Keyboard-shortcut cheat-sheet overlay (opened with "?").
  const [shortcutOpen, setShortcutOpen] = useState(false);
  // First-run onboarding overlay. Only opens for a genuinely new user (flag unset
  // AND an empty index), decided once after the initial load settles below. A
  // returning user (flag set) never sees it; dismissing sets the flag for good.
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Side-by-side session comparison modal. Holds the left/base session id while
  // open (null = closed). Opened from the transcript header's "Compare" button.
  const [compareSessionId, setCompareSessionId] = useState<string | null>(null);
  // Browse: whether the per-project Overview deep-dive is showing in the transcript
  // area (instead of the transcript / "select a session" hint). Additive — the
  // project→sessions→transcript flow is untouched when this is off.
  const [showOverview, setShowOverview] = useState(false);
  // Set once the /api/projects/:id/overview route 404s (older server), so we hide
  // the Overview affordance entirely rather than offer a button that can't work.
  const [overviewUnavailable, setOverviewUnavailable] = useState(false);
  // Reduced-motion / perf mode: respects prefers-reduced-motion and a persisted
  // manual toggle, and sets data-reduce-motion on <html> for index.css to key off.
  const perf = useReducedMotion();
  // Light/dark/system theming: persisted in localStorage and applied via
  // data-theme on <html> (the index.css token palettes key off it). This is the
  // instant, client-side source of truth for the rendered palette; we ALSO mirror
  // the choice into the server-backed settings.theme below so it round-trips.
  const theme = useTheme();
  // Server-backed app settings (default model/permission, theme, budget…).
  // Loaded once on mount and updated when the Settings tab saves.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const settingsRequestVersionRef = useRef(0);
  const beginSettingsRequest = useCallback(
    () => ++settingsRequestVersionRef.current,
    [],
  );
  const acceptSettingsResponse = useCallback(
    (next: AppSettings, requestVersion?: number) => {
      const version = requestVersion ?? ++settingsRequestVersionRef.current;
      if (isLatestSettingsResponse(version, settingsRequestVersionRef.current)) {
        setSettings(next);
        return true;
      }
      return false;
    },
    [],
  );
  const refreshSettings = useCallback(async () => {
    const requestVersion = beginSettingsRequest();
    try {
      const next = await api.getSettings();
      acceptSettingsResponse(next, requestVersion);
    } catch {
      // A dropped mutation response can still mean the server committed it.
      // Re-read once with a newer version; the shared fetch-error surface owns
      // any persistent retry copy after that bounded reconciliation attempt.
      const retryVersion = beginSettingsRequest();
      try {
        const next = await api.getSettings();
        acceptSettingsResponse(next, retryVersion);
      } catch {
        // Keep the last known-safe shell state.
      }
    }
  }, [acceptSettingsResponse, beginSettingsRequest]);
  // Seeds ChatPane to resume an existing session (--resume) after a handoff
  // from the Browse transcript. Cleared once consumed.
  const [chatSeed, setChatSeed] = useState<{ sessionId: string; projectId: string } | null>(null);
  // Bumping this remounts ChatPane to start a fresh conversation (command palette
  // "New chat" / programmatic reset), since ChatPane keys off it.
  const [chatNonce, setChatNonce] = useState(0);
  // Chat model lifted to App so the command palette can switch it; ChatPane
  // still owns permission mode locally. Falls back to settings then a default.
  const [chatModel, setChatModel] = useState<string | null>(null);
  // Carries a session to auto-select after a search-driven project switch.
  const pendingSessionRef = useRef<string | null>(null);
  // The message seq a search pick wants the transcript to jump to + highlight,
  // once it loads. Bumped each pick (via a nonce) so re-picking the SAME hit
  // re-triggers the jump even when seq is unchanged. Null = no pending jump.
  const [jumpTarget, setJumpTarget] = useState<{ seq: number; nonce: number } | null>(null);
  // Transient notification toasts (from the SSE `notify` event). Capped so a burst
  // never stacks endlessly; each toast also auto-dismisses on its own timer.
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  // Push a toast and return its id (so a caller can dismiss it later — e.g. a
  // fetch-error Retry that succeeds). Capped at 4 visible, like the notify path.
  const pushToast = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
    return id;
  }, []);

  // Recently-opened sessions (jump-back list), persisted in localStorage.
  const { recents, pushRecent, clearRecents } = useRecentSessions();

  // Surface non-401 API fetch failures as retryable error toasts.
  useFetchErrorToasts(pushToast, dismissToast);

  // Persist UI state (active tab + selected project) so a reload lands the user
  // back where they were. Merge over any existing keys (e.g. theme/density) so
  // we never clobber settings this component doesn't own.
  useEffect(() => {
    writeUiState({ ...readUiState(), tab, projectId });
  }, [tab, projectId]);

  const refreshProjects = useCallback(async () => {
    const p = await api.projects();
    setProjects(p);
    // Keep the current selection when it still exists (covers a restored
    // projectId); otherwise fall back to the first project.
    setProjectId((prev) => (prev && p.some((x) => x.id === prev) ? prev : p[0]?.id ?? null));
  }, []);

  const refreshSessions = useCallback(async (pid: string) => {
    setLoadingSessions(true);
    try {
      setSessions(await api.sessions(pid));
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  // initial load
  useEffect(() => {
    void refreshProjects();
    api.health().then((h) => setSessionCount(h.sessionCount)).catch(() => {});
    void refreshSettings();
  }, [refreshProjects, refreshSettings]);

  // Decide whether to show first-run onboarding — exactly once, shortly after the
  // initial load settles. We only welcome a genuinely NEW user: the "seen" flag is
  // unset AND the index is empty (no projects and no indexed sessions). A returning
  // user (flag set, or any history) is never interrupted. The short delay lets the
  // health/projects fetches land so we don't flash the welcome before data arrives.
  const onboardingDecidedRef = useRef(false);
  useEffect(() => {
    if (onboardingDecidedRef.current) return;
    if (hasSeenOnboarding()) {
      onboardingDecidedRef.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      if (onboardingDecidedRef.current) return;
      onboardingDecidedRef.current = true;
      // Empty index = a fresh install with nothing discovered yet.
      if (projects.length === 0 && sessionCount === 0) setOnboardingOpen(true);
    }, 1200);
    return () => window.clearTimeout(t);
  }, [projects.length, sessionCount]);

  const dismissOnboarding = useCallback(() => {
    markOnboardingSeen();
    setOnboardingOpen(false);
  }, []);

  // sessions follow the selected project
  useEffect(() => {
    // A search pick can pre-stage the session to open after the switch.
    const pending = pendingSessionRef.current;
    pendingSessionRef.current = null;
    setSessionId(pending);
    setPage(null);
    if (projectId) void refreshSessions(projectId);
  }, [projectId, refreshSessions]);

  // messages follow the selected session (+ tail window)
  useEffect(() => {
    if (!sessionId) {
      setPage(null);
      return;
    }
    let cancelled = false;
    setLoadingPage(true);
    api
      .messages(sessionId, tailBytes)
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        // Record the just-opened transcript in the jump-back list (most-recent
        // first, de-duped). Uses the loaded page's authoritative title/project.
        pushRecent({
          sessionId: p.session.sessionId,
          title: p.session.title,
          projectId: p.session.projectId,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingPage(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, tailBytes, pushRecent]);

  // Handle a `notify` SSE event: show a transient toast, and (when the tab is
  // hidden) fire a browser Notification so a finished/waiting session is noticed
  // even when the app isn't focused. Stable identity so the SSE effect below need
  // not re-subscribe; it reads latest navigation via openSessionRef.
  const handleNotify = useCallback(
    (e: import("./lib/types").NotifyEvent) => {
      const title = e.title || (e.level === "warning" ? "Session waiting for you" : "Session update");
      const body = e.body || (e.project ? `in ${e.project}` : undefined);
      const onClick =
        e.projectId && e.sessionId
          ? () => openSessionRef.current(e.projectId!, e.sessionId!)
          : undefined;
      const id = ++toastSeq.current;
      // Cap the visible stack at 4 (drop the oldest) so a burst stays unobtrusive.
      setToasts((prev) => [...prev.slice(-3), { id, title, body, level: e.level, onClick }]);

      // Fire an OS notification only when the tab is hidden and the user granted it.
      if (
        typeof document !== "undefined" &&
        document.hidden &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const n = new Notification(title, { body, tag: e.sessionId ?? undefined });
          if (onClick) {
            n.onclick = () => {
              window.focus();
              onClick();
              n.close();
            };
          }
        } catch {
          /* Notification construction can throw on some platforms — non-fatal */
        }
      }
    },
    [],
  );

  // Opportunistically request OS-notification permission once, after mount. Only
  // when it's still "default" (never re-prompts a user who denied/granted).
  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    // Defer slightly so the request doesn't fire during the initial render burst.
    const t = window.setTimeout(() => {
      void Notification.requestPermission().catch(() => {});
    }, 1500);
    return () => window.clearTimeout(t);
  }, []);

  // live updates via SSE
  useEffect(() => {
    return subscribeEvents((e) => {
      if (e.kind === "index-progress") {
        setProgress({ done: e.done, total: e.total });
        setSessionCount(e.done);
      } else if (e.kind === "ready") {
        setProgress(null);
        void refreshProjects();
      } else if (e.kind === "session-added" || e.kind === "session-changed") {
        void refreshProjects();
        if (projectId && e.projectId === projectId) void refreshSessions(projectId);
      } else if (e.kind === "notify") {
        handleNotify(e);
      }
    });
  }, [refreshProjects, refreshSessions, projectId, handleNotify]);

  // Global hotkeys: ⌘K search, ⌘⇧P command palette, ⌘P project switcher.
  // Opening any one closes the others so they never stack. The ⌘⇧P (shift)
  // branch is checked before plain ⌘P so the command palette wins on shift.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const isP = e.key === "p" || e.key === "P";
      if (mod && e.shiftKey && isP) {
        e.preventDefault();
        setSearchOpen(false);
        setProjectSwitcherOpen(false);
        setCommandOpen((v) => !v);
      } else if (mod && !e.shiftKey && isP) {
        // Plain ⌘P — overrides the browser's print dialog for the switcher.
        e.preventDefault();
        setSearchOpen(false);
        setCommandOpen(false);
        setProjectSwitcherOpen((v) => !v);
      } else if (mod && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCommandOpen(false);
        setProjectSwitcherOpen(false);
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "?" opens the keyboard-shortcut cheat-sheet — but only when the user isn't
  // typing into a field (so a literal "?" in a prompt/search still types). No
  // modifier required; Shift is fine since "?" itself is Shift+/.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) {
        return;
      }
      e.preventDefault();
      setShortcutOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Adopt the server-backed theme into the client `useTheme` hook ONCE, after
  // settings first load — so a preference saved on another device (or in the
  // Settings tab) is honored on launch. The hook then owns the live rendering
  // (data-theme + the `.dark` class) from there; the header/palette toggles drive
  // it directly. Guarded so it runs a single time and never fights the hook.
  const adoptedServerThemeRef = useRef(false);
  useEffect(() => {
    if (adoptedServerThemeRef.current) return;
    const t = settings?.theme;
    if (!t) return;
    adoptedServerThemeRef.current = true;
    // Only override the local default when the server has a different stored value.
    if (t !== theme.preference) theme.setPreference(t);
  }, [settings?.theme, theme]);

  // Persist a settings patch to the server and update local state on success.
  const saveSettings = useCallback((patch: Partial<AppSettings>) => {
    const requestVersion = beginSettingsRequest();
    api
      .putSettings(patch)
      .then((next) => acceptSettingsResponse(next, requestVersion))
      .catch(() => void refreshSettings());
  }, [acceptSettingsResponse, beginSettingsRequest, refreshSettings]);

  // Persist a project's per-project chat defaults (PATCH /api/projects/:id), then
  // refresh the project list so the open ChatPane picks them up. Throws on
  // failure so the ChatPane control can show a failed state. A server that
  // doesn't persist these keys still ACKs the PATCH (it forwards present keys),
  // so this degrades to a no-op rather than an error there.
  const saveProjectDefaults = useCallback(
    async (id: string, model: string, permissionMode: string) => {
      await api.patchProject(id, {
        defaultModel: model,
        defaultPermissionMode: permissionMode,
      });
      await refreshProjects();
    },
    [refreshProjects],
  );

  // Persist a project's favorite / archived flags (PATCH /api/projects/:id), then
  // refresh the list so the header + ProjectsPane reflect the new state. The
  // server forwards present keys, so a server that doesn't persist these still
  // ACKs harmlessly. Errors are swallowed (the UI just won't change).
  const toggleProjectFavorite = useCallback(
    async (id: string, favorite: boolean) => {
      try {
        await api.patchProject(id, { favorite });
        await refreshProjects();
      } catch {
        /* non-fatal — leave the list as-is */
      }
    },
    [refreshProjects],
  );
  const toggleProjectArchive = useCallback(
    async (id: string, archived: boolean) => {
      try {
        await api.patchProject(id, { archived });
        await refreshProjects();
      } catch {
        /* non-fatal — leave the list as-is */
      }
    },
    [refreshProjects],
  );

  // Cycle dark → light → system. Drives the client `useTheme` hook (instant,
  // localStorage) AND mirrors the choice into the server-backed settings so it
  // round-trips. Shared by the header ThemeSwitcher and the command palette.
  const cycleTheme = useCallback(() => {
    const order: ThemePreference[] = ["dark", "light", "system"];
    const next = order[(order.indexOf(theme.preference) + 1) % order.length]!;
    theme.setPreference(next);
    saveSettings({ theme: next });
  }, [theme, saveSettings]);

  const onSelectSession = (id: string) => {
    setTailBytes(undefined);
    setSessionId(id);
    // Opening a session's transcript supersedes the project summary.
    setShowOverview(false);
  };

  // Picking a search hit jumps to the Browse viewer at that project + session,
  // then (when the hit carries a `seq`) tells the transcript to scroll to and
  // briefly highlight that exact message once it loads.
  const onPickHit = (hit: SearchHitWithSeq) => {
    setSearchOpen(false);
    setTab("browse");
    setTailBytes(undefined);
    setJumpTarget(
      typeof hit.seq === "number" ? { seq: hit.seq, nonce: Date.now() } : null,
    );
    if (hit.projectId === projectId) {
      // Same project: the project effect won't re-run, so select directly.
      setSessionId(hit.sessionId);
    } else {
      // Different project: stage the session for the project-change effect.
      pendingSessionRef.current = hit.sessionId;
      setProjectId(hit.projectId);
    }
  };

  // Open a session in the Browse transcript from elsewhere (e.g. the dashboard's
  // Top Spenders, or a notification toast). Mirrors onPickHit's project-switch
  // handling but without a message jump: same project selects directly; a
  // different one stages the session for the project-change effect to pick up.
  const openSession = useCallback(
    (pid: string, sid: string) => {
      setTab("browse");
      setTailBytes(undefined);
      setJumpTarget(null);
      if (pid === projectId) {
        setSessionId(sid);
      } else {
        pendingSessionRef.current = sid;
        setChatSeed(null);
        setProjectId(pid);
      }
    },
    [projectId],
  );

  // Latest openSession, read by the SSE notify handler so it can navigate without
  // forcing the EventSource to re-subscribe whenever openSession's identity changes.
  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;

  // Open a running session from the LiveOpsBoard, which only knows the session's
  // cwd (not a projectId). Resolve the cwd to a known project before navigating;
  // if it doesn't match any known project, we just switch to Browse (the session
  // may not be indexed yet) so the click is never a dead end.
  const openSessionByCwd = useCallback(
    (cwd: string | null, sid: string) => {
      const match = cwd ? projects.find((p) => p.cwd === cwd) : null;
      if (match) {
        openSession(match.id, sid);
      } else {
        setChatSeed(null);
        setTab("browse");
      }
    },
    [projects, openSession],
  );

  // ── Deep-link URL routing ────────────────────────────────────────────────
  // Reflect the current view (tab + project + session) in the URL query so a
  // copied link reopens the same place and back/forward walks history. Restore
  // a route on load / popstate by adopting tab + project + (staged) session,
  // reusing the same pendingSessionRef pattern as openSession for cross-project
  // session selection. All params are tolerated as missing/malformed.
  const routeState = useMemo<RouteState>(
    () => ({ tab: tab as RouteTab, project: projectId, session: sessionId }),
    [tab, projectId, sessionId],
  );
  // Latest selected project id, read by applyRoute (which has empty deps so its
  // identity stays stable for the router) to decide same- vs cross-project nav.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const applyRoute = useCallback(
    (route: RouteState) => {
      if (route.tab) setTab(route.tab);
      // Adopt the routed project + session. Same project → select the session
      // directly; a different project stages it for the project-change effect.
      const nextProject = route.project ?? null;
      const nextSession = route.session ?? null;
      setChatSeed(null);
      setTailBytes(undefined);
      setJumpTarget(null);
      if (nextProject && nextProject !== projectIdRef.current) {
        // Cross-project: stage the session for the project-change effect to pick up.
        pendingSessionRef.current = nextSession;
        setProjectId(nextProject);
      } else {
        // Same (or no) project switch — set the session directly so it isn't lost.
        setSessionId(nextSession);
      }
    },
    [],
  );
  const { initial: initialRoute } = useUrlRouter(routeState, applyRoute);
  // Honor a route present in the entry URL once, after the first projects load
  // (so a staged session can resolve). Runs a single time.
  const restoredRouteRef = useRef(false);
  useEffect(() => {
    if (restoredRouteRef.current) return;
    const hasRoute =
      initialRoute.tab != null || initialRoute.project != null || initialRoute.session != null;
    if (!hasRoute) {
      restoredRouteRef.current = true;
      return;
    }
    // Wait until projects exist so a routed project id can be validated/selected.
    if (projects.length === 0) return;
    restoredRouteRef.current = true;
    if (initialRoute.project && projects.some((p) => p.id === initialRoute.project)) {
      applyRoute(initialRoute);
    } else if (initialRoute.tab) {
      setTab(initialRoute.tab);
    }
  }, [projects, initialRoute, applyRoute]);

  const handleRename = async (id: string, title: string | null) => {
    await api.rename(id, title);
    if (projectId) await refreshSessions(projectId);
  };
  const handlePin = async (id: string, pinned: boolean) => {
    await api.setPinned(id, pinned);
    if (projectId) await refreshSessions(projectId);
  };
  // Bulk pin/unpin: PATCH each session, then refresh once. Errors on individual
  // PATCHes are swallowed per-id so one failure doesn't abort the rest.
  const handleBulkPin = async (ids: string[], pinned: boolean) => {
    await Promise.allSettled(ids.map((id) => api.setPinned(id, pinned)));
    if (projectId) await refreshSessions(projectId);
  };
  // Bulk add-a-tag: union the new tag onto each session's existing tags (the
  // server normalizes + de-dupes), then refresh once.
  const handleBulkAddTag = async (ids: string[], tag: string) => {
    const t = tag.trim();
    if (!t) return;
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    await Promise.allSettled(
      ids.map((id) => {
        const existing = byId.get(id)?.tags ?? [];
        return api.setTags(id, [...existing, t]);
      }),
    );
    if (projectId) await refreshSessions(projectId);
  };
  const handleLoadMore = () => setTailBytes((b) => (b ?? BASE_TAIL) * 2);

  // "Continue this chat": jump to the Chat tab and seed ChatPane to resume this
  // session in its project (the transcript's project is the selected one).
  const handleContinue = (sid: string, _cwd: string) => {
    if (!projectId) return;
    setChatSeed({ sessionId: sid, projectId });
    setTab("chat");
  };

  // Switching projects is a fresh intent — drop any pending resume seed.
  const selectProject = (id: string) => {
    setChatSeed(null);
    setProjectId(id);
  };

  // Open a project in the Browse view from elsewhere (e.g. the dashboard's
  // Project leaderboard). Switches to Browse and selects the project, dropping any
  // pending resume seed — mirrors the command palette's "Jump to project" action.
  const openProject = useCallback((id: string) => {
    setChatSeed(null);
    setProjectId(id);
    setTab("browse");
  }, []);

  // The ProjectOverview reports back when its endpoint 404s (older server); hide
  // the affordance and fall back to the transcript so the button never dead-ends.
  const markOverviewUnavailable = useCallback(() => {
    setOverviewUnavailable(true);
    setShowOverview(false);
  }, []);

  const project = projects.find((p) => p.id === projectId) ?? null;
  // Only honor the seed while its project is the active one.
  const activeSeed = chatSeed && chatSeed.projectId === projectId ? chatSeed : null;

  // Responsive Browse layout: 3 panes on wide screens, a single active pane with
  // a breadcrumb on narrow ones. The stage auto-advances as the user drills in.
  const shell = useResponsiveShell({ hasProject: !!projectId, hasSession: !!sessionId });
  // The open session's title for the transcript breadcrumb crumb (when loaded).
  const sessionTitle = page?.session.title ?? null;

  // Effective chat model: explicit palette choice → settings default → built-in.
  const effectiveModel = chatModel ?? settings?.defaultModel ?? CHAT_MODELS[0];

  const startNewChat = useCallback(() => {
    setChatSeed(null);
    setChatNonce((n) => n + 1);
    setTab("chat");
  }, []);

  // ── Command-palette ACTIONS that hit endpoints ───────────────────────────
  // Each reuses an existing api.ts client fn and surfaces a toast on success /
  // failure. The *Maybe-backed calls map an older server's missing route to a
  // NotImplementedError, which we report as a quiet "not available" toast rather
  // than letting it bubble — mirroring how the Settings controls degrade.

  // Force a full re-index (POST /api/reindex). The 202 ack only means the pass
  // STARTED; live progress streams over the existing SSE the header already shows.
  const runReindex = useCallback(async () => {
    try {
      await api.reindex();
      pushToast({ title: "Rebuilding index…", body: "Progress shows in the top bar.", level: "info" });
    } catch (err) {
      pushToast(
        err instanceof NotImplementedError
          ? { title: "Rebuild index unavailable", body: "This server doesn't support reindex yet.", level: "warning" }
          : { title: "Couldn't start rebuild", body: err instanceof Error ? err.message : String(err), level: "error" },
      );
    }
  }, [pushToast]);

  // Read-only index-health audit (GET /api/maintenance/integrity). Reports the
  // verdict as a toast; the full per-issue list lives in Settings → Index health.
  const checkIndexHealth = useCallback(async () => {
    try {
      const r = await api.maintenanceIntegrity();
      pushToast(
        r.ok
          ? { title: "Index healthy", body: "No issues found.", level: "success" }
          : {
              title: `${r.issues.length} index ${r.issues.length === 1 ? "issue" : "issues"} found`,
              body: "Open Settings → Index health to review and repair.",
              level: "warning",
            },
      );
    } catch (err) {
      pushToast(
        err instanceof NotImplementedError
          ? { title: "Index health unavailable", body: "This server doesn't support the health check yet.", level: "warning" }
          : { title: "Couldn't check index", body: err instanceof Error ? err.message : String(err), level: "error" },
      );
    }
  }, [pushToast]);

  // Export the portable archive — a real file download. A plain anchor click
  // streams it straight from the server (the big bundle never lives in memory),
  // exactly like ArchiveTransfer's Download button. SSR-guarded.
  const downloadArchive = useCallback(() => {
    if (typeof document === "undefined") return;
    const a = document.createElement("a");
    a.href = exportArchiveUrl();
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    pushToast({ title: "Exporting archive…", body: "Your browser will download the .json file.", level: "info" });
  }, [pushToast]);

  // Build the command palette actions from current app state. Memoized so the
  // list is stable between renders unless its inputs change.
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "tab-home",
        title: "Go to Home",
        group: "Navigate",
        icon: <Home className="h-3.5 w-3.5" />,
        run: () => setTab("home"),
      },
      {
        id: "tab-browse",
        title: "Go to Browse",
        group: "Navigate",
        icon: <Folder className="h-3.5 w-3.5" />,
        run: () => setTab("browse"),
      },
      {
        id: "tab-chat",
        title: "Go to Chat",
        group: "Navigate",
        icon: <Sparkles className="h-3.5 w-3.5" />,
        run: () => setTab("chat"),
      },
      {
        id: "tab-ops",
        title: "Go to Live Ops",
        group: "Navigate",
        keywords: "running sessions monitor live board",
        icon: <Radio className="h-3.5 w-3.5" />,
        run: () => setTab("ops"),
      },
      {
        id: "tab-inbox",
        title: "Go to Inbox",
        group: "Navigate",
        keywords: "triage unsorted untagged sessions",
        icon: <Inbox className="h-3.5 w-3.5" />,
        run: () => setTab("inbox"),
      },
      {
        id: "tab-dashboard",
        title: "Go to Dashboard",
        group: "Navigate",
        icon: <LayoutDashboard className="h-3.5 w-3.5" />,
        run: () => setTab("dashboard"),
      },
      {
        id: "open-settings",
        title: "Open Settings",
        group: "Navigate",
        icon: <Settings className="h-3.5 w-3.5" />,
        run: () => setTab("settings"),
      },
      {
        id: "new-chat",
        title: "New chat",
        group: "Chat",
        icon: <MessageSquarePlus className="h-3.5 w-3.5" />,
        run: startNewChat,
      },
      {
        id: "focus-search",
        title: "Search sessions",
        group: "Find",
        hint: "⌘K",
        keywords: "find filter",
        icon: <Search className="h-3.5 w-3.5" />,
        run: () => setSearchOpen(true),
      },
      {
        id: "toggle-theme",
        title: `Toggle theme (now: ${theme.preference})`,
        group: "Theme",
        keywords: "dark light system appearance",
        icon:
          theme.preference === "light" ? (
            <Sun className="h-3.5 w-3.5" />
          ) : (
            <Moon className="h-3.5 w-3.5" />
          ),
        run: cycleTheme,
      },
      // ── Actions: run real app behavior straight from the palette ───────────
      {
        id: "toggle-perf",
        title: `Toggle reduced motion (now: ${perf.preference})`,
        group: "Actions",
        keywords: "perf performance animation accessibility motion calm snappy",
        icon: perf.reduced ? <Zap className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />,
        run: perf.cyclePreference,
      },
      {
        id: "open-shortcuts",
        title: "Keyboard shortcuts",
        group: "Actions",
        hint: "?",
        keywords: "help cheat sheet hotkeys bindings",
        icon: <Keyboard className="h-3.5 w-3.5" />,
        run: () => setShortcutOpen(true),
      },
      {
        id: "rebuild-index",
        title: "Rebuild index",
        group: "Actions",
        keywords: "reindex re-index refresh backfill analytics",
        icon: <DatabaseZap className="h-3.5 w-3.5" />,
        run: () => void runReindex(),
      },
      {
        id: "check-index-health",
        title: "Check index health",
        group: "Actions",
        keywords: "integrity audit repair maintenance",
        icon: <ShieldCheck className="h-3.5 w-3.5" />,
        run: () => void checkIndexHealth(),
      },
      {
        id: "export-archive",
        title: "Export archive",
        group: "Actions",
        keywords: "backup download portable transfer json",
        icon: <Archive className="h-3.5 w-3.5" />,
        run: downloadArchive,
      },
    ];

    for (const m of CHAT_MODELS) {
      list.push({
        id: `model-${m}`,
        title: `Use model ${m}`,
        group: "Model",
        hint: effectiveModel === m ? "current" : undefined,
        keywords: "change model llm",
        icon: <Cpu className="h-3.5 w-3.5" />,
        run: () => {
          setChatModel(m);
          setTab("chat");
        },
      });
    }

    for (const p of projects) {
      list.push({
        id: `project-${p.id}`,
        title: `Jump to ${p.name}`,
        group: "Project",
        keywords: p.cwd,
        icon: <Folder className="h-3.5 w-3.5" />,
        run: () => {
          setChatSeed(null);
          setProjectId(p.id);
          setTab("browse");
        },
      });
    }

    // Recently-opened sessions — a jump-back list straight in the palette.
    for (const r of recents) {
      list.push({
        id: `recent-${r.sessionId}`,
        title: `Reopen ${r.title}`,
        group: "Recent",
        keywords: "recent jump back history session",
        icon: <History className="h-3.5 w-3.5" />,
        run: () => openSession(r.projectId, r.sessionId),
      });
    }

    return list;
  }, [
    projects,
    theme.preference,
    effectiveModel,
    cycleTheme,
    startNewChat,
    recents,
    openSession,
    perf.preference,
    perf.reduced,
    perf.cyclePreference,
    runReindex,
    checkIndexHealth,
    downloadArchive,
  ]);

  // A single resolved mode drives both nav chrome and route content so the
  // shell cannot label the legacy parser as native (or vice versa).
  const codexShellMode = resolveCodexShellMode(settings);
  const claudeShellMode = resolveClaudeShellMode(settings);
  const codexNav = codexNavPresentation(codexShellMode);
  const legacyClaudePane = (
    <div className="flex min-h-0 flex-1">
      <ProjectsPane projects={projects} selectedId={projectId} onSelect={selectProject} />
      {project ? (
        <ChatPane
          key={
            activeSeed
              ? `${project.id}:${activeSeed.sessionId}`
              : `${project.id}:${chatNonce}`
          }
          cwd={project.cwd}
          projectId={project.id}
          projectName={project.name}
          initialSessionId={activeSeed?.sessionId}
          defaultModel={settings?.defaultModel}
          defaultPermissionMode={
            settings?.defaultPermissionMode as PermissionMode | undefined
          }
          projectDefaultModel={project.defaultModel}
          projectDefaultPermissionMode={
            project.defaultPermissionMode as PermissionMode | null | undefined
          }
          onSaveProjectDefaults={(m, pm) => saveProjectDefaults(project.id, m, pm)}
          model={chatModel}
          onModelChange={setChatModel}
        />
      ) : (
        <div className="flex-1 bg-zinc-950">
          <EmptyState
            icon={<MessagesSquare className="h-12 w-12" />}
            title="Pick a project to chat"
            hint="Select a project on the left to start a live Claude Code session in its working directory."
          />
        </div>
      )}
    </div>
  );

  return (
    <AuthGate>
      <div className="flex h-full flex-col">
      {/* Skip link: the first focusable element, hidden until focused (Tab from a
          fresh load) so a keyboard/screen-reader user can jump straight past the
          top bar into the main content instead of tabbing through every header
          control. Visually offscreen until focused, then a clay pill, top-left. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-2 focus:z-[80] focus:rounded-md focus:bg-clay-500 focus:px-3 focus:py-1.5 focus:text-[12px] focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-clay-500/50"
      >
        Skip to main content
      </a>
      <TopBar
        tab={tab}
        onTab={(t) => {
          // A manual tab click is a fresh intent — drop any pending resume seed.
          setChatSeed(null);
          setTab(t);
        }}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenCommands={() => setCommandOpen(true)}
        onOpenShortcuts={() => setShortcutOpen(true)}
        perfPreference={perf.preference}
        perfReduced={perf.reduced}
        onCyclePerf={perf.cyclePreference}
        themePreference={theme.preference}
        theme={theme.theme}
        onCycleTheme={cycleTheme}
        progress={progress}
        sessionCount={sessionCount}
        projectCount={projects.length}
        recents={recents}
        onOpenRecent={openSession}
        onClearRecents={clearRecents}
        projectSessions={sessions}
        projectName={project?.name}
      />
      <ErrorBoundary>
      {/* Main landmark + skip-link target. `tabIndex={-1}` lets the skip link move
          focus here (it's not natively focusable) without adding it to the Tab
          order. `outline-none` so that programmatic focus doesn't draw a ring. */}
      <div id="main-content" role="main" tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
        {/* ── Sidebar nav ─────────────────────────────────────────────────── */}
        <nav
          aria-label="Primary navigation"
          className="flex w-44 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950 py-2"
        >
          {/* ── CLAUDE section ── */}
          <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            Claude
          </div>
          {(
            [
              { id: "home" as Tab, icon: <Home className="h-3.5 w-3.5" />, label: "Home" },
              { id: "browse" as Tab, icon: <Folder className="h-3.5 w-3.5" />, label: "Browse" },
              { id: "chat" as Tab, icon: <Sparkles className="h-3.5 w-3.5" />, label: claudeShellMode === "native" ? "Claude" : "New Chat" },
              { id: "dashboard" as Tab, icon: <LayoutDashboard className="h-3.5 w-3.5" />, label: "Dashboard" },
            ] as const
          ).map(({ id, icon, label }) => (
            <button
              key={id}
              type="button"
              aria-current={navigationAriaCurrent(tab === id)}
              onClick={() => { setChatSeed(null); setTab(id); }}
              className={cn(
                "mx-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
                tab === id
                  ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/20"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
              )}
            >
              {icon}
              {label}
            </button>
          ))}

          {/* ── OPENAI section ── */}
          <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            OpenAI
          </div>
          {(
            [
              { id: "openai-chat" as Tab, icon: <Bot className="h-3.5 w-3.5" />, label: "New Chat" },
              {
                id: "codex-history" as Tab,
                icon: codexNav.icon === "bot"
                  ? <Bot className="h-3.5 w-3.5" />
                  : <History className="h-3.5 w-3.5" />,
                label: codexNav.label,
              },
            ] as const
          ).map(({ id, icon, label }) => (
            <button
              key={id}
              type="button"
              aria-current={navigationAriaCurrent(tab === id)}
              onClick={() => { setChatSeed(null); setTab(id); }}
              className={cn(
                "mx-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
                tab === id
                  ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/20"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
              )}
            >
              {icon}
              {label}
            </button>
          ))}

          {/* ── GENERAL section ── */}
          <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            General
          </div>
          {(
            [
              { id: "ops" as Tab, icon: <Radio className="h-3.5 w-3.5" />, label: "Live Ops" },
              { id: "inbox" as Tab, icon: <Inbox className="h-3.5 w-3.5" />, label: "Inbox" },
              { id: "settings" as Tab, icon: <Settings className="h-3.5 w-3.5" />, label: "Settings" },
            ] as const
          ).map(({ id, icon, label }) => (
            <button
              key={id}
              type="button"
              aria-current={navigationAriaCurrent(tab === id)}
              onClick={() => { setChatSeed(null); setTab(id); }}
              className={cn(
                "mx-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
                tab === id
                  ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/20"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>

        {/* ── Main content area ────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
        {tab === "home" ? (
          <Suspense fallback={<PaneFallback />}>
            <HomePane onNewChat={startNewChat} />
          </Suspense>
        ) : tab === "settings" ? (
          <Suspense fallback={<PaneFallback />}>
            <SettingsPane
              authoritativeSettings={settings}
              onSettingsRequestStart={beginSettingsRequest}
              onSettingsSaved={acceptSettingsResponse}
              onSettingsReconcile={refreshSettings}
              projectCwd={project?.cwd}
            />
          </Suspense>
        ) : tab === "dashboard" ? (
          <Suspense fallback={<DashboardSkeleton />}>
            <DashboardPane onOpenSession={openSession} onOpenProject={openProject} />
          </Suspense>
        ) : tab === "ops" ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Ops view toggle: the running-sessions board vs. the multi-session
                grid (watch/drive several live sessions at once). A slim bar above
                both views, so neither view needs to know about the other and the
                existing board is untouched. */}
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950 px-6 py-2">
              <div
                role="tablist"
                aria-label="Ops view"
                className="inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800"
              >
                {(["board", "grid"] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={opsMode === m}
                    onClick={() => setOpsMode(m)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
                      opsMode === m
                        ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                        : "text-zinc-500 hover:text-zinc-300",
                    )}
                    title={
                      m === "grid"
                        ? "Watch and drive several live sessions at once"
                        : "At-a-glance board of running sessions"
                    }
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {opsMode === "grid" ? (
              <Suspense fallback={<PaneFallback />}>
                <MultiSessionGrid />
              </Suspense>
            ) : (
              <LiveOpsBoard onOpenSession={openSessionByCwd} />
            )}
          </div>
        ) : tab === "inbox" ? (
          <InboxPane onOpenSession={openSession} />
        ) : tab === "browse" ? (
          <ResponsiveShell
            stage={shell.stage}
            onNavigate={shell.setStage}
            projectLabel={project?.name}
            sessionLabel={sessionTitle}
            projects={
              <ProjectsPane projects={projects} selectedId={projectId} onSelect={selectProject} />
            }
            sessions={
              <SessionsPane
                project={project}
                sessions={sessions}
                loading={loadingSessions}
                selectedId={sessionId}
                onSelect={onSelectSession}
                onRename={handleRename}
                onTogglePin={handlePin}
                onBulkPin={handleBulkPin}
                onBulkAddTag={handleBulkAddTag}
                overviewActive={showOverview}
                // Hide the toggle once we know the route is unavailable (older server).
                onToggleOverview={
                  overviewUnavailable
                    ? undefined
                    : () =>
                        setShowOverview((v) => {
                          const next = !v;
                          // On narrow screens the overview lives in the transcript
                          // slot, so reveal that pane when turning it on (the
                          // transcript crumb is otherwise gated on a session).
                          if (next) shell.setStage("transcript");
                          return next;
                        })
                }
              />
            }
            transcript={
              // Wholly empty index (no projects discovered): replace the bare
              // transcript area with a richer hint that distinguishes "still
              // indexing" from "indexed but empty" and points at Rebuild index.
              projects.length === 0 && !loadingSessions ? (
                <div className="flex min-w-0 flex-1 flex-col bg-zinc-950">
                  <EmptyIndexHint
                    indexing={progress != null}
                    onOpenSettings={() => setTab("settings")}
                  />
                </div>
              ) : showOverview && project ? (
                // Per-project Overview deep-dive — replaces the transcript area while
                // toggled on. Additive: the project→sessions→transcript flow is intact
                // (selecting a session, below, flips this off). Lazy-loaded so its
                // chunk (incl. the dashboard ModelBreakdown) stays out of the initial
                // paint. A 404 here marks the route unavailable + hides the toggle.
                <Suspense fallback={<PaneFallback />}>
                  <ProjectOverview
                    key={project.id}
                    projectId={project.id}
                    fallbackName={project.name}
                    fallbackCwd={project.cwd}
                    onUnavailable={markOverviewUnavailable}
                  />
                </Suspense>
              ) : (
                <div className="flex min-w-0 flex-1 flex-col">
                  {/* Rich project header atop the transcript area: branch, sessions,
                      tokens + spend, last activity, favorite/archive toggles. */}
                  {project ? (
                    <ProjectDetailHeader
                      project={project}
                      onToggleFavorite={toggleProjectFavorite}
                      onToggleArchive={toggleProjectArchive}
                    />
                  ) : null}
                  <TranscriptPane
                    page={page}
                    loading={loadingPage}
                    onLoadMore={handleLoadMore}
                    onContinue={handleContinue}
                    onCompare={setCompareSessionId}
                    jumpTarget={jumpTarget}
                    onToast={pushToast}
                    onTagsApplied={(_sid, _tags) => {
                      // The autotag apply wrote to the index sidecar; refresh the
                      // project's session list so the row chips reflect the new set.
                      if (projectId) void refreshSessions(projectId);
                    }}
                  />
                </div>
              )
            }
          />
        ) : tab === "openai-chat" ? (
          <Suspense fallback={<PaneFallback />}>
            <OpenAIPane />
          </Suspense>
        ) : tab === "codex-history" ? (
          codexShellMode === "native" ? (
            <Suspense fallback={<PaneFallback />}>
              <CodexNativePane
                key={nativePaneRouteKey("openai")}
                fallback={<CodexHistoryPane />}
              />
            </Suspense>
          ) : (
            <CodexHistoryPane />
          )
        ) : claudeShellMode === "native" ? (
          <Suspense fallback={<PaneFallback />}>
            <CodexNativePane
              key={nativePaneRouteKey("anthropic")}
              provider="anthropic"
              preferredTaskId={nativeClaudePreferredTaskId(activeSeed)}
              fallback={legacyClaudePane}
            />
          </Suspense>
        ) : legacyClaudePane}
        </div>{/* end main content area */}
      </div>
      </ErrorBoundary>

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPick={onPickHit}
        activeProjectId={projectId}
        activeProjectName={project?.name}
      />

      <ProjectSwitcher
        open={projectSwitcherOpen}
        projects={projects}
        selectedId={projectId}
        onClose={() => setProjectSwitcherOpen(false)}
        onPick={(id) => {
          // Same intent as the palette's "Jump to project": fresh selection,
          // drop any pending resume seed, land on Browse.
          setChatSeed(null);
          setProjectId(id);
          setTab("browse");
        }}
      />

      {/* Mounted only while open so its code-split chunk loads on first use; it
          renders null when closed anyway, so behavior (Esc/focus-trap) is intact. */}
      {shortcutOpen ? (
        <Suspense fallback={null}>
          <ShortcutOverlay open={shortcutOpen} onClose={() => setShortcutOpen(false)} />
        </Suspense>
      ) : null}

      {/* First-run onboarding — only mounts for a brand-new, empty install (decided
          once after load); a returning user never sees it. */}
      <FirstRun open={onboardingOpen} onDismiss={dismissOnboarding} />

      {/* Side-by-side session comparison (read-only). Seeded with the open
          transcript's session as the left column; candidates are the active
          project's loaded sessions. Only mounts once that base session is loaded. */}
      {compareSessionId && page && page.session.sessionId === compareSessionId ? (
        <Suspense fallback={null}>
          <SessionCompare
            baseSession={page.session}
            sessions={sessions}
            onClose={() => setCompareSessionId(null)}
          />
        </Suspense>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    </AuthGate>
  );
}
