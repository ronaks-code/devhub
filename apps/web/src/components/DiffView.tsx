import { memo } from "react";

/** One line of a unified diff. " " = unchanged context, "-" = removed, "+" = added. */
type DiffLine = { sign: " " | "-" | "+"; text: string };

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

function LineRow({ line }: { line: DiffLine }) {
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
      <span className="whitespace-pre-wrap break-words pr-3">{line.text || " "}</span>
    </div>
  );
}

/** Red/green unified LCS diff for a parsed file edit. */
export const DiffView = memo(function DiffView({ edit }: { edit: EditInput }) {
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {edit.hunks.map((h, i) => (
        <div key={i} className={i > 0 ? "mt-2 border-t border-zinc-800 pt-2" : ""}>
          {diffHunk(h.oldStr, h.newStr).map((line, j) => (
            <LineRow key={j} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
});
