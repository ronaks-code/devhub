import { memo, useMemo, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";

/** One line of a unified diff. " " = unchanged context, "-" = removed, "+" = added. */
export type DiffLine = { sign: " " | "-" | "+"; text: string };

/**
 * A flat run of syntax-colored text: `text` carries the characters, `cls` the
 * highlight.js class to color it (empty = plain). Producing a FLAT stream (rather
 * than nested spans) lets us re-split it at word-diff boundaries so syntax colors
 * and the intra-line +/- background can coexist on the same characters.
 */
type SyntaxSpan = { text: string; cls: string };

/**
 * Map a file extension to a highlight.js language id, mirroring ReadCard's table.
 * Returns undefined for unknown/extension-less files so we skip highlighting
 * entirely (cheaper, and avoids mis-detection on diff fragments).
 */
function langFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    md: "markdown",
    markdown: "markdown",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    xml: "xml",
    sql: "sql",
    diff: "diff",
    dockerfile: "dockerfile",
  };
  return map[ext];
}

/**
 * Highlight ONE line of code into a flat list of syntax spans. We highlight per
 * line (not the whole file) because a diff hunk's removed/added sides aren't
 * contiguous source — feeding them as one blob would mis-color. `ignoreIllegals`
 * keeps a partial line (common in diffs) from throwing. On any failure we return
 * a single plain span so the line still renders (just uncolored).
 *
 * The hljs HTML is parsed into spans via a tiny tag walker: each `<span class>`
 * pushes its class, `</span>` pops, and text between tags becomes a SyntaxSpan
 * carrying the innermost class. hljs escapes its text output, so we unescape the
 * handful of entities it emits to recover the literal characters.
 */
function highlightLine(text: string, language: string | undefined): SyntaxSpan[] {
  if (text === "") return [{ text: "", cls: "" }];
  let html: string;
  try {
    html =
      language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : text; // no language → leave plain (don't pay for auto-detect per line)
  } catch {
    return [{ text, cls: "" }];
  }
  if (html === text) return [{ text, cls: "" }];
  return parseHljsSpans(html);
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parse a single line of highlight.js HTML into a flat list of class-tagged runs. */
function parseHljsSpans(html: string): SyntaxSpan[] {
  const out: SyntaxSpan[] = [];
  const classStack: string[] = [];
  const tagRe = /<span class="([^"]*)">|<\/span>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (raw: string) => {
    if (!raw) return;
    out.push({ text: unescapeHtml(raw), cls: classStack[classStack.length - 1] ?? "" });
  };
  while ((m = tagRe.exec(html)) !== null) {
    pushText(html.slice(last, m.index));
    if (m[0].startsWith("</")) classStack.pop();
    else classStack.push(m[1] ?? "");
    last = tagRe.lastIndex;
  }
  pushText(html.slice(last));
  return out.length ? out : [{ text: unescapeHtml(html), cls: "" }];
}

/**
 * Slice a flat syntax-span stream to the half-open character range [start, end),
 * preserving each covered run's class. Used to color a word-diff part with the
 * syntax classes that fall under it, so syntax + diff highlighting compose.
 */
function sliceSpans(spans: SyntaxSpan[], start: number, end: number): SyntaxSpan[] {
  const out: SyntaxSpan[] = [];
  let pos = 0;
  for (const s of spans) {
    const sStart = pos;
    const sEnd = pos + s.text.length;
    pos = sEnd;
    if (sEnd <= start) continue;
    if (sStart >= end) break;
    const from = Math.max(start, sStart) - sStart;
    const to = Math.min(end, sEnd) - sStart;
    out.push({ text: s.text.slice(from, to), cls: s.cls });
  }
  return out;
}

/** Render a flat syntax-span stream as React nodes (hljs class → color). */
function renderSpans(spans: SyntaxSpan[], keyPrefix: string): ReactNode[] {
  return spans.map((s, i) =>
    s.cls ? (
      <span key={`${keyPrefix}-${i}`} className={s.cls}>
        {s.text}
      </span>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{s.text}</span>
    ),
  );
}

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
 * One side of a rendered line, syntax-highlighted and optionally enriched with a
 * word-level diff. Composition of the two signals:
 *
 *  - The line text is highlighted once into a flat {@link SyntaxSpan} stream so
 *    keywords/strings/etc. get their hljs colors.
 *  - With no word pairing (whole-line change or context), we just render those
 *    syntax spans.
 *  - With a paired counterpart, we walk the word-diff runs over the SAME stream:
 *    each run is sliced out of the syntax spans (so its tokens keep their colors)
 *    and a CHANGED run additionally gets the bright +/- intra-line background.
 *
 * The red/green whole-line background is owned by the row wrapper (LineRow), so
 * this function only adds syntax color + the brighter intra-line emphasis.
 */
function lineContent(line: DiffLine, pairedWith: string | null, language: string | undefined): ReactNode {
  const spans = highlightLine(line.text, language);

  // Context lines, or changed lines with no counterpart: syntax colors only.
  if (pairedWith == null || (line.sign !== "+" && line.sign !== "-")) {
    if (line.text === "") return " ";
    return <>{renderSpans(spans, "s")}</>;
  }

  const oldLine = line.sign === "-" ? line.text : pairedWith;
  const newLine = line.sign === "+" ? line.text : pairedWith;
  const parts = wordDiff(oldLine, newLine, line.sign);
  // No actual intra-line change → fall back to plain syntax-colored line.
  if (!parts.some((p) => p.changed)) {
    if (line.text === "") return " ";
    return <>{renderSpans(spans, "s")}</>;
  }

  // wordDiff returns runs for THIS side in order, so their lengths tile the line;
  // we track the running char offset to slice the matching syntax spans per run.
  const hl = line.sign === "+" ? "bg-emerald-400/25 text-emerald-100" : "bg-red-400/25 text-red-100";
  let offset = 0;
  return (
    <>
      {parts.map((p, i) => {
        const start = offset;
        const end = offset + p.text.length;
        offset = end;
        const inner = renderSpans(sliceSpans(spans, start, end), `p${i}`);
        return p.changed ? (
          <span key={i} className={`rounded-sm ${hl}`}>
            {inner}
          </span>
        ) : (
          <span key={i}>{inner}</span>
        );
      })}
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
  language,
}: {
  line: DiffLine;
  /**
   * The text of this line's counterpart on the other side of the edit, when it
   * was paired (a "-" with its "+"). Drives the intra-line word highlight; null
   * (the default) renders the line as a plain whole-line change.
   */
  pairedWith?: string | null;
  /**
   * highlight.js language id for the file being diffed (from its extension), or
   * undefined to skip syntax coloring. Threaded down so the same DiffLine renders
   * with file-appropriate colors without re-deriving the language per line.
   */
  language?: string | undefined;
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
      {/* `hljs` enables the github-dark token colors (.hljs-keyword/.hljs-string/…)
          on the inner spans. `diff-syntax` (see index.css) neutralizes the hljs
          theme's own base background + text color so the row's red/green tint and
          text color show through — only the syntax TOKEN colors are layered on. */}
      <span className="hljs diff-syntax whitespace-pre-wrap break-words pr-3">
        {lineContent(line, pairedWith, language)}
      </span>
    </div>
  );
}

/** Render an already-parsed unified diff (e.g. a raw git patch) in the same
 *  red/green styling as {@link DiffView}, without the LCS synthesis step.
 *  `filePath` (optional) drives syntax highlighting by extension. */
export const DiffLines = memo(function DiffLines({
  lines,
  filePath,
}: {
  lines: DiffLine[];
  filePath?: string;
}) {
  const paired = pairChangedLines(lines);
  const language = useMemo(() => langFromPath(filePath), [filePath]);
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {lines.map((line, i) => (
        <LineRow key={i} line={line} pairedWith={paired[i]!} language={language} />
      ))}
    </div>
  );
});

/** Red/green unified LCS diff for a parsed file edit, with intra-line word diff
 *  and file-extension syntax highlighting. */
export const DiffView = memo(function DiffView({ edit }: { edit: EditInput }) {
  const language = useMemo(() => langFromPath(edit.filePath), [edit.filePath]);
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {edit.hunks.map((h, i) => {
        const lines = diffHunk(h.oldStr, h.newStr);
        const paired = pairChangedLines(lines);
        return (
          <div key={i} className={i > 0 ? "mt-2 border-t border-zinc-800 pt-2" : ""}>
            {lines.map((line, j) => (
              <LineRow key={j} line={line} pairedWith={paired[j]!} language={language} />
            ))}
          </div>
        );
      })}
    </div>
  );
});
