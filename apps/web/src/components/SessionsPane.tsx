import { useMemo, useState } from "react";
import { Search, Pin, Pencil, MessageSquare, Coins, GitBranch, Check, X } from "lucide-react";
import type { ProjectSummary, SessionSummary } from "../lib/types";
import { cn } from "../lib/utils";
import { compactNumber, relativeTime, totalTokens } from "../lib/format";
import { IconButton } from "./ui";

export function SessionsPane({
  project,
  sessions,
  selectedId,
  onSelect,
  onRename,
  onTogglePin,
}: {
  project: ProjectSummary | null;
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string | null) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return sessions;
    return sessions.filter((x) => x.title.toLowerCase().includes(s));
  }, [sessions, q]);

  function startEdit(s: SessionSummary) {
    setEditingId(s.sessionId);
    setDraft(s.title);
  }
  function commit(s: SessionSummary) {
    const t = draft.trim();
    onRename(s.sessionId, t.length ? t : null);
    setEditingId(null);
  }

  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950">
      <div className="px-4 pb-2 pt-3">
        <h2 className="truncate text-sm font-semibold text-zinc-200">
          {project ? project.name : "Sessions"}
        </h2>
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
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {filtered.map((s) => {
          const active = s.sessionId === selectedId;
          const editing = s.sessionId === editingId;
          return (
            <div
              key={s.sessionId}
              className={cn(
                "group mb-0.5 rounded-lg px-2.5 py-2 transition",
                active ? "bg-clay-500/10 ring-1 ring-clay-500/30" : "hover:bg-zinc-900",
              )}
            >
              <div className="flex items-start gap-1.5">
                <IconButton
                  className={cn(
                    "-ml-1 mt-0.5 p-1",
                    s.pinned ? "text-clay-400 hover:text-clay-300" : "opacity-0 group-hover:opacity-100",
                  )}
                  title={s.pinned ? "Unpin" : "Pin"}
                  onClick={() => onTogglePin(s.sessionId, !s.pinned)}
                >
                  <Pin className={cn("h-3.5 w-3.5", s.pinned && "fill-current")} />
                </IconButton>

                {editing ? (
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
                ) : (
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
                        {s.title}
                      </span>
                      {s.titleSource === "custom" && (
                        <span className="text-[9px] text-zinc-600">renamed</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2.5 text-[10.5px] text-zinc-600">
                      <span>{relativeTime(s.lastTimestamp)}</span>
                      <span className="flex items-center gap-0.5">
                        <MessageSquare className="h-3 w-3" />
                        {s.messageCount}
                      </span>
                      {totalTokens(s.usage) > 0 && (
                        <span className="flex items-center gap-0.5">
                          <Coins className="h-3 w-3" />
                          {compactNumber(totalTokens(s.usage))}
                        </span>
                      )}
                      {s.gitBranch ? (
                        <span className="flex items-center gap-0.5 truncate">
                          <GitBranch className="h-3 w-3" />
                          {s.gitBranch}
                        </span>
                      ) : null}
                    </div>
                  </button>
                )}

                {!editing && (
                  <IconButton
                    className="p-1 opacity-0 group-hover:opacity-100"
                    title="Rename"
                    onClick={() => startEdit(s)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </div>
            </div>
          );
        })}
        {project && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">No sessions</div>
        )}
        {!project && (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">Select a project</div>
        )}
      </div>
    </div>
  );
}
