/**
 * Cross-project full-text search over the mirrored message text.
 *
 * Extracted out of index-db.ts so the query parsing, FTS5/LIKE backends, and the
 * row→hit mapping live in one focused module. `TranscriptIndex` constructs a
 * `MessageSearch` with its own db handle + active `searchMode` and delegates to it.
 *
 *  - FTS5 mode uses MATCH + rank + snippet() (fast, token-aware).
 *  - LIKE mode (when node:sqlite's SQLite was built without FTS5) scans
 *    `text LIKE %term%` and builds the excerpt by hand.
 *
 * `search(query, { limit })` stays backward-compatible; the optional facet filters
 * (projectId/role/toolName/since/until/gitBranch) narrow the result set — they
 * filter on the mirrored message rows (role/toolName) and the joined `sessions`
 * row (projectId/gitBranch/lastTs) and are AND-ed onto the text match.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { projectName } from "./paths.js";
import type { SearchHit } from "./types.js";

/** Optional facet filters narrowing a search. All are AND-ed onto the text match. */
export interface SearchFacets {
  /** Cap on the number of returned hits (1..500; default 50). */
  limit?: number;
  /** Only sessions in this project (stable projectId / sha1 of cwd). */
  projectId?: string;
  /** Only mirrored rows with this role ("user" | "assistant" | "tool"). */
  role?: string;
  /** Only `role="tool"` rows whose invoked tool matches this name (e.g. "Bash"). */
  toolName?: string;
  /** Only sessions whose last activity (ISO `lastTs`) is >= this value. */
  since?: string;
  /** Only sessions whose last activity (ISO `lastTs`) is <= this value. */
  until?: string;
  /** Only sessions on this git branch. */
  gitBranch?: string;
  /** Only sessions carrying this tag (case-insensitive; matched against session_meta.tags). */
  tag?: string;
  /** Only sessions that ran on this model id (exact match against sessions.model). */
  model?: string;
}

/** Default/clamp bounds for the result cap. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Characters of context to show around the first match in LIKE-mode excerpts. */
const LIKE_EXCERPT_RADIUS = 80;

/**
 * Per-role multipliers applied to a row's bm25 score (FTS5 mode). bm25 returns
 * NEGATIVE numbers where more-negative == more relevant, so a LARGER multiplier
 * makes a match score more strongly. We weight real conversation (assistant/user
 * `text`) above the mirrored tool I/O (command lines + tool_result bodies), which
 * is high-volume noise that otherwise drowns out the substantive answer.
 */
const ROLE_WEIGHT: Record<string, number> = {
  assistant: 3.0,
  user: 2.0,
  tool: 1.0,
};
const DEFAULT_ROLE_WEIGHT = 2.0;

/**
 * Recency boost (FTS5 mode). Each matched session's best bm25 score is nudged
 * toward "worse" in proportion to how stale the session is, so that two similarly
 * relevant sessions are tie-broken by recency (recent first). The penalty is
 * `min(ageDays, RECENCY_CAP_DAYS) / RECENCY_CAP_DAYS * RECENCY_WEIGHT` — i.e. a
 * brand-new session adds ~0 and a year-old one adds the full `RECENCY_WEIGHT`.
 *
 * `RECENCY_WEIGHT` is sized to sit on the same order of magnitude as a typical
 * bm25 delta (~1e-5..1e-6 for these short docs) so recency refines, but does not
 * steamroll, raw textual relevance.
 */
const RECENCY_CAP_DAYS = 365.0;
const RECENCY_WEIGHT = 5e-6;

/** One parsed token of a user query. `phrase` keeps multi-word "quoted" groups intact. */
interface QueryTerm {
  /** The literal text to match (no surrounding quotes). */
  text: string;
  /** Match as a leading prefix (trailing `*`). */
  prefix: boolean;
  /** Negated term (leading `-`): exclude documents containing it. */
  exclude: boolean;
  /** Whether the token was an explicitly-quoted phrase (may contain spaces). */
  phrase: boolean;
}

/**
 * Tokenize a raw user query into terms:
 *  - "double quoted" runs become a single phrase term (spaces preserved).
 *  - a leading `-` marks an exclusion; a trailing `*` marks a prefix match.
 *  - everything else splits on whitespace into bare AND-ed terms.
 */
export function parseQueryTerms(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  const re = /-?"[^"]*"\*?|-?\S+/g;
  for (const m of query.match(re) ?? []) {
    let tok = m;
    let exclude = false;
    if (tok.startsWith("-")) {
      exclude = true;
      tok = tok.slice(1);
    }
    let phrase = false;
    let prefix = false;
    if (tok.startsWith('"')) {
      phrase = true;
      const close = tok.lastIndexOf('"');
      const inner = close > 0 ? tok.slice(1, close) : tok.slice(1);
      prefix = tok.slice(close + 1).includes("*");
      tok = inner;
    } else if (tok.endsWith("*")) {
      prefix = true;
      tok = tok.slice(0, -1);
    }
    const text = tok.trim();
    if (!text) continue;
    terms.push({ text, prefix, exclude, phrase });
  }
  return terms;
}

/** Quote a term as an FTS5 string literal (doubling embedded quotes), optionally a prefix. */
function fts5Term(t: QueryTerm): string {
  const quoted = `"${t.text.replace(/"/g, '""')}"`;
  return t.prefix ? `${quoted}*` : quoted;
}

/**
 * Build a safe FTS5 MATCH expression from a raw query: space-separated terms are
 * AND-ed (FTS5 implicit AND), "quoted phrases" stay phrases, trailing `*` is a
 * prefix, and `-term` becomes `NOT term`. Returns null when there is no positive
 * term to match (FTS5 rejects a pure-negation query).
 */
export function buildMatchExpr(query: string): string | null {
  const terms = parseQueryTerms(query);
  const include = terms.filter((t) => !t.exclude);
  const exclude = terms.filter((t) => t.exclude);
  if (include.length === 0) return null;
  let expr = include.map(fts5Term).join(" AND ");
  for (const t of exclude) expr += ` NOT ${fts5Term(t)}`;
  return expr;
}

/**
 * Build a ~160-char excerpt centered on the first (case-insensitive) match of
 * `query` in `text`, wrapping the match in [brackets] and adding ellipses when
 * the window is cut from either side. Used only in LIKE mode (FTS5 has snippet()).
 */
function likeExcerpt(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, LIKE_EXCERPT_RADIUS * 2).trim();
  const start = Math.max(0, idx - LIKE_EXCERPT_RADIUS);
  const end = Math.min(text.length, idx + query.length + LIKE_EXCERPT_RADIUS);
  const match = text.slice(idx, idx + query.length);
  const core = `${text.slice(start, idx)}[${match}]${text.slice(idx + query.length, end)}`.trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
}

/** SQL fragment + bound params for the session-level facet filters (shared by both backends). */
interface FacetSql {
  /** WHERE fragments referencing the message alias `f`/`t` and session alias `s`. */
  clauses: string[];
  /** Positional params in clause order (every facet value is a string). */
  params: string[];
}

/**
 * Translate the message-level (role/toolName) and session-level
 * (projectId/gitBranch/since/until) facets into SQL clauses + params. The caller
 * aliases the mirrored-text table as `f` (FTS) or `t` (LIKE) and the sessions
 * table as `s`; pass the matching `textAlias`.
 *
 * `placeholder` controls how a bound value is rendered. The FTS query already uses
 * EXPLICIT numbered params (`?1`, `?2`) so its facets must continue the numbering
 * (`?3`, `?4`, ...) — SQLite forbids mixing numbered and bare `?`. The LIKE query
 * uses bare `?`. The caller passes a `placeholder(i)` accordingly; `i` is the
 * 0-based index of this facet within the returned `params`.
 */
function facetClauses(
  facets: SearchFacets,
  textAlias: string,
  placeholder: (i: number) => string,
): FacetSql {
  const clauses: string[] = [];
  const params: string[] = [];
  const add = (sql: (ph: string) => string, value: string) => {
    clauses.push(sql(placeholder(params.length)));
    params.push(value);
  };
  if (facets.role) add((ph) => `${textAlias}.role = ${ph}`, facets.role);
  if (facets.toolName) add((ph) => `${textAlias}.toolName = ${ph}`, facets.toolName);
  if (facets.projectId) add((ph) => `s.projectId = ${ph}`, facets.projectId);
  if (facets.gitBranch) add((ph) => `s.gitBranch = ${ph}`, facets.gitBranch);
  if (facets.model) add((ph) => `s.model = ${ph}`, facets.model);
  if (facets.since) add((ph) => `s.lastTs >= ${ph}`, facets.since);
  if (facets.until) add((ph) => `s.lastTs <= ${ph}`, facets.until);
  return { clauses, params };
}

/**
 * SQL clause + bound param for the `tag` facet, matched against `session_meta.tags`
 * under the given alias (joined by the caller). Tags are stored as a JSON array of
 * normalized (trimmed, lower-cased) strings, e.g. `["alpha","beta"]`, so an exact
 * tag is a substring match on its quoted JSON token: `tags LIKE '%"alpha"%'`. The
 * needle is lower-cased to mirror the stored normalization, and `"`/`%`/`_`/`\`
 * are escaped so a tag containing them can't break the LIKE pattern. Returns null
 * when the facet is unset or the (trimmed) tag is empty.
 */
function tagClause(
  tag: string | undefined,
  metaAlias: string,
  placeholder: string,
): { clause: string; param: string } | null {
  const t = (tag ?? "").trim().toLowerCase();
  if (!t) return null;
  const escaped = t.replace(/[\\%_"]/g, (c) => `\\${c}`);
  return {
    clause: `${metaAlias}.tags LIKE ${placeholder} ESCAPE '\\'`,
    param: `%"${escaped}"%`,
  };
}

/**
 * Search over a session-index DB's mirrored message text. Owns no schema — it is
 * handed the live db connection and the active search backend by `TranscriptIndex`.
 */
export class MessageSearch {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly searchMode: "fts5" | "like",
  ) {}

  /**
   * Cross-project full-text search. Returns the best matching hit per session
   * (deduped). Facets (projectId/role/toolName/since/until/gitBranch/tag) are
   * optional and AND-ed onto the text match; `{ limit }` alone keeps the original
   * behavior.
   */
  search(query: string, facets: SearchFacets = {}): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const lim = Math.max(1, Math.min(facets.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    return this.searchMode === "fts5"
      ? this.searchFts(q, lim, facets)
      : this.searchLike(q, lim, facets);
  }

  private searchFts(query: string, limit: number, facets: SearchFacets): SearchHit[] {
    // Parse the query into a real FTS5 MATCH expression (AND-ed terms, phrases,
    // prefix*, -exclusion). A pure-negation query has nothing to match -> [].
    const match = buildMatchExpr(query);
    if (!match) return [];

    // Facets that touch the messages_fts row (role/toolName) must be applied INSIDE
    // the scored CTE (so we pick the best *eligible* row per session); session-level
    // facets (projectId/gitBranch/since/until) join `sessions` and filter there.
    // The query already binds ?1 (match) and ?2 (limit), so facet params continue
    // from ?3 — SQLite disallows mixing numbered and anonymous placeholders.
    const { clauses, params } = facetClauses(facets, "f", (i) => `?${i + 3}`);

    // The `tag` facet lives on session_meta (not sessions), so it gets its own
    // optional LEFT JOIN + clause inside the scored CTE. Its param continues the
    // numbering after the regular facet params (?3..?(2+N) -> next is ?(3+N)).
    const tag = tagClause(facets.tag, "tm", `?${params.length + 3}`);
    const metaJoin = tag ? " LEFT JOIN session_meta tm ON tm.sessionId = f.sessionId" : "";
    const allClauses = tag ? [...clauses, tag.clause] : clauses;
    const allParams = tag ? [...params, tag.param] : params;
    const facetWhere = allClauses.length ? ` AND ${allClauses.join(" AND ")}` : "";

    // Per-role bm25 weight as an inline CASE. Weights are trusted module constants
    // (not user input), so embedding them as literals is safe and keeps the
    // placeholder numbering (?1 match, ?2 limit, ?3+ facets) intact.
    const roleCase =
      `CASE f.role` +
      Object.entries(ROLE_WEIGHT)
        .map(([role, w]) => ` WHEN '${role}' THEN ${w.toFixed(4)}`)
        .join("") +
      ` ELSE ${DEFAULT_ROLE_WEIGHT.toFixed(4)} END`;

    // RANKING (3-stage, all in SQL):
    //  1) `scored`  — bm25(messages_fts) for each matching row, multiplied by the
    //     per-role weight so assistant/user text outranks mirrored tool noise.
    //     (bm25 is negative; multiplying by a larger weight makes it MORE negative
    //     = better. It is selected as a plain column here — FTS5 forbids using the
    //     bm25() auxiliary fn directly inside a window function's ORDER BY.)
    //  2) `best`    — ROW_NUMBER() over that alias keeps the single best row per
    //     session.
    //  3) final SELECT — adds a recency penalty derived from the session `lastTs`
    //     (stale sessions get nudged toward 0 = worse) and orders by the combined
    //     score, then caps to `limit`. We re-MATCH messages_fts so snippet() has
    //     its query context (it can't run inside the window subquery). `text` is
    //     column index 4 now that toolName precedes it.
    const rows = this.db
      .prepare(
        `WITH scored AS (
           SELECT f.rowid AS rid, f.sessionId AS sessionId,
                  bm25(messages_fts) * (${roleCase}) AS adj
           FROM messages_fts f
           JOIN sessions s ON s.sessionId = f.sessionId${metaJoin}
           WHERE messages_fts MATCH ?1${facetWhere}
         ),
         ranked AS (
           SELECT rid, sessionId, adj,
                  ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY adj) AS rn
           FROM scored
         ),
         best AS (
           SELECT r.rid AS rid,
                  r.adj
                    + MIN(MAX(julianday('now') - julianday(s.lastTs), 0.0), ${RECENCY_CAP_DAYS})
                      / ${RECENCY_CAP_DAYS} * ${RECENCY_WEIGHT} AS score
           FROM ranked r
           JOIN sessions s ON s.sessionId = r.sessionId
           WHERE r.rn = 1
           ORDER BY score LIMIT ?2
         )
         SELECT f.sessionId AS sessionId, f.role AS role, f.toolName AS toolName, f.seq AS seq,
                snippet(messages_fts, 4, '[', ']', '…', 12) AS excerpt,
                s.projectId AS projectId, s.cwd AS cwd, s.lastTs AS lastTs,
                s.title AS title, s.titleSource AS titleSource,
                m.customTitle AS customTitle
         FROM best
         JOIN messages_fts f ON f.rowid = best.rid AND messages_fts MATCH ?1
         JOIN sessions s ON s.sessionId = f.sessionId
         LEFT JOIN session_meta m ON m.sessionId = f.sessionId
         ORDER BY best.score`,
      )
      .all(match, limit, ...allParams) as unknown as Array<{
      sessionId: string;
      role: string;
      toolName: string | null;
      seq: number | null;
      excerpt: string | null;
      projectId: string | null;
      cwd: string | null;
      lastTs: string | null;
      title: string | null;
      titleSource: string | null;
      customTitle: string | null;
    }>;

    return rows.map((r) => toHit(r, (r.excerpt ?? "").trim()));
  }

  private searchLike(query: string, limit: number, facets: SearchFacets): SearchHit[] {
    // No FTS5: emulate the parsed query with LIKE. Each positive term must be
    // present (AND); each negated term must be absent (NOT LIKE). Prefix/phrase
    // collapse to plain substring matches here (LIKE has no token boundaries).
    const terms = parseQueryTerms(query);
    const include = terms.filter((t) => !t.exclude);
    const exclude = terms.filter((t) => t.exclude);
    if (include.length === 0) return [];

    const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const clauses: string[] = [];
    const params: string[] = [];
    for (const t of include) {
      clauses.push(`t.text LIKE ? ESCAPE '\\'`);
      params.push(likePattern(t.text));
    }
    for (const t of exclude) {
      clauses.push(`t.text NOT LIKE ? ESCAPE '\\'`);
      params.push(likePattern(t.text));
    }
    // Facets AND onto the same WHERE. role/toolName hit the `t` row directly; the
    // session-level facets reference `s` (joined in the CTE below). LIKE mode uses
    // anonymous `?` placeholders throughout, so facets do too.
    const facet = facetClauses(facets, "t", () => "?");
    clauses.push(...facet.clauses);
    params.push(...facet.params);

    // The `tag` facet lives on session_meta (joined as `tm` only when needed).
    const tag = tagClause(facets.tag, "tm", "?");
    if (tag) {
      clauses.push(tag.clause);
      params.push(tag.param);
    }
    const metaJoin = tag ? " LEFT JOIN session_meta tm ON tm.sessionId = t.sessionId" : "";
    const where = clauses.join(" AND ");

    // Pick the newest row per session (ROW_NUMBER) and cap to `limit` sessions in SQL.
    const rows = this.db
      .prepare(
        `WITH matched AS (
           SELECT t.sessionId AS sessionId, t.role AS role, t.toolName AS toolName, t.seq AS seq, t.text AS text,
                  ROW_NUMBER() OVER (PARTITION BY t.sessionId ORDER BY t.seq DESC) AS rn
           FROM messages_text t
           JOIN sessions s ON s.sessionId = t.sessionId${metaJoin}
           WHERE ${where}
         )
         SELECT mt.sessionId AS sessionId, mt.role AS role, mt.toolName AS toolName, mt.seq AS seq, mt.text AS text,
                s.projectId AS projectId, s.cwd AS cwd, s.lastTs AS lastTs,
                s.title AS title, s.titleSource AS titleSource,
                m.customTitle AS customTitle
         FROM matched mt
         JOIN sessions s ON s.sessionId = mt.sessionId
         LEFT JOIN session_meta m ON m.sessionId = mt.sessionId
         WHERE mt.rn = 1
         ORDER BY s.lastTs DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as Array<{
      sessionId: string;
      role: string;
      toolName: string | null;
      seq: number | null;
      text: string | null;
      projectId: string | null;
      cwd: string | null;
      lastTs: string | null;
      title: string | null;
      titleSource: string | null;
      customTitle: string | null;
    }>;

    // Center the excerpt on the first positive term that actually appears.
    const focus = include[0]!.text;
    return rows.map((r) => toHit(r, likeExcerpt(r.text ?? "", focus)));
  }
}

/** Shared row -> SearchHit mapping (title precedence: custom > stored title). */
function toHit(
  r: {
    sessionId: string;
    role: string;
    seq: number | null;
    projectId: string | null;
    cwd: string | null;
    lastTs: string | null;
    title: string | null;
    customTitle: string | null;
  },
  snippet: string,
): SearchHit {
  const custom = r.customTitle && r.customTitle.trim() ? r.customTitle.trim() : null;
  return {
    sessionId: r.sessionId,
    projectId: r.projectId ?? "unknown",
    projectName: r.cwd ? projectName(r.cwd) : "",
    title: custom ?? r.title ?? r.sessionId.slice(0, 8),
    cwd: r.cwd,
    role: r.role,
    snippet,
    timestamp: r.lastTs,
    // The matched row's in-session message index; 0 when absent (legacy rows).
    seq: typeof r.seq === "number" ? r.seq : Number(r.seq ?? 0) || 0,
  };
}
