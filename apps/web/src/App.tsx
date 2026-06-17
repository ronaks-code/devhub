import { useCallback, useEffect, useRef, useState } from "react";
import { Hexagon, MessagesSquare, Search } from "lucide-react";
import { api, subscribeEvents } from "./lib/api";
import type { ProjectSummary, SessionMessagesPage, SessionSummary } from "./lib/types";
import type { SearchHit } from "@claude-ui/engine/types";
import { ProjectsPane } from "./components/ProjectsPane";
import { SessionsPane } from "./components/SessionsPane";
import { TranscriptPane } from "./components/TranscriptPane";
import { ChatPane } from "./components/ChatPane";
import { DashboardPane } from "./components/DashboardPane";
import { SearchPalette } from "./components/SearchPalette";
import { EmptyState, Spinner } from "./components/ui";
import { cn } from "./lib/utils";

const BASE_TAIL = 2 * 1024 * 1024;

type Tab = "browse" | "chat" | "dashboard";

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

const VALID_TABS: readonly Tab[] = ["browse", "chat", "dashboard"];

function TopBar({
  tab,
  onTab,
  onOpenSearch,
  progress,
  sessionCount,
  projectCount,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onOpenSearch: () => void;
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
  // Seeds ChatPane to resume an existing session (--resume) after a handoff
  // from the Browse transcript. Cleared once consumed.
  const [chatSeed, setChatSeed] = useState<{ sessionId: string; projectId: string } | null>(null);
  // Carries a session to auto-select after a search-driven project switch.
  const pendingSessionRef = useRef<string | null>(null);

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

  // Global Cmd/Ctrl+K opens the search palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSelectSession = (id: string) => {
    setTailBytes(undefined);
    setSessionId(id);
  };

  // Picking a search hit jumps to the Browse viewer at that project + session.
  const onPickHit = (hit: SearchHit) => {
    setSearchOpen(false);
    setTab("browse");
    setTailBytes(undefined);
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
        progress={progress}
        sessionCount={sessionCount}
        projectCount={projects.length}
      />
      <div className="flex min-h-0 flex-1">
        {tab === "dashboard" ? (
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
            />
            <TranscriptPane
              page={page}
              loading={loadingPage}
              onLoadMore={handleLoadMore}
              onContinue={handleContinue}
            />
          </>
        ) : (
          <>
            <ProjectsPane projects={projects} selectedId={projectId} onSelect={selectProject} />
            {project ? (
              <ChatPane
                key={activeSeed ? `${project.id}:${activeSeed.sessionId}` : project.id}
                cwd={project.cwd}
                projectName={project.name}
                initialSessionId={activeSeed?.sessionId}
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
    </div>
  );
}
