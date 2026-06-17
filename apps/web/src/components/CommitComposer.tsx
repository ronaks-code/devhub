import { useState } from "react";
import { GitCommitHorizontal, Plus, Sparkles, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import type { GitStatus } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * A compact commit UI for the GitPanel: lists the files that will be committed,
 * a message textarea, a "Suggest" button (asks the server to draft a message),
 * and a "Commit" button (POSTs {all:true} so tracked changes are staged + committed
 * in one step). On a successful commit it clears the message and calls `onCommitted`
 * so the host can refresh git status.
 *
 * All git writes happen server-side via GitService; this component only POSTs the
 * intent through the api.git* helpers. Errors (including a missing endpoint, since
 * the routes live in the server package) surface inline rather than throwing.
 */
export function CommitComposer({
  cwd,
  status,
  onCommitted,
  message: controlledMessage,
  onMessageChange,
}: {
  cwd: string;
  status: GitStatus;
  onCommitted: () => void;
  /**
   * Optional controlled commit message. When provided (with onMessageChange),
   * the textarea is driven by the host so a sibling control (GitSync's
   * "Commit & Push") can read/commit the same draft. Uncontrolled otherwise.
   */
  message?: string;
  onMessageChange?: (message: string) => void;
}) {
  const [localMessage, setLocalMessage] = useState("");
  const message = controlledMessage ?? localMessage;
  const setMessage = (m: string) => {
    if (onMessageChange) onMessageChange(m);
    else setLocalMessage(m);
  };
  const [suggesting, setSuggesting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okNote, setOkNote] = useState<string | null>(null);

  // Files that a {all:true} commit will include: staged + tracked-but-unstaged.
  // Untracked files aren't picked up by `git add -u`, so we surface them as a hint
  // rather than implying they'll be committed.
  const willCommit = [...status.staged, ...status.unstaged];
  const dedupedWillCommit = Array.from(new Set(willCommit));
  const nothingToCommit = dedupedWillCommit.length === 0;

  const suggest = async () => {
    setError(null);
    setOkNote(null);
    setSuggesting(true);
    try {
      const res = await api.gitSuggestMessage(cwd);
      if (res.message) setMessage(res.message);
      else setError("No message suggested.");
    } catch {
      setError("Couldn't suggest a message.");
    } finally {
      setSuggesting(false);
    }
  };

  const commit = async () => {
    const msg = message.trim();
    if (!msg || committing) return;
    setError(null);
    setOkNote(null);
    setCommitting(true);
    try {
      const res = await api.gitCommit(cwd, msg, true);
      if (res.ok) {
        setMessage("");
        // Engine returns the full 40-char HEAD hash; show a short prefix.
        setOkNote(res.hash ? `Committed ${res.hash.slice(0, 7)}` : "Committed");
        onCommitted();
      } else {
        setError(res.error || "Nothing was committed.");
      }
    } catch {
      setError("Commit failed.");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/30 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-zinc-600">
        <GitCommitHorizontal className="h-3 w-3" />
        Commit
        {dedupedWillCommit.length > 0 ? (
          <span className="font-normal normal-case tracking-normal text-zinc-500">
            · {dedupedWillCommit.length} file{dedupedWillCommit.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {dedupedWillCommit.length > 0 ? (
        <ul className="mb-2 max-h-28 space-y-0.5 overflow-y-auto pr-1">
          {dedupedWillCommit.map((f) => (
            <li key={f} className="flex items-center gap-1.5 text-[11.5px] text-zinc-400">
              <Plus className="h-3 w-3 shrink-0 text-emerald-400/80" />
              <span className="truncate font-mono" title={f}>
                {f}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mb-2 text-[11px] text-zinc-600">
          {status.untracked.length > 0
            ? "Only untracked files — stage them in your editor/terminal to commit here."
            : "No tracked changes to commit."}
        </div>
      )}

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        placeholder="Commit message…"
        className="max-h-40 min-h-[3rem] w-full resize-y rounded-md bg-zinc-900 px-2 py-1.5 text-[12px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
      />

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={suggest}
          disabled={suggesting || committing || nothingToCommit}
          title="Draft a commit message from the diff"
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-700 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-40"
        >
          {suggesting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Suggest
        </button>

        {error ? <span className="min-w-0 truncate text-[11px] text-red-400">{error}</span> : null}
        {okNote ? <span className="min-w-0 truncate text-[11px] text-emerald-400">{okNote}</span> : null}

        <button
          onClick={commit}
          disabled={!message.trim() || committing || suggesting || nothingToCommit}
          title="Commit tracked changes"
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium text-white transition",
            "bg-clay-500 hover:bg-clay-600 disabled:bg-zinc-800 disabled:text-zinc-600",
          )}
        >
          {committing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitCommitHorizontal className="h-3.5 w-3.5" />
          )}
          Commit
        </button>
      </div>
    </div>
  );
}
