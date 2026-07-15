import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { redactSecrets } from "../redact.js";
import { MAX_PROVIDER_HOME_CHARS } from "../providers/native-id.js";
import { canonicalizeProviderHome } from "../providers/task-key.js";
import type {
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  ProviderId,
} from "../providers/types.js";
import {
  canonicalProviderIndexJson,
  homeFingerprint,
  parseTaskLocator,
  serializeTaskLocator,
  type ProviderTaskLocator,
} from "./identity.js";
import {
  createProviderIndexOwnerToken,
  normalizeProviderIndexStoreOptions,
  prepareProviderTaskSnapshotForStore,
  prepareProviderTaskSummaryForStore,
  readProviderIndexNow,
} from "./store-codec.js";
import {
  ProviderIndexCacheError,
  assertGenerationCapacity,
  censusRowCount,
  countGenerationRows,
  countGenerationSnapshotTasks,
  clearRebuildableCacheRows,
  deleteTaskEveryGeneration,
  generationCensus,
  generationHasStructuralGap,
  providerSyncStatesEqual,
  requireDatabaseChangeDelta,
  requireGenerationCensus,
  retireOtherGenerationRows,
  taskGenerationCensus,
  totalDatabaseChanges,
  type GenerationCensus,
  type ProviderSyncState,
  type ProviderSyncStateRow,
} from "./store-cache.js";
import {
  normalizeProviderIndexListOptions,
  type ProviderIndexListOptions,
} from "./cursor.js";
import {
  listActiveProviderTasks,
  readActiveProviderTask,
} from "./store-active-read.js";
import {
  classifyLegacySession as classifyLegacySessionLocal,
  linkProviderFork,
  listProviderForkLinks,
  mapVerifiedLegacySession as mapVerifiedLegacySessionLocal,
  normalizeProviderTaskMetaPatch,
  patchProviderTaskMeta,
  providerLocalStateFailureCode,
  readVerifiedLegacySessionMapping,
  readProviderTaskMeta,
  type ProviderRegisteredHomeAuthority,
} from "./store-local-state.js";
import { hashPersistedProviderHome } from "./home-fingerprint.js";
import {
  ProviderIndexStoreError,
  type NormalizedProviderIndexStoreConfig,
  type IndexedProviderTask,
  type IndexedProviderTaskSummary,
  type ProviderHomeRegistration,
  type ProviderHomeScope,
  type ProviderCacheClearResult,
  type ProviderIndexCompletion,
  type ProviderIndexPromotion,
  type ProviderIndexPage,
  type ProviderIndexRegisteredHome,
  type ProviderIndexScope,
  type ProviderIndexStage,
  type ProviderIndexStoreErrorCode,
  type ProviderIndexStoreOptions,
  type LegacySessionProvenance,
  type ProviderForkLink,
  type ProviderTaskMeta,
  type ProviderTaskMetaPatch,
  type ProviderReconciliationReason,
  type ProviderReconciliationState,
  type ProviderReconciliationStore,
  type PreparedProviderTaskSnapshot,
  type PreparedProviderTaskSummary,
  type ReconciliationLatchInput,
  type VerifiedLegacyMapping,
  type VerifiedLegacySessionResolution,
} from "./store-types.js";
import { hasCanonicalUnicode, sqliteTextLengthAtMost } from "./text-boundary.js";

const MAX_FINGERPRINT_CHARS = 1_024;
const HOME_FINGERPRINT = /^[0-9a-f]{64}$/u;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

interface MutationGuardState {
  inProgress: boolean;
}

const mutationGuards = new WeakMap<SqliteDatabase, MutationGuardState>();

function mutationGuardFor(db: SqliteDatabase): MutationGuardState {
  const existing = mutationGuards.get(db);
  if (existing !== undefined) return existing;
  const created: MutationGuardState = { inProgress: false };
  mutationGuards.set(db, created);
  return created;
}

const RECONCILIATION_REASONS = new Set<ProviderReconciliationReason>([
  "REPLAY_CONFLICT",
  "NATIVE_REVISION_MISMATCH",
  "NATIVE_TASK_MISSING",
  "WRITER_LEASE_LOST",
  "MUTATION_OUTCOME_UNCERTAIN",
  "PROCESS_GENERATION_CHANGED",
  "NATIVE_STATE_INVALID",
]);

interface RegisteredHomeRow {
  readonly provider: unknown;
  readonly home_fingerprint: unknown;
  readonly canonical_home: unknown;
  readonly registered_at: unknown;
}

interface ReconciliationRow {
  readonly provider: unknown;
  readonly home_fingerprint: unknown;
  readonly native_task_id: unknown;
  readonly required: unknown;
  readonly latch_revision: unknown;
  readonly reviewed_fingerprint: unknown;
  readonly native_fingerprint: unknown;
  readonly writer_epoch: unknown;
  readonly reason: unknown;
  readonly updated_at: unknown;
}

interface ReconciliationTarget {
  readonly locator: ProviderTaskLocator;
  readonly canonicalHome: string | null;
}

interface NormalizedReconciliationInput {
  readonly reviewedFingerprint: string | null;
  readonly nativeFingerprint: string | null;
  readonly writerEpoch: number;
  readonly reason: ProviderReconciliationReason;
}

interface NormalizedHomeRegistration extends ProviderHomeRegistration {
  readonly canonicalHome: string;
}

interface KnownHomeScope {
  readonly scope: Readonly<ProviderHomeScope>;
  readonly canonicalHome: string;
}

interface KnownTaskKey {
  readonly known: KnownHomeScope;
  readonly key: NativeTaskKey;
}

class InternalStoreFailure extends Error {
  readonly code: ProviderIndexStoreErrorCode;

  constructor(code: ProviderIndexStoreErrorCode) {
    super(code);
    this.code = code;
  }
}

function fail(code: ProviderIndexStoreErrorCode): never {
  throw new InternalStoreFailure(code);
}

function publicFailure(error: unknown, fallback: ProviderIndexStoreErrorCode): ProviderIndexStoreError {
  return new ProviderIndexStoreError(
    error instanceof InternalStoreFailure || error instanceof ProviderIndexCacheError
      ? error.code
      : fallback,
  );
}

function runProviderLocalState<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const code = providerLocalStateFailureCode(error);
    if (code !== null) fail(code);
    throw error;
  }
}

function runVerifiedMappingLocalState(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    const code = providerLocalStateFailureCode(error);
    if (code === "UNKNOWN_HOME") fail("CORRUPT_ROW");
    if (code !== null) fail(code);
    throw error;
  }
}

function exactOwnData(
  value: unknown,
  requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const required = new Set(requiredKeys);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.size ||
    keys.some((key) => typeof key !== "string" || !required.has(key))) {
    throw new TypeError();
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function providerId(value: unknown): ProviderId {
  if (value !== "openai" && value !== "anthropic") throw new TypeError();
  return value;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError();
  }
  return value;
}

function homeFingerprintValue(value: unknown): string {
  if (typeof value !== "string" || !HOME_FINGERPRINT.test(value)) throw new TypeError();
  return value;
}

function boundedStoredHome(value: unknown): string {
  if (typeof value !== "string" || value.includes("\u0000") ||
    value.length === 0 ||
    sqliteTextLengthAtMost(value, MAX_PROVIDER_HOME_CHARS) === null ||
    !hasCanonicalUnicode(value)) {
    throw new TypeError();
  }
  return value;
}

function exactCanonicalHome(value: unknown): string {
  const home = boundedStoredHome(value);
  const canonical = canonicalizeProviderHome(home);
  if (canonical !== home) throw new TypeError();
  return canonical;
}

function normalizeRegistrationInput(
  keyValue: Pick<NativeTaskKey, "provider" | "home">,
  registeredAtValue: number,
): Readonly<NormalizedHomeRegistration> {
  const key = exactOwnData(keyValue, ["provider", "home"]);
  const provider = providerId(key.provider);
  const canonicalHome = exactCanonicalHome(key.home);
  const registeredAt = safeInteger(registeredAtValue);
  const fingerprint = homeFingerprint(provider, canonicalHome);
  return Object.freeze({
    provider,
    canonicalHome,
    homeFingerprint: fingerprint,
    registeredAt,
  });
}

function normalizedHomeScope(value: ProviderHomeScope): Readonly<ProviderHomeScope> {
  const input = exactOwnData(value, ["provider", "homeFingerprint"]);
  return Object.freeze({
    provider: providerId(input.provider),
    homeFingerprint: homeFingerprintValue(input.homeFingerprint),
  });
}

function normalizedIndexScope(value: ProviderIndexScope | undefined): Readonly<ProviderIndexScope> | null {
  if (value === undefined) return null;
  const input = exactOwnData(value, ["provider", "homeFingerprint"]);
  return Object.freeze({
    provider: providerId(input.provider),
    homeFingerprint: input.homeFingerprint === null
      ? null
      : homeFingerprintValue(input.homeFingerprint),
  });
}

function normalizedStage(value: ProviderIndexStage): Readonly<ProviderIndexStage> {
  const input = exactOwnData(value, [
    "provider",
    "homeFingerprint",
    "generation",
    "ownerToken",
  ]);
  return Object.freeze({
    provider: providerId(input.provider),
    homeFingerprint: homeFingerprintValue(input.homeFingerprint),
    generation: safeInteger(input.generation, 1),
    ownerToken: ownerTokenValue(input.ownerToken),
  });
}

function ownerTokenValue(value: unknown): string {
  if (typeof value !== "string" || sqliteTextLengthAtMost(value, 512) === null ||
    value.length === 0 || value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) || !hasCanonicalUnicode(value)) {
    throw new TypeError();
  }
  return value;
}

function optionalStoredText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    sqliteTextLengthAtMost(value, maximum) === null || !hasCanonicalUnicode(value)) {
    throw new TypeError();
  }
  return value;
}

function optionalSafeInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

function leaseExpiry(now: number, config: NormalizedProviderIndexStoreConfig): number {
  if (now > MAX_SAFE_INTEGER - config.stageLeaseMs) fail("CLOCK_FAILURE");
  return now + config.stageLeaseMs;
}

function sampleOwnerToken(config: NormalizedProviderIndexStoreConfig): string {
  try {
    return createProviderIndexOwnerToken(config);
  } catch {
    return fail("TOKEN_FAILURE");
  }
}

function normalizeLocator(value: ProviderTaskLocator): ProviderTaskLocator {
  return parseTaskLocator(serializeTaskLocator(value));
}

function semanticFingerprint(value: unknown, canonicalHome: string | null): string {
  if (typeof value !== "string" || value.includes("\u0000") ||
    sqliteTextLengthAtMost(value, MAX_FINGERPRINT_CHARS) === null ||
    value.length === 0 || !hasCanonicalUnicode(value) ||
    (canonicalHome !== null && value.includes(canonicalHome)) ||
    redactSecrets(value) !== value) {
    throw new TypeError();
  }
  return value;
}

function optionalSemanticFingerprint(value: unknown, canonicalHome: string | null): string | null {
  return value === null ? null : semanticFingerprint(value, canonicalHome);
}

function reconciliationReason(value: unknown): ProviderReconciliationReason {
  if (typeof value !== "string" ||
    !RECONCILIATION_REASONS.has(value as ProviderReconciliationReason)) {
    throw new TypeError();
  }
  return value as ProviderReconciliationReason;
}

function normalizeReconciliationInput(
  value: ReconciliationLatchInput,
  canonicalHome: string | null,
): Readonly<NormalizedReconciliationInput> {
  const input = exactOwnData(value, [
    "reviewedFingerprint",
    "nativeFingerprint",
    "writerEpoch",
    "reason",
  ]);
  return Object.freeze({
    reviewedFingerprint: optionalSemanticFingerprint(
      input.reviewedFingerprint,
      canonicalHome,
    ),
    nativeFingerprint: optionalSemanticFingerprint(input.nativeFingerprint, canonicalHome),
    writerEpoch: safeInteger(input.writerEpoch),
    reason: reconciliationReason(input.reason),
  });
}

function sampleNow(config: NormalizedProviderIndexStoreConfig): number {
  try {
    return readProviderIndexNow(config);
  } catch {
    return fail("CLOCK_FAILURE");
  }
}

function assertNoCallerTransaction(db: SqliteDatabase): void {
  let inTransaction: boolean;
  try {
    inTransaction = db.isTransaction;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (inTransaction) fail("DATABASE_UNAVAILABLE");
}

/** The only top-level transaction owner for provider-index mutations. */
function withOwnedImmediateTransaction<T>(
  db: SqliteDatabase,
  mutation: () => T,
): T {
  assertNoCallerTransaction(db);
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const result = mutation();
    db.exec("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {
        fail("DATABASE_UNAVAILABLE");
      }
    }
    if (error instanceof InternalStoreFailure || error instanceof ProviderIndexCacheError) {
      throw error;
    }
    return fail("DATABASE_UNAVAILABLE");
  }
}

function queryRegisteredHomeByFingerprint(
  db: SqliteDatabase,
  provider: ProviderId,
  fingerprint: string,
): RegisteredHomeRow | null {
  let row: RegisteredHomeRow | undefined;
  try {
    row = db.prepare(`SELECT provider, home_fingerprint, canonical_home, registered_at
      FROM provider_homes WHERE provider = ? AND home_fingerprint = ?`)
      .get(provider, fingerprint) as RegisteredHomeRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row ?? null;
}

function queryRegisteredHomeByPath(
  db: SqliteDatabase,
  provider: ProviderId,
  canonicalHome: string,
): RegisteredHomeRow | null {
  let row: RegisteredHomeRow | undefined;
  try {
    row = db.prepare(`SELECT provider, home_fingerprint, canonical_home, registered_at
      FROM provider_homes WHERE provider = ? AND canonical_home = ?`)
      .get(provider, canonicalHome) as RegisteredHomeRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row ?? null;
}

function decodeRegisteredHomeRow(row: RegisteredHomeRow): Readonly<{
  provider: ProviderId;
  homeFingerprint: string;
  canonicalHome: string;
  registeredAt: number;
}> {
  try {
    return Object.freeze({
      provider: providerId(row.provider),
      homeFingerprint: homeFingerprintValue(row.home_fingerprint),
      canonicalHome: boundedStoredHome(row.canonical_home),
      registeredAt: safeInteger(row.registered_at),
    });
  } catch {
    return fail("CORRUPT_ROW");
  }
}

function resolveRegisteredHome(
  db: SqliteDatabase,
  provider: ProviderId,
  fingerprint: string,
): string | null {
  const row = queryRegisteredHomeByFingerprint(db, provider, fingerprint);
  if (row === null) return null;
  const decoded = decodeRegisteredHomeRow(row);
  if (decoded.provider !== provider || decoded.homeFingerprint !== fingerprint) {
    return fail("CORRUPT_ROW");
  }
  let canonicalHome: string;
  let expected: string;
  try {
    canonicalHome = exactCanonicalHome(decoded.canonicalHome);
    expected = homeFingerprint(provider, canonicalHome);
  } catch {
    return fail("CORRUPT_ROW");
  }
  if (expected !== fingerprint) return fail("CORRUPT_ROW");
  return canonicalHome;
}

function verifiedMappingAuthority(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): ProviderRegisteredHomeAuthority {
  const row = queryRegisteredHomeByFingerprint(
    db,
    locator.provider,
    locator.homeFingerprint,
  );
  if (row === null) fail("UNKNOWN_HOME");
  const decoded = decodeRegisteredHomeRow(row);
  let canonicalHome: string;
  let expectedFingerprint: string;
  try {
    canonicalHome = exactCanonicalHome(decoded.canonicalHome);
    expectedFingerprint = homeFingerprint(decoded.provider, canonicalHome);
  } catch {
    return fail("CORRUPT_ROW");
  }
  if (decoded.provider !== locator.provider ||
    decoded.homeFingerprint !== locator.homeFingerprint ||
    expectedFingerprint !== locator.homeFingerprint) fail("CORRUPT_ROW");
  return Object.freeze({
    provider: decoded.provider,
    homeFingerprint: decoded.homeFingerprint,
    canonicalHome,
    registeredAt: decoded.registeredAt,
  });
}

function rawVerifiedMappingAuthority(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): ProviderRegisteredHomeAuthority | null {
  let row: RegisteredHomeRow | undefined;
  try {
    row = db.prepare(`SELECT provider, home_fingerprint, canonical_home, registered_at
      FROM provider_homes WHERE provider = ? AND home_fingerprint = ?`)
      .get(locator.provider, locator.homeFingerprint) as RegisteredHomeRow | undefined;
  } catch {
    throw new Error("provider index authority reread failed");
  }
  if (row === undefined) return null;
  return Object.freeze({
    provider: row.provider,
    homeFingerprint: row.home_fingerprint,
    canonicalHome: row.canonical_home,
    registeredAt: row.registered_at,
  }) as unknown as ProviderRegisteredHomeAuthority;
}

function validatePersistedRegisteredHomeAuthority(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
): void {
  const row = queryRegisteredHomeByFingerprint(db, scope.provider, scope.homeFingerprint);
  if (row === null) fail("CORRUPT_ROW");
  const decoded = decodeRegisteredHomeRow(row);
  const expectedFingerprint = hashPersistedProviderHome(
    decoded.provider,
    decoded.canonicalHome,
  );
  if (decoded.provider !== scope.provider ||
    decoded.homeFingerprint !== scope.homeFingerprint ||
    expectedFingerprint !== scope.homeFingerprint) fail("CORRUPT_ROW");
}

function verifyInsertedRegisteredHomeInsideOwnedTransaction(
  db: SqliteDatabase,
  expected: NormalizedHomeRegistration,
): Readonly<ProviderHomeRegistration> {
  const row = queryRegisteredHomeByFingerprint(
    db,
    expected.provider,
    expected.homeFingerprint,
  );
  if (row === null) fail("CORRUPT_ROW");
  const decoded = decodeRegisteredHomeRow(row);
  if (decoded.provider !== expected.provider ||
    decoded.homeFingerprint !== expected.homeFingerprint ||
    decoded.canonicalHome !== expected.canonicalHome ||
    decoded.registeredAt !== expected.registeredAt) {
    fail("CORRUPT_ROW");
  }
  return Object.freeze({
    provider: expected.provider,
    homeFingerprint: expected.homeFingerprint,
    registeredAt: expected.registeredAt,
  });
}

function knownHomeScope(
  db: SqliteDatabase,
  value: ProviderHomeScope,
): Readonly<KnownHomeScope> {
  const scope = normalizedHomeScope(value);
  const canonicalHome = resolveRegisteredHome(db, scope.provider, scope.homeFingerprint);
  if (canonicalHome === null) fail("UNKNOWN_HOME");
  return Object.freeze({ scope, canonicalHome });
}

function recheckKnownHomeInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
): void {
  const row = queryRegisteredHomeByFingerprint(
    db,
    known.scope.provider,
    known.scope.homeFingerprint,
  );
  if (row === null) fail("UNKNOWN_HOME");
  const decoded = decodeRegisteredHomeRow(row);
  if (decoded.provider !== known.scope.provider ||
    decoded.homeFingerprint !== known.scope.homeFingerprint ||
    decoded.canonicalHome !== known.canonicalHome) {
    fail("CORRUPT_ROW");
  }
}

function querySyncState(
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

function decodeSyncState(
  row: ProviderSyncStateRow,
  scope: ProviderHomeScope,
): Readonly<ProviderSyncState> {
  try {
    const provider = providerId(row.provider);
    const fingerprint = homeFingerprintValue(row.home_fingerprint);
    if (provider !== scope.provider || fingerprint !== scope.homeFingerprint) {
      throw new TypeError();
    }
    const activeGeneration = safeInteger(row.active_generation);
    const stagingGeneration = optionalSafeInteger(row.staging_generation);
    const stagingOwnerToken = row.staging_owner_token === null
      ? null
      : ownerTokenValue(row.staging_owner_token);
    const stagingHeartbeatAt = optionalSafeInteger(row.staging_heartbeat_at);
    const stagingExpiresAt = optionalSafeInteger(row.staging_expires_at);
    if (row.state !== "idle" && row.state !== "staging") throw new TypeError();
    const state = row.state;
    const providerVersion = optionalStoredText(row.provider_version, 1_024);
    const lastCompletedAt = optionalSafeInteger(row.last_completed_at);
    const generationEpoch = safeInteger(row.generation_epoch);
    if (generationEpoch < activeGeneration) throw new TypeError();
    if (state === "idle") {
      if (stagingGeneration !== null || stagingOwnerToken !== null ||
        stagingHeartbeatAt !== null || stagingExpiresAt !== null) {
        throw new TypeError();
      }
    } else if (stagingGeneration === null || stagingOwnerToken === null ||
      stagingHeartbeatAt === null || stagingExpiresAt === null ||
      stagingGeneration <= activeGeneration || stagingGeneration !== generationEpoch ||
      stagingHeartbeatAt >= stagingExpiresAt) {
      throw new TypeError();
    }
    return Object.freeze({
      provider,
      homeFingerprint: fingerprint,
      activeGeneration,
      stagingGeneration,
      stagingOwnerToken,
      stagingHeartbeatAt,
      stagingExpiresAt,
      state,
      providerVersion,
      lastCompletedAt,
      generationEpoch,
    });
  } catch (error) {
    if (error instanceof InternalStoreFailure) throw error;
    return fail("CORRUPT_ROW");
  }
}

function requiredSyncState(
  db: SqliteDatabase,
  expected: ProviderSyncState,
): Readonly<ProviderSyncState> {
  const row = querySyncState(db, expected);
  if (row === null) fail("CORRUPT_ROW");
  const decoded = decodeSyncState(row, expected);
  if (!providerSyncStatesEqual(decoded, expected)) fail("CORRUPT_ROW");
  return decoded;
}

function stageFromState(state: ProviderSyncState): Readonly<ProviderIndexStage> {
  if (state.state !== "staging" || state.stagingGeneration === null ||
    state.stagingOwnerToken === null) {
    fail("CORRUPT_ROW");
  }
  return Object.freeze({
    provider: state.provider,
    homeFingerprint: state.homeFingerprint,
    generation: state.stagingGeneration,
    ownerToken: state.stagingOwnerToken,
  });
}

function stagingState(
  current: ProviderSyncState | null,
  scope: ProviderHomeScope,
  generation: number,
  ownerToken: string,
  now: number,
  expiresAt: number,
): Readonly<ProviderSyncState> {
  return Object.freeze({
    provider: scope.provider,
    homeFingerprint: scope.homeFingerprint,
    activeGeneration: current?.activeGeneration ?? 0,
    stagingGeneration: generation,
    stagingOwnerToken: ownerToken,
    stagingHeartbeatAt: now,
    stagingExpiresAt: expiresAt,
    state: "staging",
    providerVersion: current?.providerVersion ?? null,
    lastCompletedAt: current?.lastCompletedAt ?? null,
    generationEpoch: generation,
  });
}

function idleState(current: ProviderSyncState): Readonly<ProviderSyncState> {
  return Object.freeze({
    ...current,
    stagingGeneration: null,
    stagingOwnerToken: null,
    stagingHeartbeatAt: null,
    stagingExpiresAt: null,
    state: "idle",
  });
}

function hasCacheGeneration(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
): boolean {
  try {
    return db.prepare(`SELECT 1 AS present FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation = ?
      LIMIT 1`).get(scope.provider, scope.homeFingerprint, generation) !== undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
}

function maximumCacheGeneration(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
): number | null {
  let row: { maximum: unknown } | undefined;
  try {
    row = db.prepare(`SELECT MAX(cache_generation) AS maximum
      FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ?`)
      .get(scope.provider, scope.homeFingerprint) as { maximum: unknown } | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  try {
    return optionalSafeInteger(row.maximum);
  } catch {
    return fail("CORRUPT_ROW");
  }
}

function deleteCacheGeneration(
  db: SqliteDatabase,
  scope: ProviderHomeScope,
  generation: number,
): void {
  try {
    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ? AND cache_generation = ?`)
      .run(scope.provider, scope.homeFingerprint, generation);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (hasCacheGeneration(db, scope, generation)) fail("CORRUPT_ROW");
}

function reconciliationTarget(
  db: SqliteDatabase,
  locatorValue: ProviderTaskLocator,
): Readonly<ReconciliationTarget> {
  let locator: ProviderTaskLocator;
  try {
    locator = normalizeLocator(locatorValue);
  } catch {
    throw new TypeError();
  }
  const canonicalHome = resolveRegisteredHome(
    db,
    locator.provider,
    locator.homeFingerprint,
  );
  if (canonicalHome !== null && locator.nativeTaskId.includes(canonicalHome)) {
    throw new TypeError();
  }
  return Object.freeze({ locator, canonicalHome });
}

function queryReconciliationRow(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): ReconciliationRow | null {
  let row: ReconciliationRow | undefined;
  try {
    row = db.prepare(`SELECT
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
      FROM provider_reconciliation_state
      WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`)
      .get(locator.provider, locator.homeFingerprint, locator.nativeTaskId) as
        ReconciliationRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row ?? null;
}

function missingReconciliationState(
  locator: ProviderTaskLocator,
): Readonly<ProviderReconciliationState> {
  return Object.freeze({
    locator,
    required: false,
    latchRevision: 0,
    reviewedFingerprint: null,
    nativeFingerprint: null,
    writerEpoch: 0,
    reason: null,
    updatedAt: null,
  });
}

function decodeReconciliationRow(
  row: ReconciliationRow,
  target: ReconciliationTarget,
): Readonly<ProviderReconciliationState> {
  try {
    if (providerId(row.provider) !== target.locator.provider ||
      homeFingerprintValue(row.home_fingerprint) !== target.locator.homeFingerprint ||
      row.native_task_id !== target.locator.nativeTaskId) {
      throw new TypeError();
    }
    const requiredValue = safeInteger(row.required);
    if (requiredValue !== 0 && requiredValue !== 1) throw new TypeError();
    const required = requiredValue === 1;
    const latchRevision = safeInteger(row.latch_revision, 1);
    const reviewedFingerprint = optionalSemanticFingerprint(
      row.reviewed_fingerprint,
      target.canonicalHome,
    );
    const nativeFingerprint = optionalSemanticFingerprint(
      row.native_fingerprint,
      target.canonicalHome,
    );
    const writerEpoch = safeInteger(row.writer_epoch);
    const reason = row.reason === null ? null : reconciliationReason(row.reason);
    const updatedAt = safeInteger(row.updated_at);
    if (required !== (reason !== null)) throw new TypeError();
    if (!required && reviewedFingerprint !== nativeFingerprint) {
      throw new TypeError();
    }
    return Object.freeze({
      locator: target.locator,
      required,
      latchRevision,
      reviewedFingerprint,
      nativeFingerprint,
      writerEpoch,
      reason,
      updatedAt,
    });
  } catch (error) {
    if (error instanceof InternalStoreFailure) throw error;
    return fail("CORRUPT_ROW");
  }
}

function writeRequiredReconciliationInsideOwnedTransaction(
  db: SqliteDatabase,
  target: ReconciliationTarget,
  input: NormalizedReconciliationInput,
  updatedAt: number,
): Readonly<ProviderReconciliationState> {
  const currentRow = queryReconciliationRow(db, target.locator);
  const current = currentRow === null ? null : decodeReconciliationRow(currentRow, target);
  if (current?.latchRevision === MAX_SAFE_INTEGER) fail("CAPACITY");

  let row: ReconciliationRow | undefined;
  try {
    row = db.prepare(`INSERT INTO provider_reconciliation_state (
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at
    ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, home_fingerprint, native_task_id) DO UPDATE SET
      required = 1,
      latch_revision = provider_reconciliation_state.latch_revision + 1,
      reviewed_fingerprint = excluded.reviewed_fingerprint,
      native_fingerprint = excluded.native_fingerprint,
      writer_epoch = excluded.writer_epoch,
      reason = excluded.reason,
      updated_at = excluded.updated_at
    WHERE provider_reconciliation_state.latch_revision < ${MAX_SAFE_INTEGER}
    RETURNING
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at`)
      .get(
        target.locator.provider,
        target.locator.homeFingerprint,
        target.locator.nativeTaskId,
        input.reviewedFingerprint,
        input.nativeFingerprint,
        input.writerEpoch,
        input.reason,
        updatedAt,
      ) as ReconciliationRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  const committedRow = queryReconciliationRow(db, target.locator);
  if (committedRow === null) fail("CORRUPT_ROW");
  const written = decodeReconciliationRow(committedRow, target);
  const expectedRevision = current === null ? 1 : current.latchRevision + 1;
  if (!written.required || written.latchRevision !== expectedRevision ||
    written.reviewedFingerprint !== input.reviewedFingerprint ||
    written.nativeFingerprint !== input.nativeFingerprint ||
    written.writerEpoch !== input.writerEpoch || written.reason !== input.reason ||
    written.updatedAt !== updatedAt) {
    fail("CORRUPT_ROW");
  }
  return written;
}

function acknowledgeInsideOwnedTransaction(
  db: SqliteDatabase,
  target: ReconciliationTarget,
  expectedLatchRevision: number,
  reviewedFingerprint: string | null,
  observedNativeFingerprint: string | null,
  updatedAt: number,
): Readonly<ProviderReconciliationState> {
  const currentRow = queryReconciliationRow(db, target.locator);
  if (currentRow === null) return fail("RECONCILIATION_CAS_MISMATCH");
  const current = decodeReconciliationRow(currentRow, target);
  if (!current.required || current.latchRevision !== expectedLatchRevision ||
    reviewedFingerprint !== observedNativeFingerprint) {
    return fail("RECONCILIATION_CAS_MISMATCH");
  }

  let row: ReconciliationRow | undefined;
  try {
    row = db.prepare(`UPDATE provider_reconciliation_state SET
      required = 0,
      reviewed_fingerprint = ?,
      native_fingerprint = ?,
      reason = NULL,
      updated_at = ?
    WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?
      AND required = 1 AND latch_revision = ?
      AND reviewed_fingerprint IS ? AND native_fingerprint IS ?
    RETURNING
      provider, home_fingerprint, native_task_id, required, latch_revision,
      reviewed_fingerprint, native_fingerprint, writer_epoch, reason, updated_at`)
      .get(
        reviewedFingerprint,
        observedNativeFingerprint,
        updatedAt,
        target.locator.provider,
        target.locator.homeFingerprint,
        target.locator.nativeTaskId,
        expectedLatchRevision,
        current.reviewedFingerprint,
        current.nativeFingerprint,
      ) as ReconciliationRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) return fail("CORRUPT_ROW");
  const committedRow = queryReconciliationRow(db, target.locator);
  if (committedRow === null) fail("CORRUPT_ROW");
  const acknowledged = decodeReconciliationRow(committedRow, target);
  if (acknowledged.required || acknowledged.reason !== null ||
    acknowledged.latchRevision !== current.latchRevision ||
    acknowledged.writerEpoch !== current.writerEpoch ||
    acknowledged.reviewedFingerprint !== reviewedFingerprint ||
    acknowledged.nativeFingerprint !== observedNativeFingerprint ||
    acknowledged.updatedAt !== updatedAt) {
    return fail("CORRUPT_ROW");
  }
  return acknowledged;
}

function beginStageInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
  now: number,
  expiresAt: number,
  ownerToken: string,
): Readonly<ProviderIndexStage> {
  recheckKnownHomeInsideOwnedTransaction(db, known);
  const currentRow = querySyncState(db, known.scope);
  const current = currentRow === null ? null : decodeSyncState(currentRow, known.scope);
  const maximumCached = maximumCacheGeneration(db, known.scope);
  if ((current === null && maximumCached !== null) ||
    (current?.state === "idle" && maximumCached !== null &&
      maximumCached > current.activeGeneration) ||
    (current?.state === "staging" && maximumCached !== null &&
      maximumCached > current.generationEpoch)) {
    fail("CORRUPT_ROW");
  }
  if (current?.state === "staging") {
    if (current.stagingExpiresAt === null || current.stagingGeneration === null) {
      fail("CORRUPT_ROW");
    }
    if (now < current.stagingExpiresAt) fail("STAGE_BUSY");
  }
  if (current?.generationEpoch === MAX_SAFE_INTEGER) fail("CAPACITY");
  if (current?.state === "staging") {
    deleteCacheGeneration(db, known.scope, current.generationEpoch);
  }

  const generation = (current?.generationEpoch ?? 0) + 1;
  const expected = stagingState(
    current,
    known.scope,
    generation,
    ownerToken,
    now,
    expiresAt,
  );
  let row: ProviderSyncStateRow | undefined;
  try {
    if (current === null) {
      row = db.prepare(`INSERT INTO provider_sync_state (
        provider, home_fingerprint, active_generation, staging_generation,
        staging_owner_token, staging_heartbeat_at, staging_expires_at,
        state, provider_version, last_completed_at, generation_epoch
      ) VALUES (?, ?, 0, ?, ?, ?, ?, 'staging', NULL, NULL, ?)
      RETURNING
        provider, home_fingerprint, active_generation, staging_generation,
        staging_owner_token, staging_heartbeat_at, staging_expires_at,
        state, provider_version, last_completed_at, generation_epoch`)
        .get(
          known.scope.provider,
          known.scope.homeFingerprint,
          generation,
          ownerToken,
          now,
          expiresAt,
          generation,
        ) as ProviderSyncStateRow | undefined;
    } else {
      row = db.prepare(`UPDATE provider_sync_state SET
        staging_generation = ?, staging_owner_token = ?,
        staging_heartbeat_at = ?, staging_expires_at = ?,
        state = 'staging', generation_epoch = ?
      WHERE provider = ? AND home_fingerprint = ?
        AND active_generation = ? AND generation_epoch = ? AND state = ?
        AND staging_generation IS ? AND staging_owner_token IS ?
        AND staging_heartbeat_at IS ? AND staging_expires_at IS ?
        AND provider_version IS ? AND last_completed_at IS ?
      RETURNING
        provider, home_fingerprint, active_generation, staging_generation,
        staging_owner_token, staging_heartbeat_at, staging_expires_at,
        state, provider_version, last_completed_at, generation_epoch`)
        .get(
          generation,
          ownerToken,
          now,
          expiresAt,
          generation,
          current.provider,
          current.homeFingerprint,
          current.activeGeneration,
          current.generationEpoch,
          current.state,
          current.stagingGeneration,
          current.stagingOwnerToken,
          current.stagingHeartbeatAt,
          current.stagingExpiresAt,
          current.providerVersion,
          current.lastCompletedAt,
        ) as ProviderSyncStateRow | undefined;
    }
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  return stageFromState(requiredSyncState(db, expected));
}

function heartbeatStageInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
  stage: ProviderIndexStage,
  now: number,
  expiresAt: number,
): boolean {
  recheckKnownHomeInsideOwnedTransaction(db, known);
  const currentRow = querySyncState(db, known.scope);
  if (currentRow === null) return false;
  const current = decodeSyncState(currentRow, known.scope);
  if (current.state !== "staging" || current.stagingGeneration !== stage.generation ||
    current.stagingOwnerToken !== stage.ownerToken) {
    return false;
  }
  if (current.stagingHeartbeatAt === null || current.stagingExpiresAt === null) {
    fail("CORRUPT_ROW");
  }
  if (now >= current.stagingExpiresAt) return false;
  if (now < current.stagingHeartbeatAt) fail("CLOCK_FAILURE");
  const renewedExpiresAt = Math.max(expiresAt, current.stagingExpiresAt);
  const expected = Object.freeze({
    ...current,
    stagingHeartbeatAt: now,
    stagingExpiresAt: renewedExpiresAt,
  });
  let row: ProviderSyncStateRow | undefined;
  try {
    row = db.prepare(`UPDATE provider_sync_state SET
      staging_heartbeat_at = ?, staging_expires_at = ?
    WHERE provider = ? AND home_fingerprint = ?
      AND active_generation = ? AND generation_epoch = ? AND state = 'staging'
      AND staging_generation = ? AND staging_owner_token = ?
      AND staging_heartbeat_at = ? AND staging_expires_at = ?
      AND provider_version IS ? AND last_completed_at IS ?
    RETURNING
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at,
      state, provider_version, last_completed_at, generation_epoch`)
      .get(
        now,
        renewedExpiresAt,
        current.provider,
        current.homeFingerprint,
        current.activeGeneration,
        current.generationEpoch,
        current.stagingGeneration,
        current.stagingOwnerToken,
        current.stagingHeartbeatAt,
        current.stagingExpiresAt,
        current.providerVersion,
        current.lastCompletedAt,
      ) as ProviderSyncStateRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  requiredSyncState(db, expected);
  return true;
}

function abortStageInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
  stage: ProviderIndexStage,
): void {
  recheckKnownHomeInsideOwnedTransaction(db, known);
  const currentRow = querySyncState(db, known.scope);
  if (currentRow === null) fail("STAGE_LOST");
  const current = decodeSyncState(currentRow, known.scope);
  if (current.state !== "staging" || current.stagingGeneration !== stage.generation ||
    current.stagingOwnerToken !== stage.ownerToken) {
    fail("STAGE_LOST");
  }
  deleteCacheGeneration(db, known.scope, stage.generation);
  const expected = idleState(current);
  let row: ProviderSyncStateRow | undefined;
  try {
    row = db.prepare(`UPDATE provider_sync_state SET
      staging_generation = NULL, staging_owner_token = NULL,
      staging_heartbeat_at = NULL, staging_expires_at = NULL,
      state = 'idle'
    WHERE provider = ? AND home_fingerprint = ?
      AND active_generation = ? AND generation_epoch = ? AND state = 'staging'
      AND staging_generation = ? AND staging_owner_token = ?
      AND staging_heartbeat_at = ? AND staging_expires_at = ?
      AND provider_version IS ? AND last_completed_at IS ?
    RETURNING
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at,
      state, provider_version, last_completed_at, generation_epoch`)
      .get(
        current.provider,
        current.homeFingerprint,
        current.activeGeneration,
        current.generationEpoch,
        current.stagingGeneration,
        current.stagingOwnerToken,
        current.stagingHeartbeatAt,
        current.stagingExpiresAt,
        current.providerVersion,
        current.lastCompletedAt,
      ) as ProviderSyncStateRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  requiredSyncState(db, expected);
  if (hasCacheGeneration(db, known.scope, stage.generation)) fail("CORRUPT_ROW");
}

function registeredHomeForKnown(
  known: KnownHomeScope,
): Readonly<ProviderIndexRegisteredHome> {
  return Object.freeze({
    provider: known.scope.provider,
    homeFingerprint: known.scope.homeFingerprint,
    canonicalHome: known.canonicalHome,
  });
}

function knownHomeForTaskKey(
  db: SqliteDatabase,
  value: NativeTaskKey,
): Readonly<KnownTaskKey> {
  const input = exactOwnData(value, ["provider", "home", "nativeTaskId"]);
  const provider = providerId(input.provider);
  const home = boundedStoredHome(input.home);
  const canonicalHome = canonicalizeProviderHome(home);
  const fingerprint = homeFingerprint(provider, canonicalHome);
  const known = knownHomeScope(db, { provider, homeFingerprint: fingerprint });
  if (known.canonicalHome !== canonicalHome) fail("HOME_CONFLICT");
  return Object.freeze({
    known,
    key: Object.freeze({
      provider,
      home: canonicalHome,
      nativeTaskId: input.nativeTaskId,
    }) as NativeTaskKey,
  });
}

function activeGenerationInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
): Readonly<ProviderSyncState> | null {
  recheckKnownHomeInsideOwnedTransaction(db, known);
  const row = querySyncState(db, known.scope);
  if (row === null) return null;
  const current = decodeSyncState(row, known.scope);
  return current.activeGeneration === 0 ? null : current;
}

function cacheTarget(
  known: KnownHomeScope,
  generation: number,
): Readonly<ProviderIndexStage> {
  return Object.freeze({
    provider: known.scope.provider,
    homeFingerprint: known.scope.homeFingerprint,
    generation,
    ownerToken: "active-cache",
  });
}

function indexedPreparedSummary(
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

function indexedPreparedSnapshot(
  prepared: PreparedProviderTaskSnapshot,
  generation: number,
  observedAt: number,
): Readonly<IndexedProviderTask> {
  return Object.freeze({
    ...indexedPreparedSummary(prepared, generation, observedAt, "snapshot"),
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


function renewRequiredStageInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
  stage: ProviderIndexStage,
  now: number,
  expiresAt: number,
): Readonly<ProviderSyncState> {
  recheckKnownHomeInsideOwnedTransaction(db, known);
  const currentRow = querySyncState(db, known.scope);
  if (currentRow === null) fail("STAGE_LOST");
  const current = decodeSyncState(currentRow, known.scope);
  if (current.state !== "staging" || current.stagingGeneration !== stage.generation ||
    current.stagingOwnerToken !== stage.ownerToken) fail("STAGE_LOST");
  if (current.stagingHeartbeatAt === null || current.stagingExpiresAt === null) {
    fail("CORRUPT_ROW");
  }
  if (now >= current.stagingExpiresAt) fail("STAGE_EXPIRED");
  if (now < current.stagingHeartbeatAt) fail("CLOCK_FAILURE");
  const renewedExpiresAt = Math.max(expiresAt, current.stagingExpiresAt);
  const expected = Object.freeze({
    ...current,
    stagingHeartbeatAt: now,
    stagingExpiresAt: renewedExpiresAt,
  });
  let row: ProviderSyncStateRow | undefined;
  try {
    row = db.prepare(`UPDATE provider_sync_state SET
      staging_heartbeat_at = ?, staging_expires_at = ?
    WHERE provider = ? AND home_fingerprint = ?
      AND active_generation = ? AND generation_epoch = ? AND state = 'staging'
      AND staging_generation = ? AND staging_owner_token = ?
      AND staging_heartbeat_at = ? AND staging_expires_at = ?
      AND provider_version IS ? AND last_completed_at IS ?
    RETURNING
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at,
      state, provider_version, last_completed_at, generation_epoch`)
      .get(
        now,
        renewedExpiresAt,
        current.provider,
        current.homeFingerprint,
        current.activeGeneration,
        current.generationEpoch,
        current.stagingGeneration,
        current.stagingOwnerToken,
        current.stagingHeartbeatAt,
        current.stagingExpiresAt,
        current.providerVersion,
        current.lastCompletedAt,
      ) as ProviderSyncStateRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  return requiredSyncState(db, expected);
}

function writePreparedTaskRow(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
  observedAt: number,
): void {
  const revision = prepared.revision;
  try {
    db.prepare(`INSERT INTO provider_task_cache (
      provider, home_fingerprint, native_task_id,
      title, cwd, cwd_redacted, model, status, created_at, updated_at, archived, source,
      revision_updated_at, revision_status, revision_last_turn_id,
      revision_last_turn_status, revision_last_item_id, revision_fingerprint,
      cache_generation, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, home_fingerprint, native_task_id, cache_generation)
    DO UPDATE SET
      title = excluded.title,
      cwd = excluded.cwd,
      cwd_redacted = excluded.cwd_redacted,
      model = excluded.model,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      archived = excluded.archived,
      source = excluded.source,
      revision_updated_at = excluded.revision_updated_at,
      revision_status = excluded.revision_status,
      revision_last_turn_id = excluded.revision_last_turn_id,
      revision_last_turn_status = excluded.revision_last_turn_status,
      revision_last_item_id = excluded.revision_last_item_id,
      revision_fingerprint = excluded.revision_fingerprint,
      observed_at = excluded.observed_at`)
      .run(
        prepared.locator.provider,
        prepared.locator.homeFingerprint,
        prepared.locator.nativeTaskId,
        prepared.title,
        prepared.cwd,
        prepared.cwdRedacted ? 1 : 0,
        prepared.model,
        prepared.status,
        prepared.createdAt,
        prepared.updatedAt,
        prepared.archived === null ? null : prepared.archived ? 1 : 0,
        prepared.source,
        revision?.updatedAt ?? null,
        revision?.status ?? null,
        revision?.lastTurnId ?? null,
        revision?.lastTurnStatus ?? null,
        revision?.lastItemId ?? null,
        revision?.fingerprint ?? null,
        stage.generation,
        observedAt,
      );
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
}

function writePreparedSnapshotReceipt(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSnapshot,
  observedAt: number,
): void {
  try {
    db.prepare(`INSERT INTO provider_replay_receipts (
      provider, home_fingerprint, native_task_id, cache_generation,
      replay_key, snapshot_fingerprint, event_count, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        prepared.locator.provider,
        prepared.locator.homeFingerprint,
        prepared.locator.nativeTaskId,
        stage.generation,
        prepared.receiptKey,
        prepared.snapshotFingerprint,
        prepared.eventCount,
        observedAt,
      );
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
}

type CacheRow = Readonly<Record<string, unknown>>;

function queryTaskRow(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
): CacheRow | null {
  let row: CacheRow | undefined;
  try {
    row = db.prepare(`SELECT * FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?`)
      .get(
        prepared.locator.provider,
        prepared.locator.homeFingerprint,
        prepared.locator.nativeTaskId,
        stage.generation,
      ) as CacheRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  return row ?? null;
}

function queryTaskChildRows(
  db: SqliteDatabase,
  table: "provider_turn_cache" | "provider_event_cache" | "provider_replay_receipts",
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
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
        prepared.locator.provider,
        prepared.locator.homeFingerprint,
        prepared.locator.nativeTaskId,
        stage.generation,
        limit,
      ) as unknown as CacheRow[];
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
}

function taskRowMatchesPrepared(
  row: CacheRow,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
  observedAt: number | null,
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
    cache_generation: stage.generation,
    observed_at: observedAt,
  };
  return Object.entries(expected).every(([key, value]) => (
    key === "observed_at" && observedAt === null ? true : row[key] === value
  )) && Reflect.ownKeys(row).length === Reflect.ownKeys(expected).length;
}

function databaseDataVersion(db: SqliteDatabase): number {
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = db.prepare("PRAGMA main.data_version").get() as
      Readonly<Record<string, unknown>> | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  const value = row.data_version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("CORRUPT_ROW");
  }
  return value;
}

function canonicalRowAuthority(row: CacheRow): string {
  try {
    return canonicalProviderIndexJson(row);
  } catch {
    return fail("CORRUPT_ROW");
  }
}

function querySingleTaskReceipt(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
): CacheRow | null {
  let rows: IterableIterator<unknown>;
  try {
    rows = db.prepare(`SELECT * FROM provider_replay_receipts
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?
      ORDER BY replay_key
      LIMIT 2`).iterate(
        prepared.locator.provider,
        prepared.locator.homeFingerprint,
        prepared.locator.nativeTaskId,
        stage.generation,
      );
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  let receipt: CacheRow | null = null;
  try {
    for (const row of rows) {
      if (receipt !== null || row === null || typeof row !== "object") {
        return fail("CORRUPT_ROW");
      }
      receipt = row as CacheRow;
    }
  } catch (error) {
    if (error instanceof InternalStoreFailure || error instanceof ProviderIndexCacheError) {
      throw error;
    }
    return fail("DATABASE_UNAVAILABLE");
  }
  return receipt;
}

function censusEquals(left: GenerationCensus, right: GenerationCensus): boolean {
  return left.taskCount === right.taskCount && left.turnCount === right.turnCount &&
    left.eventCount === right.eventCount && left.receiptCount === right.receiptCount;
}

interface PreservedSnapshotPreflight {
  readonly dataVersion: number;
  readonly generation: number;
  readonly sync: Readonly<ProviderSyncState>;
  readonly census: Readonly<GenerationCensus>;
  readonly taskAuthority: string;
  readonly receiptAuthority: string;
}

function preflightPreservedActiveSnapshot(
  db: SqliteDatabase,
  known: KnownHomeScope,
  prepared: PreparedProviderTaskSummary,
  config: NormalizedProviderIndexStoreConfig,
): Readonly<PreservedSnapshotPreflight> | null {
  const dataVersion = databaseDataVersion(db);
  const changesBefore = totalDatabaseChanges(db);
  const sync = activeGenerationInsideOwnedTransaction(db, known);
  if (sync === null) return null;
  const generation = sync.activeGeneration;
  const target = cacheTarget(known, generation);
  const census = taskGenerationCensus(
    db,
    known.scope,
    prepared.locator.nativeTaskId,
    generation,
  );
  const task = queryTaskRow(db, target, prepared);
  if (task === null || census.receiptCount !== 1 ||
    !taskRowMatchesPrepared(task, target, prepared, null)) return null;
  const receipt = querySingleTaskReceipt(db, target, prepared);
  if (receipt === null) fail("CORRUPT_ROW");
  const taskAuthority = canonicalRowAuthority(task);
  const receiptAuthority = canonicalRowAuthority(receipt);
  const decoded = readActiveProviderTask(
    db,
    registeredHomeForKnown(known),
    prepared.locator,
    generation,
    config,
  );
  if (decoded === null || decoded.cacheDetail !== "snapshot") fail("CORRUPT_ROW");
  const syncAfter = activeGenerationInsideOwnedTransaction(db, known);
  const taskAfter = queryTaskRow(db, target, prepared);
  const receiptAfter = querySingleTaskReceipt(db, target, prepared);
  const censusAfter = taskGenerationCensus(
    db,
    known.scope,
    prepared.locator.nativeTaskId,
    generation,
  );
  if (databaseDataVersion(db) !== dataVersion || syncAfter === null ||
    !providerSyncStatesEqual(syncAfter, sync) || taskAfter === null || receiptAfter === null ||
    canonicalRowAuthority(taskAfter) !== taskAuthority ||
    canonicalRowAuthority(receiptAfter) !== receiptAuthority ||
    !censusEquals(censusAfter, census)) fail("CORRUPT_ROW");
  requireDatabaseChangeDelta(db, changesBefore, 0);
  return Object.freeze({
    dataVersion,
    generation,
    sync,
    census,
    taskAuthority,
    receiptAuthority,
  });
}

function updatePreparedTaskObservationInsideOwnedTransaction(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
  prior: CacheRow,
  observedAt: number,
): void {
  const priorValues = [
    prior.title,
    prior.cwd,
    prior.cwd_redacted,
    prior.model,
    prior.status,
    prior.created_at,
    prior.updated_at,
    prior.archived,
    prior.source,
    prior.revision_updated_at,
    prior.revision_status,
    prior.revision_last_turn_id,
    prior.revision_last_turn_status,
    prior.revision_last_item_id,
    prior.revision_fingerprint,
    prior.observed_at,
  ].map((value): string | number | null => {
    if (value === null || typeof value === "string" ||
      (typeof value === "number" && Number.isSafeInteger(value))) return value;
    return fail("CORRUPT_ROW");
  });
  let row: CacheRow | undefined;
  try {
    row = db.prepare(`UPDATE provider_task_cache SET observed_at = ?
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?
        AND title IS ? AND cwd IS ? AND cwd_redacted IS ? AND model IS ?
        AND status IS ? AND created_at IS ? AND updated_at IS ? AND archived IS ?
        AND source IS ? AND revision_updated_at IS ? AND revision_status IS ?
        AND revision_last_turn_id IS ? AND revision_last_turn_status IS ?
        AND revision_last_item_id IS ? AND revision_fingerprint IS ?
        AND observed_at IS ?
      RETURNING *`).get(
        observedAt,
        stage.provider,
        stage.homeFingerprint,
        prepared.locator.nativeTaskId,
        stage.generation,
        ...priorValues,
      ) as CacheRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined || !taskRowMatchesPrepared(row, stage, prepared, observedAt)) {
    fail("CORRUPT_ROW");
  }
  const persisted = queryTaskRow(db, stage, prepared);
  if (persisted === null || !taskRowMatchesPrepared(persisted, stage, prepared, observedAt)) {
    fail("CORRUPT_ROW");
  }
}

function deletePreparedTaskRows(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
): void {
  try {
    db.prepare(`DELETE FROM provider_task_cache
      WHERE provider = ? AND home_fingerprint = ?
        AND native_task_id = ? AND cache_generation = ?`)
      .run(
        prepared.locator.provider,
        prepared.locator.homeFingerprint,
        prepared.locator.nativeTaskId,
        stage.generation,
      );
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  const remaining = taskGenerationCensus(
    db,
    prepared.locator,
    prepared.locator.nativeTaskId,
    stage.generation,
  );
  if (remaining.taskCount !== 0 || remaining.turnCount !== 0 ||
    remaining.eventCount !== 0 || remaining.receiptCount !== 0) {
    fail("CORRUPT_ROW");
  }
}

function stagePreparedSummaryInsideOwnedTransaction(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSummary,
  observedAt: number,
): void {
  const taskRow = queryTaskRow(db, stage, prepared);
  const census = taskGenerationCensus(
    db,
    prepared.locator,
    prepared.locator.nativeTaskId,
    stage.generation,
  );
  if (taskRow === null) {
    if (census.taskCount !== 0 || census.turnCount !== 0 || census.eventCount !== 0 ||
      census.receiptCount !== 0) fail("CORRUPT_ROW");
  } else if (census.taskCount !== 1) {
    fail("CORRUPT_ROW");
  } else if (census.receiptCount === 0) {
    if (census.turnCount !== 0 || census.eventCount !== 0) fail("CORRUPT_ROW");
  } else {
    if (census.receiptCount !== 1) fail("CORRUPT_ROW");
    if (taskRowMatchesPrepared(taskRow, stage, prepared, null)) return;
    deletePreparedTaskRows(db, stage, prepared);
  }
  writePreparedTaskRow(db, stage, prepared, observedAt);
  const persisted = queryTaskRow(db, stage, prepared);
  if (persisted === null || !taskRowMatchesPrepared(persisted, stage, prepared, observedAt)) {
    fail("CORRUPT_ROW");
  }
}

function writePreparedSnapshotChildren(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSnapshot,
): void {
  try {
    const turnStatement = db.prepare(`INSERT INTO provider_turn_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, status, started_at, completed_at, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const turn of prepared.turns) {
      turnStatement.run(
        prepared.locator.provider,
        prepared.locator.homeFingerprint,
        prepared.locator.nativeTaskId,
        stage.generation,
        turn.nativeTurnKey,
        turn.status,
        turn.startedAt,
        turn.completedAt,
        turn.ordinal,
      );
    }
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  const turns = queryTaskChildRows(
    db,
    "provider_turn_cache",
    stage,
    prepared,
    "ordinal",
    prepared.turns.length + 1,
  );
  const expectedTurns = prepared.turns.map((turn) => ({
    provider: prepared.locator.provider,
    home_fingerprint: prepared.locator.homeFingerprint,
    native_task_id: prepared.locator.nativeTaskId,
    cache_generation: stage.generation,
    native_turn_key: turn.nativeTurnKey,
    status: turn.status,
    started_at: turn.startedAt,
    completed_at: turn.completedAt,
    ordinal: turn.ordinal,
  }));
  if (JSON.stringify(turns) !== JSON.stringify(expectedTurns)) fail("CORRUPT_ROW");
  try {
    const eventStatement = db.prepare(`INSERT INTO provider_event_cache (
      provider, home_fingerprint, native_task_id, cache_generation,
      native_turn_key, native_item_key, replay_key, ordinal,
      event_fingerprint, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const turn of prepared.turns) {
      for (const event of turn.events) {
        eventStatement.run(
          prepared.locator.provider,
          prepared.locator.homeFingerprint,
          prepared.locator.nativeTaskId,
          stage.generation,
          turn.nativeTurnKey,
          event.nativeItemKey,
          event.replayKey,
          event.ordinal,
          event.eventFingerprint,
          event.eventJson,
        );
      }
    }
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
}

function snapshotRowsMatchPrepared(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSnapshot,
  taskObservedAt: number,
  receiptObservedAt = taskObservedAt,
): boolean {
  const task = queryTaskRow(db, stage, prepared);
  if (task === null || !taskRowMatchesPrepared(task, stage, prepared, taskObservedAt)) return false;
  const turns = queryTaskChildRows(
    db,
    "provider_turn_cache",
    stage,
    prepared,
    "ordinal",
    prepared.turns.length + 1,
  );
  const expectedTurns = prepared.turns.map((turn) => ({
    provider: prepared.locator.provider,
    home_fingerprint: prepared.locator.homeFingerprint,
    native_task_id: prepared.locator.nativeTaskId,
    cache_generation: stage.generation,
    native_turn_key: turn.nativeTurnKey,
    status: turn.status,
    started_at: turn.startedAt,
    completed_at: turn.completedAt,
    ordinal: turn.ordinal,
  }));
  if (JSON.stringify(turns) !== JSON.stringify(expectedTurns)) return false;
  const events = queryTaskChildRows(
    db,
    "provider_event_cache",
    stage,
    prepared,
    "ordinal",
    prepared.eventCount + 1,
  );
  const expectedEvents = prepared.turns.flatMap((turn) => turn.events.map((event) => ({
    provider: prepared.locator.provider,
    home_fingerprint: prepared.locator.homeFingerprint,
    native_task_id: prepared.locator.nativeTaskId,
    cache_generation: stage.generation,
    native_turn_key: turn.nativeTurnKey,
    native_item_key: event.nativeItemKey,
    replay_key: event.replayKey,
    ordinal: event.ordinal,
    event_fingerprint: event.eventFingerprint,
    event_json: event.eventJson,
  })));
  if (JSON.stringify(events) !== JSON.stringify(expectedEvents)) return false;
  const receipts = queryTaskChildRows(
    db,
    "provider_replay_receipts",
    stage,
    prepared,
    "replay_key",
    2,
  );
  return JSON.stringify(receipts) === JSON.stringify([{
    provider: prepared.locator.provider,
    home_fingerprint: prepared.locator.homeFingerprint,
    native_task_id: prepared.locator.nativeTaskId,
    cache_generation: stage.generation,
    replay_key: prepared.receiptKey,
    snapshot_fingerprint: prepared.snapshotFingerprint,
    event_count: prepared.eventCount,
    observed_at: receiptObservedAt,
  }]);
}

function stagePreparedSnapshotInsideOwnedTransaction(
  db: SqliteDatabase,
  stage: ProviderIndexStage,
  prepared: PreparedProviderTaskSnapshot,
  observedAt: number,
): Readonly<{ existingFingerprint: string; incomingFingerprint: string }> | null {
  const receipts = queryTaskChildRows(
    db,
    "provider_replay_receipts",
    stage,
    prepared,
    "replay_key",
    2,
  );
  if (receipts.length > 1) fail("CORRUPT_ROW");
  const existingReceipt = receipts[0];
  if (existingReceipt !== undefined &&
    existingReceipt.replay_key === prepared.receiptKey &&
    existingReceipt.snapshot_fingerprint === prepared.snapshotFingerprint) {
    const existingObservedAt = safeInteger(existingReceipt.observed_at);
    if (!snapshotRowsMatchPrepared(db, stage, prepared, existingObservedAt)) fail("CORRUPT_ROW");
    return null;
  }
  if (existingReceipt !== undefined && existingReceipt.replay_key === prepared.receiptKey) {
    return Object.freeze({
      existingFingerprint: homeFingerprintValue(existingReceipt.snapshot_fingerprint),
      incomingFingerprint: prepared.snapshotFingerprint,
    });
  }
  if (queryTaskRow(db, stage, prepared) !== null) {
    deletePreparedTaskRows(db, stage, prepared);
  }
  writePreparedTaskRow(db, stage, prepared, observedAt);
  writePreparedSnapshotChildren(db, stage, prepared);
  writePreparedSnapshotReceipt(db, stage, prepared, observedAt);
  if (!snapshotRowsMatchPrepared(db, stage, prepared, observedAt)) fail("CORRUPT_ROW");
  return null;
}

interface NormalizedCompletion extends ProviderIndexCompletion {}

function normalizedCompletion(
  value: ProviderIndexCompletion,
  canonicalHome: string,
  config: NormalizedProviderIndexStoreConfig,
): Readonly<NormalizedCompletion> {
  const input = exactOwnData(value, [
    "completedAt",
    "providerVersion",
    "taskCount",
    "turnCount",
    "eventCount",
    "snapshotCount",
    "receiptCount",
  ]);
  const completion = Object.freeze({
    completedAt: safeInteger(input.completedAt),
    providerVersion: optionalSemanticFingerprint(input.providerVersion, canonicalHome),
    taskCount: safeInteger(input.taskCount),
    turnCount: safeInteger(input.turnCount),
    eventCount: safeInteger(input.eventCount),
    snapshotCount: safeInteger(input.snapshotCount),
    receiptCount: safeInteger(input.receiptCount),
  });
  if (completion.taskCount > config.maxTasksPerGeneration ||
    completion.turnCount > config.maxTurnsPerGeneration ||
    completion.eventCount > config.maxEventsPerGeneration) fail("CAPACITY");
  if (completion.snapshotCount > completion.taskCount ||
    completion.receiptCount !== completion.snapshotCount) fail("STAGE_INCOMPLETE");
  return completion;
}

function requiredUnexpiredStageInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
  stage: ProviderIndexStage,
  now: number,
): Readonly<ProviderSyncState> {
  recheckKnownHomeInsideOwnedTransaction(db, known);
  const row = querySyncState(db, known.scope);
  if (row === null) fail("STAGE_LOST");
  const current = decodeSyncState(row, known.scope);
  if (current.state !== "staging" || current.stagingGeneration !== stage.generation ||
    current.stagingOwnerToken !== stage.ownerToken) fail("STAGE_LOST");
  if (current.stagingHeartbeatAt === null || current.stagingExpiresAt === null) {
    fail("CORRUPT_ROW");
  }
  if (now < current.stagingHeartbeatAt) fail("CLOCK_FAILURE");
  if (now >= current.stagingExpiresAt) fail("STAGE_EXPIRED");
  return current;
}

function replacementGenerationCensus(
  before: GenerationCensus,
  priorTask: GenerationCensus,
  nextTask: GenerationCensus,
): Readonly<GenerationCensus> {
  return Object.freeze({
    taskCount: safeInteger(before.taskCount - priorTask.taskCount + nextTask.taskCount),
    turnCount: safeInteger(before.turnCount - priorTask.turnCount + nextTask.turnCount),
    eventCount: safeInteger(before.eventCount - priorTask.eventCount + nextTask.eventCount),
    receiptCount: safeInteger(before.receiptCount - priorTask.receiptCount + nextTask.receiptCount),
  });
}

function promoteStageInsideOwnedTransaction(
  db: SqliteDatabase,
  known: KnownHomeScope,
  stage: ProviderIndexStage,
  completion: NormalizedCompletion,
  now: number,
  config: NormalizedProviderIndexStoreConfig,
): Readonly<ProviderIndexPromotion> {
  const current = requiredUnexpiredStageInsideOwnedTransaction(db, known, stage, now);
  const taskCount = countGenerationRows(db, "provider_task_cache", known.scope, stage.generation);
  const turnCount = countGenerationRows(db, "provider_turn_cache", known.scope, stage.generation);
  const eventCount = countGenerationRows(db, "provider_event_cache", known.scope, stage.generation);
  const receiptCount = countGenerationRows(
    db,
    "provider_replay_receipts",
    known.scope,
    stage.generation,
  );
  const snapshotCount = countGenerationSnapshotTasks(db, known.scope, stage.generation);
  assertGenerationCapacity(db, known.scope, stage.generation, config);
  if (taskCount !== completion.taskCount || turnCount !== completion.turnCount ||
    eventCount !== completion.eventCount || receiptCount !== completion.receiptCount ||
    snapshotCount !== completion.snapshotCount || receiptCount !== snapshotCount ||
    generationHasStructuralGap(db, known.scope, stage.generation)) fail("STAGE_INCOMPLETE");

  const expected = Object.freeze({
    ...current,
    activeGeneration: stage.generation,
    stagingGeneration: null,
    stagingOwnerToken: null,
    stagingHeartbeatAt: null,
    stagingExpiresAt: null,
    state: "idle" as const,
    providerVersion: completion.providerVersion,
    lastCompletedAt: completion.completedAt,
  });
  let row: ProviderSyncStateRow | undefined;
  try {
    row = db.prepare(`UPDATE provider_sync_state SET
      active_generation = ?, staging_generation = NULL, staging_owner_token = NULL,
      staging_heartbeat_at = NULL, staging_expires_at = NULL, state = 'idle',
      provider_version = ?, last_completed_at = ?
    WHERE provider = ? AND home_fingerprint = ?
      AND active_generation = ? AND generation_epoch = ? AND state = 'staging'
      AND staging_generation = ? AND staging_owner_token = ?
      AND staging_heartbeat_at = ? AND staging_expires_at = ?
      AND provider_version IS ? AND last_completed_at IS ?
    RETURNING
      provider, home_fingerprint, active_generation, staging_generation,
      staging_owner_token, staging_heartbeat_at, staging_expires_at,
      state, provider_version, last_completed_at, generation_epoch`)
      .get(
        stage.generation,
        completion.providerVersion,
        completion.completedAt,
        current.provider,
        current.homeFingerprint,
        current.activeGeneration,
        current.generationEpoch,
        current.stagingGeneration,
        current.stagingOwnerToken,
        current.stagingHeartbeatAt,
        current.stagingExpiresAt,
        current.providerVersion,
        current.lastCompletedAt,
      ) as ProviderSyncStateRow | undefined;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) fail("CORRUPT_ROW");
  retireOtherGenerationRows(db, known.scope, stage.generation);
  requiredSyncState(db, expected);
  if (countGenerationRows(db, "provider_task_cache", known.scope, stage.generation) !== taskCount ||
    countGenerationRows(db, "provider_turn_cache", known.scope, stage.generation) !== turnCount ||
    countGenerationRows(db, "provider_event_cache", known.scope, stage.generation) !== eventCount ||
    countGenerationRows(db, "provider_replay_receipts", known.scope, stage.generation) !== receiptCount ||
    countGenerationSnapshotTasks(db, known.scope, stage.generation) !== snapshotCount ||
    generationHasStructuralGap(db, known.scope, stage.generation)) fail("CORRUPT_ROW");
  return Object.freeze({
    provider: current.provider,
    homeFingerprint: current.homeFingerprint,
    previousGeneration: current.activeGeneration,
    activeGeneration: stage.generation,
    completedAt: completion.completedAt,
    taskCount,
    turnCount,
    eventCount,
    snapshotCount,
  });
}

export class ProviderTaskIndexStore implements ProviderReconciliationStore {
  private readonly db: SqliteDatabase;
  private readonly config: Readonly<NormalizedProviderIndexStoreConfig>;
  private readonly mutationGuard: MutationGuardState;

  constructor(db: SqliteDatabase, options?: ProviderIndexStoreOptions) {
    this.db = db;
    this.config = normalizeProviderIndexStoreOptions(options);
    this.mutationGuard = mutationGuardFor(db);
  }

  registerHome(
    key: Pick<NativeTaskKey, "provider" | "home">,
    registeredAt: number,
  ): Readonly<ProviderHomeRegistration> {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const input = normalizeRegistrationInput(key, registeredAt);
      return withOwnedImmediateTransaction(this.db, () => {
        const byFingerprint = queryRegisteredHomeByFingerprint(
          this.db,
          input.provider,
          input.homeFingerprint,
        );
        const byHome = queryRegisteredHomeByPath(
          this.db,
          input.provider,
          input.canonicalHome,
        );
        if (byFingerprint !== null || byHome !== null) {
          const fingerprintRow = byFingerprint === null ? null : decodeRegisteredHomeRow(byFingerprint);
          const homeRow = byHome === null ? null : decodeRegisteredHomeRow(byHome);
          const existing = fingerprintRow ?? homeRow;
          if (existing === null || fingerprintRow?.canonicalHome !== input.canonicalHome ||
            homeRow?.homeFingerprint !== input.homeFingerprint ||
            existing.provider !== input.provider ||
            existing.homeFingerprint !== input.homeFingerprint ||
            existing.canonicalHome !== input.canonicalHome) {
            return fail("HOME_CONFLICT");
          }
          return Object.freeze({
            provider: input.provider,
            homeFingerprint: input.homeFingerprint,
            registeredAt: existing.registeredAt,
          });
        }

        try {
          this.db.prepare(`INSERT INTO provider_homes
            (provider, home_fingerprint, canonical_home, registered_at)
            VALUES (?, ?, ?, ?)`)
            .run(
              input.provider,
              input.homeFingerprint,
              input.canonicalHome,
              input.registeredAt,
            );
        } catch {
          return fail("DATABASE_UNAVAILABLE");
        }
        return verifyInsertedRegisteredHomeInsideOwnedTransaction(this.db, input);
      });
    });
  }

  resolveHome(providerValue: ProviderId, homeFingerprintInput: string): string | null {
    let provider: ProviderId;
    let fingerprint: string;
    try {
      provider = providerId(providerValue);
      fingerprint = homeFingerprintValue(homeFingerprintInput);
    } catch (error) {
      throw publicFailure(error, "INVALID_INPUT");
    }
    try {
      return resolveRegisteredHome(this.db, provider, fingerprint);
    } catch (error) {
      throw publicFailure(error, "DATABASE_UNAVAILABLE");
    }
  }

  beginStage(scopeValue: ProviderHomeScope): Readonly<ProviderIndexStage> {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const known = knownHomeScope(this.db, scopeValue);
      const now = sampleNow(this.config);
      const expiresAt = leaseExpiry(now, this.config);
      const ownerToken = sampleOwnerToken(this.config);
      return withOwnedImmediateTransaction(this.db, () =>
        beginStageInsideOwnedTransaction(
          this.db,
          known,
          now,
          expiresAt,
          ownerToken,
        ));
    });
  }

  heartbeatStage(stageValue: ProviderIndexStage): boolean {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const stage = normalizedStage(stageValue);
      const known = knownHomeScope(this.db, {
        provider: stage.provider,
        homeFingerprint: stage.homeFingerprint,
      });
      const now = sampleNow(this.config);
      const expiresAt = leaseExpiry(now, this.config);
      return withOwnedImmediateTransaction(this.db, () =>
        heartbeatStageInsideOwnedTransaction(
          this.db,
          known,
          stage,
          now,
          expiresAt,
        ));
    });
  }

  abortStage(stageValue: ProviderIndexStage): void {
    this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const stage = normalizedStage(stageValue);
      const known = knownHomeScope(this.db, {
        provider: stage.provider,
        homeFingerprint: stage.homeFingerprint,
      });
      withOwnedImmediateTransaction(this.db, () =>
        abortStageInsideOwnedTransaction(this.db, known, stage));
    });
  }

  stageSummary(
    stageValue: ProviderIndexStage,
    keyValue: NativeTaskKey,
    summaryValue: NativeTaskSummary,
  ): void {
    this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const stage = normalizedStage(stageValue);
      const known = knownHomeScope(this.db, {
        provider: stage.provider,
        homeFingerprint: stage.homeFingerprint,
      });
      const preparation = prepareProviderTaskSummaryForStore(
        registeredHomeForKnown(known),
        keyValue,
        summaryValue,
      );
      if (preparation.status === "failed") fail(preparation.code);
      const prepared = preparation.value;
      const now = sampleNow(this.config);
      const expiresAt = leaseExpiry(now, this.config);
      withOwnedImmediateTransaction(this.db, () => {
        const before = generationCensus(this.db, known.scope, stage.generation);
        const priorTask = taskGenerationCensus(
          this.db,
          known.scope,
          prepared.locator.nativeTaskId,
          stage.generation,
        );
        const existing = queryTaskRow(this.db, stage, prepared);
        const preservesSnapshot = existing !== null && priorTask.receiptCount === 1 &&
          taskRowMatchesPrepared(existing, stage, prepared, null);
        const expected = replacementGenerationCensus(before, priorTask, {
          taskCount: 1,
          turnCount: preservesSnapshot ? priorTask.turnCount : 0,
          eventCount: preservesSnapshot ? priorTask.eventCount : 0,
          receiptCount: preservesSnapshot ? 1 : 0,
        });
        renewRequiredStageInsideOwnedTransaction(this.db, known, stage, now, expiresAt);
        stagePreparedSummaryInsideOwnedTransaction(this.db, stage, prepared, now);
        requireGenerationCensus(this.db, known.scope, stage.generation, expected);
        assertGenerationCapacity(this.db, known.scope, stage.generation, this.config);
      });
    });
  }

  stageSnapshot(
    stageValue: ProviderIndexStage,
    keyValue: NativeTaskKey,
    taskValue: NativeTask,
  ): void {
    this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const stage = normalizedStage(stageValue);
      const known = knownHomeScope(this.db, {
        provider: stage.provider,
        homeFingerprint: stage.homeFingerprint,
      });
      const preparation = prepareProviderTaskSnapshotForStore(
        registeredHomeForKnown(known),
        keyValue,
        taskValue,
        this.config,
      );
      if (preparation.status === "failed") fail(preparation.code);
      const prepared = preparation.value;
      const now = sampleNow(this.config);
      const expiresAt = leaseExpiry(now, this.config);
      let replayConflict = false;
      withOwnedImmediateTransaction(this.db, () => {
        const before = generationCensus(this.db, known.scope, stage.generation);
        const priorTask = taskGenerationCensus(
          this.db,
          known.scope,
          prepared.locator.nativeTaskId,
          stage.generation,
        );
        const expected = replacementGenerationCensus(before, priorTask, {
          taskCount: 1,
          turnCount: prepared.turns.length,
          eventCount: prepared.eventCount,
          receiptCount: 1,
        });
        renewRequiredStageInsideOwnedTransaction(this.db, known, stage, now, expiresAt);
        const conflict = stagePreparedSnapshotInsideOwnedTransaction(
          this.db,
          stage,
          prepared,
          now,
        );
        if (conflict === null) {
          requireGenerationCensus(this.db, known.scope, stage.generation, expected);
          assertGenerationCapacity(this.db, known.scope, stage.generation, this.config);
          return;
        }
        abortStageInsideOwnedTransaction(this.db, known, stage);
        const target: ReconciliationTarget = Object.freeze({
          locator: prepared.locator,
          canonicalHome: known.canonicalHome,
        });
        const input = normalizeReconciliationInput({
          reviewedFingerprint: `provider-index-snapshot:v1:${conflict.existingFingerprint}`,
          nativeFingerprint: `provider-index-snapshot:v1:${conflict.incomingFingerprint}`,
          writerEpoch: 0,
          reason: "REPLAY_CONFLICT",
        }, known.canonicalHome);
        writeRequiredReconciliationInsideOwnedTransaction(this.db, target, input, now);
        replayConflict = true;
      });
      if (replayConflict) fail("REPLAY_CONFLICT");
    });
  }

  promoteStage(
    stageValue: ProviderIndexStage,
    completionValue: ProviderIndexCompletion,
  ): Readonly<ProviderIndexPromotion> {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const stage = normalizedStage(stageValue);
      const known = knownHomeScope(this.db, {
        provider: stage.provider,
        homeFingerprint: stage.homeFingerprint,
      });
      const completion = normalizedCompletion(completionValue, known.canonicalHome, this.config);
      const now = sampleNow(this.config);
      return withOwnedImmediateTransaction(this.db, () =>
        promoteStageInsideOwnedTransaction(
          this.db,
          known,
          stage,
          completion,
          now,
          this.config,
        ));
    });
  }

  replaceActiveSummary(
    keyValue: NativeTaskKey,
    summaryValue: NativeTaskSummary,
    observedAtValue: number,
  ): Readonly<IndexedProviderTaskSummary> | null {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const targetKey = knownHomeForTaskKey(this.db, keyValue);
      const preparation = prepareProviderTaskSummaryForStore(
        registeredHomeForKnown(targetKey.known),
        targetKey.key,
        summaryValue,
      );
      if (preparation.status === "failed") fail(preparation.code);
      const prepared = preparation.value;
      const observedAt = safeInteger(observedAtValue);
      const preservedPreflight = preflightPreservedActiveSnapshot(
        this.db,
        targetKey.known,
        prepared,
        this.config,
      );
      return withOwnedImmediateTransaction(this.db, () => {
        const sync = activeGenerationInsideOwnedTransaction(this.db, targetKey.known);
        if (sync === null) {
          if (preservedPreflight !== null) fail("CORRUPT_ROW");
          return null;
        }
        const generation = sync.activeGeneration;
        const target = cacheTarget(targetKey.known, generation);
        const before = generationCensus(this.db, targetKey.known.scope, generation);
        const priorTask = taskGenerationCensus(
          this.db,
          targetKey.known.scope,
          prepared.locator.nativeTaskId,
          generation,
        );
        const existing = queryTaskRow(this.db, target, prepared);
        const preservedReceipt = preservedPreflight === null
          ? null
          : querySingleTaskReceipt(this.db, target, prepared);
        if (preservedPreflight !== null && (existing === null || preservedReceipt === null ||
          preservedPreflight.generation !== generation ||
          preservedPreflight.dataVersion !== databaseDataVersion(this.db) ||
          !providerSyncStatesEqual(preservedPreflight.sync, sync) ||
          !censusEquals(preservedPreflight.census, priorTask) ||
          canonicalRowAuthority(existing) !== preservedPreflight.taskAuthority ||
          canonicalRowAuthority(preservedReceipt) !== preservedPreflight.receiptAuthority)) {
          fail("CORRUPT_ROW");
        }
        const preservesSnapshot = existing !== null && priorTask.receiptCount === 1 &&
          taskRowMatchesPrepared(existing, target, prepared, null);
        const expected = replacementGenerationCensus(before, priorTask, {
          taskCount: 1,
          turnCount: preservesSnapshot ? priorTask.turnCount : 0,
          eventCount: preservesSnapshot ? priorTask.eventCount : 0,
          receiptCount: preservesSnapshot ? 1 : 0,
        });
        const changesBefore = totalDatabaseChanges(this.db);
        const expectedChanges = preservesSnapshot || priorTask.receiptCount === 0
          ? 1
          : censusRowCount(priorTask) + 1;
        if (preservesSnapshot) {
          if (preservedPreflight === null || preservedReceipt === null) fail("CORRUPT_ROW");
          updatePreparedTaskObservationInsideOwnedTransaction(
            this.db,
            target,
            prepared,
            existing!,
            observedAt,
          );
        } else {
          stagePreparedSummaryInsideOwnedTransaction(this.db, target, prepared, observedAt);
        }
        requireGenerationCensus(this.db, targetKey.known.scope, generation, expected);
        assertGenerationCapacity(this.db, targetKey.known.scope, generation, this.config);
        requireDatabaseChangeDelta(this.db, changesBefore, expectedChanges);
        requiredSyncState(this.db, sync);
        recheckKnownHomeInsideOwnedTransaction(this.db, targetKey.known);
        return indexedPreparedSummary(
          prepared,
          generation,
          observedAt,
          preservesSnapshot ? "snapshot" : "summary",
        );
      });
    });
  }

  replaceActiveSnapshot(
    keyValue: NativeTaskKey,
    taskValue: NativeTask,
    observedAtValue: number,
  ): Readonly<IndexedProviderTask> | null {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const targetKey = knownHomeForTaskKey(this.db, keyValue);
      const preparation = prepareProviderTaskSnapshotForStore(
        registeredHomeForKnown(targetKey.known),
        targetKey.key,
        taskValue,
        this.config,
      );
      if (preparation.status === "failed") fail(preparation.code);
      const prepared = preparation.value;
      const observedAt = safeInteger(observedAtValue);
      let replayConflict = false;
      const result = withOwnedImmediateTransaction(this.db, () => {
        const sync = activeGenerationInsideOwnedTransaction(this.db, targetKey.known);
        if (sync === null) return null;
        const generation = sync.activeGeneration;
        const target = cacheTarget(targetKey.known, generation);
        const before = generationCensus(this.db, targetKey.known.scope, generation);
        const priorTask = taskGenerationCensus(
          this.db,
          targetKey.known.scope,
          prepared.locator.nativeTaskId,
          generation,
        );
        const expected = replacementGenerationCensus(before, priorTask, {
          taskCount: 1,
          turnCount: prepared.turns.length,
          eventCount: prepared.eventCount,
          receiptCount: 1,
        });
        const changesBefore = totalDatabaseChanges(this.db);
        const receipts = queryTaskChildRows(
          this.db,
          "provider_replay_receipts",
          target,
          prepared,
          "replay_key",
          2,
        );
        if (receipts.length > 1) fail("CORRUPT_ROW");
        const existingReceipt = receipts[0];
        let conflict: Readonly<{
          existingFingerprint: string;
          incomingFingerprint: string;
        }> | null;
        if (existingReceipt !== undefined &&
          existingReceipt.replay_key === prepared.receiptKey &&
          existingReceipt.snapshot_fingerprint === prepared.snapshotFingerprint) {
          const existingTask = queryTaskRow(this.db, target, prepared);
          if (existingTask === null) fail("CORRUPT_ROW");
          const taskObservedAt = safeInteger(existingTask.observed_at);
          const receiptObservedAt = safeInteger(existingReceipt.observed_at);
          if (!snapshotRowsMatchPrepared(
            this.db,
            target,
            prepared,
            taskObservedAt,
            receiptObservedAt,
          )) fail("CORRUPT_ROW");
          deletePreparedTaskRows(this.db, target, prepared);
          writePreparedTaskRow(this.db, target, prepared, observedAt);
          writePreparedSnapshotChildren(this.db, target, prepared);
          writePreparedSnapshotReceipt(this.db, target, prepared, observedAt);
          if (!snapshotRowsMatchPrepared(this.db, target, prepared, observedAt)) {
            fail("CORRUPT_ROW");
          }
          conflict = null;
        } else {
          conflict = stagePreparedSnapshotInsideOwnedTransaction(
            this.db,
            target,
            prepared,
            observedAt,
          );
        }
        if (conflict !== null) {
          deletePreparedTaskRows(this.db, target, prepared);
          const reconciliationTargetValue: ReconciliationTarget = Object.freeze({
            locator: prepared.locator,
            canonicalHome: targetKey.known.canonicalHome,
          });
          const input = normalizeReconciliationInput({
            reviewedFingerprint: `provider-index-snapshot:v1:${conflict.existingFingerprint}`,
            nativeFingerprint: `provider-index-snapshot:v1:${conflict.incomingFingerprint}`,
            writerEpoch: 0,
            reason: "REPLAY_CONFLICT",
          }, targetKey.known.canonicalHome);
          writeRequiredReconciliationInsideOwnedTransaction(
            this.db,
            reconciliationTargetValue,
            input,
            observedAt,
          );
          requireDatabaseChangeDelta(
            this.db,
            changesBefore,
            censusRowCount(priorTask) + 1,
          );
          requiredSyncState(this.db, sync);
          recheckKnownHomeInsideOwnedTransaction(this.db, targetKey.known);
          replayConflict = true;
          return null;
        }
        requireGenerationCensus(this.db, targetKey.known.scope, generation, expected);
        assertGenerationCapacity(this.db, targetKey.known.scope, generation, this.config);
        requireDatabaseChangeDelta(
          this.db,
          changesBefore,
          censusRowCount(priorTask) + censusRowCount({
            taskCount: 1,
            turnCount: prepared.turns.length,
            eventCount: prepared.eventCount,
            receiptCount: 1,
          }),
        );
        requiredSyncState(this.db, sync);
        recheckKnownHomeInsideOwnedTransaction(this.db, targetKey.known);
        return indexedPreparedSnapshot(prepared, generation, observedAt);
      });
      if (replayConflict) fail("REPLAY_CONFLICT");
      return result;
    });
  }

  list(
    optionsValue: ProviderIndexListOptions = {},
  ): Readonly<ProviderIndexPage<IndexedProviderTaskSummary>> {
    return this.runMutation(() => {
      let options;
      try {
        options = normalizeProviderIndexListOptions(optionsValue);
      } catch {
        return fail("INVALID_INPUT");
      }
      return listActiveProviderTasks(this.db, options, decodeSyncState);
    });
  }

  read(locatorValue: ProviderTaskLocator): Readonly<IndexedProviderTask> | null {
    return this.runMutation(() => {
      const locator = normalizeLocator(locatorValue);
      const known = knownHomeScope(this.db, {
        provider: locator.provider,
        homeFingerprint: locator.homeFingerprint,
      });
      const syncRow = querySyncState(this.db, known.scope);
      if (syncRow === null) return null;
      const sync = decodeSyncState(syncRow, known.scope);
      if (sync.activeGeneration === 0) return null;
      return readActiveProviderTask(
        this.db,
        registeredHomeForKnown(known),
        locator,
        sync.activeGeneration,
        this.config,
      );
    });
  }

  invalidate(locatorValue: ProviderTaskLocator): boolean {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const locator = normalizeLocator(locatorValue);
      const known = knownHomeScope(this.db, {
        provider: locator.provider,
        homeFingerprint: locator.homeFingerprint,
      });
      return withOwnedImmediateTransaction(this.db, () => {
        recheckKnownHomeInsideOwnedTransaction(this.db, known);
        return deleteTaskEveryGeneration(this.db, locator);
      });
    });
  }

  clearRebuildableCache(
    scopeValue?: ProviderIndexScope,
  ): Readonly<ProviderCacheClearResult> {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const scope = normalizedIndexScope(scopeValue);
      return withOwnedImmediateTransaction(this.db, () =>
        clearRebuildableCacheRows(this.db, scope, (row, rowScope) => {
          const decoded = decodeSyncState(row, rowScope);
          validatePersistedRegisteredHomeAuthority(this.db, decoded);
          return decoded;
        }));
    });
  }

  getMeta(locatorValue: ProviderTaskLocator): Readonly<ProviderTaskMeta> {
    return this.runMutation(() => runProviderLocalState(() =>
      readProviderTaskMeta(
        this.db,
        normalizeLocator(locatorValue),
        this.config.maxMetadataDepth,
      )));
  }

  patchMeta(
    locatorValue: ProviderTaskLocator,
    patchValue: ProviderTaskMetaPatch,
  ): Readonly<ProviderTaskMeta> {
    return this.runMutation(() => {
      const locator = normalizeLocator(locatorValue);
      const patch = runProviderLocalState(() =>
        normalizeProviderTaskMetaPatch(patchValue, this.config.maxMetadataDepth));
      const updatedAt = sampleNow(this.config);
      return runProviderLocalState(() => patchProviderTaskMeta(
        this.db,
        locator,
        patch,
        updatedAt,
        this.config.maxMetadataDepth,
      ));
    });
  }

  linkFork(
    sourceValue: ProviderTaskLocator,
    targetValue: ProviderTaskLocator,
    digestValue: string,
    createdAtValue: number,
  ): Readonly<ProviderForkLink> {
    return this.runMutation(() => runProviderLocalState(() => linkProviderFork(
      this.db,
      sourceValue,
      targetValue,
      digestValue,
      createdAtValue,
    )));
  }

  listForkLinks(locatorValue: ProviderTaskLocator): readonly ProviderForkLink[] {
    return this.runMutation(() => runProviderLocalState(() =>
      listProviderForkLinks(this.db, locatorValue)));
  }

  classifyLegacySession(
    sessionIdValue: string,
    provenanceValue: LegacySessionProvenance,
    observedAtValue: number,
  ): void {
    this.runMutation(() => runProviderLocalState(() => classifyLegacySessionLocal(
      this.db,
      sessionIdValue,
      provenanceValue,
      observedAtValue,
    )));
  }

  getVerifiedLegacySessionMapping(
    sessionIdValue: string,
  ): Readonly<VerifiedLegacySessionResolution> | null {
    return this.runMutation(() => runProviderLocalState(() =>
      readVerifiedLegacySessionMapping(this.db, sessionIdValue)));
  }

  mapVerifiedLegacySession(
    sessionIdValue: string,
    locatorValue: ProviderTaskLocator,
    evidenceValue: VerifiedLegacyMapping,
  ): void {
    this.runMutation(() => {
      const locator = normalizeLocator(locatorValue);
      const authority = verifiedMappingAuthority(this.db, locator);
      runVerifiedMappingLocalState(() => mapVerifiedLegacySessionLocal(
        this.db,
        sessionIdValue,
        locator,
        evidenceValue,
        authority,
        () => rawVerifiedMappingAuthority(this.db, locator),
      ));
    });
  }

  getReconciliation(locatorValue: ProviderTaskLocator): Readonly<ProviderReconciliationState> {
    let target: Readonly<ReconciliationTarget>;
    try {
      target = reconciliationTarget(this.db, locatorValue);
    } catch (error) {
      throw publicFailure(error, "INVALID_INPUT");
    }
    try {
      const row = queryReconciliationRow(this.db, target.locator);
      if (row === null) return missingReconciliationState(target.locator);
      return decodeReconciliationRow(row, target);
    } catch (error) {
      throw publicFailure(error, "CORRUPT_ROW");
    }
  }

  requireReconciliation(
    locatorValue: ProviderTaskLocator,
    inputValue: ReconciliationLatchInput,
  ): Readonly<ProviderReconciliationState> {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const target = reconciliationTarget(this.db, locatorValue);
      const input = normalizeReconciliationInput(inputValue, target.canonicalHome);
      const now = sampleNow(this.config);
      return withOwnedImmediateTransaction(this.db, () =>
        writeRequiredReconciliationInsideOwnedTransaction(this.db, target, input, now));
    });
  }

  acknowledgeReconciliation(
    locatorValue: ProviderTaskLocator,
    expectedLatchRevisionValue: number,
    reviewedFingerprintValue: string | null,
    observedNativeFingerprintValue: string | null,
  ): Readonly<ProviderReconciliationState> {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const target = reconciliationTarget(this.db, locatorValue);
      const expectedLatchRevision = safeInteger(expectedLatchRevisionValue);
      const reviewedFingerprint = optionalSemanticFingerprint(
        reviewedFingerprintValue,
        target.canonicalHome,
      );
      const observedNativeFingerprint = optionalSemanticFingerprint(
        observedNativeFingerprintValue,
        target.canonicalHome,
      );
      const now = sampleNow(this.config);
      return withOwnedImmediateTransaction(this.db, () => {
        return acknowledgeInsideOwnedTransaction(
          this.db,
          target,
          expectedLatchRevision,
          reviewedFingerprint,
          observedNativeFingerprint,
          now,
        );
      });
    });
  }

  private runMutation<T>(mutation: () => T): T {
    if (this.mutationGuard.inProgress) {
      throw new ProviderIndexStoreError("DATABASE_UNAVAILABLE");
    }
    this.mutationGuard.inProgress = true;
    try {
      return mutation();
    } catch (error) {
      throw publicFailure(error, "INVALID_INPUT");
    } finally {
      this.mutationGuard.inProgress = false;
    }
  }
}
