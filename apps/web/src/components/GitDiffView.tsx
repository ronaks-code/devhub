import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { GitDiff } from "../lib/types";
import { DiffLines, type DiffLine } from "./DiffView";
import { Spinner } from "./ui";

/** A parsed hunk: its `@@ … @@` header plus the body lines that follow. */
interface Hunk {
  header: string;
  lines: DiffLine[];
}

/**
 * Parse a raw unified-diff patch (git's `diff` output) into hunks. We drop the
 * file-level header noise (`diff --git`, `index …`, `--- a/…`, `+++ b/…`) and
 * keep each `@@ … @@` hunk with its body, mapping the leading +/-/space to a
 * {@link DiffLine} sign so it renders in the shared red/green style.
 *
 * "\ No newline at end of file" markers are kept as context lines (sign " ")
 * so the absence of a trailing newline is still visible.
 */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  // split on \n; a CRLF patch keeps a trailing \r which we trim per line.
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current == null) continue; // pre-hunk header lines (diff --git, index, ---, +++)
    if (line.startsWith("+")) current.lines.push({ sign: "+", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ sign: "-", text: line.slice(1) });
    else if (line.startsWith(" ")) current.lines.push({ sign: " ", text: line.slice(1) });
    else if (line.startsWith("\\")) current.lines.push({ sign: " ", text: line });
    else if (line.length > 0) current.lines.push({ sign: " ", text: line });
  }
  return hunks;
}

/**
 * Fetches and renders a REAL git diff for one changed file in a project's
 * working tree (GET /api/git/diff?cwd=&file=). Reuses the DiffView line
 * renderer so working-tree changes look identical to the per-tool edit diffs.
 *
 * Lazily fetched: a parent (GitPanel) mounts this only when the file row is
 * expanded, so an unexpanded list never pays the `git diff` cost.
 */
export function GitDiffView({ cwd, file }: { cwd: string; file: string }) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  // Guards a stale response from overwriting a newer fetch when cwd/file change.
  const reqRef = useRef(0);

  useEffect(() => {
    const req = ++reqRef.current;
    setState("loading");
    api
      .gitDiff(cwd, file)
      .then((d) => {
        if (reqRef.current !== req) return;
        setDiff(d);
        setState("done");
      })
      .catch(() => {
        if (reqRef.current !== req) return;
        setState("error");
      });
  }, [cwd, file]);

  const hunks = useMemo(() => (diff?.patch ? parsePatch(diff.patch) : []), [diff?.patch]);

  if (state === "loading") {
    return (
      <div className="flex items-center gap-2 py-2 pl-6 text-[11px] text-zinc-600">
        <Spinner className="h-3 w-3" />
        Loading diff…
      </div>
    );
  }
  if (state === "error") {
    return <div className="py-2 pl-6 text-[11px] text-red-400">Could not load diff.</div>;
  }
  if (hunks.length === 0) {
    // No textual hunks: binary file, mode-only change, or an empty patch.
    return (
      <div className="py-2 pl-6 text-[11px] text-zinc-600">
        No textual changes to show (binary or mode-only change).
      </div>
    );
  }

  return (
    <div className="mt-1 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950/60">
      {hunks.map((h, i) => (
        <div key={i} className={i > 0 ? "border-t border-zinc-800" : ""}>
          <div className="bg-zinc-900/60 px-2 py-0.5 font-mono text-[11px] text-clay-300/80">
            {h.header}
          </div>
          <DiffLines lines={h.lines} />
        </div>
      ))}
    </div>
  );
}
