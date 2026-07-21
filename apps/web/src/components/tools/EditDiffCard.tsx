import { type ReactNode } from "react";
import { FileDiff, Terminal } from "lucide-react";
import type { PairedToolUse } from "../../lib/transcript";
import { DiffView, parseEditInput, countEditLines } from "../DiffView";
import { OpenInEditor } from "../OpenInEditor";
import { ResultBody } from "../ResultBody";
import { ToolStatus } from "../ToolCard";

/**
 * Tool-specific renderer for the file-EDITING tools — Edit, MultiEdit, Write, and
 * NotebookEdit. It reuses {@link parseEditInput} + {@link DiffView} (the same
 * red/green LCS renderer the working-tree diffs use) so a proposed change reads as
 * a real diff with the file path as a prominent header:
 *
 *  - Edit: a single old_string → new_string diff.
 *  - MultiEdit: each edit in `edits` rendered as its own old → new hunk (DiffView
 *    already separates hunks under the one file path).
 *  - Write: the whole file as an additive diff (old side empty); DiffView's
 *    `collapseContext` folds long unchanged/added runs into "… N more" expanders,
 *    so a large file caps gracefully instead of blowing out the transcript.
 *  - NotebookEdit: best-effort cell source old → new (or new) as a single hunk.
 *
 * Dispatched from {@link ToolCard} for those four names; the {@link fallback}
 * (the generic tool card) renders instead when the input shape is unexpected or
 * partial (streaming/partial tool_use), so we never throw on a half-formed input.
 */
export function EditDiffCard({
  block,
  live,
  fallback,
}: {
  block: PairedToolUse;
  /** Live chat (vs. history): drives the running…/spinner status. */
  live: boolean;
  /** Generic renderer used when the edit input can't be parsed. */
  fallback: () => ReactNode;
}) {
  const name = block.name || "tool";
  const edit = parseEditInput(name, block.input);
  // Unexpected/partial shape (e.g. a still-streaming tool_use with no fields yet):
  // degrade to the generic card rather than rendering an empty diff or throwing.
  if (!edit) return <>{fallback()}</>;

  const result = block.result;
  const isError = result?.isError ?? false;
  // The same LCS line totals FileChangeSummary shows, surfaced as a +/- badge in
  // the header so the magnitude of the change reads at a glance before expanding.
  const { added, removed } = countEditLines(edit);

  // Aurora Cockpit §3.3: the diff is NEVER auto-expanded in chat — the header
  // carries the file path + ±line totals, and the hunks stay one click away in the
  // collapsed body (owner explicitly doesn't want diff-forward UI here).
  return (
    <details className="my-1.5 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 open:bg-zinc-900/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-[var(--dh-brand)]" />
        <span className="shrink-0 text-[var(--dh-brand)]">{name}</span>
        {edit.filePath ? (
          <span className="truncate font-mono text-[11px] text-zinc-400" title={edit.filePath}>
            {edit.filePath}
          </span>
        ) : null}
        {/* +/- line totals (same diff the viewer renders). */}
        {added > 0 || removed > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[10.5px] font-medium">
            {added > 0 ? <span className="text-emerald-400">+{added}</span> : null}
            {removed > 0 ? <span className="text-red-400">-{removed}</span> : null}
          </span>
        ) : null}
        {/* Open the edited file in the user's editor (needs an ambient project
            cwd; renders nothing without one). */}
        {edit.filePath ? <OpenInEditor file={edit.filePath} /> : null}
        <ToolStatus result={result} live={live} />
      </summary>
      <div className="border-t border-zinc-800 px-3 py-2">
        <DiffView edit={edit} collapseContext />
      </div>
      {result && (isError || (result.content ?? "").length > 0) ? (
        <details className="border-t border-zinc-800/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500">
            <Terminal className="h-3 w-3" />
            {isError ? "error" : "result"}
          </summary>
          <ResultBody result={result} />
        </details>
      ) : null}
    </details>
  );
}
