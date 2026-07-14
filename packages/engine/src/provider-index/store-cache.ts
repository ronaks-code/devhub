import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import type {
  NormalizedProviderIndexStoreConfig,
  ProviderHomeScope,
} from "./store-types.js";

export type ProviderIndexCacheErrorCode = "CAPACITY" | "CORRUPT_ROW" | "DATABASE_UNAVAILABLE";

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
      ) OR EXISTS (
        SELECT 1 FROM provider_event_cache AS event
        WHERE event.provider = ? AND event.home_fingerprint = ?
          AND event.cache_generation = ?
        GROUP BY event.native_task_id
        HAVING MIN(event.ordinal) <> 0
          OR MAX(event.ordinal) + 1 <> COUNT(*)
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

export function retireOlderGenerationRows(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
): void {
  try {
    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation < ?`)
      .run(scope.provider, scope.homeFingerprint, generation);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = db.prepare(`SELECT 1 AS remaining FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation < ?
      LIMIT 1`).get(scope.provider, scope.homeFingerprint, generation) as
        Readonly<Record<string, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row !== undefined) fail("CORRUPT_ROW");
}
