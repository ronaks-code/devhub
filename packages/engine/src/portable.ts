/**
 * Full-archive EXPORT / IMPORT — a portable, self-describing bundle of everything the
 * engine OWNS, so a user can move their durable index to another machine (or back it
 * up) and restore it losslessly.
 *
 * WHAT IT CONTAINS. Only OUR data — never raw ~/.claude transcripts. A bundle holds, per
 * session, the indexed `sessions` row (the normalized metadata: title/tokens/model/…),
 * every mirrored message-text row we keep for search (the same `(role, seq, toolName,
 * text)` tuples that live in messages_fts / messages_text — already-normalized text we
 * own, NOT the verbatim transcript), and all the sidecar metadata: custom titles, pins,
 * tags, archived flags, and notes (session_meta), the permission-decision audit log
 * (permission_audit), and saved views / smart folders (saved_views). The mirrored text
 * is the same lossy copy our DB already stores; we never re-read or copy a transcript
 * file, and import NEVER writes to ~/.claude.
 *
 * SHAPE. A single versioned JSON document ({@link ArchiveBundle}) with a `schemaVersion`,
 * an export `timestamp` (epoch ms, INJECTED by the caller so tests are deterministic),
 * and a `sessions` array streamed/chunked by `exportArchiveChunks` for very large
 * indexes. {@link exportArchive} returns the whole document in memory (convenient for
 * normal-sized indexes + tests); {@link exportArchiveChunks} yields it section-by-section
 * for a caller that wants to stream it to disk without holding it all at once.
 *
 * SELECTIVE EXPORT. By default a bundle holds the WHOLE corpus, but the export options
 * accept an optional selection — `projectId`, `sessionIds`, and/or `sinceTs` (any
 * combination) — so a user can export/share just a subset (e.g. one project). When set,
 * only the matching sessions travel (with only their sidecar meta + mirrored text), the
 * audit log is scoped to those sessions, and saved views (which have no per-session key)
 * are still included in full — they're global smart folders, useful to carry along, and
 * import de-dupes them anyway. The selection is pushed into SQL (filter at the source),
 * never an export-all-then-filter. The bundle SHAPE/schemaVersion is unchanged: a
 * selective bundle is just a smaller valid bundle that {@link importArchive} reads
 * identically to a full one. With no selection the output is byte-identical to before.
 *
 * IMPORT. {@link importArchive} restores a bundle into THIS index, idempotently — it
 * reuses the W23 stable-rowid write path for the mirrored text (so re-importing the same
 * bundle never duplicates rows) and UPSERTs session/sidecar rows keyed by their natural
 * identity. A bundle whose `schemaVersion` we can't read throws a typed
 * {@link ArchiveVersionError} rather than corrupting the DB.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { writeFtsRows } from "./fts-write.js";
import { FTS_TABLE } from "./fts-schema.js";
import type { SearchText } from "./parse-session.js";

/**
 * The bundle schema version. Bump when the bundle SHAPE changes incompatibly. Import
 * accepts a bundle at this exact version; an older/unknown version is rejected with a
 * typed error so a face can prompt the user instead of silently mangling rows.
 */
export const ARCHIVE_SCHEMA_VERSION = 1;

/** A mirrored message-text row, exactly the columns our search store carries. */
export interface ArchiveTextRow {
  role: string;
  seq: number;
  toolName: string | null;
  text: string;
}

/** One exported session: its indexed `sessions` row + sidecar meta + mirrored text. */
export interface ArchiveSession {
  /** The full `sessions` row (normalized metadata we indexed — never the transcript). */
  session: {
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
  };
  /** The session's sidecar metadata (session_meta), or null when never customized. */
  meta: {
    customTitle: string | null;
    pinned: number;
    tags: string | null;
    archived: number;
    notes: string | null;
  } | null;
  /** The mirrored message/text rows we keep for search (our own lossy copy). */
  text: ArchiveTextRow[];
}

/** A saved view (smart folder) as stored in `saved_views`. */
export interface ArchiveSavedView {
  name: string;
  query: string;
  facets: string;
  createdAt: number;
}

/** A permission-audit row as stored in `permission_audit`. */
export interface ArchiveAuditRow {
  sessionId: string | null;
  toolName: string;
  decision: string;
  scope: string | null;
  reason: string | null;
  ts: number;
}

/** The complete portable bundle — a single versioned, self-describing JSON document. */
export interface ArchiveBundle {
  /** Marker so a reader can sniff the document kind before trusting the rest. */
  kind: "claude-ui-archive";
  /** Bundle schema version — see {@link ARCHIVE_SCHEMA_VERSION}. */
  schemaVersion: number;
  /** Export time, epoch milliseconds (injected by the caller for determinism). */
  timestamp: number;
  /** Every indexed session with its sidecar meta + mirrored text. */
  sessions: ArchiveSession[];
  /** Saved views / smart folders. */
  savedViews: ArchiveSavedView[];
  /** Permission-decision audit log. */
  audit: ArchiveAuditRow[];
}

/** Options for {@link exportArchive} / {@link exportArchiveChunks}. */
export interface ExportArchiveOptions {
  /**
   * Export timestamp, epoch ms. Date.now is fine in engine runtime, but the caller
   * passes it in so tests are deterministic; defaults to Date.now() when omitted.
   */
  timestamp?: number;
  /**
   * SELECTIVE export — limit the bundle to sessions in this project. Combines (AND) with
   * the other selection fields. Omitted = no project filter (i.e. the full corpus unless
   * another selection narrows it).
   */
  projectId?: string;
  /**
   * SELECTIVE export — limit the bundle to these exact session ids. Combines (AND) with
   * the other selection fields. An empty array selects NO sessions; omitted = no id
   * filter.
   */
  sessionIds?: string[];
  /**
   * SELECTIVE export — limit the bundle to sessions whose last activity (`lastTs`) is at
   * or after this instant (epoch ms). Sessions with no usable timestamp are excluded.
   * Combines (AND) with the other selection fields; omitted = no time floor.
   */
  sinceTs?: number;
}

/** Result of an {@link importArchive} run — what was written. */
export interface ImportArchiveResult {
  /** Sessions whose `sessions` row was inserted/updated. */
  sessions: number;
  /** Sessions whose sidecar `session_meta` row was written. */
  meta: number;
  /** Mirrored message-text rows inserted (re-import of the same bundle adds 0 new). */
  textRows: number;
  /** Saved views inserted (skipping ones already present). */
  savedViews: number;
  /** Permission-audit rows inserted (skipping ones already present). */
  audit: number;
}

/** Options for {@link importArchive}. */
export interface ImportArchiveOptions {
  /**
   * When true (the default), a bundle whose `schemaVersion` we don't understand throws
   * {@link ArchiveVersionError}. Set false to NO-OP on an incompatible bundle instead
   * (returns an all-zero result) — a softer mode for a best-effort restore.
   */
  strictVersion?: boolean;
}

/**
 * Thrown by {@link importArchive} when a bundle's `schemaVersion` is not one this build
 * can read (and strict-version mode is on). Carries both versions so a face can explain
 * the mismatch or offer to upgrade.
 */
export class ArchiveVersionError extends Error {
  /** The version the bundle declared. */
  readonly found: number;
  /** The version this build can read. */
  readonly expected: number;
  constructor(found: number, expected: number) {
    super(
      `archive schemaVersion ${found} is incompatible with this build (expects ${expected})`,
    );
    this.name = "ArchiveVersionError";
    this.found = found;
    this.expected = expected;
  }
}

/** Resolve the active mirrored-text table for this DB (FTS5 virtual table or LIKE table). */
function textTable(db: SqliteDatabase): string {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    )
    .get(FTS_TABLE) as { name?: string } | undefined;
  return row?.name === FTS_TABLE ? FTS_TABLE : "messages_text";
}

/** Coerce a sqlite numeric (which may arrive as a bigint) to a JS number. */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/** Coerce a sqlite nullable text column to `string | null`. */
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface SessionRow {
  sessionId: string;
  filePath: string;
  cwd: string | null;
  projectId: string | null;
  title: string | null;
  titleSource: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  messageCount: number | bigint;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
  cacheReadTokens: number | bigint;
  cacheCreationTokens: number | bigint;
  sizeBytes: number | bigint;
  mtimeMs: number | bigint;
  indexedBytes: number | bigint;
  hasSubagents: number | bigint;
  model: string | null;
  headSig: string | null;
}

interface MetaRow {
  sessionId: string;
  customTitle: string | null;
  pinned: number | bigint | null;
  tags: string | null;
  archived: number | bigint | null;
  notes: string | null;
}

interface TextRow {
  sessionId: string;
  role: string | null;
  seq: number | bigint | null;
  toolName: string | null;
  text: string | null;
}

/**
 * A resolved export selection: which sessions to include. `null` means "everything"
 * (the default), so the full-export path stays byte-identical. When non-null, `ids` is
 * the EXACT set of sessionIds the selection resolved to (already filtered in SQL by
 * project/id-list/since) — every downstream read keys off this set so the sidecar/text
 * /audit slices match the sessions exactly.
 */
interface ResolvedSelection {
  ids: Set<string>;
}

/** True when any selection field is present (so the export is selective, not full). */
function hasSelection(opts: ExportArchiveOptions): boolean {
  return (
    typeof opts.projectId === "string" ||
    Array.isArray(opts.sessionIds) ||
    typeof opts.sinceTs === "number"
  );
}

/**
 * Resolve a selective export down to the concrete set of sessionIds it matches, by
 * pushing every filter into SQL (project = ?, sessionId IN (...), lastTs >= instant) so
 * we never read-all-then-filter. Returns `null` for a full export (no selection), which
 * the readers treat as "no filter" to keep the default path byte-identical.
 */
function resolveSelection(db: SqliteDatabase, opts: ExportArchiveOptions): ResolvedSelection | null {
  if (!hasSelection(opts)) return null;

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (typeof opts.projectId === "string") {
    where.push("projectId = ?");
    params.push(opts.projectId);
  }
  if (Array.isArray(opts.sessionIds)) {
    if (opts.sessionIds.length === 0) return { ids: new Set() }; // empty list selects nothing
    where.push(`sessionId IN (${opts.sessionIds.map(() => "?").join(", ")})`);
    params.push(...opts.sessionIds);
  }
  if (typeof opts.sinceTs === "number") {
    // lastTs is the raw ISO transcript timestamp; compare in epoch seconds (floor both
    // sides to the second, symmetrically) so the threshold is timezone-safe. A row with
    // no usable timestamp yields NULL and is excluded — sensible for a time floor.
    where.push("CAST(strftime('%s', lastTs) AS INTEGER) >= ?");
    params.push(Math.floor(opts.sinceTs / 1000));
  }

  const ids = new Set<string>();
  for (const r of db
    .prepare(`SELECT sessionId FROM sessions WHERE ${where.join(" AND ")}`)
    .all(...params) as unknown as Array<{ sessionId: string }>) {
    ids.add(r.sessionId);
  }
  return { ids };
}

/**
 * Read every indexed session (its `sessions` row + the matching `session_meta` sidecar
 * + the mirrored text rows) and assemble the per-session export records. Pure read — no
 * writes, no transcript I/O. Shared by {@link exportArchive} and the chunked streamer.
 * When `sel` is non-null the read is scoped to exactly its `ids` (a SELECTIVE export);
 * `null` reads the whole corpus (the default, byte-identical to before).
 */
function readSessions(db: SqliteDatabase, sel: ResolvedSelection | null): ArchiveSession[] {
  // A selective export with an empty resolved set has nothing to read — bail before any
  // query so the sidecar/text scans below stay bounded to real work.
  if (sel && sel.ids.size === 0) return [];
  const include = (id: string) => !sel || sel.ids.has(id);

  const table = textTable(db);
  const sessionRows = (
    db
      .prepare(
        `SELECT sessionId, filePath, cwd, projectId, title, titleSource, gitBranch,
              firstTs, lastTs, messageCount, inputTokens, outputTokens,
              cacheReadTokens, cacheCreationTokens, sizeBytes, mtimeMs, indexedBytes,
              hasSubagents, model, headSig
       FROM sessions ORDER BY sessionId`,
      )
      .all() as unknown as SessionRow[]
  ).filter((s) => include(s.sessionId));

  // Index the sidecar meta + mirrored text by sessionId in one scan each, so assembling
  // the bundle is O(rows) rather than a per-session query. For a selective export we
  // still scan once but keep only rows whose session is included (the set is small).
  const metaBySession = new Map<string, MetaRow>();
  for (const m of db
    .prepare(
      "SELECT sessionId, customTitle, pinned, tags, archived, notes FROM session_meta",
    )
    .all() as unknown as MetaRow[]) {
    if (include(m.sessionId)) metaBySession.set(m.sessionId, m);
  }

  const textBySession = new Map<string, ArchiveTextRow[]>();
  for (const t of db
    .prepare(`SELECT sessionId, role, seq, toolName, text FROM ${table} ORDER BY sessionId, seq`)
    .all() as unknown as TextRow[]) {
    if (!include(t.sessionId)) continue;
    let arr = textBySession.get(t.sessionId);
    if (!arr) {
      arr = [];
      textBySession.set(t.sessionId, arr);
    }
    arr.push({
      role: t.role ?? "",
      seq: num(t.seq),
      toolName: t.toolName ?? null,
      text: t.text ?? "",
    });
  }

  return sessionRows.map((s) => {
    const m = metaBySession.get(s.sessionId);
    return {
      session: {
        sessionId: s.sessionId,
        filePath: s.filePath,
        cwd: s.cwd,
        projectId: s.projectId,
        title: s.title,
        titleSource: s.titleSource,
        gitBranch: s.gitBranch,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        messageCount: num(s.messageCount),
        inputTokens: num(s.inputTokens),
        outputTokens: num(s.outputTokens),
        cacheReadTokens: num(s.cacheReadTokens),
        cacheCreationTokens: num(s.cacheCreationTokens),
        sizeBytes: num(s.sizeBytes),
        mtimeMs: num(s.mtimeMs),
        indexedBytes: num(s.indexedBytes),
        hasSubagents: num(s.hasSubagents),
        model: s.model,
        headSig: s.headSig,
      },
      meta: m
        ? {
            customTitle: m.customTitle,
            pinned: num(m.pinned),
            tags: m.tags,
            archived: num(m.archived),
            notes: m.notes,
          }
        : null,
      text: textBySession.get(s.sessionId) ?? [],
    };
  });
}

/** Read the saved views (smart folders) for the bundle. */
function readSavedViews(db: SqliteDatabase): ArchiveSavedView[] {
  const rows = db
    .prepare("SELECT name, query, facets, createdAt FROM saved_views ORDER BY createdAt, id")
    .all() as unknown as Array<{
    name: string;
    query: string | null;
    facets: string | null;
    createdAt: number | bigint;
  }>;
  return rows.map((r) => ({
    name: r.name,
    query: r.query ?? "",
    facets: r.facets ?? "{}",
    createdAt: num(r.createdAt),
  }));
}

/**
 * Read the permission-decision audit log for the bundle. For a SELECTIVE export (`sel`
 * non-null) we keep only rows whose `sessionId` is one of the included sessions — audit
 * rows with a null/other sessionId are dropped, so a shared project bundle never leaks
 * decisions from sessions it doesn't carry. `null` reads the whole log (the default).
 */
function readAudit(db: SqliteDatabase, sel: ResolvedSelection | null): ArchiveAuditRow[] {
  const rows = db
    .prepare(
      "SELECT sessionId, toolName, decision, scope, reason, ts FROM permission_audit ORDER BY ts, id",
    )
    .all() as unknown as Array<{
    sessionId: string | null;
    toolName: string | null;
    decision: string | null;
    scope: string | null;
    reason: string | null;
    ts: number | bigint;
  }>;
  return rows
    .filter((r) => !sel || (r.sessionId != null && sel.ids.has(r.sessionId)))
    .map((r) => ({
      sessionId: r.sessionId ?? null,
      toolName: r.toolName ?? "tool",
      decision: r.decision === "allow" ? "allow" : "deny",
      scope: r.scope ?? null,
      reason: r.reason ?? null,
      ts: num(r.ts),
    }));
}

/**
 * Serialize the durable archive into a portable {@link ArchiveBundle} — the whole
 * document in memory. Convenient for normal-sized indexes and tests; for a very large
 * index prefer {@link exportArchiveChunks} to stream it without holding everything at
 * once. Read-only: no writes, no transcript I/O. The `timestamp` is the caller's
 * injected export time (defaults to Date.now()).
 *
 * Pass a SELECTION (`projectId` / `sessionIds` / `sinceTs`, any combination) to export
 * only a subset; with none the result is byte-identical to a full export.
 */
export function exportArchive(db: SqliteDatabase, opts: ExportArchiveOptions = {}): ArchiveBundle {
  const sel = resolveSelection(db, opts);
  return {
    kind: "claude-ui-archive",
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    timestamp: typeof opts.timestamp === "number" ? opts.timestamp : Date.now(),
    sessions: readSessions(db, sel),
    savedViews: readSavedViews(db),
    audit: readAudit(db, sel),
  };
}

/**
 * Convenience wrapper for the most common SELECTIVE export: everything in one project.
 * Equivalent to {@link exportArchive} with `{ projectId }`; merges any other options
 * (e.g. a deterministic `timestamp`) so a caller can still inject them.
 */
export function exportArchiveForProject(
  db: SqliteDatabase,
  projectId: string,
  opts: ExportArchiveOptions = {},
): ArchiveBundle {
  return exportArchive(db, { ...opts, projectId });
}

/** One streamed slice of a chunked export — assemble them in order into a full bundle. */
export type ArchiveChunk =
  | {
      kind: "header";
      bundle: { kind: "claude-ui-archive"; schemaVersion: number; timestamp: number };
    }
  | { kind: "session"; session: ArchiveSession }
  | { kind: "savedViews"; savedViews: ArchiveSavedView[] }
  | { kind: "audit"; audit: ArchiveAuditRow[] };

/**
 * Stream a {@link ArchiveBundle} section-by-section so a caller can serialize a very
 * large index to disk without materializing the whole document in memory. Yields a
 * `header` chunk first (the versioned envelope, no sessions), then one `session` chunk
 * per indexed session, then the `savedViews` and `audit` chunks. Re-assembling the
 * chunks reproduces exactly what {@link exportArchive} returns. Read-only. Honors the
 * same SELECTION options as {@link exportArchive}.
 */
export function* exportArchiveChunks(
  db: SqliteDatabase,
  opts: ExportArchiveOptions = {},
): Generator<ArchiveChunk> {
  const sel = resolveSelection(db, opts);
  yield {
    kind: "header",
    bundle: {
      kind: "claude-ui-archive",
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      timestamp: typeof opts.timestamp === "number" ? opts.timestamp : Date.now(),
    },
  };
  for (const session of readSessions(db, sel)) {
    yield { kind: "session", session };
  }
  yield { kind: "savedViews", savedViews: readSavedViews(db) };
  yield { kind: "audit", audit: readAudit(db, sel) };
}

/** True when this build can read a bundle declaring `version`. */
function versionSupported(version: unknown): boolean {
  return version === ARCHIVE_SCHEMA_VERSION;
}

/**
 * Restore a {@link ArchiveBundle} into `db`, IDEMPOTENTLY. Re-importing the same bundle
 * does not duplicate rows:
 *
 *  - `sessions` / `session_meta` rows UPSERT on their primary key (sessionId).
 *  - Mirrored message text is written through the W23 stable-rowid path
 *    ({@link writeFtsRows} in `full` mode), so the same logical rows land on the same
 *    rowids and a re-import is a no-op replace — never a duplicate.
 *  - `saved_views` (no natural key) are de-duped by `(name, query, facets, createdAt)`,
 *    and `permission_audit` by `(sessionId, toolName, decision, scope, reason, ts)`, so
 *    re-importing skips rows already present.
 *
 * NEVER writes to ~/.claude — only this index DB. A bundle whose `schemaVersion` we
 * can't read throws {@link ArchiveVersionError} (or no-ops when `strictVersion` is
 * false). Everything runs inside one transaction so a failure rolls back cleanly.
 */
export function importArchive(
  db: SqliteDatabase,
  bundle: ArchiveBundle,
  opts: ImportArchiveOptions = {},
): ImportArchiveResult {
  const empty: ImportArchiveResult = {
    sessions: 0,
    meta: 0,
    textRows: 0,
    savedViews: 0,
    audit: 0,
  };
  if (!versionSupported(bundle?.schemaVersion)) {
    if (opts.strictVersion === false) return empty;
    throw new ArchiveVersionError(num(bundle?.schemaVersion), ARCHIVE_SCHEMA_VERSION);
  }

  const table = textTable(db);
  const result: ImportArchiveResult = { ...empty };

  const upsertSession = db.prepare(`
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
  const upsertMeta = db.prepare(`
    INSERT INTO session_meta (sessionId, customTitle, pinned, tags, archived, notes)
    VALUES ($sessionId, $customTitle, $pinned, $tags, $archived, $notes)
    ON CONFLICT(sessionId) DO UPDATE SET
      customTitle=$customTitle, pinned=$pinned, tags=$tags, archived=$archived, notes=$notes
  `);
  // De-dupe a saved view by its full content (no natural key). We only insert when no
  // identical row already exists, so re-importing the same bundle adds nothing.
  const viewExists = db.prepare(
    "SELECT 1 FROM saved_views WHERE name = ? AND query = ? AND facets = ? AND createdAt = ? LIMIT 1",
  );
  const insertView = db.prepare(
    "INSERT INTO saved_views (name, query, facets, createdAt) VALUES (?, ?, ?, ?)",
  );
  // De-dupe an audit row by its full content. `IS` (not `=`) so NULL columns match.
  const auditExists = db.prepare(
    `SELECT 1 FROM permission_audit
     WHERE sessionId IS ? AND toolName = ? AND decision = ? AND scope IS ? AND reason IS ? AND ts = ?
     LIMIT 1`,
  );
  const insertAudit = db.prepare(
    "INSERT INTO permission_audit (sessionId, toolName, decision, scope, reason, ts) VALUES (?, ?, ?, ?, ?, ?)",
  );

  db.exec("BEGIN");
  try {
    for (const entry of bundle.sessions ?? []) {
      const s = entry.session;
      upsertSession.run({
        sessionId: s.sessionId,
        filePath: s.filePath,
        cwd: s.cwd,
        projectId: s.projectId,
        title: s.title,
        titleSource: s.titleSource,
        gitBranch: s.gitBranch,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        messageCount: s.messageCount,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheCreationTokens: s.cacheCreationTokens,
        sizeBytes: s.sizeBytes,
        mtimeMs: s.mtimeMs,
        indexedBytes: s.indexedBytes,
        hasSubagents: s.hasSubagents,
        model: s.model,
        headSig: s.headSig,
      });
      result.sessions++;

      if (entry.meta) {
        upsertMeta.run({
          sessionId: s.sessionId,
          customTitle: entry.meta.customTitle,
          pinned: entry.meta.pinned,
          tags: entry.meta.tags,
          archived: entry.meta.archived,
          notes: entry.meta.notes,
        });
        result.meta++;
      }

      // Mirrored text through the stable-rowid write path in FULL mode: the session's
      // existing rows are cleared and re-written onto deterministic rowids, so a
      // re-import reproduces the SAME rows (idempotent) rather than duplicating them.
      const rows: SearchText[] = entry.text.map((t) => ({
        // The store's `role` column is free-form text; SearchText types it as the
        // narrow union, so cast (the value round-trips verbatim either way).
        role: t.role as SearchText["role"],
        seq: t.seq,
        text: t.text,
        toolName: t.toolName,
      }));
      result.textRows += writeFtsRows(db, table, s.sessionId, rows, true);
    }

    for (const v of bundle.savedViews ?? []) {
      if (!viewExists.get(v.name, v.query, v.facets, v.createdAt)) {
        insertView.run(v.name, v.query, v.facets, v.createdAt);
        result.savedViews++;
      }
    }

    for (const a of bundle.audit ?? []) {
      if (!auditExists.get(a.sessionId, a.toolName, a.decision, a.scope, a.reason, a.ts)) {
        insertAudit.run(a.sessionId, a.toolName, a.decision, a.scope, a.reason, a.ts);
        result.audit++;
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return result;
}
