import { memo, type ReactNode } from "react";

/** One line of a unified diff. " " = unchanged context, "-" = removed, "+" = added. */
export type DiffLine = { sign: " " | "-" | "+"; text: string };

/**
 * One token of an intra-line word diff. `changed` marks the run as an edit
 * (gets a brighter inline background); unchanged runs render plainly so the
 * eye lands on exactly what differs within a modified line.
 */
type WordPart = { text: string; changed: boolean };

/** Parsed file-edit shape for the tools we special-case. */
export interface EditInput {
  filePath?: string;
  /** Each hunk = one old→new replacement (Edit/MultiEdit) or a whole-file write. */
  hunks: Array<{ oldStr: string; newStr: string }>;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Pull file_path + old/new strings out of an Edit/Write/MultiEdit/NotebookEdit
 * tool input. Returns null when the input doesn't look like a file edit.
 */
export function parseEditInput(toolName: string, input: unknown): EditInput | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const filePath = asString(o.file_path ?? o.filePath ?? o.notebook_path ?? o.notebookPath) || undefined;

  switch (toolName) {
    case "Edit": {
      if (typeof o.old_string !== "string" && typeof o.new_string !== "string") return null;
      return { filePath, hunks: [{ oldStr: asString(o.old_string), newStr: asString(o.new_string) }] };
    }
    case "Write": {
      if (typeof o.content !== "string") return null;
      // A Write replaces the whole file: old side is empty, every line is an addition.
      return { filePath, hunks: [{ oldStr: "", newStr: asString(o.content) }] };
    }
    case "MultiEdit": {
      const edits = Array.isArray(o.edits) ? o.edits : null;
      if (!edits) return null;
      const hunks = edits
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({ oldStr: asString(e.old_string), newStr: asString(e.new_string) }));
      if (hunks.length === 0) return null;
      return { filePath, hunks };
    }
    case "NotebookEdit": {
      // Cell edits: new_source replaces old. Treat as a single hunk.
      if (typeof o.new_source !== "string" && typeof o.new_string !== "string") return null;
      return {
        filePath,
        hunks: [{ oldStr: asString(o.old_source ?? o.old_string), newStr: asString(o.new_source ?? o.new_string) }],
      };
    }
    default:
      return null;
  }
}

/**
 * Split text into lines without inventing a trailing empty line. An empty
 * string yields no lines (nothing to show on that side of a hunk).
 */
function toLines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

/**
 * Classic LCS (longest common subsequence) length matrix over two line arrays.
 * Rows = a.length+1, cols = b.length+1. lcs[i][j] is the LCS length of the
 * suffixes a[i..] and b[j..], so we can walk forward from (0,0) to emit a
 * minimal, in-order diff. This is the dynamic-programming core of a Myers-style
 * line diff — O(n·m) which is fine for the small edits these tools produce.
 */
function lcsMatrix(a: string[], b: string[]): Uint32Array[] {
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  return lcs;
}

/**
 * Split a line into word-ish tokens for the intra-line diff: runs of
 * word-characters, whitespace, and individual punctuation each become a token.
 * Keeping whitespace as its own token means re-indentation reads as a precise
 * change rather than smearing the whole line.
 */
function tokenize(line: string): string[] {
  return line.match(/\s+|\w+|[^\s\w]/g) ?? [];
}

/**
 * Generic LCS length matrix over two token arrays, same shape/semantics as
 * {@link lcsMatrix} but over strings. Kept separate so the line differ's
 * Uint32Array fast path is untouched.
 */
function tokenLcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  return lcs;
}

/**
 * Word-level diff between a removed line and its paired added line. Returns the
 * parts FOR ONE SIDE: `side: "-"` yields the old tokens (common + removed),
 * `side: "+"` yields the new tokens (common + added). Adjacent same-kind tokens
 * are coalesced so a contiguous edit renders as one highlighted run.
 */
function wordDiff(oldLine: string, newLine: string, side: "-" | "+"): WordPart[] {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const lcs = tokenLcs(a, b);
  const parts: WordPart[] = [];
  const push = (text: string, changed: boolean) => {
    const last = parts[parts.length - 1];
    if (last && last.changed === changed) last.text += text;
    else parts.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i]!, false);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      if (side === "-") push(a[i]!, true);
      i++;
    } else {
      if (side === "+") push(b[j]!, true);
      j++;
    }
  }
  while (i < a.length) {
    if (side === "-") push(a[i]!, true);
    i++;
  }
  while (j < b.length) {
    if (side === "+") push(b[j]!, true);
    j++;
  }
  return parts;
}

/**
 * One side of a rendered line, optionally enriched with a word-level diff. When
 * `pairedWith` is given, intra-line edits get a brighter inline background; the
 * unchanged spans stay plain so the precise change reads at a glance.
 */
function lineContent(line: DiffLine, pairedWith: string | null): ReactNode {
  if (pairedWith == null || (line.sign !== "+" && line.sign !== "-")) {
    return line.text || " ";
  }
  const oldLine = line.sign === "-" ? line.text : pairedWith;
  const newLine = line.sign === "+" ? line.text : pairedWith;
  const parts = wordDiff(oldLine, newLine, line.sign);
  if (!parts.some((p) => p.changed)) return line.text || " ";
  const hl = line.sign === "+" ? "bg-emerald-400/25 text-emerald-100" : "bg-red-400/25 text-red-100";
  return (
    <>
      {parts.map((p, i) =>
        p.changed ? (
          <span key={i} className={`rounded-sm ${hl}`}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Pair each changed line with its counterpart on the other side for the
 * intra-line word diff. We pair a maximal run of "-" lines with the immediately
 * following run of "+" lines, matching them by position (the i-th removal with
 * the i-th addition). Returns a parallel array: index → the paired line's text,
 * or null when a line has no counterpart (so it renders as a whole-line change).
 */
function pairChangedLines(lines: DiffLine[]): Array<string | null> {
  const paired = new Array<string | null>(lines.length).fill(null);
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.sign !== "-") {
      i++;
      continue;
    }
    let dEnd = i;
    while (dEnd < lines.length && lines[dEnd]!.sign === "-") dEnd++;
    let aEnd = dEnd;
    while (aEnd < lines.length && lines[aEnd]!.sign === "+") aEnd++;
    const dels = dEnd - i;
    const adds = aEnd - dEnd;
    const n = Math.min(dels, adds);
    for (let k = 0; k < n; k++) {
      paired[i + k] = lines[dEnd + k]!.text; // removed line ← its paired added line
      paired[dEnd + k] = lines[i + k]!.text; // added line ← its paired removed line
    }
    i = aEnd > dEnd ? aEnd : dEnd;
  }
  return paired;
}

/**
 * Diff one old→new replacement into a unified line list. Unchanged lines appear
 * exactly once (sign " "); only lines that truly differ are marked "-" / "+".
 * Walks the LCS matrix from the front so output order matches the source.
 */
function diffHunk(oldStr: string, newStr: string): DiffLine[] {
  const a = toLines(oldStr);
  const b = toLines(newStr);
  // Fast paths: a pure add (Write / new content) or a pure delete needs no matrix.
  if (a.length === 0) return b.map((text) => ({ sign: "+", text }));
  if (b.length === 0) return a.map((text) => ({ sign: "-", text }));

  const lcs = lcsMatrix(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ sign: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      // Dropping a[i] keeps the longer common subsequence → it's a removal.
      out.push({ sign: "-", text: a[i]! });
      i++;
    } else {
      out.push({ sign: "+", text: b[j]! });
      j++;
    }
  }
  // Drain whatever's left on either side (trailing removals / additions).
  while (i < a.length) out.push({ sign: "-", text: a[i++]! });
  while (j < b.length) out.push({ sign: "+", text: b[j++]! });
  return out;
}

/**
 * Count added/removed lines across all hunks of a parsed edit, using the same
 * LCS line diff the viewer renders — so the +/- totals in FileChangeSummary match
 * exactly what DiffView shows. Context lines (sign " ") aren't counted.
 */
export function countEditLines(edit: EditInput): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of edit.hunks) {
    for (const line of diffHunk(h.oldStr, h.newStr)) {
      if (line.sign === "+") added++;
      else if (line.sign === "-") removed++;
    }
  }
  return { added, removed };
}

export function LineRow({
  line,
  pairedWith = null,
}: {
  line: DiffLine;
  /**
   * The text of this line's counterpart on the other side of the edit, when it
   * was paired (a "-" with its "+"). Drives the intra-line word highlight; null
   * (the default) renders the line as a plain whole-line change.
   */
  pairedWith?: string | null;
}) {
  const bg =
    line.sign === "+"
      ? "bg-emerald-500/10 text-emerald-200"
      : line.sign === "-"
        ? "bg-red-500/10 text-red-200"
        : "text-zinc-400";
  const marker =
    line.sign === "+" ? "text-emerald-500" : line.sign === "-" ? "text-red-500" : "text-zinc-700";
  return (
    <div className={`flex ${bg}`}>
      <span className={`w-4 shrink-0 select-none text-center ${marker}`}>{line.sign}</span>
      <span className="whitespace-pre-wrap break-words pr-3">{lineContent(line, pairedWith)}</span>
    </div>
  );
}

/** Render an already-parsed unified diff (e.g. a raw git patch) in the same
 *  red/green styling as {@link DiffView}, without the LCS synthesis step. */
export const DiffLines = memo(function DiffLines({ lines }: { lines: DiffLine[] }) {
  const paired = pairChangedLines(lines);
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {lines.map((line, i) => (
        <LineRow key={i} line={line} pairedWith={paired[i]!} />
      ))}
    </div>
  );
});

/** Red/green unified LCS diff for a parsed file edit, with intra-line word diff. */
export const DiffView = memo(function DiffView({ edit }: { edit: EditInput }) {
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {edit.hunks.map((h, i) => {
        const lines = diffHunk(h.oldStr, h.newStr);
        const paired = pairChangedLines(lines);
        return (
          <div key={i} className={i > 0 ? "mt-2 border-t border-zinc-800 pt-2" : ""}>
            {lines.map((line, j) => (
              <LineRow key={j} line={line} pairedWith={paired[j]!} />
            ))}
          </div>
        );
      })}
    </div>
  );
});
