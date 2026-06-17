import { useMemo, type ReactNode } from "react";
import { FolderSearch, Search } from "lucide-react";
import type { PairedToolUse } from "../../lib/transcript";
import { cn } from "../../lib/utils";

/** The fields a Grep/Glob tool_use carries that we surface compactly. */
interface ParsedSearch {
  /** Search pattern (Grep regex) or glob (Glob), required for either tool. */
  pattern: string;
  /** Directory the search ran in (Grep `path` / Glob `path`), when given. */
  path?: string;
  /** Grep-only glob filter, e.g. "*.ts" (Grep `glob`). */
  glob?: string;
  /** Grep-only file-type filter, e.g. "ts" (Grep `type`). */
  type?: string;
  /** Grep-only output mode ("content" | "files_with_matches" | "count"). */
  outputMode?: string;
}

/**
 * Pull the search fields out of a Grep or Glob tool_use input. Grep uses
 * `pattern` (+ optional path/glob/type/output_mode); Glob uses `pattern` for the
 * glob itself (+ optional path). Returns null when there's no pattern to show, so
 * the caller can fall back to the generic card.
 */
function parseSearch(input: unknown): ParsedSearch | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const pattern = typeof o.pattern === "string" ? o.pattern : null;
  if (!pattern) return null;
  return {
    pattern,
    path: typeof o.path === "string" ? o.path : undefined,
    glob: typeof o.glob === "string" ? o.glob : undefined,
    type: typeof o.type === "string" ? o.type : undefined,
    outputMode: typeof o.output_mode === "string" ? o.output_mode : undefined,
  };
}

/**
 * Summarize the result body into a count + the matched lines/files to render.
 * Grep/Glob results are newline-separated text (file paths, "path:line:match"
 * rows, or a bare count). We cap how many rows we render to keep the DOM small.
 */
function summarizeResult(content: string): { count: number; rows: string[]; truncated: boolean } {
  const trimmed = content.trim();
  if (!trimmed) return { count: 0, rows: [], truncated: false };
  const all = trimmed.split("\n").filter((l) => l.length > 0);
  const MAX_ROWS = 50;
  return {
    count: all.length,
    rows: all.slice(0, MAX_ROWS),
    truncated: all.length > MAX_ROWS,
  };
}

/** A small labeled filter chip (path / glob / type / mode) for the subheader. */
function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-zinc-400">
      <span className="text-zinc-600">{label}</span>
      <span className="font-mono text-zinc-300">{value}</span>
    </span>
  );
}

/**
 * Tool-specific renderer for the Grep AND Glob tool_use. Shows the search
 * pattern in a monospace header, the path + any filters (glob/type/mode) as
 * chips, and the matched files/lines compactly with a match count. Dispatched
 * from MessageView/ToolCard when a tool_use's name is "Grep" or "Glob"; falls
 * back to the generic card when the input has no pattern.
 *
 * Plain words: instead of a wall of raw JSON, this shows "you searched for X in
 * folder Y and here are the N files/lines that matched."
 */
export function GrepCard({
  block,
  fallback,
}: {
  block: PairedToolUse;
  /** Generic renderer used when the input has no pattern. */
  fallback: () => ReactNode;
}) {
  const parsed = parseSearch(block.input);

  const result = block.result;
  const isError = result?.isError ?? false;
  const rawContent = result?.content ?? "";

  const summary = useMemo(() => summarizeResult(rawContent), [rawContent]);

  if (!parsed) return <>{fallback()}</>;

  const isGlob = (block.name || "") === "Glob";
  const Icon = isGlob ? FolderSearch : Search;
  const tone = isGlob ? "text-violet-400" : "text-amber-400";
  const label = isGlob ? "Glob" : "Grep";
  // Glob matches are files; Grep's depend on the output mode (default "content"
  // = matching lines). Keep the noun honest for the count line, with its plural.
  const matchesFiles = isGlob || parsed.outputMode === "files_with_matches";
  const countLabel = (n: number) =>
    matchesFiles ? `${n} file${n === 1 ? "" : "s"}` : `${n} match${n === 1 ? "" : "es"}`;

  return (
    <details
      className={cn(
        "my-1.5 overflow-hidden rounded-lg border bg-zinc-900/40 open:bg-zinc-900/60",
        isError ? "border-red-900/60" : "border-zinc-800",
      )}
      open
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
        <span className={cn("shrink-0", tone)}>{label}</span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-300"
          title={parsed.pattern}
        >
          {parsed.pattern}
        </code>
        {result ? (
          isError ? (
            <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              error
            </span>
          ) : (
            <span className="shrink-0 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-400">
              {countLabel(summary.count)}
            </span>
          )
        ) : null}
      </summary>

      {/* Filters subheader — path, and (Grep only) glob/type/output mode. */}
      {parsed.path || parsed.glob || parsed.type || parsed.outputMode ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-800 px-3 py-1.5">
          {parsed.path ? <FilterChip label="in" value={parsed.path} /> : null}
          {parsed.glob ? <FilterChip label="glob" value={parsed.glob} /> : null}
          {parsed.type ? <FilterChip label="type" value={parsed.type} /> : null}
          {parsed.outputMode ? <FilterChip label="mode" value={parsed.outputMode} /> : null}
        </div>
      ) : null}

      {/* Matched files / lines, or an empty / error state. */}
      {result ? (
        isError ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-red-900/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-red-300">
            {rawContent || "(error)"}
          </pre>
        ) : summary.count === 0 ? (
          <div className="border-t border-zinc-800 px-3 py-2 text-[11.5px] text-zinc-600">
            No matches.
          </div>
        ) : (
          <div className="overflow-auto border-t border-zinc-800">
            <ul className="divide-y divide-zinc-800/40 font-mono text-[11.5px] leading-relaxed">
              {summary.rows.map((row, i) => (
                <li
                  key={i}
                  className="truncate px-3 py-0.5 text-zinc-300 hover:bg-zinc-800/30"
                  title={row}
                >
                  {row}
                </li>
              ))}
            </ul>
            {summary.truncated ? (
              <div className="border-t border-zinc-800/60 px-3 py-1.5 text-[11px] text-zinc-600">
                … {summary.count - summary.rows.length} more (showing first {summary.rows.length})
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </details>
  );
}
