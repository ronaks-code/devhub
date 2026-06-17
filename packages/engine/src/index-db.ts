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
import { stat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { appDataDir, projectIdFromCwd, projectName } from "./paths.js";
import { scanSession, emptySeed } from "./parse-session.js";
import type { ScanSeed, ScanResult, SearchText } from "./parse-session.js";
import { workerScanEnabled, runScanInWorker, closeScanWorker } from "./index-worker.js";
import { runMigrations } from "./migrations.js";
import { archiveSession } from "./archive.js";
import { SettingsStore } from "./settings.js";
import { ProjectMetaStore } from "./project-meta.js";
import type { ProjectMetaPatch } from "./project-meta.js";
import { TagStore, parseTags } from "./tags.js";
import { SavedViewStore } from "./saved-views.js";
import type { SavedView, SaveViewInput } from "./saved-views.js";
import { AuditStore } from "./audit.js";
import { MessageSearch } from "./search.js";
import type { SearchFacets } from "./search.js";
import {
  FTS_TABLE,
  createFtsTableSql,
  createLikeTableSql,
  detectFtsTokenizer,
  tokenizerOf,
} from "./fts-schema.js";
import type { FtsTokenizer } from "./fts-schema.js";
import { listAllSessions } from "./all-sessions.js";
import type { ListAllSessionsOptions } from "./all-sessions.js";
import { AggregateCache } from "./aggregates.js";
import { dailyUsage } from "./rollups.js";
import type { DailyUsage, DailyUsageOptions } from "./rollups.js";
import type {
  ProjectMeta,
  ProjectSummary,
  SearchHit,
  SessionSummary,
  TitleSource,
} from "./types.js";

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
  model: string | null;
  headSig: string | null;
  customTitle: string | null;
  pinned: number;
  tags: string | null;
  archived: number;
  notes: string | null;
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
  hasSubagents INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  headSig TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId);
CREATE INDEX IF NOT EXISTS idx_sessions_lastTs ON sessions(lastTs);

CREATE TABLE IF NOT EXISTS session_meta (
  sessionId TEXT PRIMARY KEY,
  customTitle TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  facets TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT,
  toolName TEXT NOT NULL,
  decision TEXT NOT NULL,
  scope TEXT,
  reason TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permission_audit_session ON permission_audit(sessionId);
`;

const SELECT_COLS = `
  s.sessionId, s.filePath, s.cwd, s.projectId, s.title, s.titleSource, s.gitBranch,
  s.firstTs, s.lastTs, s.messageCount, s.inputTokens, s.outputTokens,
  s.cacheReadTokens, s.cacheCreationTokens, s.sizeBytes, s.mtimeMs, s.indexedBytes,
  s.hasSubagents, s.model, s.headSig, m.customTitle, COALESCE(m.pinned, 0) AS pinned, m.tags,
  COALESCE(m.archived, 0) AS archived, m.notes
`;

function n(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

// Load node:sqlite via require so bundlers/test-runners (Vite/vitest) don't try to
// resolve this newer builtin through their module graph — Node resolves it natively.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

// The per-line parse helpers (renderableText/toolTexts/messageModel) and the
// MAX_SEARCH_TEXT/MAX_TOOL_RESULT_TEXT caps + the SearchText shape now live in
// parse-session.ts, the single source of truth shared with the indexing worker.

/**
 * Bytes of the transcript HEAD fingerprinted to detect a prefix rewrite / rotation.
 * Claude Code transcripts are append-only, so identical leading bytes mean the file
 * grew by appending; if these bytes change, the file was REWRITTEN (rotated /
 * re-created / corrupted) and must be re-indexed from byte 0. 4 KiB comfortably
 * spans several leading JSONL lines (the session header + first turns).
 */
const HEAD_SIG_BYTES = 4096;

/**
 * Fingerprint of a transcript's first {@link HEAD_SIG_BYTES} bytes: a sha1 of the
 * leading bytes, prefixed with how many bytes were actually read (so a file shorter
 * than the window still produces a stable, length-aware signature). Returns null on
 * any read error (a null signature is treated as "unknown" by the change detector,
 * which then falls back to size-based heuristics). Reads at most one small chunk —
 * cheap even for a multi-hundred-MB transcript.
 */
async function readHeadSig(filePath: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_SIG_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_SIG_BYTES, 0);
    const hash = createHash("sha1").update(buf.subarray(0, bytesRead)).digest("hex");
    return `${bytesRead}:${hash}`;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

export class TranscriptIndex {
  private db: SqliteDatabase;
  private upsert: StatementSync;
  private selectOne: StatementSync;
  /** User preferences, sharing this index's DB connection. */
  readonly settings: SettingsStore;
  /** Per-project UI metadata (favorite/archived/order/color), sharing this DB. */
  readonly projectMeta: ProjectMetaStore;
  /** Per-session tags (session_meta.tags JSON array), sharing this DB. */
  readonly tags: TagStore;
  /** Saved views / smart folders (saved_views table), sharing this DB. */
  readonly savedViews: SavedViewStore;
  /** Permission-decision audit log (permission_audit table), sharing this DB. */
  readonly audit: AuditStore;
  /** Which search backend is active: FTS5 virtual table, or a plain LIKE-scanned table. */
  readonly searchMode: "fts5" | "like";
  /**
   * The FTS5 tokenizer actually in effect (trigram > porter > unicode61), or null in
   * LIKE mode. Reported for diagnostics — trigram gives substring/code-token search.
   */
  readonly ftsTokenizer: FtsTokenizer | null;
  /** Full-text search over mirrored message text (shares this DB + searchMode). */
  private readonly searcher: MessageSearch;
  /** Memoized project/stats rollups, invalidated on every session write. */
  private readonly aggregates: AggregateCache;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(appDataDir(), "index.db");
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Concurrency/throughput pragmas. WAL + synchronous=NORMAL is the recommended
    // durable-enough/fast combo; busy_timeout lets the watcher and indexAll wait
    // out a brief lock instead of throwing SQLITE_BUSY; mmap/cache speed reads.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA mmap_size = 268435456;"); // 256 MB
    this.db.exec("PRAGMA cache_size = -16000;"); // ~16 MB page cache
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // Apply additive schema migrations BEFORE preparing statements that may depend
    // on migrated columns/tables.
    runMigrations(this.db);
    this.settings = new SettingsStore(this.db);
    this.projectMeta = new ProjectMetaStore(this.db);
    this.tags = new TagStore(this.db);
    this.savedViews = new SavedViewStore(this.db);
    this.audit = new AuditStore(this.db);
    const store = this.initSearchStore();
    this.searchMode = store.mode;
    this.ftsTokenizer = store.tokenizer;
    this.searcher = new MessageSearch(this.db, this.searchMode);
    this.aggregates = new AggregateCache(this.db);
    this.upsert = this.db.prepare(`
      INSERT INTO sessions (
        sessionId, filePath, cwd, projectId, title, titleSource, gitBranch,
        firstTs, lastTs, messageCount, inputTokens, outputTokens,
        cacheReadTokens, cacheCreationTokens, sizeBytes, mtimeMs, indexedBytes, hasSubagents, model, headSig
      ) VALUES (
        $sessionId, $filePath, $cwd, $projectId, $title, $titleSource, $gitBranch,
        $firstTs, $lastTs, $messageCount, $inputTokens, $outputTokens,
        $cacheReadTokens, $cacheCreationTokens, $sizeBytes, $mtimeMs, $indexedBytes, $hasSubagents, $model, $headSig
      )
      ON CONFLICT(sessionId) DO UPDATE SET
        filePath=$filePath, cwd=$cwd, projectId=$projectId, title=$title, titleSource=$titleSource,
        gitBranch=$gitBranch, firstTs=$firstTs, lastTs=$lastTs, messageCount=$messageCount,
        inputTokens=$inputTokens, outputTokens=$outputTokens, cacheReadTokens=$cacheReadTokens,
        cacheCreationTokens=$cacheCreationTokens, sizeBytes=$sizeBytes, mtimeMs=$mtimeMs,
        indexedBytes=$indexedBytes, hasSubagents=$hasSubagents, model=$model, headSig=$headSig
    `);
    this.selectOne = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM sessions s LEFT JOIN session_meta m USING (sessionId) WHERE s.sessionId = ?`,
    );
  }

  /**
   * Stand up the message-text mirror used by search. Prefer FTS5 (fast MATCH +
   * built-in snippet/rank), but node:sqlite's bundled SQLite may be compiled without
   * it — if no FTS5 tokenizer can be created, fall back to a plain table we scan with
   * LIKE. The FTS DDL + tokenizer detection live in fts-schema.ts (single source of
   * truth); migration v8 has already rebuilt any LEGACY messages_fts onto the best
   * tokenizer by the time we get here, so on an existing DB we just adopt that table
   * (and report its tokenizer). On a fresh DB we CREATE it directly on the best
   * tokenizer (trigram > porter > unicode61) so substring/code-token search works
   * from the first index pass. Returns the mode + active tokenizer.
   */
  private initSearchStore(): { mode: "fts5" | "like"; tokenizer: FtsTokenizer | null } {
    // If a messages_fts already exists (created earlier, possibly rebuilt by v8),
    // adopt it and report its tokenizer — don't recreate.
    const existing = tokenizerOf(this.db, FTS_TABLE);
    if (existing) return { mode: "fts5", tokenizer: existing };

    const tokenizer = detectFtsTokenizer(this.db);
    if (tokenizer) {
      // Fresh DB (or one that lost its FTS table): create on the best tokenizer.
      this.db.exec(createFtsTableSql(FTS_TABLE, tokenizer, { ifNotExists: true }));
      return { mode: "fts5", tokenizer };
    }
    // FTS5 unavailable in this build — fall back to a plain LIKE-scanned table.
    this.db.exec(createLikeTableSql());
    return { mode: "like", tokenizer: null };
  }

  close(): void {
    // Tear down the (optional) index worker. It's unref()'d so it never blocks exit;
    // terminate is best-effort and async, so we don't await it here (close stays sync).
    void closeScanWorker();
    this.db.close();
  }

  private getRow(sessionId: string): Row | undefined {
    return this.selectOne.get(sessionId) as Row | undefined;
  }

  /**
   * Run the PARSE phase for one session — the only CPU-heavy part of indexing.
   * DEFAULT: synchronous, in-process {@link scanSession} (behavior unchanged). When
   * `CLAUDE_UI_INDEX_WORKER` is set, offload it to a worker thread instead; the worker
   * runs the SAME scanSession (identical output) and only READS the file — this thread
   * still does every DB write. A worker failure falls back to the synchronous scan so
   * a broken worker can never lose an index pass.
   */
  private async scanFile(
    filePath: string,
    startByte: number,
    seed: ScanSeed,
  ): Promise<ScanResult> {
    if (workerScanEnabled()) {
      try {
        return await runScanInWorker(filePath, startByte, seed);
      } catch (err) {
        console.warn(`[engine] index worker scan failed for ${filePath}; using sync:`, err);
      }
    }
    return scanSession(filePath, startByte, seed);
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

    // Fingerprint the file head. Transcripts are APPEND-ONLY, so the leading bytes
    // are stable as a file grows — a changed head means the file was rewritten
    // (rotated / re-created / corrupted), not appended to.
    const headSig = await readHeadSig(filePath);

    // Incremental (read only the appended tail) is safe ONLY when the file grew AND
    // its head is byte-for-byte unchanged. If the head changed (prefix rewrite), or
    // we can't fingerprint it, or it shrank, fall back to a FULL re-index from byte 0
    // so a rewritten transcript can never be read as a bogus "append" onto stale
    // offsets. (A shrunken file already wouldn't satisfy st.size > indexedBytes.)
    const headUnchanged =
      !!existing &&
      existing.headSig != null &&
      headSig != null &&
      existing.headSig === headSig;
    const incremental =
      !!existing && existing.indexedBytes > 0 && st.size > existing.indexedBytes && headUnchanged;
    const startByte = incremental ? existing!.indexedBytes : 0;

    // Seed the parse phase: on an incremental pass we carry the prior accumulators
    // forward; on a full pass we start from zero. `incumbentModel` (the already-stored
    // model) is preferred on a tie so a single new differing line doesn't flip a
    // session that ran mostly on another model. searchSeq continues after the rows
    // already stored on an incremental pass.
    const incumbentModel: string | null = incremental ? existing!.model : null;
    const seed: ScanSeed = incremental
      ? {
          messageCount: existing!.messageCount,
          usage: {
            inputTokens: existing!.inputTokens,
            outputTokens: existing!.outputTokens,
            cacheReadTokens: existing!.cacheReadTokens,
            cacheCreationTokens: existing!.cacheCreationTokens,
          },
          cwd: existing!.cwd,
          gitBranch: existing!.gitBranch,
          firstTs: existing!.firstTs,
          lastTs: existing!.lastTs,
          incumbentModel,
          startSeq: existing!.messageCount,
        }
      : emptySeed();

    // Scan the (appended) bytes. Off-loaded to a worker thread when the worker path
    // is enabled (CLAUDE_UI_INDEX_WORKER); otherwise scanned synchronously in-process.
    // Either way the parsed output is byte-for-byte identical (same scanSession code),
    // and the DB write below stays single-writer on this thread.
    const scan = await this.scanFile(filePath, startByte, seed);

    const { messageCount, usage, cwd, gitBranch, firstTs, lastTs } = scan;
    const lastModel = scan.lastModel;

    let title = incremental ? existing!.title : null;
    let titleSource: TitleSource | null = incremental
      ? (existing!.titleSource as TitleSource | null)
      : null;
    if (scan.aiTitle) {
      title = scan.aiTitle;
      titleSource = "ai-title";
    } else if (!incremental && scan.summary) {
      title = scan.summary;
      titleSource = "summary";
    } else if (!incremental && scan.firstPrompt) {
      title = scan.firstPrompt;
      titleSource = "first-prompt";
    } else if (incremental && scan.summary && titleSource !== "ai-title") {
      title = scan.summary;
      titleSource = "summary";
    }
    if (!title) {
      title = sessionId.slice(0, 8);
      titleSource = "session-id";
    }

    // Resolve the session's model: the most-frequent assistant model. Ties prefer
    // the incumbent (the already-stored model, so an incremental pass doesn't flip on
    // a single new line), then the last one seen. Falls through to the prior
    // value/null when no assistant line carried a model.
    let model: string | null = null;
    let bestCount = -1;
    const tiePriority = (id: string): number => (id === incumbentModel ? 2 : id === lastModel ? 1 : 0);
    for (const [id, count] of scan.modelCounts) {
      if (count > bestCount || (count === bestCount && model !== null && tiePriority(id) > tiePriority(model))) {
        bestCount = count;
        model = id;
      }
    }
    if (!model) model = lastModel;

    const searchTexts = scan.searchTexts;
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
        model,
        headSig,
      });
      this.writeSearchText(sessionId, searchTexts, startByte === 0);
      this.db.exec("COMMIT");
      // A session's tokens/cost/activity changed — drop the memoized rollups so the
      // next getProjects/getStats recomputes against the fresh data.
      this.aggregates.invalidate();
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Durably archive a gzipped copy so the session stays viewable after Claude
    // Code's ~30-day transcript auto-delete. Best-effort and isolated from the
    // index transaction: an archive failure must not fail indexing.
    try {
      await archiveSession(filePath, sessionId);
    } catch (err) {
      console.warn(`[engine] failed to archive session ${sessionId}:`, err);
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

  getSessionsForProject(
    projectId: string,
    opts: { includeArchived?: boolean } = {},
  ): SessionSummary[] {
    // Archived sessions are hidden by default (COALESCE: a NULL/missing meta row is
    // not archived). includeArchived drops the filter.
    const archivedFilter = opts.includeArchived ? "" : " AND COALESCE(m.archived, 0) = 0";
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLS} FROM sessions s LEFT JOIN session_meta m USING (sessionId)
         WHERE s.projectId = ?${archivedFilter} ORDER BY COALESCE(m.pinned,0) DESC, s.lastTs DESC`,
      )
      .all(projectId) as unknown as Row[];
    return rows.map(rowToSummary);
  }

  /**
   * Cross-project session listing for a global "All Sessions" view. Reuses this
   * index (one query, no transcript reads); see {@link listAllSessions} for the
   * sort/filter/paging options. Returns SessionSummary[] across ALL projects.
   * Archived sessions are excluded unless `opts.includeArchived` is set.
   */
  listAllSessions(opts: ListAllSessionsOptions = {}): SessionSummary[] {
    return listAllSessions<Row>(this.db, SELECT_COLS, rowToSummary, opts);
  }

  /**
   * Per-day token & cost time series (oldest→newest), bucketed by each session's
   * last-activity day. Delegates to the `rollups` module, which owns the query +
   * aggregation. Optional since/until/projectId filters narrow the window.
   */
  dailyUsage(opts: DailyUsageOptions = {}): DailyUsage[] {
    return dailyUsage(this.db, opts);
  }

  /**
   * Projects grouped by true cwd, decorated with the user's per-project metadata
   * (favorite/archived/sortOrder/color). Ordering: favorites first, then by
   * sortOrder ascending (manual hint), then most-recent activity. Archived projects
   * are HIDDEN unless `opts.includeArchived` is set.
   */
  getProjects(opts: { includeArchived?: boolean } = {}): ProjectSummary[] {
    // Heavy per-project token/activity/folder rollups come from SQL GROUP BY
    // (memoized + invalidated on write) instead of summing every row in JS here.
    const rollups = this.aggregates.projectRollups();
    const meta = this.projectMeta.getAll();
    const projects: ProjectSummary[] = [];
    for (const g of rollups) {
      const m = meta.get(g.projectId);
      if (m?.archived && !opts.includeArchived) continue; // hidden by default
      projects.push({
        id: g.projectId,
        cwd: g.cwd,
        name: projectName(g.cwd),
        sessionCount: g.sessionCount,
        lastActivity: g.lastActivity,
        totalUsage: g.totalUsage,
        encodedFolders: g.encodedFolders,
        favorite: m?.favorite ?? false,
        archived: m?.archived ?? false,
        sortOrder: m?.sortOrder ?? 0,
        color: m?.color ?? null,
        defaultModel: m?.defaultModel ?? null,
        defaultPermissionMode: m?.defaultPermissionMode ?? null,
      });
    }
    projects.sort((a, b) => {
      // Favorites float to the top.
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      // Then the manual sortOrder hint (lower first).
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      // Then most-recent activity.
      return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
    });
    return projects;
  }

  // -- Per-project UI metadata (favorite/archived/order/color) ---------------

  /** Read one project's UI metadata (defaults when never customized). */
  getProjectMeta(projectId: string): ProjectMeta {
    return this.projectMeta.get(projectId);
  }

  /** Merge a partial UI-metadata update for one project; returns the new value. */
  setProjectMeta(projectId: string, patch: ProjectMetaPatch): ProjectMeta {
    return this.projectMeta.set(projectId, patch);
  }

  getSessionCount(): number {
    return n((this.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: unknown }).c);
  }

  /**
   * APPROXIMATE USD cost per project, computed PER SESSION (so each session's own
   * model picks its pricing tier) and rolled up by projectId. Returns a map of
   * projectId -> total USD; the caller sums it for the grand total. Sessions with a
   * null projectId are bucketed under "unknown".
   */
  getCostByProject(): Map<string, number> {
    return this.aggregates.costByProject();
  }

  /**
   * APPROXIMATE usage rolled up BY MODEL: per-model token total, USD cost, and the
   * number of sessions that ran on that model. Cost is computed per session (each
   * priced by its own model) so the model's own pricing tier applies. Sessions with
   * a null/unknown model bucket under "unknown" (and use fallback pricing). Sorted by
   * cost descending. Powers the dashboard's per-model spend breakdown.
   */
  getUsageByModel(): Array<{ model: string; tokens: number; costUsd: number; sessions: number }> {
    return this.aggregates.usageByModel();
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
   * Cross-project full-text search over mirrored message text. Delegates to the
   * `MessageSearch` module (which owns the FTS5/LIKE backends, query parsing, and
   * row→hit mapping). Backward-compatible: `search(query)` and `search(query, n)`
   * keep the original behavior; pass a facets object to narrow by
   * projectId/role/toolName/since/until/gitBranch.
   */
  search(query: string, facets: number | SearchFacets = {}): SearchHit[] {
    // Tolerate the legacy positional `limit` arg (search(q, 50)) for callers that
    // predate facets, while preferring the richer { limit, ...facets } object.
    const opts = typeof facets === "number" ? { limit: facets } : facets;
    return this.searcher.search(query, opts);
  }

  /**
   * ALL matching message rows within a SINGLE session (not deduped to one best
   * hit), ordered by in-session `seq`. Powers an expandable "all matches in this
   * conversation" view. Delegates to {@link MessageSearch.searchInSession}.
   */
  searchInSession(sessionId: string, query: string, opts: { limit?: number } = {}): SearchHit[] {
    return this.searcher.searchInSession(sessionId, query, opts);
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

  /**
   * Archive (or un-archive) a session. Archived sessions drop out of
   * getSessionsForProject / listAllSessions (and so out of getProjects' session
   * lists) unless an includeArchived flag is passed. Our own flag in session_meta —
   * never touches the transcript.
   */
  setArchived(sessionId: string, archived: boolean): void {
    this.db
      .prepare(
        `INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived`,
      )
      .run(sessionId, archived ? 1 : 0);
  }

  /** Read one session's tags (normalized; empty when untagged). */
  getTags(sessionId: string): string[] {
    return this.tags.get(sessionId);
  }

  /** Replace a session's tags (normalized on write); returns the persisted set. */
  setTags(sessionId: string, tags: string[]): string[] {
    return this.tags.set(sessionId, tags);
  }

  /** Every distinct tag in use with its session count (count desc, then name asc). */
  getAllTags(): Array<{ tag: string; count: number }> {
    return this.tags.getAll();
  }

  /**
   * Read a session's free-form notes (markdown), or null when none. Our own data in
   * session_meta.notes; never derived from the transcript.
   */
  getNotes(sessionId: string): string | null {
    const row = this.db
      .prepare("SELECT notes FROM session_meta WHERE sessionId = ?")
      .get(sessionId) as { notes: string | null } | undefined;
    const notes = row?.notes;
    return typeof notes === "string" && notes.trim() ? notes : null;
  }

  /**
   * Set (or clear) a session's notes. A blank/whitespace-only value stores NULL so
   * the row reads back as "no notes". Stored in session_meta — never touches the
   * transcript.
   */
  setNotes(sessionId: string, md: string | null): void {
    const value = typeof md === "string" && md.trim() ? md : null;
    this.db
      .prepare(
        `INSERT INTO session_meta (sessionId, notes) VALUES (?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET notes = excluded.notes`,
      )
      .run(sessionId, value);
  }

  /** All saved views (smart folders), newest first. */
  listSavedViews(): SavedView[] {
    return this.savedViews.list();
  }

  /** Persist a new saved view; returns the stored view (with id + createdAt). */
  saveView(input: SaveViewInput): SavedView {
    return this.savedViews.save(input);
  }

  /** Delete a saved view by id; returns true when a row was removed. */
  deleteView(id: number): boolean {
    return this.savedViews.delete(id);
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
    model: row.model ?? null,
    pinned: n(row.pinned) === 1,
    archived: n(row.archived) === 1,
    tags: parseTags(row.tags),
    notes: row.notes && row.notes.trim() ? row.notes : null,
    indexed: true,
  };
}
