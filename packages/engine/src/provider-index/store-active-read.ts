import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { redactSecrets } from "../redact.js";
import { MAX_PROVIDER_HOME_CHARS } from "../providers/native-id.js";
import { canonicalizeProviderHome } from "../providers/task-key.js";
import type {
  ProviderId,
} from "../providers/types.js";
import {
  homeFingerprint,
  parseCachedTurnKey,
  parseTaskLocator,
  serializeTaskLocator,
  type ProviderTaskLocator,
} from "./identity.js";
import {
  type NormalizedProviderIndexListOptions,
  serializeProviderIndexCursor,
} from "./cursor.js";
import {
  decodeCachedProviderEvent,
  decodePersistedProviderTaskSummaryForStore,
  verifyPreparedProviderTaskSnapshotForStore,
} from "./store-codec.js";
import {
  type DecodeProviderSyncState,
  ProviderIndexCacheError,
  taskGenerationCensus,
  type GenerationCensus,
} from "./store-cache.js";
import type {
  IndexedProviderTask,
  IndexedProviderTaskSummary,
  NormalizedProviderIndexStoreConfig,
  PreparedProviderEvent,
  PreparedProviderTaskSnapshot,
  PreparedProviderTaskSummary,
  PreparedProviderTurn,
  ProviderIndexPage,
  ProviderIndexRegisteredHome,
} from "./store-types.js";
import { hasCanonicalUnicode, sqliteTextLengthAtMost } from "./text-boundary.js";

const HOME_FINGERPRINT = /^[0-9a-f]{64}$/u;

type CacheRow = Readonly<Record<string, unknown>>;

interface RegisteredHomeRow {
  readonly provider: unknown;
  readonly home_fingerprint: unknown;
  readonly canonical_home: unknown;
  readonly registered_at: unknown;
}

function fail(
  code: "CORRUPT_ROW" | "DATABASE_UNAVAILABLE" | "UNKNOWN_HOME",
): never {
  throw new ProviderIndexCacheError(code);
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("CORRUPT_ROW");
  }
  return value;
}

function providerId(value: unknown): ProviderId {
  if (value !== "openai" && value !== "anthropic") return fail("CORRUPT_ROW");
  return value;
}

function storedFingerprint(value: unknown): string {
  if (typeof value !== "string" || !HOME_FINGERPRINT.test(value)) {
    return fail("CORRUPT_ROW");
  }
  return value;
}

function exactCanonicalHome(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    sqliteTextLengthAtMost(value, MAX_PROVIDER_HOME_CHARS) === null ||
    !hasCanonicalUnicode(value)) return fail("CORRUPT_ROW");
  let canonical: string;
  try {
    canonical = canonicalizeProviderHome(value);
  } catch {
    return fail("CORRUPT_ROW");
  }
  if (canonical !== value) return fail("CORRUPT_ROW");
  return canonical;
}

function registeredHome(
  db: SqliteDatabase,
  provider: ProviderId,
  fingerprint: string,
  missingCode: "CORRUPT_ROW" | "UNKNOWN_HOME" = "UNKNOWN_HOME",
): Readonly<ProviderIndexRegisteredHome> {
  let row: RegisteredHomeRow | undefined;
  try {
    row = db.prepare(`SELECT provider, home_fingerprint, canonical_home, registered_at
      FROM provider_homes WHERE provider = ? AND home_fingerprint = ?`)
      .get(provider, fingerprint) as RegisteredHomeRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) return fail(missingCode);
  const decodedProvider = providerId(row.provider);
  const decodedFingerprint = storedFingerprint(row.home_fingerprint);
  const canonicalHome = exactCanonicalHome(row.canonical_home);
  safeInteger(row.registered_at);
  let expectedFingerprint: string;
  try {
    expectedFingerprint = homeFingerprint(decodedProvider, canonicalHome);
  } catch {
    return fail("CORRUPT_ROW");
  }
  if (decodedProvider !== provider || decodedFingerprint !== fingerprint ||
    expectedFingerprint !== fingerprint) return fail("CORRUPT_ROW");
  return Object.freeze({ provider, homeFingerprint: fingerprint, canonicalHome });
}

function normalizedStoredLocator(row: CacheRow): ProviderTaskLocator {
  try {
    return parseTaskLocator(serializeTaskLocator({
      version: 1,
      provider: row.provider,
      homeFingerprint: row.home_fingerprint,
      nativeTaskId: row.native_task_id,
    } as ProviderTaskLocator));
  } catch {
    return fail("CORRUPT_ROW");
  }
}

function taskRowMatchesPrepared(
  row: CacheRow,
  prepared: PreparedProviderTaskSummary,
  generation: number,
  observedAt: number,
): boolean {
  const revision = prepared.revision;
  const expected: CacheRow = {
    provider: prepared.locator.provider,
    home_fingerprint: prepared.locator.homeFingerprint,
    native_task_id: prepared.locator.nativeTaskId,
    title: prepared.title,
    cwd: prepared.cwd,
    cwd_redacted: prepared.cwdRedacted ? 1 : 0,
    model: prepared.model,
    status: prepared.status,
    created_at: prepared.createdAt,
    updated_at: prepared.updatedAt,
    archived: prepared.archived === null ? null : prepared.archived ? 1 : 0,
    source: prepared.source,
    revision_updated_at: revision?.updatedAt ?? null,
    revision_status: revision?.status ?? null,
    revision_last_turn_id: revision?.lastTurnId ?? null,
    revision_last_turn_status: revision?.lastTurnStatus ?? null,
    revision_last_item_id: revision?.lastItemId ?? null,
    revision_fingerprint: revision?.fingerprint ?? null,
    cache_generation: generation,
    observed_at: observedAt,
  };
  return Object.entries(expected).every(([key, value]) => row[key] === value) &&
    Reflect.ownKeys(row).length === Reflect.ownKeys(expected).length;
}

function taskRowWithoutReceiptCount(row: CacheRow): CacheRow {
  return Object.freeze({
    provider: row.provider,
    home_fingerprint: row.home_fingerprint,
    native_task_id: row.native_task_id,
    title: row.title,
    cwd: row.cwd,
    cwd_redacted: row.cwd_redacted,
    model: row.model,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived: row.archived,
    source: row.source,
    revision_updated_at: row.revision_updated_at,
    revision_status: row.revision_status,
    revision_last_turn_id: row.revision_last_turn_id,
    revision_last_turn_status: row.revision_last_turn_status,
    revision_last_item_id: row.revision_last_item_id,
    revision_fingerprint: row.revision_fingerprint,
    cache_generation: row.cache_generation,
    observed_at: row.observed_at,
  });
}

function preparedSummaryFromTaskRow(
  row: CacheRow,
  registration: ProviderIndexRegisteredHome,
  locator: ProviderTaskLocator,
  generation: number,
): Readonly<{ prepared: PreparedProviderTaskSummary; observedAt: number }> {
  let prepared: Readonly<PreparedProviderTaskSummary>;
  try {
    prepared = decodePersistedProviderTaskSummaryForStore(row, registration, locator);
  } catch {
    return fail("CORRUPT_ROW");
  }
  const observedAt = safeInteger(row.observed_at);
  if (!taskRowMatchesPrepared(row, prepared, generation, observedAt)) {
    return fail("CORRUPT_ROW");
  }
  return Object.freeze({ prepared, observedAt });
}

function indexedSummary(
  prepared: PreparedProviderTaskSummary,
  generation: number,
  observedAt: number,
  cacheDetail: "summary" | "snapshot",
): Readonly<IndexedProviderTaskSummary> {
  return Object.freeze({
    locator: prepared.locator,
    title: prepared.title,
    cwd: prepared.cwd,
    cwdRedacted: prepared.cwdRedacted,
    model: prepared.model,
    status: prepared.status,
    createdAt: prepared.createdAt,
    updatedAt: prepared.updatedAt,
    archived: prepared.archived,
    source: prepared.source,
    revision: prepared.revision,
    cacheDetail,
    cacheGeneration: generation,
    observedAt,
  });
}

function indexedSnapshot(
  prepared: PreparedProviderTaskSnapshot,
  generation: number,
  observedAt: number,
): Readonly<IndexedProviderTask> {
  return Object.freeze({
    ...indexedSummary(prepared, generation, observedAt, "snapshot"),
    turns: Object.freeze(prepared.turns.map((turn) => Object.freeze({
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      ordinal: turn.ordinal,
      events: Object.freeze(turn.events.map((event) => event.event)),
    }))),
  });
}

function activeTaskRow(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
  generation: number,
): CacheRow | null {
  let row: CacheRow | undefined;
  try {
    row = db.prepare(`SELECT * FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?`)
      .get(
        locator.provider,
        locator.homeFingerprint,
        locator.nativeTaskId,
        generation,
      ) as CacheRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row ?? null;
}

function queryTaskChildRows(
  db: SqliteDatabase,
  table: "provider_turn_cache" | "provider_event_cache" | "provider_replay_receipts",
  locator: ProviderTaskLocator,
  generation: number,
  orderBy: string,
  limit: number,
): readonly CacheRow[] {
  try {
    return db.prepare(`SELECT * FROM ${table}
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?
      ORDER BY ${orderBy}
      LIMIT ?`)
      .all(
        locator.provider,
        locator.homeFingerprint,
        locator.nativeTaskId,
        generation,
        limit,
      ) as unknown as CacheRow[];
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
}

function storedTurnText(value: unknown, canonicalHome: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    sqliteTextLengthAtMost(value, 512) === null || !hasCanonicalUnicode(value) ||
    value.includes(canonicalHome) || redactSecrets(value) !== value) {
    return fail("CORRUPT_ROW");
  }
  return value;
}

function storedTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return fail("CORRUPT_ROW");
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    return fail("CORRUPT_ROW");
  }
  return value;
}

function decodedSnapshotFromRows(
  db: SqliteDatabase,
  registration: ProviderIndexRegisteredHome,
  locator: ProviderTaskLocator,
  generation: number,
  decodedSummary: Readonly<{ prepared: PreparedProviderTaskSummary; observedAt: number }>,
  census: GenerationCensus,
  config: NormalizedProviderIndexStoreConfig,
): Readonly<IndexedProviderTask> {
  if (census.receiptCount !== 1 || census.turnCount > config.maxTurnsPerGeneration ||
    census.eventCount > config.maxEventsPerTask ||
    census.eventCount > config.maxEventsPerGeneration) return fail("CORRUPT_ROW");
  const receipts = queryTaskChildRows(
    db,
    "provider_replay_receipts",
    locator,
    generation,
    "replay_key",
    2,
  );
  if (receipts.length !== 1) return fail("CORRUPT_ROW");
  const receipt = receipts[0]!;
  if (receipt.provider !== locator.provider ||
    receipt.home_fingerprint !== locator.homeFingerprint ||
    receipt.native_task_id !== locator.nativeTaskId ||
    safeInteger(receipt.cache_generation) !== generation ||
    safeInteger(receipt.event_count) !== census.eventCount ||
    typeof receipt.replay_key !== "string" ||
    typeof receipt.snapshot_fingerprint !== "string") return fail("CORRUPT_ROW");
  safeInteger(receipt.observed_at);
  const turns = queryTaskChildRows(
    db,
    "provider_turn_cache",
    locator,
    generation,
    "ordinal",
    census.turnCount + 1,
  );
  const events = queryTaskChildRows(
    db,
    "provider_event_cache",
    locator,
    generation,
    "ordinal",
    census.eventCount + 1,
  );
  if (turns.length !== census.turnCount || events.length !== census.eventCount) {
    return fail("CORRUPT_ROW");
  }
  const eventRowsByTurn = new Map<string, PreparedProviderEvent[]>();
  const turnIds = new Map<string, string>();
  for (let ordinal = 0; ordinal < turns.length; ordinal += 1) {
    const row = turns[ordinal]!;
    if (row.provider !== locator.provider || row.home_fingerprint !== locator.homeFingerprint ||
      row.native_task_id !== locator.nativeTaskId ||
      safeInteger(row.cache_generation) !== generation || safeInteger(row.ordinal) !== ordinal ||
      typeof row.native_turn_key !== "string") return fail("CORRUPT_ROW");
    let id: string | null;
    try {
      id = parseCachedTurnKey(row.native_turn_key);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (id === null || id.includes(registration.canonicalHome) ||
      turnIds.has(row.native_turn_key)) return fail("CORRUPT_ROW");
    turnIds.set(row.native_turn_key, id);
    eventRowsByTurn.set(row.native_turn_key, []);
  }
  for (let ordinal = 0; ordinal < events.length; ordinal += 1) {
    const row = events[ordinal]!;
    if (row.provider !== locator.provider || row.home_fingerprint !== locator.homeFingerprint ||
      row.native_task_id !== locator.nativeTaskId ||
      safeInteger(row.cache_generation) !== generation || safeInteger(row.ordinal) !== ordinal ||
      typeof row.native_turn_key !== "string" || !turnIds.has(row.native_turn_key)) {
      return fail("CORRUPT_ROW");
    }
    let event;
    try {
      event = decodeCachedProviderEvent({
        provider: row.provider,
        home_fingerprint: row.home_fingerprint,
        native_task_id: row.native_task_id,
        native_turn_key: row.native_turn_key,
        native_item_key: row.native_item_key,
        replay_key: row.replay_key,
        ordinal: row.ordinal,
        event_fingerprint: row.event_fingerprint,
        event_json: row.event_json,
      }, locator, row.native_turn_key, registration);
    } catch {
      return fail("CORRUPT_ROW");
    }
    eventRowsByTurn.get(row.native_turn_key)!.push(Object.freeze({
      nativeTurnKey: row.native_turn_key,
      nativeItemKey: row.native_item_key,
      replayKey: row.replay_key,
      ordinal,
      eventFingerprint: row.event_fingerprint,
      eventJson: row.event_json,
      event,
    }) as PreparedProviderEvent);
  }
  const preparedTurns: PreparedProviderTurn[] = turns.map((row, ordinal) => {
    const nativeTurnKey = row.native_turn_key as string;
    return Object.freeze({
      nativeTurnKey,
      id: turnIds.get(nativeTurnKey)!,
      status: storedTurnText(row.status, registration.canonicalHome),
      startedAt: storedTimestamp(row.started_at),
      completedAt: storedTimestamp(row.completed_at),
      ordinal,
      events: Object.freeze(eventRowsByTurn.get(nativeTurnKey)!),
    });
  });
  if (!verifyPreparedProviderTaskSnapshotForStore(
    decodedSummary.prepared,
    preparedTurns,
    receipt.replay_key,
    receipt.snapshot_fingerprint,
  )) return fail("CORRUPT_ROW");
  const preparedSnapshot: PreparedProviderTaskSnapshot = Object.freeze({
    ...decodedSummary.prepared,
    turns: Object.freeze(preparedTurns),
    eventCount: census.eventCount,
    snapshotFingerprint: receipt.snapshot_fingerprint,
    receiptKey: receipt.replay_key,
  });
  return indexedSnapshot(preparedSnapshot, generation, decodedSummary.observedAt);
}

export function readActiveProviderTask(
  db: SqliteDatabase,
  registration: ProviderIndexRegisteredHome,
  locator: ProviderTaskLocator,
  generation: number,
  config: NormalizedProviderIndexStoreConfig,
): Readonly<IndexedProviderTask> | null {
  const row = activeTaskRow(db, locator, generation);
  if (row === null) return null;
  const decoded = preparedSummaryFromTaskRow(row, registration, locator, generation);
  const census = taskGenerationCensus(db, locator, locator.nativeTaskId, generation);
  if (census.taskCount !== 1) return fail("CORRUPT_ROW");
  if (census.receiptCount === 0) {
    if (census.turnCount !== 0 || census.eventCount !== 0) return fail("CORRUPT_ROW");
    return Object.freeze({
      ...indexedSummary(decoded.prepared, generation, decoded.observedAt, "summary"),
      turns: Object.freeze([]),
    });
  }
  return decodedSnapshotFromRows(
    db,
    registration,
    locator,
    generation,
    decoded,
    census,
    config,
  );
}

export function listActiveProviderTasks(
  db: SqliteDatabase,
  options: NormalizedProviderIndexListOptions,
  decodeSyncState: DecodeProviderSyncState,
): Readonly<ProviderIndexPage<IndexedProviderTaskSummary>> {
  const clauses = [
    "sync.active_generation > 0",
    "task.cache_generation = sync.active_generation",
  ];
  const parameters: Array<string | number | null> = [];
  if (options.scope.provider !== null) {
    clauses.push("task.provider = ?");
    parameters.push(options.scope.provider);
  }
  if (options.scope.homeFingerprint !== null) {
    clauses.push("task.home_fingerprint = ?");
    parameters.push(options.scope.homeFingerprint);
  }
  if (!options.scope.includeArchived) clauses.push("task.archived IS NOT 1");
  if (options.position !== null) {
    const tupleClause = `(task.provider > ? OR
      (task.provider = ? AND task.home_fingerprint > ?) OR
      (task.provider = ? AND task.home_fingerprint = ? AND task.native_task_id > ?))`;
    const tupleParameters = [
      options.position.provider,
      options.position.provider,
      options.position.homeFingerprint,
      options.position.provider,
      options.position.homeFingerprint,
      options.position.nativeTaskId,
    ];
    if (options.position.updatedAt === null) {
      clauses.push(`task.updated_at IS NULL AND ${tupleClause}`);
      parameters.push(...tupleParameters);
    } else {
      clauses.push(`(task.updated_at IS NULL OR task.updated_at < ? OR
        (task.updated_at = ? AND ${tupleClause}))`);
      parameters.push(
        options.position.updatedAt,
        options.position.updatedAt,
        ...tupleParameters,
      );
    }
  }
  let rows: readonly CacheRow[];
  try {
    rows = db.prepare(`SELECT task.*,
      sync.provider AS sync_provider,
      sync.home_fingerprint AS sync_home_fingerprint,
      sync.active_generation AS sync_active_generation,
      sync.staging_generation AS sync_staging_generation,
      sync.staging_owner_token AS sync_staging_owner_token,
      sync.staging_heartbeat_at AS sync_staging_heartbeat_at,
      sync.staging_expires_at AS sync_staging_expires_at,
      sync.state AS sync_state,
      sync.provider_version AS sync_provider_version,
      sync.last_completed_at AS sync_last_completed_at,
      sync.generation_epoch AS sync_generation_epoch,
      (SELECT COUNT(*) FROM provider_replay_receipts AS receipt
        WHERE receipt.provider = task.provider
          AND receipt.home_fingerprint = task.home_fingerprint
          AND receipt.native_task_id = task.native_task_id
          AND receipt.cache_generation = task.cache_generation) AS receipt_count
      FROM provider_task_cache AS task
      JOIN provider_sync_state AS sync
        ON sync.provider = task.provider
        AND sync.home_fingerprint = task.home_fingerprint
      WHERE ${clauses.join(" AND ")}
      ORDER BY task.updated_at IS NULL ASC, task.updated_at DESC,
        task.provider ASC, task.home_fingerprint ASC, task.native_task_id ASC
      LIMIT ?`)
      .all(...parameters, options.limit + 1) as unknown as CacheRow[];
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  const hasNext = rows.length > options.limit;
  const authorizedItems = rows.map((row) => {
    const locator = normalizedStoredLocator(row);
    const registration = registeredHome(
      db,
      locator.provider,
      locator.homeFingerprint,
      "CORRUPT_ROW",
    );
    const generation = safeInteger(row.cache_generation);
    const sync = decodeSyncState({
      provider: row.sync_provider,
      home_fingerprint: row.sync_home_fingerprint,
      active_generation: row.sync_active_generation,
      staging_generation: row.sync_staging_generation,
      staging_owner_token: row.sync_staging_owner_token,
      staging_heartbeat_at: row.sync_staging_heartbeat_at,
      staging_expires_at: row.sync_staging_expires_at,
      state: row.sync_state,
      provider_version: row.sync_provider_version,
      last_completed_at: row.sync_last_completed_at,
      generation_epoch: row.sync_generation_epoch,
    }, locator);
    if (sync.activeGeneration !== generation || generation === 0) return fail("CORRUPT_ROW");
    const decoded = preparedSummaryFromTaskRow(
      taskRowWithoutReceiptCount(row),
      registration,
      locator,
      generation,
    );
    const receiptCount = safeInteger(row.receipt_count);
    if (receiptCount > 1) return fail("CORRUPT_ROW");
    return indexedSummary(
      decoded.prepared,
      generation,
      decoded.observedAt,
      receiptCount === 1 ? "snapshot" : "summary",
    );
  });
  const items = hasNext ? authorizedItems.slice(0, options.limit) : authorizedItems;
  const last = items.at(-1);
  let nextCursor: string | null = null;
  try {
    nextCursor = hasNext && last !== undefined
      ? serializeProviderIndexCursor(options.scope, {
        updatedAt: last.updatedAt,
        provider: last.locator.provider,
        homeFingerprint: last.locator.homeFingerprint,
        nativeTaskId: last.locator.nativeTaskId,
      })
      : null;
  } catch {
    return fail("CORRUPT_ROW");
  }
  return Object.freeze({ items: Object.freeze(items), nextCursor });
}
