/**
 * Durable index of every session across every project.
 *
 *  - Uses Node's built-in `node:sqlite` (no native build step).
 *  - BYTE-OFFSET INCREMENTAL indexing: transcripts are append-only, so after the
 *    first pass we only read bytes appended since `indexedBytes` — a 534MB file is
 *    read in full exactly once, then updates are cheap.
 *  - Doubles as a PERMANENT archive of metadata that survives Claude Code's
 *    ~30-day transcript auto-delete.
 *  - `session_meta` holds OUR custom data (rename/pin/tags) — we never edit transcripts.
 */
import { createRequire } from "node:module";
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { appDataDir, projectIdFromCwd, projectName } from "./paths.js";
import { streamRawLines, usageFromMessage, isCommandOrMetaPrompt } from "./parser.js";
import type {
  ProjectSummary,
  SearchHit,
  SessionSummary,
  TitleSource,
  TokenUsage,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";

interface Row {
  sessionId: string;
  filePath: string;
  cwd: string | null;
  projectId: string | null;
  title: string | null;
  titleSource: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sizeBytes: number;
  mtimeMs: number;
  indexedBytes: number;
  hasSubagents: number;
  customTitle: string | null;
  pinned: number;
  tags: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  filePath TEXT NOT NULL,
  cwd TEXT,
  projectId TEXT,
  title TEXT,
  titleSource TEXT,
  gitBranch TEXT,
  firstTs TEXT,
  lastTs TEXT,
  messageCount INTEGER NOT NULL DEFAULT 0,
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  sizeBytes INTEGER NOT NULL DEFAULT 0,
  mtimeMs INTEGER NOT NULL DEFAULT 0,
  indexedBytes INTEGER NOT NULL DEFAULT 0,
  hasSubagents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId);
CREATE INDEX IF NOT EXISTS idx_sessions_lastTs ON sessions(lastTs);

CREATE TABLE IF NOT EXISTS session_meta (
  sessionId TEXT PRIMARY KEY,
  customTitle TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT
);
`;

const SELECT_COLS = `
  s.sessionId, s.filePath, s.cwd, s.projectId, s.title, s.titleSource, s.gitBranch,
  s.firstTs, s.lastTs, s.messageCount, s.inputTokens, s.outputTokens,
  s.cacheReadTokens, s.cacheCreationTokens, s.sizeBytes, s.mtimeMs, s.indexedBytes,
  s.hasSubagents, m.customTitle, COALESCE(m.pinned, 0) AS pinned, m.tags
`;

function n(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/** One row of renderable text mirrored into the search store for a session. */
interface SearchText {
  role: "user" | "assistant" | "tool";
  seq: number;
  text: string;
  /** Tool name for role="tool" rows (the invoked tool, or the tool a result belongs to). */
  toolName: string | null;
}

/** Max characters of a tool_result body we mirror into the search store. */
const MAX_TOOL_RESULT_TEXT = 2000;

/** Read a string field off an arbitrary block object, trimmed and non-empty, or null. */
function blockStr(b: Record<string, unknown>, key: string): string | null {
  const v = b[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Map a tool_use block to "<ToolName>: <key input>" for search (one compact line). */
function toolUseLine(name: string, input: unknown): string | null {
  const io =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const pick = (key: string): string | null => (io ? blockStr(io, key) : null);

  let detail: string | null = null;
  switch (name) {
    case "Bash":
      detail = pick("command");
      break;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      detail = pick("file_path") ?? pick("notebook_path");
      break;
    case "Read":
      detail = pick("file_path") ?? pick("path");
      break;
    case "Glob":
    case "Grep":
      detail = pick("pattern") ?? pick("path");
      break;
    default:
      // Unknown tool: a short JSON of its input so the args are still searchable.
      if (io) {
        try {
          detail = JSON.stringify(io);
        } catch {
          detail = null;
        }
      }
      break;
  }

  const line = detail ? `${name}: ${detail}` : name;
  const trimmed = line.trim();
  return trimmed ? trimmed.slice(0, MAX_SEARCH_TEXT) : null;
}

/**
 * Harvest tool I/O text from one message for search.
 * - assistant tool_use blocks -> "<ToolName>: <key input>" (role="tool", toolName set).
 * - user tool_result blocks    -> the (capped) result body (role="tool", toolName null).
 * Pushes a SearchText per block; the caller assigns/advances `seq`.
 */
function toolTexts(type: string, message: unknown, seq: number): SearchText[] {
  const m =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const content = m?.content;
  if (!Array.isArray(content)) return [];

  const out: SearchText[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const b = raw as Record<string, unknown>;

    if (type === "assistant" && b.type === "tool_use") {
      const name = blockStr(b, "name") ?? "Tool";
      const line = toolUseLine(name, b.input);
      if (line) out.push({ role: "tool", seq, text: line, toolName: name });
    } else if (type === "user" && b.type === "tool_result") {
      const text = toolResultText(b.content);
      if (text) out.push({ role: "tool", seq, text, toolName: null });
    }
  }
  return out;
}

/** Flatten a tool_result `content` (string or block array) to a capped plain string. */
function toolResultText(content: unknown): string | null {
  let s: string;
  if (typeof content === "string") {
    s = content;
  } else if (Array.isArray(content)) {
    s = content
      .map((b) => {
        if (!b || typeof b !== "object" || Array.isArray(b)) return "";
        const bo = b as Record<string, unknown>;
        if (bo.type === "text" && typeof bo.text === "string") return bo.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    return null;
  }
  const t = s.trim();
  return t ? t.slice(0, MAX_TOOL_RESULT_TEXT) : null;
}

/**
 * Pull the human-readable text out of a user/assistant transcript line for search.
 * - assistant: concatenate `text` blocks (skip thinking/tool_use/tool_result noise).
 * - user: only plain string content, and only when it isn't a command/meta wrapper.
 * Returns the (trimmed, capped) text or null when there's nothing worth indexing.
 */
function renderableText(type: string, message: unknown): string | null {
  const m =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const content = m?.content;

  if (type === "assistant") {
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
        const t = (b as Record<string, unknown>).text;
        if (typeof t === "string" && t.trim()) parts.push(t);
      }
    }
    const joined = parts.join("\n").trim();
    return joined ? joined.slice(0, MAX_SEARCH_TEXT) : null;
  }

  if (type === "user") {
    if (typeof content !== "string") return null;
    const t = content.trim();
    if (!t || isCommandOrMetaPrompt(content)) return null;
    return t.slice(0, MAX_SEARCH_TEXT);
  }

  return null;
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
function parseQueryTerms(query: string): QueryTerm[] {
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
function buildMatchExpr(query: string): string | null {
  const terms = parseQueryTerms(query);
  const include = terms.filter((t) => !t.exclude);
  const exclude = terms.filter((t) => t.exclude);
  if (include.length === 0) return null;
  let expr = include.map(fts5Term).join(" AND ");
  for (const t of exclude) expr += ` NOT ${fts5Term(t)}`;
  return expr;
}

// Load node:sqlite via require so bundlers/test-runners (Vite/vitest) don't try to
// resolve this newer builtin through their module graph — Node resolves it natively.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** Max characters of renderable text we mirror per message into the search store. */
const MAX_SEARCH_TEXT = 4000;
/** Characters of context to show around the first match in LIKE-mode excerpts. */
const LIKE_EXCERPT_RADIUS = 80;

export class TranscriptIndex {
  private db: SqliteDatabase;
  private upsert: StatementSync;
  private selectOne: StatementSync;
  /** Which search backend is active: FTS5 virtual table, or a plain LIKE-scanned table. */
  readonly searchMode: "fts5" | "like";

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(appDataDir(), "index.db");
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.searchMode = this.initSearchStore();
    this.upsert = this.db.prepare(`
      INSERT INTO sessions (
        sessionId, filePath, cwd, projectId, title, titleSource, gitBranch,
        firstTs, lastTs, messageCount, inputTokens, outputTokens,
        cacheReadTokens, cacheCreationTokens, sizeBytes, mtimeMs, indexedBytes, hasSubagents
      ) VALUES (
        $sessionId, $filePath, $cwd, $projectId, $title, $titleSource, $gitBranch,
        $firstTs, $lastTs, $messageCount, $inputTokens, $outputTokens,
        $cacheReadTokens, $cacheCreationTokens, $sizeBytes, $mtimeMs, $indexedBytes, $hasSubagents
      )
      ON CONFLICT(sessionId) DO UPDATE SET
        filePath=$filePath, cwd=$cwd, projectId=$projectId, title=$title, titleSource=$titleSource,
        gitBranch=$gitBranch, firstTs=$firstTs, lastTs=$lastTs, messageCount=$messageCount,
        inputTokens=$inputTokens, outputTokens=$outputTokens, cacheReadTokens=$cacheReadTokens,
        cacheCreationTokens=$cacheCreationTokens, sizeBytes=$sizeBytes, mtimeMs=$mtimeMs,
        indexedBytes=$indexedBytes, hasSubagents=$hasSubagents
    `);
    this.selectOne = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM sessions s LEFT JOIN session_meta m USING (sessionId) WHERE s.sessionId = ?`,
    );
  }

  /**
   * Stand up the message-text mirror used by search. Prefer FTS5 (fast MATCH +
   * built-in snippet/rank), but node:sqlite's bundled SQLite may be compiled
   * without it — if CREATE VIRTUAL TABLE throws, fall back to a plain table we
   * scan with LIKE. Returns the mode actually in effect.
   */
  private initSearchStore(): "fts5" | "like" {
    try {
      // toolName is UNINDEXED (carried for display, not matched). FTS5 columns are
      // fixed at create time, so a fresh index.db is required to pick this up.
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
           sessionId UNINDEXED, role UNINDEXED, seq UNINDEXED, toolName UNINDEXED, text
         )`,
      );
      return "fts5";
    } catch {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS messages_text (
           sessionId TEXT NOT NULL,
           role TEXT,
           seq INTEGER,
           toolName TEXT,
           text TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_messages_text_session ON messages_text(sessionId);
         CREATE INDEX IF NOT EXISTS idx_messages_text_text ON messages_text(text);`,
      );
      return "like";
    }
  }

  close(): void {
    this.db.close();
  }

  private getRow(sessionId: string): Row | undefined {
    return this.selectOne.get(sessionId) as Row | undefined;
  }

  /** Index (or incrementally update) a single session file. */
  async indexSession(
    filePath: string,
  ): Promise<"added" | "updated" | "unchanged" | "error"> {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return "error";
    }
    const sessionId = path.basename(filePath, ".jsonl");
    const mtimeMs = Math.floor(st.mtimeMs);
    const existing = this.getRow(sessionId);

    if (existing && existing.sizeBytes === st.size && existing.mtimeMs === mtimeMs) {
      return "unchanged";
    }

    const incremental =
      !!existing && existing.indexedBytes > 0 && st.size > existing.indexedBytes;
    const startByte = incremental ? existing!.indexedBytes : 0;

    let messageCount = incremental ? existing!.messageCount : 0;
    const usage: TokenUsage = incremental
      ? {
          inputTokens: existing!.inputTokens,
          outputTokens: existing!.outputTokens,
          cacheReadTokens: existing!.cacheReadTokens,
          cacheCreationTokens: existing!.cacheCreationTokens,
        }
      : { ...EMPTY_USAGE };
    let cwd = incremental ? existing!.cwd : null;
    let gitBranch = incremental ? existing!.gitBranch : null;
    let firstTs = incremental ? existing!.firstTs : null;
    let lastTs = incremental ? existing!.lastTs : null;
    let aiTitle: string | null = null;
    let summary: string | null = null;
    let firstPrompt: string | null = null;

    // Mirror renderable text for search. On incremental runs we append after the
    // rows already stored, so continue the seq from the prior messageCount.
    const searchTexts: SearchText[] = [];
    let searchSeq = incremental ? messageCount : 0;

    for await (const raw of streamRawLines(filePath, { startByte })) {
      const type = typeof raw.type === "string" ? raw.type : "";
      const ts = typeof raw.timestamp === "string" ? raw.timestamp : null;
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }
      if (!cwd && typeof raw.cwd === "string") cwd = raw.cwd;
      if (gitBranch === null && typeof raw.gitBranch === "string") gitBranch = raw.gitBranch;
      if (type === "user" || type === "assistant") {
        messageCount++;
        const text = renderableText(type, raw.message);
        if (text) {
          searchTexts.push({ role: type, seq: searchSeq, text, toolName: null });
        }
        // Mirror tool I/O (assistant tool_use lines + user tool_result bodies) so
        // search covers what tools were run and what they returned. Same message
        // seq; counting/usage above is unchanged.
        for (const tt of toolTexts(type, raw.message, searchSeq)) {
          searchTexts.push(tt);
        }
        searchSeq++;
      }
      if (type === "assistant") {
        const u = usageFromMessage(raw.message);
        if (u) {
          usage.inputTokens += u.inputTokens;
          usage.outputTokens += u.outputTokens;
          usage.cacheReadTokens += u.cacheReadTokens;
          usage.cacheCreationTokens += u.cacheCreationTokens;
        }
      }
      if (type === "ai-title" && typeof raw.aiTitle === "string") aiTitle = raw.aiTitle;
      if (type === "summary" && typeof raw.summary === "string") summary = raw.summary;
      if (!firstPrompt && type === "user") {
        const content = (raw.message as Record<string, unknown> | undefined)?.content;
        if (
          typeof content === "string" &&
          content.trim() &&
          raw.isMeta !== true &&
          !isCommandOrMetaPrompt(content)
        ) {
          firstPrompt = content.trim().slice(0, 120);
        }
      }
    }

    let title = incremental ? existing!.title : null;
    let titleSource: TitleSource | null = incremental
      ? (existing!.titleSource as TitleSource | null)
      : null;
    if (aiTitle) {
      title = aiTitle;
      titleSource = "ai-title";
    } else if (!incremental && summary) {
      title = summary;
      titleSource = "summary";
    } else if (!incremental && firstPrompt) {
      title = firstPrompt;
      titleSource = "first-prompt";
    } else if (incremental && summary && titleSource !== "ai-title") {
      title = summary;
      titleSource = "summary";
    }
    if (!title) {
      title = sessionId.slice(0, 8);
      titleSource = "session-id";
    }

    const projectId = cwd ? projectIdFromCwd(cwd) : null;
    const sessionDir = path.join(path.dirname(filePath), sessionId);
    const hasSubagents = existsSync(path.join(sessionDir, "subagents")) ? 1 : 0;

    // Single transaction: keep the session row and its mirrored search text in
    // lockstep. On a FULL re-index (startByte===0) we replace the session's search
    // rows; on incremental we just append the newly-seen lines.
    this.db.exec("BEGIN");
    try {
      this.upsert.run({
        sessionId,
        filePath,
        cwd,
        projectId,
        title,
        titleSource,
        gitBranch,
        firstTs,
        lastTs,
        messageCount,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        sizeBytes: st.size,
        mtimeMs,
        indexedBytes: st.size,
        hasSubagents,
      });
      this.writeSearchText(sessionId, searchTexts, startByte === 0);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return existing ? "updated" : "added";
  }

  /**
   * Persist mirrored message text for one session. `full` (startByte===0) clears
   * any prior rows for the session first; incremental runs append. Works against
   * whichever store is active (FTS5 virtual table or plain table) — same columns.
   */
  private writeSearchText(sessionId: string, rows: SearchText[], full: boolean): void {
    const table = this.searchMode === "fts5" ? "messages_fts" : "messages_text";
    if (full) {
      this.db.prepare(`DELETE FROM ${table} WHERE sessionId = ?`).run(sessionId);
    }
    if (rows.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO ${table} (sessionId, role, seq, toolName, text) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(sessionId, r.role, r.seq, r.toolName, r.text);
    }
  }

  // -- Reads -----------------------------------------------------------------

  getSessionSummary(sessionId: string): SessionSummary | undefined {
    const row = this.getRow(sessionId);
    return row ? rowToSummary(row) : undefined;
  }

  getSessionsForProject(projectId: string): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLS} FROM sessions s LEFT JOIN session_meta m USING (sessionId)
         WHERE s.projectId = ? ORDER BY COALESCE(m.pinned,0) DESC, s.lastTs DESC`,
      )
      .all(projectId) as unknown as Row[];
    return rows.map(rowToSummary);
  }

  private allRows(): Row[] {
    return this.db
      .prepare(`SELECT ${SELECT_COLS} FROM sessions s LEFT JOIN session_meta m USING (sessionId)`)
      .all() as unknown as Row[];
  }

  getProjects(): ProjectSummary[] {
    const byId = new Map<string, { rows: Row[]; folders: Set<string> }>();
    for (const row of this.allRows()) {
      if (!row.projectId || !row.cwd) continue;
      let g = byId.get(row.projectId);
      if (!g) {
        g = { rows: [], folders: new Set() };
        byId.set(row.projectId, g);
      }
      g.rows.push(row);
      g.folders.add(path.basename(path.dirname(row.filePath)));
    }
    const projects: ProjectSummary[] = [];
    for (const [id, g] of byId) {
      const cwd = g.rows[0]!.cwd!;
      let usage: TokenUsage = { ...EMPTY_USAGE };
      let last: string | null = null;
      for (const r of g.rows) {
        usage.inputTokens += r.inputTokens;
        usage.outputTokens += r.outputTokens;
        usage.cacheReadTokens += r.cacheReadTokens;
        usage.cacheCreationTokens += r.cacheCreationTokens;
        if (r.lastTs && (!last || r.lastTs > last)) last = r.lastTs;
      }
      projects.push({
        id,
        cwd,
        name: projectName(cwd),
        sessionCount: g.rows.length,
        lastActivity: last,
        totalUsage: usage,
        encodedFolders: [...g.folders],
      });
    }
    projects.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
    return projects;
  }

  getSessionCount(): number {
    return n((this.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: unknown }).c);
  }

  /**
   * Each session's last-activity timestamp (ISO `lastTs`), for activity bucketing.
   * Skips sessions that never recorded a timestamp.
   */
  getActivityDates(): string[] {
    const rows = this.db
      .prepare("SELECT lastTs FROM sessions WHERE lastTs IS NOT NULL")
      .all() as unknown as Array<{ lastTs: string | null }>;
    return rows.map((r) => r.lastTs).filter((t): t is string => !!t);
  }

  /**
   * Cross-project full-text search over mirrored message text. Returns the best
   * matching hit per session (deduped), newest sessions first. FTS5 mode uses
   * MATCH + rank + snippet(); LIKE mode scans `text LIKE %query%` and builds the
   * excerpt by hand. Joins `sessions` (which already excludes claude-mem noise)
   * for project/title/cwd/timestamp.
   */
  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const lim = Math.max(1, Math.min(limit, 500));
    return this.searchMode === "fts5"
      ? this.searchFts(q, lim)
      : this.searchLike(q, lim);
  }

  private searchFts(query: string, limit: number): SearchHit[] {
    // Parse the query into a real FTS5 MATCH expression (AND-ed terms, phrases,
    // prefix*, -exclusion). A pure-negation query has nothing to match -> [].
    const match = buildMatchExpr(query);
    if (!match) return [];

    // Pick ONE best (lowest-rank) row per session IN SQL via ROW_NUMBER(), keep the
    // top `limit` sessions, then re-join `messages_fts` (with MATCH so snippet() has
    // its query context — snippet() can't be used inside a window subquery) to render
    // the excerpt. `text` is column index 4 now that toolName precedes it.
    const rows = this.db
      .prepare(
        `WITH ranked AS (
           SELECT f.rowid AS rid,
                  ROW_NUMBER() OVER (PARTITION BY f.sessionId ORDER BY rank) AS rn,
                  rank AS rnk
           FROM messages_fts f
           WHERE messages_fts MATCH ?1
         ),
         best AS (
           SELECT rid, rnk FROM ranked WHERE rn = 1 ORDER BY rnk LIMIT ?2
         )
         SELECT f.sessionId AS sessionId, f.role AS role, f.toolName AS toolName,
                snippet(messages_fts, 4, '[', ']', '…', 12) AS excerpt,
                s.projectId AS projectId, s.cwd AS cwd, s.lastTs AS lastTs,
                s.title AS title, s.titleSource AS titleSource,
                m.customTitle AS customTitle
         FROM best
         JOIN messages_fts f ON f.rowid = best.rid AND messages_fts MATCH ?1
         JOIN sessions s ON s.sessionId = f.sessionId
         LEFT JOIN session_meta m ON m.sessionId = f.sessionId
         ORDER BY best.rnk`,
      )
      .all(match, limit) as unknown as Array<{
      sessionId: string;
      role: string;
      toolName: string | null;
      excerpt: string | null;
      projectId: string | null;
      cwd: string | null;
      lastTs: string | null;
      title: string | null;
      titleSource: string | null;
      customTitle: string | null;
    }>;

    return rows.map((r) => this.toHit(r, (r.excerpt ?? "").trim()));
  }

  private searchLike(query: string, limit: number): SearchHit[] {
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
    const where = clauses.join(" AND ");

    // Pick the newest row per session (ROW_NUMBER) and cap to `limit` sessions in SQL.
    const rows = this.db
      .prepare(
        `WITH matched AS (
           SELECT t.sessionId AS sessionId, t.role AS role, t.toolName AS toolName, t.text AS text,
                  ROW_NUMBER() OVER (PARTITION BY t.sessionId ORDER BY t.seq DESC) AS rn
           FROM messages_text t
           WHERE ${where}
         )
         SELECT mt.sessionId AS sessionId, mt.role AS role, mt.toolName AS toolName, mt.text AS text,
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
    return rows.map((r) => this.toHit(r, likeExcerpt(r.text ?? "", focus)));
  }

  /** Shared row -> SearchHit mapping (title precedence: custom > stored title). */
  private toHit(
    r: {
      sessionId: string;
      role: string;
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
    };
  }

  // -- Sidecar custom data (rename/pin/tags) ---------------------------------

  setCustomTitle(sessionId: string, title: string | null): void {
    this.db
      .prepare(
        `INSERT INTO session_meta (sessionId, customTitle) VALUES (?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET customTitle = excluded.customTitle`,
      )
      .run(sessionId, title);
  }

  setPinned(sessionId: string, pinned: boolean): void {
    this.db
      .prepare(
        `INSERT INTO session_meta (sessionId, pinned) VALUES (?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET pinned = excluded.pinned`,
      )
      .run(sessionId, pinned ? 1 : 0);
  }
}

function rowToSummary(row: Row): SessionSummary {
  const custom = row.customTitle && row.customTitle.trim() ? row.customTitle.trim() : null;
  return {
    sessionId: row.sessionId,
    filePath: row.filePath,
    cwd: row.cwd,
    projectId: row.projectId ?? "unknown",
    title: custom ?? row.title ?? row.sessionId.slice(0, 8),
    titleSource: custom ? "custom" : ((row.titleSource as TitleSource | null) ?? "session-id"),
    gitBranch: row.gitBranch,
    firstTimestamp: row.firstTs,
    lastTimestamp: row.lastTs,
    messageCount: n(row.messageCount),
    usage: {
      inputTokens: n(row.inputTokens),
      outputTokens: n(row.outputTokens),
      cacheReadTokens: n(row.cacheReadTokens),
      cacheCreationTokens: n(row.cacheCreationTokens),
    },
    sizeBytes: n(row.sizeBytes),
    mtimeMs: n(row.mtimeMs),
    hasSubagents: row.hasSubagents === 1,
    pinned: n(row.pinned) === 1,
    indexed: true,
  };
}
