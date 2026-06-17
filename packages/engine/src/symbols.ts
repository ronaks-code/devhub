/**
 * On-demand code-symbol search within a single project tree.
 *
 * Lightweight by design: there is NO persistent symbol index. Each call walks the
 * project directory, reads small text source files, and regex-scans them for
 * declaration-like lines (function/class/const/let/var/def/type/interface/enum/...).
 * It's a "jump to a definition by name" helper, not a compiler — it never parses an
 * AST, so it can serve any language with a few cheap patterns and stays fast enough
 * to run per-keystroke against a capped budget.
 *
 * Safety:
 *  - The caller (Engine.searchSymbols) is responsible for confirming `cwd` is a known,
 *    allowlisted project cwd before calling in. This module additionally refuses to
 *    follow symlinks out of the tree (it never resolves them) and skips the usual
 *    noise dirs (node_modules/.git/etc.) and obvious binaries.
 *  - Hard caps on files visited, file size read, and matches returned keep a giant
 *    monorepo from turning a search into a filesystem crawl.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

/** One declaration-like match found in the project tree. */
export interface SymbolHit {
  /** The declared identifier (e.g. the function or class name). */
  name: string;
  /** What kind of declaration produced it (function/class/const/type/...). */
  kind: SymbolKind;
  /** Absolute path to the file the match was found in. */
  file: string;
  /** 1-based line number of the match within `file`. */
  line: number;
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let"
  | "var"
  | "def"
  | "method"
  | "struct"
  | "trait"
  | "module";

/** Tunable knobs for one search; all have conservative defaults. */
export interface SymbolSearchOptions {
  /** Max hits returned (1..500; default 50). Scanning stops once this is reached. */
  limit?: number;
  /** Max files visited before giving up the walk (default 4000). */
  maxFiles?: number;
  /** Skip any file larger than this many bytes (default 1 MiB — symbols live in source). */
  maxFileBytes?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Directory names skipped wholesale during the walk: VCS metadata, dependency and
 * build output trees, caches, and editor folders. These never hold the user's own
 * declarations worth jumping to and are where the file count explodes.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "coverage",
  "vendor",
  ".gradle",
  ".terraform",
]);

/**
 * File extensions we even bother to read. Restricting to known source types is the
 * cheap way to skip binaries (images, archives, fonts) without sniffing bytes, and it
 * keeps the patterns below relevant. Extensionless files (Makefile, Dockerfile) are
 * skipped — they rarely carry the declaration shapes we match.
 */
const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".scala",
  ".lua",
  ".dart",
  ".ex",
  ".exs",
  ".sh",
  ".bash",
  ".zsh",
]);

/**
 * Declaration patterns. Each entry maps a regex (with the identifier captured in
 * group 1) to the {@link SymbolKind} it represents. Patterns are intentionally
 * permissive/cross-language — a single line is scanned against all of them and the
 * FIRST match wins (order matters: more specific shapes precede the generic ones).
 *
 * They are deliberately anchored at a word boundary after optional leading keywords
 * (export/public/async/etc.) rather than requiring start-of-line, so an exported or
 * decorated declaration still matches. We do NOT attempt to be exhaustive — false
 * negatives (a missed exotic declaration) are acceptable for a jump-to helper; the
 * patterns favor precision so the result list stays useful.
 */
const PATTERNS: Array<{ kind: SymbolKind; re: RegExp }> = [
  // function foo(...)   /   export async function foo(...)
  { kind: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)/ },
  // class Foo   /   export class Foo extends Bar
  { kind: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)/ },
  // interface Foo (TS)
  { kind: "interface", re: /\binterface\s+([A-Za-z_$][\w$]*)/ },
  // type Foo = ... (TS)
  { kind: "type", re: /\btype\s+([A-Za-z_$][\w$]*)\s*[=<]/ },
  // enum Foo (TS/Java/C#) / Rust+Swift enum
  { kind: "enum", re: /\benum\s+([A-Za-z_$][\w$]*)/ },
  // struct Foo (Go/Rust/Swift/C)
  { kind: "struct", re: /\bstruct\s+([A-Za-z_$][\w$]*)/ },
  // trait Foo (Rust/Scala)
  { kind: "trait", re: /\btrait\s+([A-Za-z_$][\w$]*)/ },
  // def foo (Python/Ruby)
  { kind: "def", re: /\bdef\s+([A-Za-z_$][\w$!?]*)/ },
  // const NAME = (arrow fn or value). Capture only when it looks like a binding,
  // i.e. followed by `=` or `:` so we don't grab `const` used in a comment.
  { kind: "const", re: /\bconst\s+([A-Za-z_$][\w$]*)\s*[=:]/ },
  { kind: "let", re: /\blet\s+([A-Za-z_$][\w$]*)\s*[=:]/ },
  { kind: "var", re: /\bvar\s+([A-Za-z_$][\w$]*)\s*[=:]/ },
  // Go top-level: func Name( / func (recv) Name(
  { kind: "function", re: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/ },
];

/** Quick reject: is this a binary-ish file we should never read? (extension-based) */
function isSourceFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return SOURCE_EXTS.has(ext);
}

/**
 * Scan one source file's lines for declarations whose name CONTAINS the (lower-cased)
 * needle. Stops appending once `remaining` hits are collected. A blank needle matches
 * every declaration (so it works as a "list all symbols in scope" probe). Returns the
 * hits found in this file (already capped to `remaining`).
 */
function scanFileText(text: string, file: string, needle: string, remaining: number): SymbolHit[] {
  const hits: SymbolHit[] = [];
  const lower = needle.toLowerCase();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && hits.length < remaining; i++) {
    const line = lines[i]!;
    // Skip obviously over-long minified lines (one machine-generated blob) cheaply.
    if (line.length > 1000) continue;
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(line);
      if (m && m[1]) {
        const name = m[1];
        if (!lower || name.toLowerCase().includes(lower)) {
          hits.push({ name, kind, file, line: i + 1 });
        }
        break; // first matching pattern wins for this line
      }
    }
  }
  return hits;
}

/**
 * Search a project tree for declaration-like symbols whose name contains `q`.
 *
 * Walks `cwd` breadth-unaware (depth-first), skipping {@link SKIP_DIRS} and
 * non-source files, reading each remaining file (up to `maxFileBytes`) and scanning
 * its lines against {@link PATTERNS}. Stops as soon as `limit` hits are collected or
 * `maxFiles` files have been visited, whichever comes first. Symlinked directories
 * are NOT descended into (we stat without following into other trees) so the walk
 * can't escape the project or loop.
 *
 * Caller MUST have validated that `cwd` is an allowlisted project directory.
 *
 * @returns matches in walk order, capped to `limit`. Best-effort: unreadable files
 *   and directories are silently skipped rather than aborting the search.
 */
export async function searchSymbols(
  cwd: string,
  q: string,
  opts: SymbolSearchOptions = {},
): Promise<SymbolHit[]> {
  const needle = (q ?? "").trim();
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const maxFiles = Math.max(1, opts.maxFiles ?? DEFAULT_MAX_FILES);
  const maxFileBytes = Math.max(1, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);

  const hits: SymbolHit[] = [];
  let filesVisited = 0;

  // Iterative DFS over a stack of directories so a deep tree can't blow the call
  // stack; the budget (`limit`/`maxFiles`) short-circuits the loop early.
  const stack: string[] = [cwd];
  while (stack.length > 0 && hits.length < limit && filesVisited < maxFiles) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir -> skip
    }
    for (const entry of entries) {
      if (hits.length >= limit || filesVisited >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      // Symlinks (to files or dirs) are not followed: ignore anything that isn't a
      // regular file. `isFile()` is false for symlinks in withFileTypes entries.
      if (!entry.isFile()) continue;
      if (!isSourceFile(entry.name)) continue;
      filesVisited++;
      try {
        const st = await stat(full);
        if (st.size > maxFileBytes) continue;
        const text = await readFile(full, "utf8");
        const found = scanFileText(text, full, needle, limit - hits.length);
        for (const h of found) hits.push(h);
      } catch {
        continue; // unreadable/binary file -> skip
      }
    }
  }
  return hits;
}
