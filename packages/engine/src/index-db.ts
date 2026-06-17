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
import { streamRawLines, usageFromMessage, isCommandOrMetaPrompt } from "./parser.js";
import { runMigrations } from "./migrations.js";
import { archiveSession } from "./archive.js";
import { SettingsStore } from "./settings.js";
import { ProjectMetaStore } from "./project-meta.js";
import type { ProjectMetaPatch } from "./project-meta.js";
import { TagStore, parseTags } from "./tags.js";
import { MessageSearch } from "./search.js";
import type { SearchFacets } from "./search.js";
import { costUsd } from "./pricing.js";
import { listAllSessions } from "./all-sessions.js";
import type { ListAllSessionsOptions } from "./all-sessions.js";
import { dailyUsage } from "./rollups.js";
import type { DailyUsage, DailyUsageOptions } from "./rollups.js";
import type {
  ProjectMeta,
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
  model: string | null;
  headSig: string | null;
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
  tags TEXT
);
`;

const SELECT_COLS = `
  s.sessionId, s.filePath, s.cwd, s.projectId, s.title, s.titleSource, s.gitBranch,
  s.firstTs, s.lastTs, s.messageCount, s.inputTokens, s.outputTokens,
  s.cacheReadTokens, s.cacheCreationTokens, s.sizeBytes, s.mtimeMs, s.indexedBytes,
  s.hasSubagents, s.model, s.headSig, m.customTitle, COALESCE(m.pinned, 0) AS pinned, m.tags
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

/** Pull a non-empty `message.model` string off an assistant transcript line, or null. */
function messageModel(message: unknown): string | null {
  const m =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const mdl = m?.model;
  return typeof mdl === "string" && mdl.trim() ? mdl.trim() : null;
}

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

// Load node:sqlite via require so bundlers/test-runners (Vite/vitest) don't try to
// resolve this newer builtin through their module graph — Node resolves it natively.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** Max characters of renderable text we mirror per message into the search store. */
const MAX_SEARCH_TEXT = 4000;

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
  /** Which search backend is active: FTS5 virtual table, or a plain LIKE-scanned table. */
  readonly searchMode: "fts5" | "like";
  /** Full-text search over mirrored message text (shares this DB + searchMode). */
  private readonly searcher: MessageSearch;

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
    this.searchMode = this.initSearchStore();
    this.searcher = new MessageSearch(this.db, this.searchMode);
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
    // Pick the session's model from its assistant lines: the most-frequently-seen
    // `message.model`, tie-broken by the last one seen (a session that switched
    // models mid-stream reports the one it spent most of its turns on). On an
    // incremental pass we only see the NEW bytes, so we can't recompute true history;
    // `incumbentModel` (the already-stored choice) is therefore preferred on a tie so
    // a single new differing line doesn't flip a session that ran mostly on another
    // model — it only changes when the new lines strictly out-count the incumbent.
    const modelCounts = new Map<string, number>();
    const incumbentModel: string | null = incremental ? existing!.model : null;
    let lastModel: string | null = incumbentModel;
    if (incumbentModel) modelCounts.set(incumbentModel, 1);
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
        const mdl = messageModel(raw.message);
        if (mdl) {
          modelCounts.set(mdl, (modelCounts.get(mdl) ?? 0) + 1);
          lastModel = mdl;
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

    // Resolve the session's model: the most-frequent assistant model. Ties prefer
    // the incumbent (the already-stored model, so an incremental pass doesn't flip on
    // a single new line), then the last one seen. Falls through to the prior
    // value/null when no assistant line carried a model.
    let model: string | null = null;
    let bestCount = -1;
    const tiePriority = (id: string): number => (id === incumbentModel ? 2 : id === lastModel ? 1 : 0);
    for (const [id, count] of modelCounts) {
      if (count > bestCount || (count === bestCount && model !== null && tiePriority(id) > tiePriority(model))) {
        bestCount = count;
        model = id;
      }
    }
    if (!model) model = lastModel;

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

  /**
   * Cross-project session listing for a global "All Sessions" view. Reuses this
   * index (one query, no transcript reads); see {@link listAllSessions} for the
   * sort/filter/paging options. Returns SessionSummary[] across ALL projects.
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
    const meta = this.projectMeta.getAll();
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
      const m = meta.get(id);
      if (m?.archived && !opts.includeArchived) continue; // hidden by default
      projects.push({
        id,
        cwd,
        name: projectName(cwd),
        sessionCount: g.rows.length,
        lastActivity: last,
        totalUsage: usage,
        encodedFolders: [...g.folders],
        favorite: m?.favorite ?? false,
        archived: m?.archived ?? false,
        sortOrder: m?.sortOrder ?? 0,
        color: m?.color ?? null,
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
    const rows = this.db
      .prepare(
        `SELECT projectId, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens
         FROM sessions`,
      )
      .all() as unknown as Array<{
      projectId: string | null;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }>;
    const byProject = new Map<string, number>();
    for (const r of rows) {
      const cost = costUsd(r.model, {
        inputTokens: n(r.inputTokens),
        outputTokens: n(r.outputTokens),
        cacheReadTokens: n(r.cacheReadTokens),
        cacheCreationTokens: n(r.cacheCreationTokens),
      });
      const id = r.projectId ?? "unknown";
      byProject.set(id, (byProject.get(id) ?? 0) + cost);
    }
    return byProject;
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
    tags: parseTags(row.tags),
    indexed: true,
  };
}
