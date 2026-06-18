import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Command as CommandIcon,
  Cpu,
  Folder,
  Gauge,
  Hexagon,
  History,
  Inbox,
  Keyboard,
  LayoutDashboard,
  MessageSquarePlus,
  MessagesSquare,
  Moon,
  Radio,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Zap,
} from "lucide-react";
import { api, subscribeEvents, type AppSettings } from "./lib/api";
import type {
  ProjectSummary,
  SearchHitWithSeq,
  SessionMessagesPage,
  SessionSummary,
} from "./lib/types";
import type { PermissionMode } from "@claude-ui/engine/driver";
import { ProjectsPane } from "./components/ProjectsPane";
import { SessionsPane } from "./components/SessionsPane";
import { ProjectDetailHeader } from "./components/ProjectDetailHeader";
import { TranscriptPane } from "./components/TranscriptPane";
import { ChatPane } from "./components/ChatPane";
import { DashboardPane } from "./components/DashboardPane";
import { LiveOpsBoard } from "./components/LiveOpsBoard";
import { MultiSessionGrid } from "./components/MultiSessionGrid";
import { InboxPane } from "./components/InboxPane";
import { SettingsPane } from "./components/SettingsPane";
import { SearchPalette } from "./components/SearchPalette";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ToastStack, type ToastItem } from "./components/Toast";
import { AuthGate, LogoutButton } from "./components/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SessionCostBadge } from "./components/SessionCostBadge";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { ResponsiveShell, useResponsiveShell } from "./components/ResponsiveShell";
import { SessionCompare } from "./components/SessionCompare";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { EmptyState, Spinner } from "./components/ui";
import { useRecentSessions, type RecentSession } from "./hooks/useRecentSessions";
import { useFetchErrorToasts } from "./hooks/useFetchErrorToasts";
import { useReducedMotion, type PerfPreference } from "./hooks/useReducedMotion";
import { useTheme, type ThemePreference } from "./hooks/useTheme";
import { useUrlRouter, type RouteState, type RouteTab } from "./lib/router";
import { cn } from "./lib/utils";

const BASE_TAIL = 2 * 1024 * 1024;

const CHAT_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

type Tab = "browse" | "chat" | "ops" | "inbox" | "dashboard" | "settings";

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

const VALID_TABS: readonly Tab[] = ["browse", "chat", "ops", "inbox", "dashboard", "settings"];

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
        <span className="text-sm font-semibold tracking-tight text-zinc-100">Claude UI</span>
      </div>

      <div className="ml-3 inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800">
        {(["browse", "chat", "ops", "inbox", "dashboard"] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className={cn(
              "rounded-md px-3 py-1 text-[12px] font-medium capitalize transition",
              tab === t
                ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <button
        onClick={onOpenSearch}
        className="ml-2 inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-500 ring-1 ring-zinc-800 transition hover:text-zinc-300"
        title="Search sessions (⌘K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search</span>
        <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">⌘K</kbd>
      </button>

      <button
        onClick={onOpenCommands}
        className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-500 ring-1 ring-zinc-800 transition hover:text-zinc-300"
        title="Command palette (⌘⇧P)"
      >
        <CommandIcon className="h-3.5 w-3.5" />
        <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">⌘⇧P</kbd>
      </button>

      <div className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
        {/* Perf / reduced-motion toggle. Cycles auto → on → off; tinted clay
            while motion is being suppressed so the active state reads at a glance. */}
        <button
          onClick={onCyclePerf}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md p-1 transition",
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
          className="rounded-md p-1 text-zinc-500 transition hover:text-zinc-300"
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
          onClick={() => onTab("settings")}
          className={cn(
            "rounded-md p-1 transition",
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
    return t && VALID_TABS.includes(t) ? t : "browse";
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
  // Side-by-side session comparison modal. Holds the left/base session id while
  // open (null = closed). Opened from the transcript header's "Compare" button.
  const [compareSessionId, setCompareSessionId] = useState<string | null>(null);
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
    api.getSettings().then(setSettings).catch(() => {});
  }, [refreshProjects]);

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
    api
      .putSettings(patch)
      .then(setSettings)
      .catch(() => {});
  }, []);

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

  // Build the command palette actions from current app state. Memoized so the
  // list is stable between renders unless its inputs change.
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
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
  }, [projects, theme.preference, effectiveModel, cycleTheme, startNewChat, recents, openSession]);

  return (
    <AuthGate>
      <div className="flex h-full flex-col">
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
      <div className="flex min-h-0 flex-1">
        {tab === "settings" ? (
          <SettingsPane onSettingsSaved={setSettings} projectCwd={project?.cwd} />
        ) : tab === "dashboard" ? (
          <DashboardPane onOpenSession={openSession} onOpenProject={openProject} />
        ) : tab === "ops" ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Ops view toggle: the running-sessions board vs. the multi-session
                grid (watch/drive several live sessions at once). A slim bar above
                both views, so neither view needs to know about the other and the
                existing board is untouched. */}
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950 px-6 py-2">
              <div className="inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800">
                {(["board", "grid"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setOpsMode(m)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition",
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
              <MultiSessionGrid />
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
              />
            }
            transcript={
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
                />
              </div>
            }
          />
        ) : (
          <>
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
          </>
        )}
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

      <ShortcutOverlay open={shortcutOpen} onClose={() => setShortcutOpen(false)} />

      {/* Side-by-side session comparison (read-only). Seeded with the open
          transcript's session as the left column; candidates are the active
          project's loaded sessions. Only mounts once that base session is loaded. */}
      {compareSessionId && page && page.session.sessionId === compareSessionId ? (
        <SessionCompare
          baseSession={page.session}
          sessions={sessions}
          onClose={() => setCompareSessionId(null)}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    </AuthGate>
  );
}
