/**
 * "Sessions related to THIS one" — a cheap, deterministic relatedness ranking.
 *
 * Given a source session, surface the OTHER sessions most likely to be about the
 * same work, using ONLY signals already sitting in the index (no embeddings, no model
 * calls, no transcript reads). Every signal is computed from the same tables `search`
 * and the session lists already query, so this is a few small SQL reads + JS scoring:
 *
 *   - TERM OVERLAP  — the strongest signal. We harvest the source session's
 *     significant terms from its mirrored conversation text (the same `messages_*`
 *     mirror search uses), keep the rarer ones (a tiny TF/IDF-style weighting via a
 *     document-frequency count), then score each candidate by how many of those terms
 *     its OWN mirrored text contains. Shared *rare* terms (a function name, a library,
 *     an error string) move the needle far more than shared common words.
 *   - SAME PROJECT  — same stable projectId (same true cwd) is a strong prior that two
 *     sessions are related work.
 *   - SHARED TAGS   — each tag both sessions carry (user-assigned or auto) adds a bump.
 *   - SHARED TOOLS  — overlap in the set of tools each session actually invoked
 *     (role="tool" rows store "<Tool>: …"); a weak signal that nudges ties.
 *   - TEMPORAL      — sessions worked on near in time to the source get a small,
 *     decaying boost (work done the same day is more likely the same thread).
 *
 * The signals are combined into a single documented score (see {@link SIGNAL_WEIGHTS});
 * the source session is always excluded, results are sorted best-first and capped. Each
 * hit carries a short human `reason` naming the signals that fired, so a face can show
 * *why* something surfaced.
 *
 * Robustness: an unknown sessionId returns []; a source session with NO indexed text
 * simply contributes no term signal and falls back to project/tag/tool/time overlap.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { parseTags } from "./tags.js";

/** Options for {@link relatedSessions}. */
export interface RelatedOptions {
  /** Max results returned (1..50; default 10). The source session is never counted. */
  limit?: number;
  /**
   * Drop hits whose combined score is below this floor (default 0). Raise it to keep
   * only confidently-related sessions; 0 returns everything with ANY shared signal.
   */
  minScore?: number;
}

/** One related session, with its combined score and a short human-readable reason. */
export interface RelatedSession {
  /** The related session's id. */
  sessionId: string;
  /** Its project (stable projectId / sha1 of cwd), or "unknown". */
  projectId: string;
  /** Its true working directory, when known. */
  cwd: string | null;
  /** Its display title (custom title wins over the stored title). */
  title: string;
  /** Its last-activity timestamp (ISO `lastTs`), or null. */
  timestamp: string | null;
  /** Combined relatedness score (higher = more related). See {@link SIGNAL_WEIGHTS}. */
  score: number;
  /** Short, human reason naming the signals that fired (e.g. "same project, shared tags"). */
  reason: string;
}

/** Default/clamp bounds for the result cap (mirrors search's clamp style). */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Per-signal weights folded into the combined score. Sized so a single shared RARE
 * term (the most meaningful signal) is worth roughly the same as being in the same
 * project, and so several weak signals (tags/tools/time) can together rival one strong
 * one — but no single weak signal alone outranks genuine textual overlap. These are
 * trusted module constants, tuned for ranking ORDER (the absolute scale is arbitrary).
 */
const SIGNAL_WEIGHTS = {
  /** Multiplies the summed IDF weight of shared significant terms (the primary signal). */
  term: 1.0,
  /** Flat bonus when the candidate is in the SAME project as the source. */
  sameProject: 3.0,
  /** Per shared tag. */
  perTag: 2.0,
  /** Per shared tool name (capped by {@link MAX_TOOL_BONUS}). */
  perTool: 0.5,
  /**
   * Max temporal boost, earned when the candidate's activity is essentially
   * simultaneous with the source; decays linearly to 0 over {@link TIME_DECAY_DAYS}.
   */
  time: 2.0,
} as const;

/** Tool-overlap contribution is capped so a tool-heavy session can't dominate on tools alone. */
const MAX_TOOL_BONUS = 2.0;

/** Days over which the temporal boost decays from full to zero. */
const TIME_DECAY_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/**
 * How many of the source session's significant terms to score against. We keep the
 * rarest (highest IDF) terms — a handful of distinctive tokens carries the signal; the
 * long tail of common words (and the cost of OR-ing them all) buys little.
 */
const MAX_SOURCE_TERMS = 24;

/**
 * Upper bound on how many distinct source terms we compute a document-frequency for.
 * A large session's mirrored text holds THOUSANDS of distinct tokens; running a
 * per-term index probe for every one of them is what made this O(seconds). We instead
 * keep only the most in-source-frequent terms as df candidates (the rare-but-meaningful
 * tokens we ultimately want are overwhelmingly among the high-TF ones), bounding the df
 * probes to a constant. The final keep is still the top {@link MAX_SOURCE_TERMS} by IDF.
 */
const MAX_DF_TERMS = 64;

/** Quote a token as an FTS5 string literal (doubling embedded quotes), mirroring search.ts. */
function ftsLiteral(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** A term must be at least this long to count (skips "a", "to", "ok", single chars). */
const MIN_TERM_LEN = 3;

/**
 * Very common English/code-chatter words we never treat as "significant". Deliberately
 * small — the IDF weighting already de-emphasizes common tokens; this just trims the
 * obvious noise so the kept-term budget goes to meaningful tokens.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her",
  "was", "one", "our", "out", "his", "has", "him", "how", "its", "may", "new", "now",
  "old", "see", "two", "who", "did", "get", "use", "she", "let", "put", "say", "this",
  "that", "with", "have", "from", "they", "will", "your", "what", "when", "your", "into",
  "then", "than", "them", "some", "here", "been", "more", "also", "were", "want", "just",
  "like", "your", "code", "file", "session", "user", "assistant", "tool", "true", "false",
  "null", "yes", "let's", "okay", "sure", "should", "would", "could", "about", "which",
]);

/** A candidate's accumulated signal counts, filled as we scan each signal's rows. */
interface Candidate {
  sessionId: string;
  projectId: string | null;
  cwd: string | null;
  title: string | null;
  customTitle: string | null;
  lastTs: string | null;
  /** Summed IDF weight of source terms found in this candidate's text. */
  termWeight: number;
  /** Count of distinct source terms this candidate shares (for the reason line). */
  termHits: number;
  sameProject: boolean;
  sharedTags: number;
  sharedTools: number;
}

/**
 * Split mirrored text into lower-cased word tokens worth indexing: alphanumeric runs
 * (with `_`), at least {@link MIN_TERM_LEN} long, that aren't pure numbers or stopwords.
 * Used both to harvest the source session's terms and to count document frequency.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < MIN_TERM_LEN) continue;
    if (/^\d+$/.test(raw)) continue; // pure numbers carry little topical signal
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** The active mirrored-text table for this DB (FTS5 virtual table or the LIKE fallback). */
function textTable(db: SqliteDatabase): string {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='messages_fts'")
    .get() as { name?: string } | undefined;
  return row?.name === "messages_fts" ? "messages_fts" : "messages_text";
}

/** Concatenate all of one session's mirrored conversation text (user/assistant rows). */
function sessionText(db: SqliteDatabase, table: string, sessionId: string): string {
  // Only the real conversation rows (user/assistant) — tool I/O is high-volume noise
  // (command lines, result bodies) that would swamp the topical terms. Tool OVERLAP is
  // captured separately as its own (weaker) signal.
  const rows = db
    .prepare(`SELECT text FROM ${table} WHERE sessionId = ? AND role IN ('user','assistant')`)
    .all(sessionId) as Array<{ text: string | null }>;
  return rows.map((r) => r.text ?? "").join(" ");
}

/** The DISTINCT set of tool names a session actually invoked (role="tool" rows). */
function sessionTools(db: SqliteDatabase, table: string, sessionId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT toolName FROM ${table}
       WHERE sessionId = ? AND role = 'tool' AND toolName IS NOT NULL AND toolName <> ''`,
    )
    .all(sessionId) as Array<{ toolName: string | null }>;
  const set = new Set<string>();
  for (const r of rows) if (r.toolName) set.add(r.toolName);
  return set;
}

/**
 * Pick the source session's significant terms with an IDF-style weight. Term frequency
 * in the source picks the candidates; document frequency across the WHOLE index (how
 * many sessions use a term) weights them so a rare token (one session uses it) outranks
 * a token half the index shares. Returns the top {@link MAX_SOURCE_TERMS} by weight.
 */
function sourceTerms(
  db: SqliteDatabase,
  table: string,
  isFts: boolean,
  text: string,
  totalSessions: number,
): Array<{ term: string; idf: number }> {
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  if (tf.size === 0) return [];

  // Cap the df work: a large session has thousands of distinct tokens, and probing the
  // index once per token is what made this slow. Keep only the most in-source-frequent
  // terms as df candidates — the distinctive tokens we want survive the cut, and the cost
  // becomes a constant number of probes instead of one-per-distinct-word.
  const candidates =
    tf.size <= MAX_DF_TERMS
      ? [...tf.entries()]
      : [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DF_TERMS);

  // Document frequency per candidate term: how many sessions' mirrored text contains it.
  // FTS5 MATCH uses the inverted index (fast); the LIKE fallback (plain `messages_text`
  // table) is only hit when FTS5 is unavailable. Both restrict to user/assistant rows.
  const dfStmt = isFts
    ? db.prepare(
        `SELECT COUNT(DISTINCT sessionId) AS df FROM ${table}
         WHERE ${table} MATCH ? AND role IN ('user','assistant')`,
      )
    : db.prepare(
        `SELECT COUNT(DISTINCT sessionId) AS df FROM ${table}
         WHERE role IN ('user','assistant') AND text LIKE ? ESCAPE '\\'`,
      );
  const scored: Array<{ term: string; idf: number }> = [];
  for (const [term, freq] of candidates) {
    const param = isFts ? ftsLiteral(term) : `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const df = (dfStmt.get(param) as { df: number }).df || 1;
    // Smoothed IDF: ln(1 + N/df). Rarer term (small df) -> larger weight. The sqrt of
    // the in-source frequency adds a gentle TF bump without letting one repeated word
    // dominate. df==N (every session has it) collapses toward ~0.69 (still positive).
    const idf = Math.log(1 + totalSessions / df) * Math.sqrt(freq);
    scored.push({ term, idf });
  }
  scored.sort((a, b) => b.idf - a.idf);
  return scored.slice(0, MAX_SOURCE_TERMS);
}

/** Round to 4 decimals so scores are stable/readable (avoids float jitter in tests). */
function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Build the short human reason string from the signals that actually fired. */
function reasonFor(c: Candidate): string {
  const parts: string[] = [];
  if (c.sameProject) parts.push("same project");
  if (c.termHits > 0) parts.push(`${c.termHits} shared term${c.termHits === 1 ? "" : "s"}`);
  if (c.sharedTags > 0) parts.push(`${c.sharedTags} shared tag${c.sharedTags === 1 ? "" : "s"}`);
  if (c.sharedTools > 0) parts.push(`${c.sharedTools} shared tool${c.sharedTools === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "near in time";
}

/**
 * Rank the OTHER sessions most related to `sessionId` using cheap, deterministic index
 * signals (term overlap, same project, shared tags, shared tools, temporal proximity).
 * Operates on a session-index DB handle (the same `sessions` / `session_meta` /
 * mirrored-text tables `search` uses) — owns no schema. The source session is always
 * excluded; an unknown id (or one with no neighbours) returns []. See the module header
 * for the full signal description.
 */
export function relatedSessions(
  db: SqliteDatabase,
  sessionId: string,
  opts: RelatedOptions = {},
): RelatedSession[] {
  const sid = (sessionId ?? "").trim();
  if (!sid) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const minScore = opts.minScore ?? 0;

  // The source session must exist; unknown id -> [] (never invents results).
  const source = db
    .prepare("SELECT sessionId, projectId, lastTs FROM sessions WHERE sessionId = ?")
    .get(sid) as { sessionId: string; projectId: string | null; lastTs: string | null } | undefined;
  if (!source) return [];

  const total = (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
  if (total <= 1) return []; // only the source itself is indexed — nothing to relate to

  const table = textTable(db);
  const isFts = table === "messages_fts";

  // -- Source signals --------------------------------------------------------
  const srcText = sessionText(db, table, sid);
  const terms = sourceTerms(db, table, isFts, srcText, total);
  const srcTools = sessionTools(db, table, sid);
  const srcTagsRow = db
    .prepare("SELECT tags FROM session_meta WHERE sessionId = ?")
    .get(sid) as { tags: string | null } | undefined;
  const srcTags = new Set(parseTags(srcTagsRow?.tags));
  const srcTs = source.lastTs ? Date.parse(source.lastTs) : NaN;

  // -- Candidate accumulator (every OTHER session, lazily filled) ------------
  const cands = new Map<string, Candidate>();
  const ensure = (row: {
    sessionId: string;
    projectId: string | null;
    cwd: string | null;
    title: string | null;
    customTitle: string | null;
    lastTs: string | null;
  }): Candidate => {
    let c = cands.get(row.sessionId);
    if (!c) {
      c = {
        sessionId: row.sessionId,
        projectId: row.projectId,
        cwd: row.cwd,
        title: row.title,
        customTitle: row.customTitle,
        lastTs: row.lastTs,
        termWeight: 0,
        termHits: 0,
        sameProject: false,
        sharedTags: 0,
        sharedTools: 0,
      };
      cands.set(row.sessionId, c);
    }
    return c;
  };

  // TERM OVERLAP: for each significant source term, find the OTHER sessions whose
  // mirrored conversation text contains it and add its IDF weight. One LIKE per term
  // (only the rarest MAX_SOURCE_TERMS), each excluding the source row. This is the
  // signal that does the heavy lifting; everything below refines its ordering.
  if (terms.length > 0) {
    // FTS5 MATCH (indexed) when available; the LIKE form is the plain-table fallback.
    // The MATCH operator must reference the table by name, so we don't alias the FTS
    // table here (mirrors search.ts); the LIKE branch keeps its alias.
    const termStmt = isFts
      ? db.prepare(
          `SELECT DISTINCT ${table}.sessionId AS sessionId, s.projectId AS projectId, s.cwd AS cwd,
                  s.title AS title, s.lastTs AS lastTs, m.customTitle AS customTitle
           FROM ${table}
           JOIN sessions s ON s.sessionId = ${table}.sessionId
           LEFT JOIN session_meta m ON m.sessionId = ${table}.sessionId
           WHERE ${table} MATCH ?2 AND ${table}.role IN ('user','assistant')
             AND ${table}.sessionId <> ?1`,
        )
      : db.prepare(
          `SELECT DISTINCT t.sessionId AS sessionId, s.projectId AS projectId, s.cwd AS cwd,
                  s.title AS title, s.lastTs AS lastTs, m.customTitle AS customTitle
           FROM ${table} t
           JOIN sessions s ON s.sessionId = t.sessionId
           LEFT JOIN session_meta m ON m.sessionId = t.sessionId
           WHERE t.role IN ('user','assistant') AND t.sessionId <> ?1
             AND t.text LIKE ?2 ESCAPE '\\'`,
    );
    for (const { term, idf } of terms) {
      const param = isFts ? ftsLiteral(term) : `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = termStmt.all(sid, param) as Array<{
        sessionId: string;
        projectId: string | null;
        cwd: string | null;
        title: string | null;
        lastTs: string | null;
        customTitle: string | null;
      }>;
      for (const row of rows) {
        const c = ensure(row);
        c.termWeight += idf;
        c.termHits += 1;
      }
    }
  }

  // SAME PROJECT: pull every other session in the source's project (when it has one).
  // These join the candidate set even with zero term overlap (project alone relates).
  if (source.projectId) {
    const rows = db
      .prepare(
        `SELECT s.sessionId AS sessionId, s.projectId AS projectId, s.cwd AS cwd,
                s.title AS title, s.lastTs AS lastTs, m.customTitle AS customTitle
         FROM sessions s LEFT JOIN session_meta m ON m.sessionId = s.sessionId
         WHERE s.projectId = ? AND s.sessionId <> ?`,
      )
      .all(source.projectId, sid) as Array<{
      sessionId: string;
      projectId: string | null;
      cwd: string | null;
      title: string | null;
      lastTs: string | null;
      customTitle: string | null;
    }>;
    for (const row of rows) ensure(row).sameProject = true;
  }

  // SHARED TAGS: when the source carries tags, find other sessions sharing each one
  // (substring match on the quoted JSON token, mirroring the `tag` search facet). Each
  // shared tag bumps the count; a tagged session with no prior signal still joins.
  if (srcTags.size > 0) {
    const tagStmt = db.prepare(
      `SELECT s.sessionId AS sessionId, s.projectId AS projectId, s.cwd AS cwd,
              s.title AS title, s.lastTs AS lastTs, m.customTitle AS customTitle
       FROM session_meta m JOIN sessions s ON s.sessionId = m.sessionId
       WHERE m.sessionId <> ? AND m.tags LIKE ? ESCAPE '\\'`,
    );
    for (const tag of srcTags) {
      const escaped = tag.replace(/[\\%_"]/g, (c) => `\\${c}`);
      const rows = tagStmt.all(sid, `%"${escaped}"%`) as Array<{
        sessionId: string;
        projectId: string | null;
        cwd: string | null;
        title: string | null;
        lastTs: string | null;
        customTitle: string | null;
      }>;
      for (const row of rows) ensure(row).sharedTags += 1;
    }
  }

  // SHARED TOOLS: count how many tools each candidate shares with the source. We only
  // probe candidates already in the set (a tool-only relationship is too weak to pull a
  // session in on its own). Fetched in ONE batched read over the candidate ids (chunked
  // to stay under SQLite's bound-parameter limit) rather than a scan per candidate.
  if (srcTools.size > 0 && cands.size > 0) {
    const ids = [...cands.keys()];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT DISTINCT sessionId, toolName FROM ${table}
           WHERE role = 'tool' AND toolName IS NOT NULL AND toolName <> ''
             AND sessionId IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ sessionId: string; toolName: string | null }>;
      for (const row of rows) {
        if (row.toolName && srcTools.has(row.toolName)) {
          const c = cands.get(row.sessionId);
          if (c) c.sharedTools += 1;
        }
      }
    }
  }

  // -- Combine signals into one score per candidate --------------------------
  const results: RelatedSession[] = [];
  for (const c of cands.values()) {
    let score = c.termWeight * SIGNAL_WEIGHTS.term;
    if (c.sameProject) score += SIGNAL_WEIGHTS.sameProject;
    score += c.sharedTags * SIGNAL_WEIGHTS.perTag;
    score += Math.min(c.sharedTools * SIGNAL_WEIGHTS.perTool, MAX_TOOL_BONUS);

    // Temporal proximity: full boost when activity is ~simultaneous, decaying to 0 over
    // TIME_DECAY_DAYS. Only applies when BOTH timestamps are known; never penalizes.
    const candTs = c.lastTs ? Date.parse(c.lastTs) : NaN;
    if (!Number.isNaN(srcTs) && !Number.isNaN(candTs)) {
      const days = Math.abs(srcTs - candTs) / MS_PER_DAY;
      if (days < TIME_DECAY_DAYS) {
        score += (1 - days / TIME_DECAY_DAYS) * SIGNAL_WEIGHTS.time;
      }
    }

    score = round(score);
    // Drop anything below the floor. With the default floor of 0 we still drop a pure
    // zero (a candidate that ended up with NO signal at all), so results always carry
    // at least one shared signal; a raised floor uses a strict `< minScore`.
    if (minScore <= 0 ? score <= 0 : score < minScore) continue;

    const custom = c.customTitle && c.customTitle.trim() ? c.customTitle.trim() : null;
    results.push({
      sessionId: c.sessionId,
      projectId: c.projectId ?? "unknown",
      cwd: c.cwd,
      title: custom ?? c.title ?? c.sessionId.slice(0, 8),
      timestamp: c.lastTs,
      score,
      reason: reasonFor(c),
    });
  }

  // Best first; tie-break deterministically by recency then sessionId so the order is
  // stable across runs (important for tests and a steady UI).
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.timestamp ?? "";
    const bt = b.timestamp ?? "";
    if (at !== bt) return bt.localeCompare(at);
    return a.sessionId.localeCompare(b.sessionId);
  });
  return results.slice(0, limit);
}
