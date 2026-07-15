import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import type {
  NormalizedProviderIndexStoreConfig,
  ProviderCacheClearResult,
  ProviderHomeScope,
  ProviderIndexScope,
} from "./store-types.js";
import type { ProviderTaskLocator } from "./identity.js";

export type ProviderIndexCacheErrorCode = "CAPACITY" | "CORRUPT_ROW" |
  "DATABASE_UNAVAILABLE" | "UNKNOWN_HOME";

export class ProviderIndexCacheError extends Error {
  readonly code: ProviderIndexCacheErrorCode;

  constructor(code: ProviderIndexCacheErrorCode) {
    super(code);
    this.code = code;
  }
}

function fail(code: ProviderIndexCacheErrorCode): never {
  throw new ProviderIndexCacheError(code);
}

function storedCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("CORRUPT_ROW");
  }
  return value;
}

type CacheTable = "provider_task_cache" | "provider_turn_cache" |
  "provider_event_cache" | "provider_replay_receipts";

export interface GenerationCensus {
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly receiptCount: number;
}

export interface ProviderSyncStateRow {
  readonly provider: unknown;
  readonly home_fingerprint: unknown;
  readonly active_generation: unknown;
  readonly staging_generation: unknown;
  readonly staging_owner_token: unknown;
  readonly staging_heartbeat_at: unknown;
  readonly staging_expires_at: unknown;
  readonly state: unknown;
  readonly provider_version: unknown;
  readonly last_completed_at: unknown;
  readonly generation_epoch: unknown;
}

export interface ProviderSyncState extends ProviderHomeScope {
  readonly activeGeneration: number;
  readonly stagingGeneration: number | null;
  readonly stagingOwnerToken: string | null;
  readonly stagingHeartbeatAt: number | null;
  readonly stagingExpiresAt: number | null;
  readonly state: "idle" | "staging";
  readonly providerVersion: string | null;
  readonly lastCompletedAt: number | null;
  readonly generationEpoch: number;
}

export function providerSyncStatesEqual(
  left: ProviderSyncState,
  right: ProviderSyncState,
): boolean {
  return left.provider === right.provider &&
    left.homeFingerprint === right.homeFingerprint &&
    left.activeGeneration === right.activeGeneration &&
    left.stagingGeneration === right.stagingGeneration &&
    left.stagingOwnerToken === right.stagingOwnerToken &&
    left.stagingHeartbeatAt === right.stagingHeartbeatAt &&
    left.stagingExpiresAt === right.stagingExpiresAt &&
    left.state === right.state &&
    left.providerVersion === right.providerVersion &&
    left.lastCompletedAt === right.lastCompletedAt &&
    left.generationEpoch === right.generationEpoch;
}

export type DecodeProviderSyncState = (
  row: ProviderSyncStateRow,
  scope: ProviderHomeScope,
) => Readonly<ProviderSyncState>;

export function censusRowCount(census: GenerationCensus): number {
  const total = census.taskCount + census.turnCount + census.eventCount + census.receiptCount;
  if (!Number.isSafeInteger(total)) fail("CAPACITY");
  return total;
}

export function totalDatabaseChanges(db: SqliteDatabase): bigint {
  let row: { count: unknown } | undefined;
  try {
    const statement = db.prepare("SELECT total_changes() AS count");
    statement.setReadBigInts(true);
    row = statement.get() as { count: unknown } | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined || typeof row.count !== "bigint" || row.count < 0n) {
    return fail("CORRUPT_ROW");
  }
  return row.count;
}

export function requireDatabaseChangeDelta(
  db: SqliteDatabase,
  before: bigint,
  expected: number,
): void {
  if (!Number.isSafeInteger(expected) || expected < 0) fail("CAPACITY");
  const after = totalDatabaseChanges(db);
  if (after < before || after - before !== BigInt(expected)) fail("CORRUPT_ROW");
}

export function countGenerationRows(
  db: SqliteDatabase,
  table: CacheTable,
  scope: ProviderHomeScope,
  generation: number,
): number {
  let row: { count: unknown } | undefined;
  try {
    row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation = ?`)
      .get(scope.provider, scope.homeFingerprint, generation) as { count: unknown } | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  return storedCount(row.count);
}

export function generationCensus(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
): Readonly<GenerationCensus> {
  return Object.freeze({
    taskCount: countGenerationRows(db, "provider_task_cache", scope, generation),
    turnCount: countGenerationRows(db, "provider_turn_cache", scope, generation),
    eventCount: countGenerationRows(db, "provider_event_cache", scope, generation),
    receiptCount: countGenerationRows(db, "provider_replay_receipts", scope, generation),
  });
}

export function taskGenerationCensus(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  nativeTaskId: string,
  generation: number,
): Readonly<GenerationCensus> {
  let row: Readonly<Record<keyof GenerationCensus, unknown>> | undefined;
  try {
    row = db.prepare(`SELECT
      (SELECT COUNT(*) FROM provider_task_cache
        WHERE provider = ? AND home_fingerprint = ?
          AND native_task_id = ? AND cache_generation = ?) AS taskCount,
      (SELECT COUNT(*) FROM provider_turn_cache
        WHERE provider = ? AND home_fingerprint = ?
          AND native_task_id = ? AND cache_generation = ?) AS turnCount,
      (SELECT COUNT(*) FROM provider_event_cache
        WHERE provider = ? AND home_fingerprint = ?
          AND native_task_id = ? AND cache_generation = ?) AS eventCount,
      (SELECT COUNT(*) FROM provider_replay_receipts
        WHERE provider = ? AND home_fingerprint = ?
          AND native_task_id = ? AND cache_generation = ?) AS receiptCount`)
      .get(
        scope.provider, scope.homeFingerprint, nativeTaskId, generation,
        scope.provider, scope.homeFingerprint, nativeTaskId, generation,
        scope.provider, scope.homeFingerprint, nativeTaskId, generation,
        scope.provider, scope.homeFingerprint, nativeTaskId, generation,
      ) as Readonly<Record<keyof GenerationCensus, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  return Object.freeze({
    taskCount: storedCount(row.taskCount),
    turnCount: storedCount(row.turnCount),
    eventCount: storedCount(row.eventCount),
    receiptCount: storedCount(row.receiptCount),
  });
}

export function taskEveryGenerationCensus(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): Readonly<GenerationCensus> {
  let row: Readonly<Record<keyof GenerationCensus, unknown>> | undefined;
  try {
    row = db.prepare(`SELECT
      (SELECT COUNT(*) FROM provider_task_cache
        WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?) AS taskCount,
      (SELECT COUNT(*) FROM provider_turn_cache
        WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?) AS turnCount,
      (SELECT COUNT(*) FROM provider_event_cache
        WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?) AS eventCount,
      (SELECT COUNT(*) FROM provider_replay_receipts
        WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?) AS receiptCount`)
      .get(
        locator.provider, locator.homeFingerprint, locator.nativeTaskId,
        locator.provider, locator.homeFingerprint, locator.nativeTaskId,
        locator.provider, locator.homeFingerprint, locator.nativeTaskId,
        locator.provider, locator.homeFingerprint, locator.nativeTaskId,
      ) as Readonly<Record<keyof GenerationCensus, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  return Object.freeze({
    taskCount: storedCount(row.taskCount),
    turnCount: storedCount(row.turnCount),
    eventCount: storedCount(row.eventCount),
    receiptCount: storedCount(row.receiptCount),
  });
}

export function requireGenerationCensus(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
  expected: GenerationCensus,
): void {
  const actual = generationCensus(db, scope, generation);
  if (actual.taskCount !== expected.taskCount || actual.turnCount !== expected.turnCount ||
    actual.eventCount !== expected.eventCount || actual.receiptCount !== expected.receiptCount) {
    fail("CORRUPT_ROW");
  }
}

export function assertGenerationCapacity(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
  config: NormalizedProviderIndexStoreConfig,
): void {
  if (countGenerationRows(db, "provider_task_cache", scope, generation) >
      config.maxTasksPerGeneration ||
    countGenerationRows(db, "provider_turn_cache", scope, generation) >
      config.maxTurnsPerGeneration ||
    countGenerationRows(db, "provider_event_cache", scope, generation) >
      config.maxEventsPerGeneration ||
    generationExceedsPerTaskEventCapacity(
      db,
      scope,
      generation,
      config.maxEventsPerTask,
    )) fail("CAPACITY");
}

function generationExceedsPerTaskEventCapacity(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
  maximum: number,
): boolean {
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = db.prepare(`SELECT 1 AS exceeded FROM provider_event_cache
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation = ?
      GROUP BY native_task_id
      HAVING COUNT(*) > ?
      LIMIT 1`)
      .get(scope.provider, scope.homeFingerprint, generation, maximum) as
        Readonly<Record<string, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row !== undefined;
}

export function countGenerationSnapshotTasks(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
): number {
  let row: { count: unknown } | undefined;
  try {
    row = db.prepare(`SELECT COUNT(DISTINCT native_task_id) AS count
      FROM provider_replay_receipts
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation = ?`)
      .get(scope.provider, scope.homeFingerprint, generation) as { count: unknown } | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  return storedCount(row.count);
}

export function generationHasStructuralGap(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
): boolean {
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = db.prepare(`SELECT 1 AS invalid
      WHERE EXISTS (
        SELECT 1 FROM provider_replay_receipts AS receipt
        WHERE receipt.provider = ? AND receipt.home_fingerprint = ?
          AND receipt.cache_generation = ?
          AND receipt.event_count <> (
            SELECT COUNT(*) FROM provider_event_cache AS event
            WHERE event.provider = receipt.provider
              AND event.home_fingerprint = receipt.home_fingerprint
              AND event.native_task_id = receipt.native_task_id
              AND event.cache_generation = receipt.cache_generation
          )
      ) OR EXISTS (
        SELECT 1 FROM provider_task_cache AS task
        WHERE task.provider = ? AND task.home_fingerprint = ?
          AND task.cache_generation = ?
          AND NOT EXISTS (
            SELECT 1 FROM provider_replay_receipts AS receipt
            WHERE receipt.provider = task.provider
              AND receipt.home_fingerprint = task.home_fingerprint
              AND receipt.native_task_id = task.native_task_id
              AND receipt.cache_generation = task.cache_generation
          ) AND (
            EXISTS (
              SELECT 1 FROM provider_turn_cache AS turn
              WHERE turn.provider = task.provider
                AND turn.home_fingerprint = task.home_fingerprint
                AND turn.native_task_id = task.native_task_id
                AND turn.cache_generation = task.cache_generation
            ) OR EXISTS (
              SELECT 1 FROM provider_event_cache AS event
              WHERE event.provider = task.provider
                AND event.home_fingerprint = task.home_fingerprint
                AND event.native_task_id = task.native_task_id
                AND event.cache_generation = task.cache_generation
            )
          )
      ) OR EXISTS (
        SELECT 1 FROM provider_turn_cache AS turn
        WHERE turn.provider = ? AND turn.home_fingerprint = ?
          AND turn.cache_generation = ?
        GROUP BY turn.native_task_id
        HAVING MIN(turn.ordinal) <> 0
          OR MAX(turn.ordinal) + 1 <> COUNT(*)
          OR COUNT(DISTINCT turn.ordinal) <> COUNT(*)
      ) OR EXISTS (
        SELECT 1 FROM provider_event_cache AS event
        WHERE event.provider = ? AND event.home_fingerprint = ?
          AND event.cache_generation = ?
        GROUP BY event.native_task_id
        HAVING MIN(event.ordinal) <> 0
          OR MAX(event.ordinal) + 1 <> COUNT(*)
          OR COUNT(DISTINCT event.ordinal) <> COUNT(*)
      ) OR EXISTS (
        SELECT 1 FROM provider_event_cache AS event
        WHERE event.provider = ? AND event.home_fingerprint = ?
          AND event.cache_generation = ?
          AND NOT EXISTS (
            SELECT 1 FROM provider_turn_cache AS turn
            WHERE turn.provider = event.provider
              AND turn.home_fingerprint = event.home_fingerprint
              AND turn.native_task_id = event.native_task_id
              AND turn.cache_generation = event.cache_generation
              AND turn.native_turn_key = event.native_turn_key
          )
      )`)
      .get(
        scope.provider, scope.homeFingerprint, generation,
        scope.provider, scope.homeFingerprint, generation,
        scope.provider, scope.homeFingerprint, generation,
        scope.provider, scope.homeFingerprint, generation,
        scope.provider, scope.homeFingerprint, generation,
      ) as Readonly<Record<string, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row !== undefined;
}

export function retireOtherGenerationRows(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
): void {
  try {
    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation <> ?`)
      .run(scope.provider, scope.homeFingerprint, generation);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = db.prepare(`SELECT 1 AS remaining FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation <> ?
      LIMIT 1`).get(scope.provider, scope.homeFingerprint, generation) as
        Readonly<Record<string, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row !== undefined) fail("CORRUPT_ROW");
}

export function deleteTaskEveryGenerationRows(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): Readonly<GenerationCensus> {
  const before = taskEveryGenerationCensus(db, locator);
  const changesBefore = totalDatabaseChanges(db);
  try {
    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`)
      .run(locator.provider, locator.homeFingerprint, locator.nativeTaskId);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  const after = taskEveryGenerationCensus(db, locator);
  if (censusRowCount(after) !== 0) fail("CORRUPT_ROW");
  requireDatabaseChangeDelta(db, changesBefore, censusRowCount(before));
  return before;
}

export function deleteTaskEveryGeneration(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): boolean {
  return deleteTaskEveryGenerationRows(db, locator).taskCount > 0;
}

interface ClearCensus extends ProviderCacheClearResult {
  readonly syncCount: number;
}

interface ScopeSql {
  readonly where: string;
  readonly parameters: readonly string[];
}

function scopeSql(scope: ProviderIndexScope | null, alias = ""): Readonly<ScopeSql> {
  const column = (name: string): string => alias.length === 0 ? name : `${alias}.${name}`;
  if (scope === null) return Object.freeze({ where: "1 = 1", parameters: [] });
  if (scope.homeFingerprint === null) {
    return Object.freeze({ where: `${column("provider")} = ?`, parameters: [scope.provider] });
  }
  return Object.freeze({
    where: `${column("provider")} = ? AND ${column("home_fingerprint")} = ?`,
    parameters: [scope.provider, scope.homeFingerprint],
  });
}

function readClearCensus(
  db: SqliteDatabase,
  cacheScope: ScopeSql,
  syncScope: ScopeSql,
): Readonly<ClearCensus> {
  let row: Readonly<Record<keyof ClearCensus, unknown>> | undefined;
  try {
    row = db.prepare(`SELECT
      (SELECT COUNT(*) FROM provider_task_cache WHERE ${cacheScope.where}) AS taskCount,
      (SELECT COUNT(*) FROM provider_turn_cache WHERE ${cacheScope.where}) AS turnCount,
      (SELECT COUNT(*) FROM provider_event_cache WHERE ${cacheScope.where}) AS eventCount,
      (SELECT COUNT(*) FROM provider_replay_receipts WHERE ${cacheScope.where}) AS receiptCount,
      (SELECT COUNT(*) FROM provider_sync_state WHERE ${syncScope.where}) AS syncCount`)
      .get(
        ...cacheScope.parameters,
        ...cacheScope.parameters,
        ...cacheScope.parameters,
        ...cacheScope.parameters,
        ...syncScope.parameters,
      ) as Readonly<Record<keyof ClearCensus, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  return Object.freeze({
    taskCount: storedCount(row.taskCount),
    turnCount: storedCount(row.turnCount),
    eventCount: storedCount(row.eventCount),
    receiptCount: storedCount(row.receiptCount),
    syncCount: storedCount(row.syncCount),
  });
}

function readNextSyncStateRow(
  db: SqliteDatabase,
  scope: ScopeSql,
  after: ProviderHomeScope | null,
): ProviderSyncStateRow | null {
  const cursorWhere = after === null
    ? ""
    : `AND (provider > ? OR (provider = ? AND home_fingerprint > ?))`;
  const cursorParameters = after === null
    ? []
    : [after.provider, after.provider, after.homeFingerprint];
  let row: ProviderSyncStateRow | undefined;
  try {
    row = db.prepare(`SELECT
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at,
      state, provider_version, last_completed_at, generation_epoch
      FROM provider_sync_state
      WHERE ${scope.where} ${cursorWhere}
      ORDER BY provider, home_fingerprint
      LIMIT 1`)
      .get(...scope.parameters, ...cursorParameters) as ProviderSyncStateRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row ?? null;
}

function syncRowScope(row: ProviderSyncStateRow): Readonly<ProviderHomeScope> {
  if ((row.provider !== "openai" && row.provider !== "anthropic") ||
    typeof row.home_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.home_fingerprint)) return fail("CORRUPT_ROW");
  return Object.freeze({
    provider: row.provider,
    homeFingerprint: row.home_fingerprint,
  });
}

function validateScopedSyncStates(
  db: SqliteDatabase,
  scope: ScopeSql,
  expectedCount: number,
  decodeSyncState: DecodeProviderSyncState,
): void {
  let cursor: ProviderHomeScope | null = null;
  let visited = 0;
  while (true) {
    const row = readNextSyncStateRow(db, scope, cursor);
    if (row === null) break;
    const rowScope = syncRowScope(row);
    decodeSyncState(row, rowScope);
    cursor = rowScope;
    visited += 1;
    if (!Number.isSafeInteger(visited) || visited > expectedCount) fail("CORRUPT_ROW");
  }
  if (visited !== expectedCount) fail("CORRUPT_ROW");
}

function assertScopedCacheHasSyncAuthority(
  db: SqliteDatabase,
  scope: ScopeSql,
): void {
  let invalid: Readonly<Record<string, unknown>> | undefined;
  try {
    invalid = db.prepare(`SELECT 1 AS invalid
      FROM provider_task_cache AS task
      WHERE ${scope.where}
        AND NOT EXISTS (
          SELECT 1 FROM provider_sync_state AS sync
          WHERE sync.provider = task.provider
            AND sync.home_fingerprint = task.home_fingerprint
        )
      LIMIT 1`).get(...scope.parameters) as Readonly<Record<string, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (invalid !== undefined) fail("CORRUPT_ROW");
}

function readExactSyncStateRow(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
): ProviderSyncStateRow | null {
  let row: ProviderSyncStateRow | undefined;
  try {
    row = db.prepare(`SELECT
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at,
      state, provider_version, last_completed_at, generation_epoch
      FROM provider_sync_state
      WHERE provider = ? AND home_fingerprint = ?`)
      .get(scope.provider, scope.homeFingerprint) as ProviderSyncStateRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row ?? null;
}

function resetScopedSyncStates(
  db: SqliteDatabase,
  scope: ScopeSql,
  expectedCount: number,
  decodeSyncState: DecodeProviderSyncState,
): void {
  let cursor: ProviderHomeScope | null = null;
  let visited = 0;
  while (true) {
    const row = readNextSyncStateRow(db, scope, cursor);
    if (row === null) break;
    const rowScope = syncRowScope(row);
    const current = decodeSyncState(row, rowScope);
    const expected: Readonly<ProviderSyncState> = Object.freeze({
      ...current,
      activeGeneration: 0,
      stagingGeneration: null,
      stagingOwnerToken: null,
      stagingHeartbeatAt: null,
      stagingExpiresAt: null,
      state: "idle",
      providerVersion: null,
      lastCompletedAt: null,
    });
    if (!providerSyncStatesEqual(current, expected)) {
      const changesBefore = totalDatabaseChanges(db);
      try {
        db.prepare(`UPDATE provider_sync_state SET
          active_generation = 0,
          staging_generation = NULL,
          staging_owner_token = NULL,
          staging_heartbeat_at = NULL,
          staging_expires_at = NULL,
          state = 'idle',
          provider_version = NULL,
          last_completed_at = NULL
          WHERE provider = ? AND home_fingerprint = ?
            AND active_generation = ? AND staging_generation IS ?
            AND staging_owner_token IS ? AND staging_heartbeat_at IS ?
            AND staging_expires_at IS ? AND state = ?
            AND provider_version IS ? AND last_completed_at IS ?
            AND generation_epoch = ?`)
          .run(
            current.provider,
            current.homeFingerprint,
            current.activeGeneration,
            current.stagingGeneration,
            current.stagingOwnerToken,
            current.stagingHeartbeatAt,
            current.stagingExpiresAt,
            current.state,
            current.providerVersion,
            current.lastCompletedAt,
            current.generationEpoch,
          );
      } catch {
        return fail("DATABASE_UNAVAILABLE");
      }
      const persistedRow = readExactSyncStateRow(db, rowScope);
      if (persistedRow === null ||
        !providerSyncStatesEqual(decodeSyncState(persistedRow, rowScope), expected)) {
        fail("CORRUPT_ROW");
      }
      requireDatabaseChangeDelta(db, changesBefore, 1);
    }
    cursor = rowScope;
    visited += 1;
    if (!Number.isSafeInteger(visited) || visited > expectedCount) fail("CORRUPT_ROW");
  }
  if (visited !== expectedCount) fail("CORRUPT_ROW");
}

export function clearRebuildableCacheRows(
  db: SqliteDatabase,
  scope: ProviderIndexScope | null,
  decodeSyncState: DecodeProviderSyncState,
): Readonly<ProviderCacheClearResult> {
  const cacheScope = scopeSql(scope);
  const taskScope = scopeSql(scope, "task");
  const syncScope = scopeSql(scope);
  const counts = readClearCensus(db, cacheScope, syncScope);
  validateScopedSyncStates(db, syncScope, counts.syncCount, decodeSyncState);
  assertScopedCacheHasSyncAuthority(db, taskScope);

  const changesBeforeDelete = totalDatabaseChanges(db);
  try {
    db.prepare(`DELETE FROM provider_task_cache WHERE ${cacheScope.where}`)
      .run(...cacheScope.parameters);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  const afterDelete = readClearCensus(db, cacheScope, syncScope);
  if (censusRowCount(afterDelete) !== 0 || afterDelete.syncCount !== counts.syncCount) {
    fail("CORRUPT_ROW");
  }
  requireDatabaseChangeDelta(db, changesBeforeDelete, censusRowCount(counts));

  resetScopedSyncStates(db, syncScope, counts.syncCount, decodeSyncState);
  const finalCounts = readClearCensus(db, cacheScope, syncScope);
  if (censusRowCount(finalCounts) !== 0 || finalCounts.syncCount !== counts.syncCount) {
    fail("CORRUPT_ROW");
  }
  return Object.freeze({
    taskCount: counts.taskCount,
    turnCount: counts.turnCount,
    eventCount: counts.eventCount,
    receiptCount: counts.receiptCount,
  });
}
