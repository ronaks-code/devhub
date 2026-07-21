import { useState } from "react";
import { ArrowUp, Folder, History } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecentSession } from "../../../hooks/useRecentSessions";
import type { SidebarWorktree } from "./Sidebar.js";

/**
 * Launchpad — the new-session empty state (§3.3b), shown for a `+` tab or an empty
 * chat route. Every element maps to a REAL source; anything absent (recents,
 * worktrees) simply doesn't render — no invented "median turn" style stats.
 */
export interface LaunchpadProps {
  /** Live count of running agents (from api.running()). */
  runningCount: number;
  mechanics: "claude" | "codex";
  onMechanicsChange: (m: "claude" | "codex") => void;
  /** Model label per engine, when known (settings.defaultModel). */
  claudeModel?: string;
  codexModel?: string;
  recents: RecentSession[];
  onOpenRecent: (projectId: string, sessionId: string) => void;
  onLaunch: (draft: string) => void;
  onBrowse: () => void;
  onOpenCodexHistory: () => void;
  worktrees?: SidebarWorktree[];
}

const PROVIDERS = [
  { id: "claude" as const, name: "Claude", mark: "dh-launch-mark--claude" },
  { id: "codex" as const, name: "Codex", mark: "dh-launch-mark--codex" },
];

export function Launchpad({
  runningCount,
  mechanics,
  onMechanicsChange,
  claudeModel,
  codexModel,
  recents,
  onOpenRecent,
  onLaunch,
  onBrowse,
  onOpenCodexHistory,
  worktrees,
}: LaunchpadProps) {
  const [draft, setDraft] = useState("");
  const lastRecent = recents[0] ?? null;

  const launch = () => {
    onLaunch(draft.trim());
    setDraft("");
  };

  return (
    <div className="dh-launchpad" data-dh-launchpad="">
      <div className="dh-launchpad-col">
        <div className="dh-launch-head">
          <div className="dh-launch-orb" aria-hidden />
          <h1 className="dh-launch-title">Start a session</h1>
          <p className="dh-launch-sub">
            Pick an engine, describe the job.
            {runningCount > 0 ? ` ${runningCount} agent${runningCount === 1 ? "" : "s"} already running.` : ""}
          </p>
        </div>

        <div className="dh-launch-providers" role="radiogroup" aria-label="Engine">
          {PROVIDERS.map((p) => {
            const model = p.id === "claude" ? claudeModel : codexModel;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={mechanics === p.id}
                className={cn("dh-launch-provider", mechanics === p.id && "dh-launch-provider--active")}
                onClick={() => onMechanicsChange(p.id)}
              >
                <span className={cn("dh-launch-mark", p.mark)} aria-hidden />
                <span className="dh-launch-provider-name">{p.name}</span>
                {model ? <span className="dh-launch-provider-model">{model}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="dh-launch-composer glass-hi" data-dh-launch-composer="">
          <textarea
            className="dh-launch-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask a question or describe what you need…"
            rows={3}
            aria-label="Task description"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                launch();
              }
            }}
          />
          <div className="dh-launch-composer-bar">
            <span className="dh-launch-hint">⌘↵ to launch</span>
            <button type="button" className="dh-launch-send" onClick={launch}>
              Start chat
              <ArrowUp size={13} strokeWidth={2.5} aria-hidden />
            </button>
          </div>
        </div>

        {worktrees && worktrees.length > 0 ? (
          <div className="dh-launch-worktrees" data-dh-launch-worktrees="">
            {worktrees.map((w) => (
              <span key={w.path} className="dh-launch-wt" title={w.path}>
                {`⎇ ${w.branch ?? "detached"}`}
                {w.isMain ? " · main" : ""}
              </span>
            ))}
          </div>
        ) : null}

        <div className="dh-launch-starters" data-dh-launch-starters="">
          {lastRecent ? (
            <button
              type="button"
              className="dh-launch-starter"
              onClick={() => onOpenRecent(lastRecent.projectId, lastRecent.sessionId)}
            >
              <History size={14} strokeWidth={2} aria-hidden />
              <span className="dh-launch-starter-label">Resume “{lastRecent.title}”</span>
            </button>
          ) : null}
          <button type="button" className="dh-launch-starter" onClick={onOpenCodexHistory}>
            <History size={14} strokeWidth={2} aria-hidden />
            <span className="dh-launch-starter-label">Open Codex history</span>
          </button>
          <button type="button" className="dh-launch-starter" onClick={onBrowse}>
            <Folder size={14} strokeWidth={2} aria-hidden />
            <span className="dh-launch-starter-label">Browse sessions</span>
          </button>
        </div>
      </div>
    </div>
  );
}
