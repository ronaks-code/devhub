/**
 * Inline filter-token parsing for search queries.
 *
 * Lets a user fold facet filters straight into the search box, e.g.:
 *
 *     tool:Bash role:assistant after:2026-01-01 before:2026-02-01 model:opus free text
 *
 * parses to:
 *
 *     { text: "free text",
 *       facets: { toolName: "Bash", role: "assistant",
 *                 since: "2026-01-01", until: "2026-02-01", modelLike: "opus" } }
 *
 * Recognized `key:value` tokens are STRIPPED out of the query and mapped onto
 * {@link SearchFacets}; everything else is left verbatim in `text` so the existing
 * FTS5/LIKE backends parse it unchanged (phrases, `prefix*`, `-exclusion` all
 * survive). A plain query with no recognized tokens round-trips to `{ text, facets:{} }`.
 *
 * This is integrated into `engine.search` (via `TranscriptIndex.search` ->
 * `MessageSearch.search`), so `/api/search` and the SearchPalette gain the syntax
 * for free. Facets passed PROGRAMMATICALLY by a caller take precedence over a token
 * the user typed, so a UI that pins `projectId` can't be overridden by free text.
 */
import type { SearchFacets } from "./search.js";

/** A parsed query split into its free-text remainder and the facets lifted from tokens. */
export interface ParsedQuery {
  /** The query with all recognized `key:value` tokens removed (trimmed, collapsed). */
  text: string;
  /** Facets extracted from recognized tokens. Empty object when none were present. */
  facets: SearchFacets;
}

/**
 * Recognized token keys (and their aliases) -> a setter onto the facets object.
 *
 * Date facets accept `after:`/`since:` and `before:`/`until:` as ergonomic aliases.
 * `model:` sets `modelLike` (a forgiving substring match) so `model:opus` matches a
 * stored id like `claude-opus-4-8`; the exact-match `model` facet stays reserved for
 * programmatic callers. `project:` maps to `projectId` (callers pass a stable id).
 * `file:` maps to the `file` facet — a substring match against the mirrored tool-I/O
 * paths, so `file:index-db.ts` narrows to sessions that Edited/Read that file.
 * Keys are matched case-insensitively. Each handler receives the already-unquoted,
 * trimmed value and writes onto `f`; an empty value is treated as "no token" by the
 * caller (the raw text is kept) so a stray `tool:` doesn't silently drop a word.
 */
const TOKEN_HANDLERS: Record<string, (f: SearchFacets, value: string) => void> = {
  tool: (f, v) => {
    f.toolName = v;
  },
  role: (f, v) => {
    f.role = v.toLowerCase();
  },
  after: (f, v) => {
    f.since = v;
  },
  since: (f, v) => {
    f.since = v;
  },
  before: (f, v) => {
    f.until = v;
  },
  until: (f, v) => {
    f.until = v;
  },
  model: (f, v) => {
    f.modelLike = v;
  },
  project: (f, v) => {
    f.projectId = v;
  },
  projectid: (f, v) => {
    f.projectId = v;
  },
  branch: (f, v) => {
    f.gitBranch = v;
  },
  gitbranch: (f, v) => {
    f.gitBranch = v;
  },
  tag: (f, v) => {
    f.tag = v;
  },
  file: (f, v) => {
    f.file = v;
  },
};

/**
 * Tokenizer for the inline syntax. We walk the raw string token-by-token (whitespace
 * separated, but a `"quoted run"` is a single token even with spaces) so we never
 * misread a colon that's part of free text — only a token of the exact shape
 * `key:value` whose `key` is recognized is lifted; everything else (URLs like
 * `http://x`, ratios like `3:4`, a bare word) is preserved verbatim.
 *
 * Matches, in order:
 *  1. `-?key:"quoted value"`  — a recognized-shape token with a quoted value.
 *  2. `-?key:value`           — a recognized-shape token with a bare (no-space) value.
 *  3. `"quoted run"\*?`       — a free-text quoted phrase (kept intact, trailing `*` ok).
 *  4. `\S+`                   — any other run of non-space chars (kept verbatim).
 *
 * (1)/(2) only become facets when `key` is in {@link TOKEN_HANDLERS} AND the value is
 * non-empty; otherwise the whole original token falls through to `text`.
 */
const TOKEN_RE =
  /([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S+)|"[^"]*"\*?|\S+/g;

/**
 * Parse inline filter tokens out of a raw search query.
 *
 * Returns the leftover free text plus the facets lifted from recognized tokens. A
 * query with no recognized tokens returns `{ text: <trimmed query>, facets: {} }`, so
 * plain searches are unchanged. Quoted token values (`tool:"My Tool"`) and quoted
 * free-text phrases are both supported.
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const raw = query ?? "";
  const facets: SearchFacets = {};
  const kept: string[] = [];

  for (const m of raw.matchAll(TOKEN_RE)) {
    // Group pairs: (1,2) quoted-value token, (3,4) bare-value token.
    const key = (m[1] ?? m[3])?.toLowerCase();
    const value = m[1] != null ? m[2] : m[3] != null ? m[4] : undefined;
    const handler = key ? TOKEN_HANDLERS[key] : undefined;
    if (handler && value != null) {
      const trimmed = value.trim();
      if (trimmed) {
        handler(facets, trimmed);
        continue; // recognized token consumed -> not part of the text query
      }
    }
    // Not a recognized token (or empty value): keep the original matched text verbatim.
    kept.push(m[0]);
  }

  return { text: kept.join(" ").trim(), facets };
}

/**
 * Merge token-derived facets UNDER caller-supplied facets: an explicit facet passed
 * by the caller always wins over the same facet typed inline (so a UI can pin a
 * filter the free text can't override). `limit` is never set by the parser, so the
 * caller's limit is preserved untouched.
 */
export function mergeFacets(parsed: SearchFacets, caller: SearchFacets): SearchFacets {
  return { ...parsed, ...caller };
}
