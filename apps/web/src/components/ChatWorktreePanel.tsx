import { useState } from "react";
import { ChevronRight, FolderTree } from "lucide-react";
import { cn } from "../lib/utils";
import { WorktreePanel } from "./WorktreePanel";

/** A compact, lazy worktree drawer shared by both live chat implementations. */
export function ChatWorktreePanel({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-900/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-5 py-2 text-left text-[12px] text-zinc-400 transition hover:bg-zinc-900/40 hover:text-zinc-200"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <FolderTree className="h-3.5 w-3.5 shrink-0 text-clay-400" />
        <span className="font-medium text-zinc-300">Worktrees</span>
      </button>

      {open ? (
        <div className="px-5 pb-3 pt-1">
          <WorktreePanel cwd={cwd} />
        </div>
      ) : null}
    </div>
  );
}
