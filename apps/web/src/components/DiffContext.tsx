import { useMemo, useState } from "react";
import { ChevronUp, UnfoldVertical } from "lucide-react";
import { LineRow, type DiffLine } from "./DiffView";

/**
 * GitHub-style context collapsing for a parsed unified diff.
 *
 * Plain words: when a diff has a long stretch of lines that DIDN'T change
 * (just sitting there for context), we hide the middle of that stretch behind a
 * "… N unchanged lines" button and keep only a few lines right next to each
 * change. Click the button to expand the hidden middle back in. This makes a big
 * file edit readable — your eye lands on what changed, not on a wall of identical
 * lines.
 *
 * It's purely a VIEW over the same `DiffLine[]` the rest of DiffView renders, so
 * the +/- styling, syntax colors, and word-diff (via `pairedWith`) are unchanged.
 */

/** How many unchanged context lines to keep around each change before collapsing. */
const DEFAULT_CONTEXT = 3;
/**
 * Don't bother collapsing a run unless hiding it actually saves more than this
 * many lines — a 1-line gap behind a button reads worse than just showing it.
 */
const MIN_COLLAPSE = 4;

/** A rendered chunk: either a run of lines, or a collapsed gap of context. */
type Chunk =
  | { kind: "lines"; from: number; to: number }
  | { kind: "gap"; from: number; to: number };

/**
 * Walk the line list and decide which runs of unchanged context to collapse.
 * A line is "near a change" when it's within `context` of any "+"/"-" line; those
 * stay visible. A maximal run of far-from-change context becomes a collapsible
 * gap, but only when it's long enough to be worth hiding (>= MIN_COLLAPSE).
 */
function buildChunks(lines: DiffLine[], context: number): Chunk[] {
  const n = lines.length;
  if (n === 0) return [];

  // Mark every line that must stay visible: all changes, plus `context` lines on
  // each side of a change.
  const keep = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (lines[i]!.sign === " ") continue;
    const lo = Math.max(0, i - context);
    const hi = Math.min(n - 1, i + context);
    for (let j = lo; j <= hi; j++) keep[j] = true;
  }

  const chunks: Chunk[] = [];
  let i = 0;
  while (i < n) {
    if (keep[i]) {
      const from = i;
      while (i < n && keep[i]) i++;
      chunks.push({ kind: "lines", from, to: i });
      continue;
    }
    // A run of collapsible context (none of it near a change).
    const from = i;
    while (i < n && !keep[i]) i++;
    const to = i;
    if (to - from >= MIN_COLLAPSE) {
      chunks.push({ kind: "gap", from, to });
    } else {
      // Too short to be worth hiding — render it inline like normal context.
      chunks.push({ kind: "lines", from, to });
    }
  }
  return chunks;
}

/** The clickable "… N unchanged lines" expander row for a collapsed gap. */
function ExpanderRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="group flex w-full items-center gap-2 bg-zinc-900/40 px-3 py-1 text-left text-[11px] text-zinc-500 transition hover:bg-sky-500/10 hover:text-sky-300"
      title="Expand hidden unchanged lines"
    >
      <UnfoldVertical className="h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-sky-400" />
      <span className="font-mono">
        … {count} unchanged line{count === 1 ? "" : "s"}
      </span>
    </button>
  );
}

/**
 * Render a parsed unified diff with long unchanged runs collapsed. `pairedWith`
 * (when given) is the parallel word-diff pairing array (same indexing as `lines`)
 * threaded straight through to {@link LineRow} so intra-line highlighting still
 * works — collapsing never touches the changed lines that carry pairings.
 */
export function DiffContext({
  lines,
  pairedWith,
  language,
  context = DEFAULT_CONTEXT,
}: {
  lines: DiffLine[];
  /** Parallel array (index → paired counterpart text) for the intra-line word diff. */
  pairedWith?: Array<string | null>;
  /** highlight.js language id for syntax coloring; undefined = plain. */
  language?: string | undefined;
  /** Lines of context to keep around each change before collapsing (default 3). */
  context?: number;
}) {
  const chunks = useMemo(() => buildChunks(lines, context), [lines, context]);
  // Which gaps the user has expanded (keyed by their `from` index, stable per diff).
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  const expand = (from: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(from);
      return next;
    });
  const collapse = (from: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(from);
      return next;
    });

  const renderLines = (from: number, to: number) => {
    const out = [];
    for (let i = from; i < to; i++) {
      out.push(
        <LineRow
          key={i}
          line={lines[i]!}
          pairedWith={pairedWith ? pairedWith[i] ?? null : null}
          language={language}
        />,
      );
    }
    return out;
  };

  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {chunks.map((chunk) => {
        if (chunk.kind === "lines") {
          return <div key={`l${chunk.from}`}>{renderLines(chunk.from, chunk.to)}</div>;
        }
        const count = chunk.to - chunk.from;
        const isOpen = expanded.has(chunk.from);
        return (
          <div key={`g${chunk.from}`}>
            {isOpen ? (
              <>
                <button
                  type="button"
                  onClick={() => collapse(chunk.from)}
                  className="group flex w-full items-center gap-2 bg-zinc-900/40 px-3 py-1 text-left text-[11px] text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-300"
                  title="Collapse these unchanged lines again"
                >
                  <ChevronUp className="h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400" />
                  <span className="font-mono">Hide {count} unchanged line{count === 1 ? "" : "s"}</span>
                </button>
                {renderLines(chunk.from, chunk.to)}
              </>
            ) : (
              <ExpanderRow count={count} onExpand={() => expand(chunk.from)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
