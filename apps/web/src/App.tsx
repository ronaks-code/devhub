import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Command as CommandIcon,
  Folder,
  Gauge,
  Hexagon,
  History,
  Home,
  Inbox,
  Keyboard,
  LayoutDashboard,
  MessagesSquare,
  Radio,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import {
  api,
  codexApi,
  subscribeEvents,
  type AppSettings,
} from "./lib/api";
import type { CodexSession } from "./lib/types";
import type {
  GitStatus,
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
import { AutomationsBoard } from "./components/AutomationsBoard";
import { InboxPane } from "./components/InboxPane";
import { SearchPalette } from "./components/SearchPalette";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ToastStack, type ToastItem } from "./components/Toast";
import { AuthGate, LogoutButton } from "./components/AuthGate";
import { SessionCostBadge } from "./components/SessionCostBadge";
import { ResponsiveShell, useResponsiveShell } from "./components/ResponsiveShell";
import { AppShell } from "./components/features/shell/AppShell";
import { resolveShellChromeMode } from "./components/features/shell/DevHubShell";
import {
  TaskRail,
  resolveTaskRailMode,
  type TaskRailModel,
} from "./components/features/shell/TaskRail";
import { TaskHeader } from "./components/features/shell/TaskHeader";
import { resolveTaskHeaderSetupMode } from "./components/features/providers/provider-capabilities";
import { ThreadWorkspace, resolveThreadWorkspaceMode } from "./components/features/shell/ThreadWorkspace";
import { resolveInspectorDockMode, InspectorDock } from "./components/features/inspectors/InspectorDock";
import { ChatHost } from "./components/features/shell/ChatHost";
import { resolveComposerSurfaceMode } from "./components/features/shell/Composer";
import {
  TaskSearchDialog,
  resolveSearchCommandsMode,
  type SearchDateFacet,
  type SearchResult,
  type SearchScope,
} from "./components/features/search/TaskSearchDialog";
import {
  CommandDialog,
  DEFAULT_COMMANDS,
  type CommandAction,
} from "./components/features/commands/CommandDialog";
import { resolveSettingsSecondaryMode } from "./components/features/settings/SettingsRoute";
import { OpsRoute } from "./components/features/ops/OpsRoute";
import { WorkModeSurface } from "./components/features/shell/WorkModeSurface";
import { InboxRoute } from "./components/features/inbox/InboxRoute";
import {
  buildDiffContent,
  buildEnvironmentSummary,
  buildFilesContent,
  buildTaskRailSections,
  legacyDestinationForTarget,
  mapMessagesToThreadItems,
  searchHitToResult,
} from "./lib/m6-compose";
import { buildFileChanges } from "./components/FileChangeSummary";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { FirstRun, EmptyIndexHint, hasSeenOnboarding, markOnboardingSeen } from "./components/FirstRun";
import { EmptyState, Spinner } from "./components/ui";
import { DashboardSkeleton } from "./components/Skeleton";
import { useRecentSessions, type RecentSession } from "./hooks/useRecentSessions";
import { useFetchErrorToasts } from "./hooks/useFetchErrorToasts";
import { useReducedMotion, type PerfPreference } from "./hooks/useReducedMotion";
import { useTheme, type ThemePreference } from "./hooks/useTheme";
import { useUrlRouter, type RouteState, type RouteTab } from "./lib/router";
import { readCompat, writeCompat } from "./lib/compat-storage";
import { cn } from "./lib/utils";

// Heavier, non-initial surfaces are code-split: each loads its own chunk the
// first time the user opens it, so the initial Browse load stays lean. The Browse
// view (the default tab) keeps its imports static so it renders without a fetch.
// Tab views — Dashboard (charts/heatmaps) and Settings (config panels):
const DashboardPane = lazy(() =>
  import("./components/DashboardPane").then((m) => ({ default: m.DashboardPane })),
);
// Progress / Shipped Work board — heavy (big mined snapshot + accordions), so
// it's code-split exactly like DashboardPane and only pulls its chunk when the
// tab is opened.
const ProgressBoard = lazy(() =>
  import("./components/ProgressBoard").then((m) => ({ default: m.ProgressBoard })),
);
// Spatial "office game" view — the PixiJS/WebGL swarm visualizer. Heavy (Pixi +
// canvas), so it's code-split and only pulls its chunk when the tab is opened.
const SpatialHub = lazy(() =>
  import("./spatial/SpatialHub").then((m) => ({ default: m.SpatialHub })),
);
const SettingsPane = lazy(() =>
  import("./components/SettingsPane").then((m) => ({ default: m.SettingsPane })),
);
// M6 slice 8 (settingsSecondary, default off): the DevHub-styled replacements for
// Settings/Dashboard, code-split exactly like their legacy owners so flag-off never
// pulls their chunk. `DashboardRoute` wraps the SAME `DashboardPane` under
// `SecondaryNav`, so it stays as lazy as the legacy tab.
const SettingsRoute = lazy(() =>
  import("./components/features/settings/SettingsRoute").then((m) => ({ default: m.SettingsRoute })),
);
const DashboardRoute = lazy(() =>
  import("./components/features/analytics/DashboardRoute").then((m) => ({ default: m.DashboardRoute })),
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

type Tab = "home" | "browse" | "chat" | "ops" | "inbox" | "dashboard" | "spatial" | "settings" | "openai-chat" | "codex-history" | "automations" | "progress";

// Lightweight UI-state persistence: remembers the active tab and selected
// project across reloads. Guarded for SSR (no window) and malformed JSON.
const UI_STATE_KEY = "devhub:ui";

interface PersistedUiState {
  tab?: Tab;
  projectId?: string | null;
  // Reserved for future use; persisted only when present so existing config survives.
  theme?: string;
  density?: string;
}

function readUiState(): PersistedUiState {
  try {
    const raw = readCompat(UI_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PersistedUiState) : {};
  } catch {
    return {};
  }
}

function writeUiState(state: PersistedUiState): void {
  writeCompat(UI_STATE_KEY, JSON.stringify(state));
}

const VALID_TABS: readonly Tab[] = ["home", "browse", "chat", "ops", "inbox", "dashboard", "spatial", "settings", "openai-chat", "codex-history", "automations", "progress"];

/** App-specific destinations extend the approved command set without reviving the retired palette. */
const APP_COMMANDS: readonly CommandAction[] = Object.freeze([
  ...DEFAULT_COMMANDS,
  {
    id: "go-to-spatial",
    title: "Go to Spatial",
    kind: "navigate",
    group: "Navigate",
    keywords: "spatial office city visualizer agents",
  },
  {
    id: "go-to-automations",
    title: "Go to Scheduled Jobs",
    kind: "navigate",
    group: "Navigate",
    keywords: "automations launchd cron jobs schedule",
  },
  {
    id: "go-to-progress",
    title: "Go to Progress",
    kind: "navigate",
    group: "Navigate",
    keywords: "progress shipped work features milestones changelog",
  },
]);

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

/**
 * The Chat tab's `taskHeaderSetup` + `threadWorkspace` + `composerSurface` slices
 * bundle ONE inseparable region inside the legacy `ChatPane` (its header/
 * transcript/composer can't be independently swapped without editing the
 * user-owned file), so `ChatHost` mounts only when ALL THREE resolve `devhub`
 * together. An explicit stored false on ANY ONE of them still restores
 * `ChatPane` — the slice contract's own instant-rollback promise, honored
 * conservatively (AND, not OR).
 */
export function resolveChatHostMode(
  taskHeaderSetupMode: "devhub" | "legacy",
  threadWorkspaceMode: "devhub" | "legacy",
  composerSurfaceMode: "devhub" | "legacy",
): "devhub" | "legacy" {
  return taskHeaderSetupMode === "devhub" &&
    threadWorkspaceMode === "devhub" &&
    composerSurfaceMode === "devhub"
    ? "devhub"
    : "legacy";
}

/**
 * M7-WORKMODE-CUTOVER: the Work-mode surface mounts only for a server-resolved
 * true `workMode` flag AND an active project with a real `cwd` (the folder
 * scope Work mode needs to create/fetch its task against) — the exact same AND
 * gate every other cutover flag uses, extracted so the cutover default flip
 * (`workMode: false -> true`) is covered by a pure, App-level test independent
 * of any DOM render. Flipping the default never bypasses this: without a real
 * project, the surface still never mounts, and once mounted, `WorkModePanel`'s
 * own no-fabrication gate (renders nothing without a real backing task) is the
 * second, independent line of defense.
 */
export function shouldMountWorkModeSurface(
  settings: AppSettings | null,
  project: { cwd?: string | null } | null,
): boolean {
  return settings?.devHubFeatures?.workMode === true &&
    typeof project?.cwd === "string" && project.cwd.length > 0;
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

/** Recover the provider home from Claude's canonical `<home>/projects/...` transcript path. */
export function nativeClaudeHomeFromSessionFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const match = /[\\/]projects[\\/]/.exec(filePath);
  return match && match.index > 0 ? filePath.slice(0, match.index) : undefined;
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
// DEVHUB-A11Y-CONTRAST-DARK-SECONDARYNAV: zinc-500 (#71717a) on the
// zinc-900/zinc-950 top-bar surfaces measures ~3.7:1/~4.1:1 — below WCAG AA's
// 4.5:1 for normal text (see apps/web/src/lib/contrast-tokens.test.ts). Bumped
// to zinc-400 (#a1a1aa, the palette's next step up, already the app's
// `--text-muted` token) which clears 4.5:1 on both surfaces with the
// smallest available visual diff.
export const TOP_BAR_SECONDARY_CLASS =
  "ml-auto hidden items-center gap-3 text-[11px] text-zinc-400 lg:flex";

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
                : "text-zinc-400 hover:text-zinc-300",
            )}
          >
            {t}
          </button>
        ))}
      </nav>

      <button
        onClick={onOpenSearch}
        className="ml-2 inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
        title="Search sessions (⌘K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search</span>
        <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">⌘K</kbd>
      </button>

      <button
        onClick={onOpenCommands}
        className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
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
  // M6 slice 7 (Task 9 data-wire): the devhub `TaskSearchDialog`'s own query/scope/
  // date-facet/results state. Only read/updated while `searchCommandsMode==="devhub"`
  // and `searchOpen`; the legacy `SearchPalette` owns its own state independently.
  const [dhSearchQuery, setDhSearchQuery] = useState("");
  const [dhSearchScope, setDhSearchScope] = useState<SearchScope>("global");
  const [dhSearchDateFacet, setDhSearchDateFacet] = useState<SearchDateFacet | null>(null);
  const [dhSearchResults, setDhSearchResults] = useState<SearchResult[]>([]);
  const [dhSearchLoading, setDhSearchLoading] = useState(false);
  const [dhSearchError, setDhSearchError] = useState(false);
  // Bumped by the in-dialog error Alert's Retry, so the fetch effect below re-runs
  // even when the query text itself is unchanged.
  const [dhSearchRetryNonce, setDhSearchRetryNonce] = useState(0);
  // The devhub `CommandDialog`'s own query filter state.
  const [dhCommandQuery, setDhCommandQuery] = useState("");
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
  // M6 slice 6 (Task 9 data-wire): real git status for the Browse InspectorDock's
  // Environment summary + branch row. Null means "no repo / not fetched yet" — the
  // dock renders that honestly (an omitted row), never a placeholder value.
  const [browseGitStatus, setBrowseGitStatus] = useState<GitStatus | null>(null);
  const [browseInspectorSelected, setBrowseInspectorSelected] = useState<
    "diff" | "files" | "terminal" | "browser" | "artifacts"
  >("diff");
  // The Commands `Toggle inspector` action (M6 slice 7) flips this; it only has an
  // effect where `inspectorDock` is actually mounted (Browse/Chat).
  const [inspectorVisible, setInspectorVisible] = useState(true);
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
  // Legacy Browse/Chat headers know the native Claude session id but not its
  // provider home. Route the intent into CodexNativePane, whose existing
  // discovery path resolves the real NativeTaskKey before opening the fork UI.
  const [crossProviderForkTaskId, setCrossProviderForkTaskId] = useState<string | null>(null);
  const [crossProviderForkHome, setCrossProviderForkHome] = useState<string | undefined>(undefined);
  const [crossProviderForkNativeRoute, setCrossProviderForkNativeRoute] = useState(false);
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

  // M6 slice 7 (Task 9 data-wire): the devhub TaskSearchDialog's own "open a result"
  // handler. `target` is provider-LOCKED, derived only from the composite task key
  // (`legacyDestinationForTarget`); this mirrors `onPickHit`'s navigation exactly, just
  // over the new dialog's contract instead of the legacy `SearchHitWithSeq`.
  const onOpenSearchResult = useCallback(
    (target: ReturnType<typeof legacyDestinationForTarget>) => {
      setSearchOpen(false);
      setTab("browse");
      setTailBytes(undefined);
      setJumpTarget(typeof target.seq === "number" ? { seq: target.seq, nonce: Date.now() } : null);
      if (target.projectId === projectId) {
        setSessionId(target.sessionId);
      } else {
        pendingSessionRef.current = target.sessionId;
        setProjectId(target.projectId);
      }
    },
    [projectId],
  );

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
  const openCrossProviderFork = useCallback((nativeTaskId: string | null) => {
    if (settings?.devHubFeatures?.crossProviderFork !== true) {
      pushToast({
        title: "Cross-provider fork unavailable",
        body: "A native target provider is not available for this task.",
        level: "info",
      });
      return;
    }
    if (!nativeTaskId || !projectId) {
      pushToast({
        title: "Start the Claude task first",
        body: "Send a message before creating a cross-provider fork.",
        level: "info",
      });
      return;
    }
    setChatSeed({ sessionId: nativeTaskId, projectId });
    setCrossProviderForkTaskId(nativeTaskId);
    setCrossProviderForkHome(nativeClaudeHomeFromSessionFile(
      sessions.find((session) => session.sessionId === nativeTaskId)?.filePath,
    ));
    setCrossProviderForkNativeRoute(true);
    setTab("chat");
  }, [projectId, pushToast, sessions, settings?.devHubFeatures?.crossProviderFork]);

  // Responsive Browse layout: 3 panes on wide screens, a single active pane with
  // a breadcrumb on narrow ones. The stage auto-advances as the user drills in.
  const shell = useResponsiveShell({ hasProject: !!projectId, hasSession: !!sessionId });
  // The open session's title for the transcript breadcrumb crumb (when loaded).
  const sessionTitle = page?.session.title ?? null;

  // M6 slice 1: mount the measured Codex-style DevHubShell only when the server
  // resolves the `shellChrome` flag true; otherwise keep the legacy chrome. Default
  // false, so the shipping default renders the current shell unchanged.
  const shellChromeMode = resolveShellChromeMode(settings);

  // M6 slice 2: swap the rail for the Codex-style open-list TaskRail only when the
  // server resolves `taskRail` true; otherwise keep the legacy rail (default false, so
  // the shipping default is unchanged). The model is built ONLY in the devhub branch
  // below, so flag-off never constructs it or instantiates TaskRail. Secondary
  // destinations are the reachable primary tabs. Task 9 data-wire: the row SECTION is
  // now the active project's real (legacy Claude) sessions, most-recent-first — a
  // native task row (a different provider's real task) is a separate, still-gated
  // data-wire (native Codex/Claude live in `CodexNativePane`, not this legacy list).
  const taskRailMode = resolveTaskRailMode(settings);
  const taskRailModel = useMemo<TaskRailModel>(
    () => ({
      sections: buildTaskRailSections(sessions, project?.name ?? "Sessions"),
      destinations: [
        { id: "home", label: "Home", current: tab === "home" },
        { id: "browse", label: "Browse", current: tab === "browse" },
        { id: "chat", label: "Chat", current: tab === "chat" },
        { id: "dashboard", label: "Dashboard", current: tab === "dashboard" },
        { id: "ops", label: "Live Ops", current: tab === "ops" },
        { id: "spatial", label: "Spatial", current: tab === "spatial" },
        { id: "progress", label: "Progress", current: tab === "progress" },
        { id: "automations", label: "Scheduled Jobs", current: tab === "automations" },
        { id: "inbox", label: "Inbox", current: tab === "inbox" },
        { id: "settings", label: "Settings", current: tab === "settings" },
      ],
    }),
    [tab, sessions, project],
  );

  // M6 slice 3 (Task 9 data-wire): TaskHeader/TaskSetup mount only for a
  // server-resolved true `taskHeaderSetup`; legacy `ProjectDetailHeader`/`ChatPane`
  // header otherwise. See `provider-capabilities.ts`.
  const taskHeaderSetupMode = resolveTaskHeaderSetupMode(settings);
  // M6 slice 4 (Task 9 data-wire): ThreadWorkspace mounts only for a server-resolved
  // true `threadWorkspace`; legacy `TranscriptPane` otherwise.
  const threadWorkspaceMode = resolveThreadWorkspaceMode(settings);
  // M6 slice 6 (Task 9 data-wire): InspectorDock mounts only for a server-resolved
  // true `inspectorDock`; legacy git/file panels otherwise.
  const inspectorDockMode = resolveInspectorDockMode(settings);

  // Real git status for the Browse InspectorDock, refetched whenever the active
  // project's cwd changes. Only fetched while the dock is actually mounted, so
  // flag-off never issues this request.
  useEffect(() => {
    if (inspectorDockMode !== "devhub" || !project?.cwd) {
      setBrowseGitStatus(null);
      return;
    }
    let cancelled = false;
    api
      .gitStatus(project.cwd)
      .then((s) => {
        if (!cancelled) setBrowseGitStatus(s);
      })
      .catch(() => {
        if (!cancelled) setBrowseGitStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectorDockMode, project?.cwd]);
  // M6 slice 7 (Task 9 data-wire): TaskSearchDialog + CommandDialog mount only for a
  // server-resolved true `searchCommands`; legacy `SearchPalette` (Commands stays
  // unmounted) otherwise.
  const searchCommandsMode = resolveSearchCommandsMode(settings);
  // M6 slice 8 (Task 9 data-wire): SettingsRoute/OpsRoute/InboxRoute/DashboardRoute
  // mount only for a server-resolved true `settingsSecondary`; legacy
  // SettingsPane/LiveOpsBoard/InboxPane/DashboardPane otherwise.
  const settingsSecondaryMode = resolveSettingsSecondaryMode(settings);
  // The Chat tab bundles TaskHeader + ThreadWorkspace + Composer into ONE region
  // inside the legacy `ChatPane` (header/transcript/composer are inseparable there
  // without editing the user-owned file), so `ChatHost` mounts only when ALL THREE
  // slices are on together — an explicit stored false on ANY ONE of them restores
  // `ChatPane`, satisfying each flag's own instant-rollback contract conservatively.
  const composerSurfaceMode = resolveComposerSurfaceMode(settings);
  const chatHostMode = resolveChatHostMode(taskHeaderSetupMode, threadWorkspaceMode, composerSurfaceMode);

  // M6 slice 7 (Task 9 data-wire): debounced real search against the SAME
  // `/api/search` endpoint the legacy `SearchPalette` calls, active only while the
  // devhub dialog is open. Every result is mapped through `searchHitToResult`, so
  // its provider is always the honest `anthropic` legacy-session encoding, never a
  // guess. Flag-off (or dialog-closed) never fires this fetch.
  useEffect(() => {
    if (!searchOpen || searchCommandsMode !== "devhub") return;
    const term = dhSearchQuery.trim();
    if (!term) {
      setDhSearchResults([]);
      setDhSearchLoading(false);
      setDhSearchError(false);
      return;
    }
    const effectiveProject = dhSearchScope === "project" && projectId ? projectId : null;
    setDhSearchLoading(true);
    setDhSearchError(false);
    let cancelled = false;
    const t = setTimeout(() => {
      const url =
        `/api/search?q=${encodeURIComponent(term)}&limit=30` +
        (effectiveProject ? `&projectId=${encodeURIComponent(effectiveProject)}` : "");
      fetch(url, { headers: { accept: "application/json" } })
        .then((r) => {
          if (!r.ok) throw new Error(`search failed: ${r.status}`);
          return r.json() as Promise<SearchHitWithSeq[]>;
        })
        .then((res) => {
          if (cancelled) return;
          const scoped = effectiveProject ? res.filter((h) => h.projectId === effectiveProject) : res;
          setDhSearchResults(scoped.map(searchHitToResult));
        })
        .catch(() => {
          if (!cancelled) {
            setDhSearchResults([]);
            setDhSearchError(true);
          }
        })
        .finally(() => {
          if (!cancelled) setDhSearchLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchOpen, searchCommandsMode, dhSearchQuery, dhSearchScope, dhSearchRetryNonce, projectId]);

  // Reset the devhub search dialog's own state each time it opens (mirrors the
  // legacy `SearchPalette`'s own open-reset effect).
  useEffect(() => {
    if (!searchOpen) return;
    setDhSearchQuery("");
    setDhSearchResults([]);
    setDhSearchError(false);
  }, [searchOpen]);

  const startNewChat = useCallback(() => {
    setChatSeed(null);
    setChatNonce((n) => n + 1);
    setTab("chat");
  }, []);

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

  // M6 Task 9 "composer host" data-wire: taskHeaderSetup + threadWorkspace +
  // composerSurface bundle one inseparable region inside the legacy `ChatPane`
  // (its header/transcript/composer can't be independently swapped without
  // editing the user-owned file), so this mounts only when ALL THREE resolve
  // devhub together; any one of them false keeps `legacyClaudePane` above,
  // unedited. `ChatHost` opens its OWN real `openChat` connection — the same
  // transport `ChatPane` uses — so this is a real, not simulated, composer.
  const devhubClaudePane =
    chatHostMode === "devhub" ? (
      <div className="flex min-h-0 flex-1">
        <ProjectsPane projects={projects} selectedId={projectId} onSelect={selectProject} />
        {project ? (
          <ChatHost
            key={activeSeed ? `${project.id}:${activeSeed.sessionId}` : `${project.id}:${chatNonce}`}
            cwd={project.cwd}
            projectId={project.id}
            initialSessionId={activeSeed?.sessionId}
            defaultModel={settings?.defaultModel}
            defaultPermissionMode={settings?.defaultPermissionMode as PermissionMode | undefined}
            title={
              activeSeed
                ? sessions.find((s) => s.sessionId === activeSeed.sessionId)?.title ?? "Resumed session"
                : "New task"
            }
            showInspector={inspectorDockMode === "devhub" && inspectorVisible}
            onFork={openCrossProviderFork}
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
    ) : null;

  return (
    <AuthGate>
      <div className="flex h-full flex-col">
      {/* M6 slice 1 (shellChrome, default off): the legacy branch reproduces the
          current chrome — skip link, TopBar, ErrorBoundary, #main-content main
          landmark, and the w-44 primary-navigation rail — byte-for-byte; the devhub
          branch mounts the measured DevHubShell with the same slots. */}
      <AppShell
        mode={shellChromeMode}
        railLabel="Primary navigation"
        header={
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
        }
        rail={
          taskRailMode === "devhub" ? (
            <TaskRail
              model={taskRailModel}
              onNewTask={startNewChat}
              onSelectDestination={(id) => { setChatSeed(null); setTab(id as Tab); }}
            />
          ) : (
          <>
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
              { id: "spatial" as Tab, icon: <Hexagon className="h-3.5 w-3.5" />, label: "Spatial" },
              { id: "progress" as Tab, icon: <Rocket className="h-3.5 w-3.5" />, label: "Progress" },
              { id: "automations" as Tab, icon: <Timer className="h-3.5 w-3.5" />, label: "Scheduled Jobs" },
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
          </>
          )
        }
      >
        {/* ── Main content area (AppShell provides the flex column wrapper) ── */}
        {tab === "home" ? (
          <Suspense fallback={<PaneFallback />}>
            <HomePane onNewChat={startNewChat} />
          </Suspense>
        ) : tab === "settings" ? (
          // M6 slice 8 (Task 9 data-wire): `SettingsRoute` replaces `SettingsPane` only
          // for `settingsSecondary===true`; legacy pane otherwise. Same props contract.
          <Suspense fallback={<PaneFallback />}>
            {settingsSecondaryMode === "devhub" ? (
              <SettingsRoute
                authoritativeSettings={settings}
                onSettingsRequestStart={beginSettingsRequest}
                onSettingsSaved={acceptSettingsResponse}
                onSettingsReconcile={refreshSettings}
                projectCwd={project?.cwd}
              />
            ) : (
              <SettingsPane
                authoritativeSettings={settings}
                onSettingsRequestStart={beginSettingsRequest}
                onSettingsSaved={acceptSettingsResponse}
                onSettingsReconcile={refreshSettings}
                projectCwd={project?.cwd}
              />
            )}
          </Suspense>
        ) : tab === "dashboard" ? (
          // M6 slice 8 (Task 9 data-wire): `DashboardRoute` routes the SAME
          // `DashboardPane` under `SecondaryNav` only for `settingsSecondary===true`.
          <Suspense fallback={<DashboardSkeleton />}>
            {settingsSecondaryMode === "devhub" ? (
              <DashboardRoute onOpenSession={openSession} onOpenProject={openProject} />
            ) : (
              <DashboardPane onOpenSession={openSession} onOpenProject={openProject} />
            )}
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
                        // DEVHUB-A11Y-CONTRAST-DARK-SECONDARYNAV: zinc-500 measured
                        // 3.67:1 against this tab-strip's zinc-900 pill — below AA.
                        : "text-zinc-400 hover:text-zinc-300",
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
            ) : settingsSecondaryMode === "devhub" ? (
              // M6 slice 8 (Task 9 data-wire): `OpsRoute` routes the SAME `LiveOpsBoard`
              // under `SecondaryNav` only for `settingsSecondary===true`.
              <OpsRoute onOpenSession={openSessionByCwd} />
            ) : (
              <LiveOpsBoard onOpenSession={openSessionByCwd} />
            )}
          </div>
        ) : tab === "progress" ? (
          <Suspense fallback={<PaneFallback />}>
            <ProgressBoard onOpenSession={openSession} onOpenProject={openProject} />
          </Suspense>
        ) : tab === "automations" ? (
          <AutomationsBoard />
        ) : tab === "inbox" ? (
          // M6 slice 8 (Task 9 data-wire): `InboxRoute` routes the SAME `InboxPane`
          // under `SecondaryNav` only for `settingsSecondary===true`.
          settingsSecondaryMode === "devhub" ? (
            <InboxRoute onOpenSession={openSession} />
          ) : (
            <InboxPane onOpenSession={openSession} />
          )
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
                <div className="flex min-w-0 flex-1">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {/* M6 slice 3 (Task 9 data-wire): the devhub read-only TaskHeader
                        replaces `ProjectDetailHeader` only for `taskHeaderSetup===true`;
                        legacy header otherwise. Provider is always `anthropic` — Browse
                        only ever shows legacy Claude sessions. */}
                    {taskHeaderSetupMode === "devhub" && project ? (
                      <TaskHeader
                        title={sessionTitle ?? project.name}
                        provider="anthropic"
                        onFork={() => openCrossProviderFork(sessionId)}
                      />
                    ) : project ? (
                      <ProjectDetailHeader
                        project={project}
                        onToggleFavorite={toggleProjectFavorite}
                        onToggleArchive={toggleProjectArchive}
                      />
                    ) : null}
                    {/* M6 slice 4 (Task 9 data-wire): the devhub ThreadWorkspace replaces
                        `TranscriptPane` only for `threadWorkspace===true`; legacy
                        transcript otherwise. Browse is read-only history, so `canSend`
                        stays false — an honest disabled composer, not a fake one, since
                        this view genuinely has no live send capability (use Chat to
                        continue a conversation). */}
                    {threadWorkspaceMode === "devhub" ? (
                      <ThreadWorkspace items={mapMessagesToThreadItems(page?.messages ?? [])} provider="anthropic" canSend={false} />
                    ) : (
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
                    )}
                  </div>
                  {/* M6 slice 6 (Task 9 data-wire): the devhub InspectorDock absorbs the
                      legacy `GitPanel`/`FileChangeSummary` (normally mounted inside
                      `TranscriptPane`) only for `inspectorDock===true`. Terminal/Browser/
                      Artifacts have no backing runtime in Browse, so they honestly render
                      "Not available"/"No artifacts" — never a faked capability. */}
                  {inspectorDockMode === "devhub" && inspectorVisible ? (
                    <InspectorDock
                      provider="anthropic"
                      selected={browseInspectorSelected}
                      onSelectDestination={setBrowseInspectorSelected}
                      environment={buildEnvironmentSummary(browseGitStatus, buildFileChanges(page?.messages ?? []))}
                      content={{
                        diff: buildDiffContent(buildFileChanges(page?.messages ?? [])),
                        files: buildFilesContent(buildFileChanges(page?.messages ?? [])),
                      }}
                    />
                  ) : null}
                </div>
              )
            }
          />
        ) : tab === "spatial" ? (
          <Suspense fallback={<PaneFallback />}>
            <SpatialHub />
          </Suspense>
        ) : tab === "openai-chat" ? (
          <Suspense fallback={<PaneFallback />}>
            <OpenAIPane />
          </Suspense>
        ) : tab === "codex-history" ? (
          codexShellMode === "native" ? (
            <Suspense fallback={<PaneFallback />}>
              <CodexNativePane
                key={nativePaneRouteKey("openai")}
                features={settings?.devHubFeatures}
                fallback={<CodexHistoryPane />}
              />
            </Suspense>
          ) : (
            <CodexHistoryPane />
          )
        ) : claudeShellMode === "native" || crossProviderForkNativeRoute ? (
          <Suspense fallback={<PaneFallback />}>
            <CodexNativePane
              key={`${nativePaneRouteKey("anthropic")}:${crossProviderForkNativeRoute ? "fork" : "normal"}`}
              provider="anthropic"
              features={settings?.devHubFeatures}
              preferredHome={crossProviderForkHome}
              preferredTaskId={crossProviderForkTaskId ?? nativeClaudePreferredTaskId(activeSeed)}
              autoOpenCrossProviderFork={crossProviderForkTaskId !== null}
              onCrossProviderForkAutoOpen={() => setCrossProviderForkTaskId(null)}
              onCrossProviderForkClosed={() => {
                setCrossProviderForkNativeRoute(false);
                setCrossProviderForkHome(undefined);
              }}
              fallback={legacyClaudePane}
            />
          </Suspense>
        ) : devhubClaudePane ?? legacyClaudePane}
      </AppShell>

      {/* M7-WORKMODE-WIRING: Work mode is a DISTINCT DevHub product mode from Code
          mode, never "Cowork" — see concepts/07-work-mode-corrected.png. Flag-off
          (default) OR no active project renders nothing; the server independently
          re-checks `workMode` on every request this surface issues. */}
      {tab !== "spatial" && shouldMountWorkModeSurface(settings, project) && project?.cwd ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 w-[420px] max-w-[calc(100vw-2rem)]">
          <div className="pointer-events-auto">
            <WorkModeSurface
              enabled
              title={project.name}
              provider="anthropic"
              home={project.cwd}
              nativeTaskId={`work-mode-source-${project.id}`}
              folderRoot={project.cwd}
              taskId={`work-mode-${project.id}`}
            />
          </div>
        </div>
      ) : null}

      {/* M6 slice 7 (Task 9 data-wire): the devhub `TaskSearchDialog` replaces the
          legacy `SearchPalette` only for `searchCommands===true`; legacy dialog
          otherwise. Every result is real (`/api/search`, mapped honestly through
          `searchHitToResult`), and opening one navigates via the SAME provider-locked
          path as the legacy palette's `onPickHit`. */}
      {searchCommandsMode === "devhub" ? (
        searchOpen ? (
          <TaskSearchDialog
            query={dhSearchQuery}
            scope={dhSearchScope}
            activeProjectId={projectId}
            activeProjectName={project?.name}
            dateFacet={dhSearchDateFacet}
            loading={dhSearchLoading}
            error={dhSearchError}
            results={dhSearchResults}
            onOpen={(target) => onOpenSearchResult(legacyDestinationForTarget(target))}
            onQueryChange={setDhSearchQuery}
            onScopeChange={setDhSearchScope}
            onDateFacetChange={setDhSearchDateFacet}
            onRetry={() => setDhSearchRetryNonce((n) => n + 1)}
            onClose={() => setSearchOpen(false)}
          />
        ) : null
      ) : (
        <SearchPalette
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onPick={onPickHit}
          activeProjectId={projectId}
          activeProjectName={project?.name}
        />
      )}

      {/* M6 slice 7 (Task 9 data-wire): the SEPARATE `CommandDialog` — the legacy
          `CommandPalette` stays unmounted exactly as today (it always was, even
          before M6). Only mounted while open AND `searchCommands===true`. */}
      {searchCommandsMode === "devhub" && commandOpen ? (
        <CommandDialog
          query={dhCommandQuery}
          commands={APP_COMMANDS}
          onQueryChange={setDhCommandQuery}
          onClose={() => setCommandOpen(false)}
          onRun={(action) => {
            setCommandOpen(false);
            setDhCommandQuery("");
            if (action.id === "new-task") startNewChat();
            else if (action.id === "toggle-inspector") setInspectorVisible((v) => !v);
            else if (action.id === "open-settings") {
              setChatSeed(null);
              setTab("settings");
            } else if (action.id === "go-to-ops") {
              setChatSeed(null);
              setTab("ops");
            } else if (action.id === "go-to-spatial") {
              setChatSeed(null);
              setTab("spatial");
            } else if (action.id === "go-to-automations") {
              setChatSeed(null);
              setTab("automations");
            } else if (action.id === "go-to-progress") {
              setChatSeed(null);
              setTab("progress");
            }
          }}
          onSearchTasks={() => {
            setCommandOpen(false);
            setDhCommandQuery("");
            setSearchOpen(true);
          }}
        />
      ) : null}

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
