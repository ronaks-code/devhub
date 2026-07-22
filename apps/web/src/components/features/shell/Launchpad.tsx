import { useState } from "react";
import { ArrowUp, Folder, History, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecentSession } from "../../../hooks/useRecentSessions";
import type { SidebarWorktree } from "./Sidebar.js";

/**
 * Launchpad — the new-session empty state (§3.3b), shown for a `+` tab or an empty
 * chat route. Every element maps to a REAL source; anything absent (recents,
 * worktrees, per-provider spend) simply doesn't render — no invented "median turn"
 * style stats. The two provider cards are a radio group: each shows its engine, a
 * model select (when we have real options for it), and a brief live spend stat
 * (only when a real, non-zero figure exists).
 */
export interface LaunchpadProps {
  /** Live count of running agents (from api.running()). */
  runningCount: number;
  mechanics: "claude" | "codex";
  onMechanicsChange: (m: "claude" | "codex") => void;
  /** Model label per engine, when known (settings.defaultModel). */
  claudeModel?: string;
  codexModel?: string;
  /** Real model options for the Claude card's select (the app's known model list). */
  claudeModels?: string[];
  /** Persist a chosen Claude model (settings.defaultModel). */
  onClaudeModelChange?: (m: string) => void;
  /**
   * REAL per-provider spend to date (aggregated from stats.byModel). Rendered only
   * when > 0 — an absent/zero figure is omitted, never shown as a fabricated $0.
   */
  claudeSpend?: number;
  codexSpend?: number;
  recents: RecentSession[];
  onOpenRecent: (projectId: string, sessionId: string) => void;
  onLaunch: (draft: string) => void;
  onBrowse: () => void;
  onOpenCodexHistory: () => void;
  /**
   * Hand the most recent session to the other provider for a second opinion
   * (existing cross-provider fork flow). Omitted → the starter doesn't render.
   */
  onSecondOpinion?: () => void;
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
  claudeModels,
  onClaudeModelChange,
  claudeSpend,
  codexSpend,
  recents,
  onOpenRecent,
  onLaunch,
  onBrowse,
  onOpenCodexHistory,
  onSecondOpinion,
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
            const active = mechanics === p.id;
            const model = p.id === "claude" ? claudeModel : codexModel;
            const spend = p.id === "claude" ? claudeSpend : codexSpend;
            const hasModelSelect =
              p.id === "claude" && claudeModels != null && claudeModels.length > 0;
            return (
              // A div (not a button) so it can host a real <select>; radio semantics
              // are provided explicitly. Selecting a model stops propagation so it
              // never doubles as a card toggle.
              <div
                key={p.id}
                role="radio"
                aria-checked={active}
                tabIndex={0}
                className={cn("dh-launch-provider", active && "dh-launch-provider--active")}
                onClick={() => onMechanicsChange(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onMechanicsChange(p.id);
                  }
                }}
              >
                <div className="dh-launch-provider-head">
                  <span className={cn("dh-launch-mark", p.mark)} aria-hidden />
                  <span className="dh-launch-provider-name">{p.name}</span>
                </div>
                {hasModelSelect ? (
                  <select
                    className="dh-launch-model-select"
                    value={claudeModel ?? claudeModels![0]}
                    aria-label="Claude model"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      onMechanicsChange(p.id);
                      onClaudeModelChange?.(e.target.value);
                    }}
                  >
                    {claudeModels!.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : model ? (
                  <span className="dh-launch-provider-model">{model}</span>
                ) : null}
                {typeof spend === "number" && spend > 0 ? (
                  <span className="dh-launch-provider-stat" data-dh-launch-stat="">
                    ${spend.toFixed(2)} spent to date
                  </span>
                ) : null}
              </div>
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
            <span className="dh-launch-hint">⌘↵ to launch · ⌘K to search</span>
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
          {lastRecent && onSecondOpinion ? (
            <button
              type="button"
              className="dh-launch-starter"
              onClick={onSecondOpinion}
            >
              <Sparkles size={14} strokeWidth={2} aria-hidden />
              <span className="dh-launch-starter-label">
                Second opinion: hand “{lastRecent.title}” to Codex
              </span>
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
