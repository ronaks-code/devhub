import { useMemo, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
import { FileText } from "lucide-react";
import type { PairedToolUse } from "../../lib/transcript";
import { cn } from "../../lib/utils";

/** Pull the file path (and optional offset/limit) out of a Read tool_use input. */
function parseRead(input: unknown): { filePath: string; offset?: number } | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const filePath = typeof o.file_path === "string" ? o.file_path : null;
  if (!filePath) return null;
  return {
    filePath,
    offset: typeof o.offset === "number" ? o.offset : undefined,
  };
}

/** Basename of a path for the compact header line. */
function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/**
 * Map a file extension to a highlight.js language id. Returns undefined for
 * unknown/extension-less files so we fall back to auto-detection (or plain text).
 * Kept small and pragmatic — covers the file types that actually show up in a
 * Claude Code transcript.
 */
function langFromPath(filePath: string): string | undefined {
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
 * The Read tool result is the file's content (possibly with a `cat -n`-style
 * gutter already baked in by Claude Code: "␣␣␣␣42→line"). Strip that prefix so we
 * can render our OWN gutter from the real starting line number — otherwise the
 * numbers would be duplicated. Returns the cleaned text + whether a gutter was
 * detected (which tells us the true first-line number when `offset` is absent).
 */
function stripCatGutter(content: string): { text: string; firstLine: number | null } {
  const lines = content.split("\n");
  // Match the Claude Code transcript gutter: optional leading spaces, a number,
  // then a tab or "→" arrow separator.
  const re = /^\s*(\d+)[\t→]/;
  let firstLine: number | null = null;
  let matched = 0;
  const out: string[] = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) {
      if (firstLine === null) firstLine = Number(m[1]);
      matched++;
      out.push(line.replace(re, ""));
    } else {
      out.push(line);
    }
  }
  // Only treat it as a gutter when most lines matched (avoids stripping content
  // that merely happens to start with a number on a couple of lines).
  if (matched >= Math.max(1, Math.floor(lines.length * 0.6))) {
    return { text: out.join("\n"), firstLine };
  }
  return { text: content, firstLine: null };
}

/** One syntax-highlighted line, rendered as raw hljs HTML. */
interface HlLine {
  /** highlight.js HTML for the line (safe: produced by hljs, not user markup). */
  html: string;
}

/** Highlight the whole blob once, then split into per-line HTML for the gutter. */
function highlightLines(text: string, language?: string): HlLine[] {
  let html: string;
  try {
    if (language && hljs.getLanguage(language)) {
      html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } else {
      html = hljs.highlightAuto(text).value;
    }
  } catch {
    // Fall back to escaped plain text on any hljs error.
    html = escapeHtml(text);
  }
  // highlight.js emits spans that may wrap across newlines; splitting raw HTML on
  // "\n" can break an open <span>. We re-balance per line so each line is
  // independently valid HTML.
  return splitHighlightedHtml(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Split highlight.js output into per-line HTML while keeping spans balanced: when
 * a line ends inside open <span>s we close them, and reopen them at the start of
 * the next line. This is the standard approach for line-numbered hljs output.
 */
function splitHighlightedHtml(html: string): HlLine[] {
  const lines = html.split("\n");
  const out: HlLine[] = [];
  // Stack of currently-open span opening tags (verbatim, to reopen next line).
  const openStack: string[] = [];
  const tagRe = /<span [^>]*>|<\/span>/g;

  for (const line of lines) {
    const prefix = openStack.join("");
    let m: RegExpExecArray | null;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(line)) !== null) {
      if (m[0] === "</span>") openStack.pop();
      else openStack.push(m[0]);
    }
    const suffix = "</span>".repeat(openStack.length);
    out.push({ html: prefix + line + suffix });
  }
  return out;
}

/**
 * Tool-specific renderer for the Read tool_use. Shows the file path as a header
 * and the file content with syntax highlighting + a line-number gutter. The
 * language is inferred from the file extension (auto-detected otherwise), and a
 * `cat -n`-style gutter already in the content is stripped so we don't double up
 * the numbers. Dispatched from MessageView/ToolCard when a tool_use's name is
 * "Read"; falls back to the generic card when the input has no file_path.
 */
export function ReadCard({
  block,
  fallback,
}: {
  block: PairedToolUse;
  /** Generic renderer used when the Read input is unparseable. */
  fallback: () => ReactNode;
}) {
  const parsed = parseRead(block.input);

  const result = block.result;
  const isError = result?.isError ?? false;
  const rawContent = result?.content ?? "";

  // Compute highlighted lines + the starting line number. Memoized on the inputs
  // since highlighting is the expensive part and the transcript can be long.
  const { lines, startLine, language, truncated } = useMemo(() => {
    const lang = parsed ? langFromPath(parsed.filePath) : undefined;
    const { text, firstLine } = stripCatGutter(rawContent);
    // Cap to keep very large reads from bloating the DOM; the result body is
    // already a peek, not the whole file in pathological cases.
    const MAX_LINES = 600;
    const allLines = text.split("\n");
    const trimmed = allLines.length > MAX_LINES;
    const shown = trimmed ? allLines.slice(0, MAX_LINES).join("\n") : text;
    const hl = highlightLines(shown, lang);
    // Prefer the gutter's first line; else the tool input's offset; else 1.
    const start = firstLine ?? (parsed?.offset ? parsed.offset : 1);
    return { lines: hl, startLine: start, language: lang, truncated: trimmed };
  }, [parsed, rawContent]);

  if (!parsed) return <>{fallback()}</>;

  return (
    <details
      className={cn(
        "my-1.5 overflow-hidden rounded-lg border bg-zinc-900/40 open:bg-zinc-900/60",
        isError ? "border-red-900/60" : "border-zinc-800",
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <FileText className="h-3.5 w-3.5 shrink-0 text-sky-400" />
        <span className="shrink-0 text-sky-400">Read</span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-300"
          title={parsed.filePath}
        >
          {basename(parsed.filePath)}
        </code>
        {language ? (
          <span className="shrink-0 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            {language}
          </span>
        ) : null}
        {isError ? (
          <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
            error
          </span>
        ) : null}
      </summary>

      {/* Full path subheader (the summary shows just the basename). */}
      <div
        className="truncate border-t border-zinc-800 px-3 py-1 font-mono text-[10.5px] text-zinc-600"
        title={parsed.filePath}
        dir="rtl"
      >
        {parsed.filePath}
      </div>

      {result ? (
        isError ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-red-900/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-red-300">
            {rawContent || "(error)"}
          </pre>
        ) : (
          <div className="overflow-auto border-t border-zinc-800 hljs-read-body">
            <table className="w-full border-collapse font-mono text-[12px] leading-relaxed">
              <tbody>
                {lines.map((ln, i) => (
                  <tr key={i} className="hover:bg-zinc-800/30">
                    <td className="select-none whitespace-nowrap border-r border-zinc-800/60 px-2 text-right align-top text-[11px] text-zinc-600 tabular-nums">
                      {startLine + i}
                    </td>
                    <td className="hljs w-full whitespace-pre-wrap break-words bg-transparent px-3 align-top text-zinc-200">
                      {/* hljs-produced HTML is trusted; the content text is escaped
                          by highlight.js, so this can't inject user markup. */}
                      <span dangerouslySetInnerHTML={{ __html: ln.html || " " }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {truncated ? (
              <div className="border-t border-zinc-800/60 px-3 py-1.5 text-[11px] text-zinc-600">
                … output truncated (showing first 600 lines)
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </details>
  );
}
