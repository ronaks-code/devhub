import { useMemo } from "react";
import { FileDiff } from "lucide-react";
import type { NormalizedMessage } from "../lib/types";
import { parseEditInput, countEditLines } from "./DiffView";
import { OpenInEditor } from "./OpenInEditor";
import { cn } from "../lib/utils";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** One file's aggregated change across the transcript. */
interface FileChange {
  filePath: string;
  added: number;
  removed: number;
  /** How many edit tool_uses touched it. */
  edits: number;
  /** Virtualizer index of the FIRST message that edits it (the jump target). */
  firstIndex: number;
}

/** Shorten an absolute path for the rail: keep the last 2 segments. */
function shortPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 2) return filePath;
  return ".../" + parts.slice(-2).join("/");
}

/**
 * Walk the (paired) transcript messages, aggregating every Edit/Write/MultiEdit/
 * NotebookEdit tool_use by file path into +/- line totals (counted with the same
 * LCS diff the viewer renders). Exported for testing/reuse; memoize at call sites.
 */
export function buildFileChanges(messages: NormalizedMessage[]): FileChange[] {
  const byFile = new Map<string, FileChange>();
  messages.forEach((m, index) => {
    if (m.role !== "assistant") return;
    for (const b of m.blocks) {
      if (b.type !== "tool_use" || !EDIT_TOOLS.has(b.name)) continue;
      const edit = parseEditInput(b.name, b.input);
      if (!edit?.filePath) continue;
      const { added, removed } = countEditLines(edit);
      const existing = byFile.get(edit.filePath);
      if (existing) {
        existing.added += added;
        existing.removed += removed;
        existing.edits += 1;
      } else {
        byFile.set(edit.filePath, {
          filePath: edit.filePath,
          added,
          removed,
          edits: 1,
          firstIndex: index,
        });
      }
    }
  });
  // Most-changed first (added + removed), then by path for stability.
  return [...byFile.values()].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || a.filePath.localeCompare(b.filePath),
  );
}

/**
 * "What changed" panel for the open transcript: lists every file touched by an
 * Edit/Write/MultiEdit/NotebookEdit with its +/- line totals. Clicking a row
 * scrolls the transcript to the first tool card that edits that file (via
 * `onJump`, wired to virtualizer.scrollToIndex in TranscriptPane).
 *
 * Rendered as a side-rail (mirroring TranscriptOutline) when toggled on from the
 * transcript header.
 */
export function FileChangeSummary({
  messages,
  onJump,
  onClose,
}: {
  messages: NormalizedMessage[];
  onJump: (index: number) => void;
  onClose: () => void;
}) {
  const changes = useMemo(() => buildFileChanges(messages), [messages]);
  const totals = useMemo(
    () =>
      changes.reduce(
        (acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }),
        { added: 0, removed: 0 },
      ),
    [changes],
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <FileDiff className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-[12px] font-semibold text-zinc-300">Changes</span>
        <span className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {changes.length}
        </span>
        {changes.length > 0 ? (
          <span className="ml-1 inline-flex items-center gap-1.5 text-[10.5px] font-medium">
            <span className="text-emerald-400">+{totals.added}</span>
            <span className="text-red-400">-{totals.removed}</span>
          </span>
        ) : null}
        <button
          onClick={onClose}
          className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          title="Hide changes"
        >
          Hide
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {changes.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-zinc-600">
            No file edits in this transcript yet.
          </div>
        ) : (
          <ul>
            {changes.map((c) => (
              <li key={c.filePath} className="group/row">
                <div className="flex items-start gap-1 px-3 py-1.5 transition hover:bg-zinc-900">
                  <button
                    onClick={() => onJump(c.firstIndex)}
                    className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                    title={c.filePath}
                  >
                    <span className="truncate font-mono text-[12px] text-zinc-300" dir="rtl">
                      {shortPath(c.filePath)}
                    </span>
                    <span className="flex items-center gap-2 text-[10.5px] font-medium">
                      <span className="text-emerald-400">+{c.added}</span>
                      <span className="text-red-400">-{c.removed}</span>
                      {c.edits > 1 ? (
                        <span className={cn("text-zinc-600")}>· {c.edits} edits</span>
                      ) : null}
                    </span>
                  </button>
                  {/* Open in editor — revealed on row hover; renders nothing
                      without an ambient project cwd. */}
                  <span className="mt-0.5 shrink-0 opacity-0 transition group-hover/row:opacity-100">
                    <OpenInEditor file={c.filePath} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
