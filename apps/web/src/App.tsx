import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Command as CommandIcon,
  Cpu,
  Folder,
  Hexagon,
  LayoutDashboard,
  MessageSquarePlus,
  MessagesSquare,
  Moon,
  Search,
  Settings,
  Sparkles,
  Sun,
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
import { TranscriptPane } from "./components/TranscriptPane";
import { ChatPane } from "./components/ChatPane";
import { DashboardPane } from "./components/DashboardPane";
import { SettingsPane } from "./components/SettingsPane";
import { SearchPalette } from "./components/SearchPalette";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { EmptyState, Spinner } from "./components/ui";
import { cn } from "./lib/utils";

const BASE_TAIL = 2 * 1024 * 1024;

const CHAT_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

type Tab = "browse" | "chat" | "dashboard" | "settings";

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

const VALID_TABS: readonly Tab[] = ["browse", "chat", "dashboard", "settings"];

function TopBar({
  tab,
  onTab,
  onOpenSearch,
  onOpenCommands,
  progress,
  sessionCount,
  projectCount,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onOpenSearch: () => void;
  onOpenCommands: () => void;
  progress: { done: number; total: number } | null;
  sessionCount: number;
  projectCount: number;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800/80 bg-zinc-950 px-4">
      <div className="flex items-center gap-2">
        <Hexagon className="h-4 w-4 fill-clay-500/20 text-clay-500" />
        <span className="text-sm font-semibold tracking-tight text-zinc-100">Claude UI</span>
      </div>

      <div className="ml-3 inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800">
        {(["browse", "chat", "dashboard"] as const).map((t) => (
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
  const [commandOpen, setCommandOpen] = useState(false);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
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
    setSessions(await api.sessions(pid));
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
        if (!cancelled) setPage(p);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingPage(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, tailBytes]);

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
      }
    });
  }, [refreshProjects, refreshSessions, projectId]);

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

  // Reflect the chosen theme onto the document root. Theming is "store only for
  // now" — we just toggle the `dark` class so the setting has a visible effect
  // and the rest can build on it later. "system" follows the OS preference.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const theme = settings?.theme ?? "system";
    const prefersDark =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : true;
    const isDark = theme === "dark" || (theme === "system" && prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, [settings?.theme]);

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

  const cycleTheme = useCallback(() => {
    const order: AppSettings["theme"][] = ["dark", "light", "system"];
    const current = settings?.theme ?? "system";
    const next = order[(order.indexOf(current) + 1) % order.length];
    saveSettings({ theme: next });
  }, [settings?.theme, saveSettings]);

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

  const project = projects.find((p) => p.id === projectId) ?? null;
  // Only honor the seed while its project is the active one.
  const activeSeed = chatSeed && chatSeed.projectId === projectId ? chatSeed : null;

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
        title: `Toggle theme (now: ${settings?.theme ?? "system"})`,
        group: "Theme",
        keywords: "dark light system appearance",
        icon:
          (settings?.theme ?? "system") === "light" ? (
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

    return list;
  }, [projects, settings?.theme, effectiveModel, cycleTheme, startNewChat]);

  return (
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
        progress={progress}
        sessionCount={sessionCount}
        projectCount={projects.length}
      />
      <div className="flex min-h-0 flex-1">
        {tab === "settings" ? (
          <SettingsPane onSettingsSaved={setSettings} projectCwd={project?.cwd} />
        ) : tab === "dashboard" ? (
          <DashboardPane />
        ) : tab === "browse" ? (
          <>
            <ProjectsPane projects={projects} selectedId={projectId} onSelect={selectProject} />
            <SessionsPane
              project={project}
              sessions={sessions}
              selectedId={sessionId}
              onSelect={onSelectSession}
              onRename={handleRename}
              onTogglePin={handlePin}
              onBulkPin={handleBulkPin}
              onBulkAddTag={handleBulkAddTag}
            />
            <TranscriptPane
              page={page}
              loading={loadingPage}
              onLoadMore={handleLoadMore}
              onContinue={handleContinue}
              jumpTarget={jumpTarget}
            />
          </>
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

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onPick={onPickHit} />

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
    </div>
  );
}
