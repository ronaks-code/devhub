/**
 * Portable archive EXPORT / IMPORT — a self-describing bundle a user can move to another
 * machine (or back up) and restore.
 *
 * TWO FORMATS live here now:
 *
 *  - DEFAULT (v2) — {@link DevHubArchiveBundleV2} `{kind:'devhub-archive',schemaVersion:2}`.
 *    This is what a plain `exportArchive` produces. It carries ONLY the durable,
 *    authority-clean data DevHub owns and can restore without re-deriving anything from a
 *    provider or a transcript: the ADDITIVE legacy sidecar metadata (custom titles / pins
 *    / tags / archived / notes, keyed by sessionId — NOT the `sessions` rows, which embed
 *    a transcript file path, and NOT the mirrored message text), saved views, the
 *    permission-audit log, and the provider-task LOCATOR-scoped local metadata + fork
 *    links from the provider index. It deliberately contains NO provider-task CACHE rows
 *    (task/turn/event snapshots — those are a rebuildable cache, never authority), NO
 *    mirrored message text, NO raw home paths, NO transcript paths, NO credentials, and
 *    NO hidden/provider reasoning. A v2 bundle is authority-only: importing it re-attaches
 *    a user's local decisions onto a target index whose cache it rebuilds itself.
 *
 *  - LEGACY (v1) — {@link LegacyArchiveBundleV1} `{kind:'claude-ui-archive',schemaVersion:1}`.
 *    The historical full bundle (session rows + mirrored text + sidecar meta + views +
 *    audit). We still IMPORT it (older backups keep working), and we can still EXPORT it
 *    for ROLLBACK ONLY via {@link exportLegacyV1Archive} — never by default. That export
 *    is a rebuildable legacy CACHE: it carries only the UNRESOLVED legacy corpus (any
 *    sessionId that already has a VERIFIED unified provider mapping is excluded, and
 *    explicitly selecting a resolved session is rejected), and never emits the unified
 *    provider cache. The transport labels it `X-DevHub-Archive-Authority:
 *    legacy-rebuildable-cache` so a consumer knows it is a downgrade artifact.
 *
 * IMPORT authority rules. v2 restores ONLY additive metadata + locator links — never a
 * cache row. Provider metadata lands as ORPHANED locators (their home is not registered
 * on this machine) unless the caller supplies a validated {@link ArchiveHomeMapping} that
 * remaps each source `(provider,homeFingerprint)` onto a same-provider REGISTERED target;
 * the mapping is fully validated (unknown target / provider change / conflict / cycle /
 * malformed are rejected BEFORE any write, and a many-to-one remap is allowed only when
 * the collapsed locator sets carry identical content — differing content on the same
 * target aborts the whole transaction). v1 import preserves the historical restore but
 * records every restored session as `archive-v1-import` provenance and NEVER claims native
 * ownership or overwrites a verified live mapping. Both formats are bounded (array + string
 * caps), schema-validated, idempotent, transactional, and secret-clean.
 */
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { writeFtsRows } from "./fts-write.js";
import { FTS_TABLE } from "./fts-schema.js";
import type { SearchText } from "./parse-session.js";
import type { ProviderTaskLocator } from "./provider-index/identity.js";
import type { ProviderId } from "./providers/types.js";
import type { ProviderMetadataObject } from "./provider-index/store-types.js";

/**
 * The DEFAULT bundle schema version. A plain {@link exportArchive} emits this; import
 * accepts a bundle at this exact version paired with the `devhub-archive` discriminator.
 */
export const DEVHUB_ARCHIVE_SCHEMA_VERSION = 2;

/** The legacy bundle schema version — imported always, exported only for rollback. */
export const LEGACY_ARCHIVE_SCHEMA_VERSION = 1;

/**
 * The current default archive schema version (an alias for
 * {@link DEVHUB_ARCHIVE_SCHEMA_VERSION}). Kept as the historically-named export.
 */
export const ARCHIVE_SCHEMA_VERSION = DEVHUB_ARCHIVE_SCHEMA_VERSION;

/** The transport authority label for a legacy-v1 rollback export. */
export const LEGACY_ARCHIVE_AUTHORITY = "legacy-rebuildable-cache";

/**
 * Hard cap on the number of items in any single bundle array we IMPORT. A bundle above
 * this is rejected as malformed (bomb-like) input before any write — an untrusted upload
 * can't ask us to buffer/iterate an unbounded array.
 */
const MAX_BUNDLE_ARRAY_ITEMS = 5_000_000;

/** String caps mirrored from the provider-index schema, enforced before insert. */
const MAX_NATIVE_ID_CHARS = 512;
const MAX_TITLE_CHARS = 65_536;
const MAX_JSON_CHARS = 65_536;
const MAX_NOTES_CHARS = 1_048_576;
const MAX_TAG_ITEMS = 4_096;
/** A home fingerprint is a lowercase 64-hex string (sha-256), same as the store. */
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const PROVIDERS: ReadonlySet<string> = new Set<ProviderId>(["openai", "anthropic"]);

// ── v1 (legacy) bundle shape ────────────────────────────────────────────────

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

/** The historical full bundle — imported always, exported only for rollback. */
export interface LegacyArchiveBundleV1 {
  kind: "claude-ui-archive";
  schemaVersion: 1;
  timestamp: number;
  sessions: ArchiveSession[];
  savedViews: ArchiveSavedView[];
  audit: ArchiveAuditRow[];
}

// ── v2 (DevHub) bundle shape ─────────────────────────────────────────────────

/**
 * Additive legacy sidecar metadata for one session, keyed by `sessionId`. This is the
 * user's own decisions — a custom title, pin, tags, archived flag, notes — NOT the
 * `sessions` row (which carries a transcript file path) and NOT any mirrored text.
 */
export interface ArchiveLegacyMeta {
  sessionId: string;
  customTitle: string | null;
  pinned: number;
  tags: string | null;
  archived: number;
  notes: string | null;
}

/** Provider-task local metadata, addressed by an opaque locator (never a raw home). */
export interface ArchiveProviderTaskMeta {
  locator: ProviderTaskLocator;
  favorite: boolean;
  pinned: boolean;
  localLabel: string | null;
  tags: readonly string[];
  notes: string | null;
  localArchived: boolean;
  uiState: ProviderMetadataObject;
  unsupportedLocal: ProviderMetadataObject;
  updatedAt: number | null;
}

/** A cross-task fork link (both endpoints are opaque locators). */
export interface ArchiveProviderForkLink {
  source: ProviderTaskLocator;
  target: ProviderTaskLocator;
  createdAt: number;
  transferDigest: string;
}

/** The default portable bundle — authority-clean, cache-free, path-free. */
export interface DevHubArchiveBundleV2 {
  /** Marker so a reader can sniff the document kind before trusting the rest. */
  kind: "devhub-archive";
  /** Bundle schema version — see {@link DEVHUB_ARCHIVE_SCHEMA_VERSION}. */
  schemaVersion: 2;
  /** Export time, epoch milliseconds (injected by the caller for determinism). */
  timestamp: number;
  /** Additive legacy sidecar metadata (session_meta), keyed by sessionId. */
  legacyMeta: ArchiveLegacyMeta[];
  /** Saved views / smart folders. */
  savedViews: ArchiveSavedView[];
  /** Permission-decision audit log. */
  audit: ArchiveAuditRow[];
  /** Provider-task local metadata (locator-addressed; no cache rows). */
  providerTaskMeta: ArchiveProviderTaskMeta[];
  /** Provider-task fork links (locator → locator). */
  providerForkLinks: ArchiveProviderForkLink[];
}

/** The default/current bundle type. */
export type ArchiveBundle = DevHubArchiveBundleV2;

/** Either format, for callers that accept an uploaded bundle of unknown version. */
export type AnyArchiveBundle = DevHubArchiveBundleV2 | LegacyArchiveBundleV1;

// ── mapping ──────────────────────────────────────────────────────────────────

/** One home-remap entry: a source `(provider,fingerprint)` → a target `(provider,fingerprint)`. */
export interface ArchiveHomeMappingEntry {
  sourceProvider: ProviderId;
  sourceFingerprint: string;
  targetProvider: ProviderId;
  targetFingerprint: string;
}

/**
 * A validated set of home remaps supplied at v2 import so provider metadata attaches to
 * a REGISTERED local home instead of importing as an orphan. See {@link importArchive}
 * for the full validation contract.
 */
export interface ArchiveHomeMapping {
  entries: readonly ArchiveHomeMappingEntry[];
}

// ── options / result / errors ──────────────────────────────────────────────

/** Options for {@link exportArchive} / {@link exportArchiveChunks} / legacy export. */
export interface ExportArchiveOptions {
  /** Export timestamp, epoch ms. Defaults to Date.now() when omitted. */
  timestamp?: number;
  /** SELECTIVE export — limit to sessions in this project (AND with the others). */
  projectId?: string;
  /** SELECTIVE export — limit to these exact session ids (empty array = none). */
  sessionIds?: string[];
  /** SELECTIVE export — limit to sessions whose `lastTs` ≥ this instant (epoch ms). */
  sinceTs?: number;
}

/** Options for {@link importArchive}. */
export interface ImportArchiveOptions {
  /**
   * When true (default), an unreadable `schemaVersion`/discriminator throws
   * {@link ArchiveVersionError}. Set false to no-op (all-zero result) instead.
   */
  strictVersion?: boolean;
  /**
   * v2 only — a validated home remap. When present, each source home listed here attaches
   * its provider metadata to the mapped registered target; sources not listed import as
   * orphans. Ignored for a v1 bundle.
   */
  homeMapping?: ArchiveHomeMapping;
}

/** Result of an {@link importArchive} run — EXACT counts of what was written. */
export interface ImportArchiveResult {
  /** Sessions whose `sessions` row was inserted/updated (v1 only). */
  sessions: number;
  /** Sidecar `session_meta` rows written (v1 sidecar OR v2 additive legacyMeta). */
  meta: number;
  /** Mirrored message-text rows inserted (v1 only; re-import adds 0). */
  textRows: number;
  /** Saved views inserted (skipping ones already present). */
  savedViews: number;
  /** Permission-audit rows inserted (skipping ones already present). */
  audit: number;
  /** Provider-task metadata rows written (v2 only). */
  providerMeta: number;
  /** Provider-task fork links written (v2 only). */
  forkLinks: number;
  /** Distinct source homes remapped onto a registered target via the mapping (v2). */
  mappedLocators: number;
  /** Distinct locators whose resolved home is NOT registered here — orphans (v2). */
  orphanedLocators: number;
  /** Sessions recorded as `archive-v1-import` provenance (v1 only). */
  legacyProvenance: number;
}

const EMPTY_RESULT: ImportArchiveResult = Object.freeze({
  sessions: 0,
  meta: 0,
  textRows: 0,
  savedViews: 0,
  audit: 0,
  providerMeta: 0,
  forkLinks: 0,
  mappedLocators: 0,
  orphanedLocators: 0,
  legacyProvenance: 0,
});

/** Thrown when a bundle's discriminator/version is not one this build can read. */
export class ArchiveVersionError extends Error {
  readonly found: number;
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

/**
 * Thrown when an uploaded bundle (or its home mapping) is structurally invalid — an
 * oversized array, a malformed locator, an unknown/cross-provider/conflicting/cyclic
 * mapping, or a mapping collision with differing content. Rejected BEFORE any write.
 */
export class ArchiveValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArchiveValidationError";
    this.code = code;
  }
}

// ── shared read helpers ──────────────────────────────────────────────────────

/** Resolve the active mirrored-text table for this DB (FTS5 virtual table or LIKE table). */
function textTable(db: SqliteDatabase): string {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    )
    .get(FTS_TABLE) as { name?: string } | undefined;
  return row?.name === FTS_TABLE ? FTS_TABLE : "messages_text";
}

/** True when `name` is a real table/view in this DB (provider-index tables may be absent). */
function tableExists(db: SqliteDatabase, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

/** Coerce a sqlite numeric (which may arrive as a bigint) to a JS number. */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
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

/** A resolved export selection: `ids` is the EXACT session set (null = the full corpus). */
interface ResolvedSelection {
  ids: Set<string>;
}

function hasSelection(opts: ExportArchiveOptions): boolean {
  return (
    typeof opts.projectId === "string" ||
    Array.isArray(opts.sessionIds) ||
    typeof opts.sinceTs === "number"
  );
}

/** Resolve a selective export to the concrete session-id set, pushing filters into SQL. */
function resolveSelection(
  db: SqliteDatabase,
  opts: ExportArchiveOptions,
): ResolvedSelection | null {
  if (!hasSelection(opts)) return null;

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (typeof opts.projectId === "string") {
    where.push("projectId = ?");
    params.push(opts.projectId);
  }
  if (Array.isArray(opts.sessionIds)) {
    if (opts.sessionIds.length === 0) return { ids: new Set() };
    where.push(`sessionId IN (${opts.sessionIds.map(() => "?").join(", ")})`);
    params.push(...opts.sessionIds);
  }
  if (typeof opts.sinceTs === "number") {
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

/** Read full session rows (+ sidecar meta + mirrored text) — the v1 payload. */
function readSessions(db: SqliteDatabase, sel: ResolvedSelection | null): ArchiveSession[] {
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

/** Read ONLY the additive sidecar metadata (v2) — no transcript path, no text. */
function readLegacyMeta(db: SqliteDatabase, sel: ResolvedSelection | null): ArchiveLegacyMeta[] {
  if (sel && sel.ids.size === 0) return [];
  const include = (id: string) => !sel || sel.ids.has(id);
  const rows = db
    .prepare(
      "SELECT sessionId, customTitle, pinned, tags, archived, notes FROM session_meta ORDER BY sessionId",
    )
    .all() as unknown as MetaRow[];
  return rows
    .filter((m) => include(m.sessionId))
    .map((m) => ({
      sessionId: m.sessionId,
      customTitle: m.customTitle,
      pinned: num(m.pinned),
      tags: m.tags,
      archived: num(m.archived),
      notes: m.notes,
    }));
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

/** Read the permission-audit log (scoped to the selection's sessions when selective). */
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

/** Parse a stored JSON object column defensively (never throws). */
function parseObject(value: unknown): ProviderMetadataObject {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ProviderMetadataObject)
      : {};
  } catch {
    return {};
  }
}

/** Parse a stored JSON string-array column defensively (never throws). */
function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Read provider-task LOCAL metadata rows (no cache, no raw home). */
function readProviderTaskMeta(db: SqliteDatabase): ArchiveProviderTaskMeta[] {
  if (!tableExists(db, "provider_task_meta")) return [];
  const rows = db
    .prepare(
      `SELECT provider, home_fingerprint, native_task_id, favorite, pinned, local_label,
              tags_json, notes, local_archived, ui_state_json, unsupported_local_json, updated_at
       FROM provider_task_meta
       ORDER BY provider, home_fingerprint, native_task_id`,
    )
    .all() as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    locator: {
      version: 1 as const,
      provider: r.provider as ProviderId,
      homeFingerprint: String(r.home_fingerprint),
      nativeTaskId: String(r.native_task_id),
    },
    favorite: num(r.favorite) !== 0,
    pinned: num(r.pinned) !== 0,
    localLabel: typeof r.local_label === "string" ? r.local_label : null,
    tags: parseTags(r.tags_json),
    notes: typeof r.notes === "string" ? r.notes : null,
    localArchived: num(r.local_archived) !== 0,
    uiState: parseObject(r.ui_state_json),
    unsupportedLocal: parseObject(r.unsupported_local_json),
    updatedAt: r.updated_at == null ? null : num(r.updated_at),
  }));
}

/** Read provider-task fork links (both endpoints are opaque locators). */
function readProviderForkLinks(db: SqliteDatabase): ArchiveProviderForkLink[] {
  if (!tableExists(db, "provider_fork_links")) return [];
  const rows = db
    .prepare(
      `SELECT source_provider, source_home_fingerprint, source_native_task_id,
              target_provider, target_home_fingerprint, target_native_task_id,
              created_at, transfer_digest
       FROM provider_fork_links
       ORDER BY source_provider, source_home_fingerprint, source_native_task_id,
                target_provider, target_home_fingerprint, target_native_task_id`,
    )
    .all() as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    source: {
      version: 1 as const,
      provider: r.source_provider as ProviderId,
      homeFingerprint: String(r.source_home_fingerprint),
      nativeTaskId: String(r.source_native_task_id),
    },
    target: {
      version: 1 as const,
      provider: r.target_provider as ProviderId,
      homeFingerprint: String(r.target_home_fingerprint),
      nativeTaskId: String(r.target_native_task_id),
    },
    createdAt: num(r.created_at),
    transferDigest: String(r.transfer_digest),
  }));
}

/** SessionIds that already carry a VERIFIED unified provider mapping (resolved corpus). */
function resolvedLegacySessionIds(db: SqliteDatabase): Set<string> {
  const ids = new Set<string>();
  if (!tableExists(db, "legacy_session_task_map")) return ids;
  for (const r of db
    .prepare("SELECT legacy_session_id FROM legacy_session_task_map")
    .all() as unknown as Array<{ legacy_session_id: string }>) {
    ids.add(r.legacy_session_id);
  }
  return ids;
}

// ── EXPORT ───────────────────────────────────────────────────────────────────

/**
 * Serialize the durable index into the DEFAULT portable bundle
 * ({@link DevHubArchiveBundleV2}). Authority-clean and cache-free: additive sidecar meta,
 * saved views, audit log, and provider-task local metadata + fork links — never session
 * rows, mirrored text, transcript/home paths, cache rows, credentials, or reasoning.
 * Read-only. Honors the SELECTION options (they scope the legacy sidecar meta + audit).
 */
export function exportArchive(
  db: SqliteDatabase,
  opts: ExportArchiveOptions = {},
): DevHubArchiveBundleV2 {
  const sel = resolveSelection(db, opts);
  return {
    kind: "devhub-archive",
    schemaVersion: DEVHUB_ARCHIVE_SCHEMA_VERSION,
    timestamp: typeof opts.timestamp === "number" ? opts.timestamp : Date.now(),
    legacyMeta: readLegacyMeta(db, sel),
    savedViews: readSavedViews(db),
    audit: readAudit(db, sel),
    providerTaskMeta: readProviderTaskMeta(db),
    providerForkLinks: readProviderForkLinks(db),
  };
}

/** Convenience wrapper for the most common selective export: everything in one project. */
export function exportArchiveForProject(
  db: SqliteDatabase,
  projectId: string,
  opts: ExportArchiveOptions = {},
): DevHubArchiveBundleV2 {
  return exportArchive(db, { ...opts, projectId });
}

/**
 * Export the LEGACY v1 bundle for ROLLBACK ONLY — a rebuildable legacy cache. It carries
 * only the UNRESOLVED legacy corpus (sessions with NO verified unified mapping); a session
 * that already resolved to a provider task is excluded, and EXPLICITLY selecting a resolved
 * session throws. Never the default; never emits the unified provider cache. The transport
 * must label the response `X-DevHub-Archive-Authority: legacy-rebuildable-cache`.
 */
export function exportLegacyV1Archive(
  db: SqliteDatabase,
  opts: ExportArchiveOptions = {},
): LegacyArchiveBundleV1 {
  const resolved = resolvedLegacySessionIds(db);

  // Reject an explicit selection that names a session already resolved to a unified
  // mapping — a rollback export must not hand back a session that is no longer legacy.
  if (Array.isArray(opts.sessionIds)) {
    for (const id of opts.sessionIds) {
      if (resolved.has(id)) {
        throw new ArchiveValidationError(
          "RESOLVED_SESSION_SELECTED",
          "cannot export a session with a verified unified mapping to a legacy rollback bundle",
        );
      }
    }
  }

  const sel = resolveSelection(db, opts);
  const drop = (id: string) => resolved.has(id);
  const sessions = readSessions(db, sel).filter((s) => !drop(s.session.sessionId));
  const audit = readAudit(db, sel).filter((a) => a.sessionId == null || !drop(a.sessionId));
  return {
    kind: "claude-ui-archive",
    schemaVersion: LEGACY_ARCHIVE_SCHEMA_VERSION,
    timestamp: typeof opts.timestamp === "number" ? opts.timestamp : Date.now(),
    sessions,
    savedViews: readSavedViews(db),
    audit,
  };
}

/** One streamed slice of a chunked v2 export. */
export type ArchiveChunk =
  | {
      kind: "header";
      bundle: { kind: "devhub-archive"; schemaVersion: number; timestamp: number };
    }
  | { kind: "legacyMeta"; legacyMeta: ArchiveLegacyMeta }
  | { kind: "savedViews"; savedViews: ArchiveSavedView[] }
  | { kind: "audit"; audit: ArchiveAuditRow[] }
  | { kind: "providerTaskMeta"; providerTaskMeta: ArchiveProviderTaskMeta }
  | { kind: "providerForkLinks"; providerForkLinks: ArchiveProviderForkLink[] };

/**
 * Stream the DEFAULT v2 bundle section-by-section. Yields a `header`, then one
 * `legacyMeta` chunk per session, `savedViews`, `audit`, one `providerTaskMeta` chunk per
 * task, and `providerForkLinks`. Re-assembling reproduces exactly {@link exportArchive}.
 */
export function* exportArchiveChunks(
  db: SqliteDatabase,
  opts: ExportArchiveOptions = {},
): Generator<ArchiveChunk> {
  const sel = resolveSelection(db, opts);
  yield {
    kind: "header",
    bundle: {
      kind: "devhub-archive",
      schemaVersion: DEVHUB_ARCHIVE_SCHEMA_VERSION,
      timestamp: typeof opts.timestamp === "number" ? opts.timestamp : Date.now(),
    },
  };
  for (const legacyMeta of readLegacyMeta(db, sel)) {
    yield { kind: "legacyMeta", legacyMeta };
  }
  yield { kind: "savedViews", savedViews: readSavedViews(db) };
  yield { kind: "audit", audit: readAudit(db, sel) };
  for (const providerTaskMeta of readProviderTaskMeta(db)) {
    yield { kind: "providerTaskMeta", providerTaskMeta };
  }
  yield { kind: "providerForkLinks", providerForkLinks: readProviderForkLinks(db) };
}

// ── IMPORT — dispatch ─────────────────────────────────────────────────────────

/** True when this build can read a v2 devhub bundle. */
function isV2(bundle: unknown): bundle is DevHubArchiveBundleV2 {
  return (
    !!bundle &&
    typeof bundle === "object" &&
    (bundle as Record<string, unknown>).kind === "devhub-archive" &&
    (bundle as Record<string, unknown>).schemaVersion === DEVHUB_ARCHIVE_SCHEMA_VERSION
  );
}

/** True when this build can read a v1 legacy bundle. */
function isV1(bundle: unknown): bundle is LegacyArchiveBundleV1 {
  return (
    !!bundle &&
    typeof bundle === "object" &&
    (bundle as Record<string, unknown>).kind === "claude-ui-archive" &&
    (bundle as Record<string, unknown>).schemaVersion === LEGACY_ARCHIVE_SCHEMA_VERSION
  );
}

/**
 * Restore a portable bundle into `db`, IDEMPOTENTLY and TRANSACTIONALLY. Dispatches on the
 * discriminator+version: a `devhub-archive` v2 bundle takes the authority-only v2 path
 * ({@link importV2}); a `claude-ui-archive` v1 bundle takes the legacy restore
 * ({@link importV1}). Any other shape throws {@link ArchiveVersionError} (or no-ops when
 * `strictVersion:false`). NEVER writes to ~/.claude — only this index DB.
 */
export function importArchive(
  db: SqliteDatabase,
  bundle: AnyArchiveBundle,
  opts: ImportArchiveOptions = {},
): ImportArchiveResult {
  if (isV2(bundle)) return importV2(db, bundle, opts);
  if (isV1(bundle)) return importV1(db, bundle);

  if (opts.strictVersion === false) return { ...EMPTY_RESULT };
  const found = num((bundle as { schemaVersion?: unknown } | null)?.schemaVersion);
  throw new ArchiveVersionError(found, DEVHUB_ARCHIVE_SCHEMA_VERSION);
}

// ── IMPORT — v1 (legacy, quarantined) ─────────────────────────────────────────

/**
 * Restore a v1 bundle: the historical session/meta/text/views/audit restore, PLUS a
 * provenance record. Every restored session is recorded as `archive-v1-import` provenance
 * — a quarantine marker that never claims native ownership. A session that already has a
 * VERIFIED live mapping keeps that mapping untouched (its provenance is not overwritten).
 */
function importV1(db: SqliteDatabase, bundle: LegacyArchiveBundleV1): ImportArchiveResult {
  assertBounded(bundle.sessions, "sessions");
  assertBounded(bundle.savedViews, "savedViews");
  assertBounded(bundle.audit, "audit");

  const table = textTable(db);
  const result: ImportArchiveResult = { ...EMPTY_RESULT };
  const hasProvenance = tableExists(db, "legacy_session_provenance");
  const resolved = hasProvenance ? resolvedLegacySessionIds(db) : new Set<string>();

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
  const viewExists = db.prepare(
    "SELECT 1 FROM saved_views WHERE name = ? AND query = ? AND facets = ? AND createdAt = ? LIMIT 1",
  );
  const insertView = db.prepare(
    "INSERT INTO saved_views (name, query, facets, createdAt) VALUES (?, ?, ?, ?)",
  );
  const auditExists = db.prepare(
    `SELECT 1 FROM permission_audit
     WHERE sessionId IS ? AND toolName = ? AND decision = ? AND scope IS ? AND reason IS ? AND ts = ?
     LIMIT 1`,
  );
  const insertAudit = db.prepare(
    "INSERT INTO permission_audit (sessionId, toolName, decision, scope, reason, ts) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // A quarantine provenance record: never claims native ownership. We only INSERT when the
  // session has no existing provenance/verified mapping — never downgrade a live-verified
  // session with an imported cache marker.
  const insertProvenance = hasProvenance
    ? db.prepare(
        `INSERT INTO legacy_session_provenance (legacy_session_id, provenance, observed_at)
         VALUES (?, 'archive-v1-import', ?)
         ON CONFLICT(legacy_session_id) DO NOTHING`,
      )
    : null;

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

      const rows: SearchText[] = entry.text.map((t) => ({
        role: t.role as SearchText["role"],
        seq: t.seq,
        text: t.text,
        toolName: t.toolName,
      }));
      result.textRows += writeFtsRows(db, table, s.sessionId, rows, true);

      // Provenance: skip a session with a verified live mapping (never overwrite it), and
      // count only the rows we newly quarantine as archive-v1-import.
      if (insertProvenance && !resolved.has(s.sessionId)) {
        const info = insertProvenance.run(s.sessionId, bundle.timestamp);
        if (num(info.changes) > 0) result.legacyProvenance++;
      }
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

// ── IMPORT — v2 (authority-only) ───────────────────────────────────────────────

/** A validated home remap: `${provider}:${sourceFingerprint}` → target fingerprint. */
type ResolvedHomeMapping = Map<string, string>;

function mappingKey(provider: ProviderId, fingerprint: string): string {
  return `${provider}:${fingerprint}`;
}

/**
 * Validate an {@link ArchiveHomeMapping} against the registered homes in `db`, rejecting
 * before any write: malformed entries, a target that isn't a same-provider REGISTERED
 * home, a provider change, a conflicting source→two-target, or a cycle. A duplicate
 * IDENTICAL entry collapses. Returns the resolved `source → target` map (empty when no
 * mapping was supplied).
 */
function validateHomeMapping(
  db: SqliteDatabase,
  mapping: ArchiveHomeMapping | undefined,
): ResolvedHomeMapping {
  const resolved: ResolvedHomeMapping = new Map();
  if (!mapping) return resolved;
  if (!Array.isArray(mapping.entries)) {
    throw new ArchiveValidationError("MAPPING_MALFORMED", "home mapping entries must be an array");
  }
  assertBounded(mapping.entries, "homeMapping.entries");

  const registered = registeredHomeSet(db);
  // Per-provider directed edges (source fp → target fp), for cycle detection.
  const edges = new Map<ProviderId, Map<string, string>>();

  for (const entry of mapping.entries) {
    if (!entry || typeof entry !== "object") {
      throw new ArchiveValidationError("MAPPING_MALFORMED", "home mapping entry is not an object");
    }
    const { sourceProvider, sourceFingerprint, targetProvider, targetFingerprint } = entry;
    if (
      !PROVIDERS.has(sourceProvider) ||
      !PROVIDERS.has(targetProvider) ||
      typeof sourceFingerprint !== "string" ||
      typeof targetFingerprint !== "string" ||
      !FINGERPRINT.test(sourceFingerprint) ||
      !FINGERPRINT.test(targetFingerprint)
    ) {
      throw new ArchiveValidationError("MAPPING_MALFORMED", "home mapping entry is malformed");
    }
    if (sourceProvider !== targetProvider) {
      throw new ArchiveValidationError(
        "MAPPING_PROVIDER_CHANGE",
        "home mapping may not change a task's provider",
      );
    }
    if (!registered.has(mappingKey(targetProvider, targetFingerprint))) {
      throw new ArchiveValidationError(
        "MAPPING_UNKNOWN_TARGET",
        "home mapping target is not a registered home",
      );
    }

    const key = mappingKey(sourceProvider, sourceFingerprint);
    const existing = resolved.get(key);
    if (existing !== undefined) {
      if (existing !== targetFingerprint) {
        throw new ArchiveValidationError(
          "MAPPING_CONFLICT",
          "home mapping maps one source to two different targets",
        );
      }
      continue; // duplicate identical entry collapses
    }
    resolved.set(key, targetFingerprint);

    let provEdges = edges.get(sourceProvider);
    if (!provEdges) {
      provEdges = new Map();
      edges.set(sourceProvider, provEdges);
    }
    if (sourceFingerprint !== targetFingerprint) provEdges.set(sourceFingerprint, targetFingerprint);
  }

  assertNoMappingCycle(edges);
  return resolved;
}

/** All homes registered on this machine, as `${provider}:${fingerprint}` keys. */
function registeredHomeSet(db: SqliteDatabase): Set<string> {
  const set = new Set<string>();
  if (!tableExists(db, "provider_homes")) return set;
  for (const r of db
    .prepare("SELECT provider, home_fingerprint FROM provider_homes")
    .all() as unknown as Array<{ provider: string; home_fingerprint: string }>) {
    set.add(mappingKey(r.provider as ProviderId, r.home_fingerprint));
  }
  return set;
}

/** Reject a mapping whose source→target edges form a cycle (per provider). */
function assertNoMappingCycle(edges: Map<ProviderId, Map<string, string>>): void {
  for (const provEdges of edges.values()) {
    const state = new Map<string, 0 | 1 | 2>(); // 0=unseen,1=on-stack,2=done
    const visit = (node: string): void => {
      const s = state.get(node);
      if (s === 2) return;
      if (s === 1) {
        throw new ArchiveValidationError("MAPPING_CYCLE", "home mapping forms a cycle");
      }
      state.set(node, 1);
      const next = provEdges.get(node);
      if (next !== undefined) visit(next);
      state.set(node, 2);
    };
    for (const node of provEdges.keys()) visit(node);
  }
}

/** A candidate row destined for a resolved locator, plus a content signature for collision. */
interface ResolvedWrite<T> {
  locator: ProviderTaskLocator;
  wasMapped: boolean;
  wasRegistered: boolean;
  content: string;
  row: T;
}

/**
 * Restore a v2 bundle: authority-only. Writes ADDITIVE sidecar meta, saved views, audit,
 * and provider-task local metadata + fork links — NEVER a cache row. Provider metadata
 * attaches to a REGISTERED target via the (already-validated) mapping, else imports as an
 * ORPHAN. Many source homes may collapse onto one target only when their per-locator
 * content is IDENTICAL; differing content on the same target aborts the whole transaction.
 */
function importV2(
  db: SqliteDatabase,
  bundle: DevHubArchiveBundleV2,
  opts: ImportArchiveOptions,
): ImportArchiveResult {
  assertBounded(bundle.legacyMeta, "legacyMeta");
  assertBounded(bundle.savedViews, "savedViews");
  assertBounded(bundle.audit, "audit");
  assertBounded(bundle.providerTaskMeta, "providerTaskMeta");
  assertBounded(bundle.providerForkLinks, "providerForkLinks");

  // Validate the mapping BEFORE any write (throws on any violation).
  const mapping = validateHomeMapping(db, opts.homeMapping);
  const registered = registeredHomeSet(db);

  const result: ImportArchiveResult = { ...EMPTY_RESULT };

  // Resolve + collision-check provider metadata rows up front (before opening the txn) so a
  // conflicting many-to-one collapse aborts without a half-written transaction.
  const metaWrites = resolveMetaWrites(bundle.providerTaskMeta ?? [], mapping, registered);
  const forkWrites = resolveForkWrites(bundle.providerForkLinks ?? [], mapping, registered);

  // Distinct SOURCE homes the mapping actually remapped (counted pre-collapse, so a
  // many-to-one collapse still reports every source home that was reattached).
  const mappedSources = new Set<string>();
  for (const m of bundle.providerTaskMeta ?? []) {
    const k = mappingKey(m.locator.provider, m.locator.homeFingerprint);
    if (mapping.has(k)) mappedSources.add(k);
  }
  for (const l of bundle.providerForkLinks ?? []) {
    for (const ep of [l.source, l.target]) {
      const k = mappingKey(ep.provider, ep.homeFingerprint);
      if (mapping.has(k)) mappedSources.add(k);
    }
  }

  const orphanLocators = new Set<string>();
  const trackLocator = (w: { locator: ProviderTaskLocator; wasMapped: boolean; wasRegistered: boolean }) => {
    if (!w.wasRegistered) {
      orphanLocators.add(
        `${w.locator.provider}:${w.locator.homeFingerprint}:${w.locator.nativeTaskId}`,
      );
    }
  };

  const upsertMeta = db.prepare(`
    INSERT INTO session_meta (sessionId, customTitle, pinned, tags, archived, notes)
    VALUES ($sessionId, $customTitle, $pinned, $tags, $archived, $notes)
    ON CONFLICT(sessionId) DO UPDATE SET
      customTitle=$customTitle, pinned=$pinned, tags=$tags, archived=$archived, notes=$notes
  `);
  const viewExists = db.prepare(
    "SELECT 1 FROM saved_views WHERE name = ? AND query = ? AND facets = ? AND createdAt = ? LIMIT 1",
  );
  const insertView = db.prepare(
    "INSERT INTO saved_views (name, query, facets, createdAt) VALUES (?, ?, ?, ?)",
  );
  const auditExists = db.prepare(
    `SELECT 1 FROM permission_audit
     WHERE sessionId IS ? AND toolName = ? AND decision = ? AND scope IS ? AND reason IS ? AND ts = ?
     LIMIT 1`,
  );
  const insertAudit = db.prepare(
    "INSERT INTO permission_audit (sessionId, toolName, decision, scope, reason, ts) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const upsertProviderMeta = tableExists(db, "provider_task_meta")
    ? db.prepare(`
        INSERT INTO provider_task_meta (
          provider, home_fingerprint, native_task_id, favorite, pinned, local_label,
          tags_json, notes, local_archived, ui_state_json, unsupported_local_json, updated_at
        ) VALUES (
          $provider, $home, $task, $favorite, $pinned, $localLabel,
          $tags, $notes, $localArchived, $uiState, $unsupportedLocal, $updatedAt
        )
        ON CONFLICT(provider, home_fingerprint, native_task_id) DO UPDATE SET
          favorite=$favorite, pinned=$pinned, local_label=$localLabel, tags_json=$tags,
          notes=$notes, local_archived=$localArchived, ui_state_json=$uiState,
          unsupported_local_json=$unsupportedLocal, updated_at=$updatedAt
      `)
    : null;
  const upsertForkLink = tableExists(db, "provider_fork_links")
    ? db.prepare(`
        INSERT INTO provider_fork_links (
          source_provider, source_home_fingerprint, source_native_task_id,
          target_provider, target_home_fingerprint, target_native_task_id,
          created_at, transfer_digest
        ) VALUES (
          $sp, $sh, $st, $tp, $th, $tt, $createdAt, $digest
        )
        ON CONFLICT(
          source_provider, source_home_fingerprint, source_native_task_id,
          target_provider, target_home_fingerprint, target_native_task_id
        ) DO UPDATE SET created_at=$createdAt, transfer_digest=$digest
      `)
    : null;

  db.exec("BEGIN");
  try {
    for (const m of bundle.legacyMeta ?? []) {
      const meta = validLegacyMeta(m);
      upsertMeta.run(meta);
      result.meta++;
    }

    for (const v of bundle.savedViews ?? []) {
      if (!viewExists.get(v.name, v.query, v.facets, v.createdAt)) {
        insertView.run(v.name, v.query, v.facets, v.createdAt);
        result.savedViews++;
      }
    }

    for (const a of bundle.audit ?? []) {
      const decision = a.decision === "allow" ? "allow" : "deny";
      if (!auditExists.get(a.sessionId ?? null, a.toolName, decision, a.scope ?? null, a.reason ?? null, a.ts)) {
        insertAudit.run(a.sessionId ?? null, a.toolName, decision, a.scope ?? null, a.reason ?? null, a.ts);
        result.audit++;
      }
    }

    if (upsertProviderMeta) {
      for (const w of metaWrites) {
        const meta = w.row;
        upsertProviderMeta.run({
          provider: w.locator.provider,
          home: w.locator.homeFingerprint,
          task: w.locator.nativeTaskId,
          favorite: meta.favorite ? 1 : 0,
          pinned: meta.pinned ? 1 : 0,
          localLabel: capText(meta.localLabel, MAX_TITLE_CHARS),
          tags: capJson(JSON.stringify(normalizeTags(meta.tags))),
          notes: capText(meta.notes, MAX_NOTES_CHARS),
          localArchived: meta.localArchived ? 1 : 0,
          uiState: capJson(JSON.stringify(meta.uiState ?? {})),
          unsupportedLocal: capJson(JSON.stringify(meta.unsupportedLocal ?? {})),
          updatedAt: meta.updatedAt == null ? 0 : num(meta.updatedAt),
        });
        result.providerMeta++;
        trackLocator(w);
      }
    }

    if (upsertForkLink) {
      for (const w of forkWrites) {
        const link = w.row;
        upsertForkLink.run({
          sp: link.source.provider,
          sh: link.source.homeFingerprint,
          st: link.source.nativeTaskId,
          tp: link.target.provider,
          th: link.target.homeFingerprint,
          tt: link.target.nativeTaskId,
          createdAt: num(link.createdAt),
          digest: link.transferDigest,
        });
        result.forkLinks++;
        trackLocator({ locator: link.source, wasMapped: w.wasMapped, wasRegistered: w.wasRegistered });
        trackLocator({ locator: link.target, wasMapped: false, wasRegistered: registered.has(mappingKey(link.target.provider, link.target.homeFingerprint)) });
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  result.mappedLocators = mappedSources.size;
  result.orphanedLocators = orphanLocators.size;
  return result;
}

/** Resolve a source locator to its target home via the validated mapping. */
function resolveLocator(
  locator: ProviderTaskLocator,
  mapping: ResolvedHomeMapping,
  registered: Set<string>,
): { locator: ProviderTaskLocator; wasMapped: boolean; wasRegistered: boolean } {
  const target = mapping.get(mappingKey(locator.provider, locator.homeFingerprint));
  const resolvedFingerprint = target ?? locator.homeFingerprint;
  const resolved: ProviderTaskLocator = {
    version: 1,
    provider: locator.provider,
    homeFingerprint: resolvedFingerprint,
    nativeTaskId: locator.nativeTaskId,
  };
  return {
    locator: resolved,
    wasMapped: target !== undefined,
    wasRegistered: registered.has(mappingKey(locator.provider, resolvedFingerprint)),
  };
}

/**
 * Resolve every provider-meta row to its target locator and collapse many-to-one, aborting
 * if two source rows land on the same locator with DIFFERING content (no last-writer-wins).
 */
function resolveMetaWrites(
  rows: readonly ArchiveProviderTaskMeta[],
  mapping: ResolvedHomeMapping,
  registered: Set<string>,
): Array<ResolvedWrite<ArchiveProviderTaskMeta>> {
  const byLocator = new Map<string, ResolvedWrite<ArchiveProviderTaskMeta>>();
  for (const raw of rows) {
    const locator = validLocator(raw?.locator);
    const r = resolveLocator(locator, mapping, registered);
    const key = `${r.locator.provider}:${r.locator.homeFingerprint}:${r.locator.nativeTaskId}`;
    const content = metaContentSignature(raw);
    const existing = byLocator.get(key);
    if (existing) {
      if (existing.content !== content) {
        throw new ArchiveValidationError(
          "MAPPING_COLLISION",
          "mapped provider metadata collides with differing content on one target",
        );
      }
      existing.wasMapped = existing.wasMapped || r.wasMapped;
      continue; // identical collapse
    }
    byLocator.set(key, { locator: r.locator, wasMapped: r.wasMapped, wasRegistered: r.wasRegistered, content, row: raw });
  }
  return [...byLocator.values()];
}

/** Same resolve+collapse+collision guard for fork links (keyed by both endpoints). */
function resolveForkWrites(
  rows: readonly ArchiveProviderForkLink[],
  mapping: ResolvedHomeMapping,
  registered: Set<string>,
): Array<ResolvedWrite<ArchiveProviderForkLink>> {
  const byLink = new Map<string, ResolvedWrite<ArchiveProviderForkLink>>();
  for (const raw of rows) {
    const source = validLocator(raw?.source);
    const target = validLocator(raw?.target);
    const rs = resolveLocator(source, mapping, registered);
    const rt = resolveLocator(target, mapping, registered);
    if (locatorsEqual(rs.locator, rt.locator)) {
      throw new ArchiveValidationError(
        "FORK_SELF_LINK",
        "fork link resolves to identical source and target",
      );
    }
    const link: ArchiveProviderForkLink = {
      source: rs.locator,
      target: rt.locator,
      createdAt: num(raw.createdAt),
      transferDigest: requireFingerprint(raw.transferDigest, "transferDigest"),
    };
    const key =
      `${rs.locator.provider}:${rs.locator.homeFingerprint}:${rs.locator.nativeTaskId}` +
      `>${rt.locator.provider}:${rt.locator.homeFingerprint}:${rt.locator.nativeTaskId}`;
    const content = `${link.createdAt}:${link.transferDigest}`;
    const existing = byLink.get(key);
    if (existing) {
      if (existing.content !== content) {
        throw new ArchiveValidationError(
          "MAPPING_COLLISION",
          "mapped fork link collides with differing content on one target",
        );
      }
      existing.wasMapped = existing.wasMapped || rs.wasMapped || rt.wasMapped;
      continue;
    }
    byLink.set(key, {
      locator: rs.locator,
      wasMapped: rs.wasMapped || rt.wasMapped,
      wasRegistered: rs.wasRegistered,
      content,
      row: link,
    });
  }
  return [...byLink.values()];
}

function locatorsEqual(a: ProviderTaskLocator, b: ProviderTaskLocator): boolean {
  return (
    a.provider === b.provider &&
    a.homeFingerprint === b.homeFingerprint &&
    a.nativeTaskId === b.nativeTaskId
  );
}

/**
 * A content signature over a meta row's USER-OWNED semantic fields (excluding the locator
 * AND the `updatedAt` bookkeeping timestamp). Two rows that carry the same user decisions
 * collapse even if their write times differ; only differing decisions are a real conflict.
 */
function metaContentSignature(m: ArchiveProviderTaskMeta): string {
  return JSON.stringify([
    !!m.favorite,
    !!m.pinned,
    capText(m.localLabel, MAX_TITLE_CHARS),
    normalizeTags(m.tags),
    capText(m.notes, MAX_NOTES_CHARS),
    !!m.localArchived,
    m.uiState ?? {},
    m.unsupportedLocal ?? {},
  ]);
}

// ── validation helpers ────────────────────────────────────────────────────────

function assertBounded(arr: unknown, field: string): void {
  if (arr === undefined || arr === null) return;
  if (!Array.isArray(arr)) {
    throw new ArchiveValidationError("BUNDLE_MALFORMED", `${field} must be an array`);
  }
  if (arr.length > MAX_BUNDLE_ARRAY_ITEMS) {
    throw new ArchiveValidationError("BUNDLE_TOO_LARGE", `${field} exceeds the archive bound`);
  }
}

/** Validate + normalize an imported locator, throwing on any malformed field. */
function validLocator(v: unknown): ProviderTaskLocator {
  if (!v || typeof v !== "object") {
    throw new ArchiveValidationError("LOCATOR_MALFORMED", "provider locator is not an object");
  }
  const l = v as Record<string, unknown>;
  if (l.version !== 1 || !PROVIDERS.has(l.provider as string)) {
    throw new ArchiveValidationError("LOCATOR_MALFORMED", "provider locator has a bad version/provider");
  }
  if (typeof l.homeFingerprint !== "string" || !FINGERPRINT.test(l.homeFingerprint)) {
    throw new ArchiveValidationError("LOCATOR_MALFORMED", "provider locator home fingerprint is invalid");
  }
  if (
    typeof l.nativeTaskId !== "string" ||
    l.nativeTaskId.length === 0 ||
    Buffer.byteLength(l.nativeTaskId, "utf8") > MAX_NATIVE_ID_CHARS
  ) {
    throw new ArchiveValidationError("LOCATOR_MALFORMED", "provider locator native task id is invalid");
  }
  return {
    version: 1,
    provider: l.provider as ProviderId,
    homeFingerprint: l.homeFingerprint,
    nativeTaskId: l.nativeTaskId,
  };
}

function requireFingerprint(v: unknown, field: string): string {
  if (typeof v !== "string" || !FINGERPRINT.test(v)) {
    throw new ArchiveValidationError("FINGERPRINT_MALFORMED", `${field} is not a valid fingerprint`);
  }
  return v;
}

/** Validate + normalize an imported legacy-meta row (bounded, session-keyed). */
function validLegacyMeta(m: unknown): {
  sessionId: string;
  customTitle: string | null;
  pinned: number;
  tags: string | null;
  archived: number;
  notes: string | null;
} {
  if (!m || typeof m !== "object") {
    throw new ArchiveValidationError("LEGACY_META_MALFORMED", "legacy meta row is not an object");
  }
  const r = m as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || r.sessionId.length === 0) {
    throw new ArchiveValidationError("LEGACY_META_MALFORMED", "legacy meta row has no sessionId");
  }
  return {
    sessionId: r.sessionId,
    customTitle: capText(typeof r.customTitle === "string" ? r.customTitle : null, MAX_TITLE_CHARS),
    pinned: num(r.pinned) !== 0 ? 1 : 0,
    tags: typeof r.tags === "string" ? capJson(r.tags) : null,
    archived: num(r.archived) !== 0 ? 1 : 0,
    notes: capText(typeof r.notes === "string" ? r.notes : null, MAX_NOTES_CHARS),
  };
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out = tags.filter((t): t is string => typeof t === "string").slice(0, MAX_TAG_ITEMS);
  return out;
}

function capText(value: string | null, max: number): string | null {
  if (value == null) return null;
  if (Buffer.byteLength(value, "utf8") > max) {
    throw new ArchiveValidationError("TEXT_TOO_LARGE", "archive text field exceeds its bound");
  }
  return value;
}

function capJson(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_JSON_CHARS) {
    throw new ArchiveValidationError("JSON_TOO_LARGE", "archive JSON field exceeds its bound");
  }
  return value;
}
