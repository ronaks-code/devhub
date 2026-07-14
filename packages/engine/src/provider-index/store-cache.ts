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

export function deleteTaskEveryGeneration(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): boolean {
  let before: { count: unknown } | undefined;
  try {
    before = db.prepare(`SELECT COUNT(*) AS count FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`)
      .get(locator.provider, locator.homeFingerprint, locator.nativeTaskId) as
        { count: unknown } | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (before === undefined) fail("CORRUPT_ROW");
  const count = storedCount(before.count);
  try {
    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`)
      .run(locator.provider, locator.homeFingerprint, locator.nativeTaskId);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  let remaining: Readonly<Record<string, unknown>> | undefined;
  try {
    remaining = db.prepare(`SELECT 1 AS remaining FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?
      LIMIT 1`).get(locator.provider, locator.homeFingerprint, locator.nativeTaskId) as
        Readonly<Record<string, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (remaining !== undefined) fail("CORRUPT_ROW");
  return count > 0;
}

export function clearRebuildableCacheRows(
  db: SqliteDatabase,
  scope: ProviderIndexScope | null,
): Readonly<ProviderCacheClearResult> {
  const cacheWhere = scope === null
    ? "1 = 1"
    : scope.homeFingerprint === null
      ? "provider = ?"
      : "provider = ? AND home_fingerprint = ?";
  const parameters = scope === null
    ? []
    : scope.homeFingerprint === null
      ? [scope.provider]
      : [scope.provider, scope.homeFingerprint];
  let counts: Readonly<Record<keyof ProviderCacheClearResult, unknown>> | undefined;
  let syncBefore: readonly Readonly<Record<string, unknown>>[];
  try {
    counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM provider_task_cache WHERE ${cacheWhere}) AS taskCount,
      (SELECT COUNT(*) FROM provider_turn_cache WHERE ${cacheWhere}) AS turnCount,
      (SELECT COUNT(*) FROM provider_event_cache WHERE ${cacheWhere}) AS eventCount,
      (SELECT COUNT(*) FROM provider_replay_receipts WHERE ${cacheWhere}) AS receiptCount`)
      .get(...parameters, ...parameters, ...parameters, ...parameters) as
        Readonly<Record<keyof ProviderCacheClearResult, unknown>> | undefined;
    syncBefore = db.prepare(`SELECT provider, home_fingerprint, generation_epoch
      FROM provider_sync_state WHERE ${cacheWhere}
      ORDER BY provider, home_fingerprint`).all(...parameters) as unknown as
        readonly Readonly<Record<string, unknown>>[];
    db.prepare(`DELETE FROM provider_task_cache WHERE ${cacheWhere}`).run(...parameters);
    db.prepare(`UPDATE provider_sync_state SET
      active_generation = 0,
      staging_generation = NULL,
      staging_owner_token = NULL,
      staging_heartbeat_at = NULL,
      staging_expires_at = NULL,
      state = 'idle',
      provider_version = NULL,
      last_completed_at = NULL
      WHERE ${cacheWhere}`).run(...parameters);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (counts === undefined) fail("CORRUPT_ROW");
  let remaining: { count: unknown } | undefined;
  let syncAfter: readonly Readonly<Record<string, unknown>>[];
  try {
    remaining = db.prepare(`SELECT
      (SELECT COUNT(*) FROM provider_task_cache WHERE ${cacheWhere}) +
      (SELECT COUNT(*) FROM provider_turn_cache WHERE ${cacheWhere}) +
      (SELECT COUNT(*) FROM provider_event_cache WHERE ${cacheWhere}) +
      (SELECT COUNT(*) FROM provider_replay_receipts WHERE ${cacheWhere}) AS count`)
      .get(...parameters, ...parameters, ...parameters, ...parameters) as
        { count: unknown } | undefined;
    syncAfter = db.prepare(`SELECT
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at, state,
      provider_version, last_completed_at, generation_epoch
      FROM provider_sync_state WHERE ${cacheWhere}
      ORDER BY provider, home_fingerprint`).all(...parameters) as unknown as
        readonly Readonly<Record<string, unknown>>[];
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (remaining === undefined || storedCount(remaining.count) !== 0 ||
    syncAfter.length !== syncBefore.length) fail("CORRUPT_ROW");
  for (let index = 0; index < syncBefore.length; index += 1) {
    const before = syncBefore[index]!;
    const after = syncAfter[index]!;
    if (after.provider !== before.provider ||
      after.home_fingerprint !== before.home_fingerprint ||
      after.generation_epoch !== before.generation_epoch ||
      after.active_generation !== 0 || after.staging_generation !== null ||
      after.staging_owner_token !== null || after.staging_heartbeat_at !== null ||
      after.staging_expires_at !== null || after.state !== "idle" ||
      after.provider_version !== null || after.last_completed_at !== null) {
      fail("CORRUPT_ROW");
    }
  }
  return Object.freeze({
    taskCount: storedCount(counts.taskCount),
    turnCount: storedCount(counts.turnCount),
    eventCount: storedCount(counts.eventCount),
    receiptCount: storedCount(counts.receiptCount),
  });
}
