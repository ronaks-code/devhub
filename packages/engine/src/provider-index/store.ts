import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { redactSecrets } from "../redact.js";
import { MAX_PROVIDER_HOME_CHARS } from "../providers/native-id.js";
import { canonicalizeProviderHome } from "../providers/task-key.js";
import type { NativeTaskKey, ProviderId } from "../providers/types.js";
import {
  homeFingerprint,
  parseTaskLocator,
  serializeTaskLocator,
  type ProviderTaskLocator,
} from "./identity.js";
import {
  normalizeProviderIndexStoreOptions,
  readProviderIndexNow,
} from "./store-codec.js";
import {
  ProviderIndexStoreError,
  type NormalizedProviderIndexStoreConfig,
  type ProviderHomeRegistration,
  type ProviderIndexStoreErrorCode,
  type ProviderIndexStoreOptions,
  type ProviderReconciliationReason,
  type ProviderReconciliationState,
  type ProviderReconciliationStore,
  type ReconciliationLatchInput,
} from "./store-types.js";
import { hasCanonicalUnicode, sqliteTextLengthAtMost } from "./text-boundary.js";

const MAX_FINGERPRINT_CHARS = 1_024;
const HOME_FINGERPRINT = /^[0-9a-f]{64}$/u;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

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

interface KnownLocator {
  readonly locator: ProviderTaskLocator;
  readonly canonicalHome: string;
}

interface NormalizedReconciliationInput {
  readonly reviewedFingerprint: string | null;
  readonly nativeFingerprint: string | null;
  readonly writerEpoch: number;
  readonly reason: ProviderReconciliationReason;
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
    error instanceof InternalStoreFailure ? error.code : fallback,
  );
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
): Readonly<{
  provider: ProviderId;
  canonicalHome: string;
  homeFingerprint: string;
  registeredAt: number;
}> {
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

function normalizeLocator(value: ProviderTaskLocator): ProviderTaskLocator {
  return parseTaskLocator(serializeTaskLocator(value));
}

function semanticFingerprint(value: unknown, canonicalHome: string): string {
  if (typeof value !== "string" || value.includes("\u0000") ||
    sqliteTextLengthAtMost(value, MAX_FINGERPRINT_CHARS) === null ||
    value.length === 0 || !hasCanonicalUnicode(value) ||
    value.includes(canonicalHome) || redactSecrets(value) !== value) {
    throw new TypeError();
  }
  return value;
}

function optionalSemanticFingerprint(value: unknown, canonicalHome: string): string | null {
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
  canonicalHome: string,
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
    if (error instanceof InternalStoreFailure) throw error;
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

function knownLocator(
  db: SqliteDatabase,
  locatorValue: ProviderTaskLocator,
): Readonly<KnownLocator> {
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
  if (canonicalHome === null) return fail("UNKNOWN_HOME");
  if (locator.nativeTaskId.includes(canonicalHome)) throw new TypeError();
  return Object.freeze({ locator, canonicalHome });
}

function recheckRegisteredHomeInsideOwnedTransaction(
  db: SqliteDatabase,
  target: KnownLocator,
): void {
  const row = queryRegisteredHomeByFingerprint(
    db,
    target.locator.provider,
    target.locator.homeFingerprint,
  );
  if (row === null) fail("UNKNOWN_HOME");
  const decoded = decodeRegisteredHomeRow(row);
  if (decoded.provider !== target.locator.provider ||
    decoded.homeFingerprint !== target.locator.homeFingerprint ||
    decoded.canonicalHome !== target.canonicalHome) {
    fail("CORRUPT_ROW");
  }
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
  target: KnownLocator,
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
    if (!required && (
      reviewedFingerprint === null || nativeFingerprint === null ||
      reviewedFingerprint !== nativeFingerprint
    )) {
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
  target: KnownLocator,
  input: NormalizedReconciliationInput,
  updatedAt: number,
): void {
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
  if (row === undefined) fail("CAPACITY");
  const written = decodeReconciliationRow(row, target);
  const expectedRevision = current === null ? 1 : current.latchRevision + 1;
  if (!written.required || written.latchRevision !== expectedRevision ||
    written.reviewedFingerprint !== input.reviewedFingerprint ||
    written.nativeFingerprint !== input.nativeFingerprint ||
    written.writerEpoch !== input.writerEpoch || written.reason !== input.reason ||
    written.updatedAt !== updatedAt) {
    fail("CORRUPT_ROW");
  }
}

function acknowledgeInsideOwnedTransaction(
  db: SqliteDatabase,
  target: KnownLocator,
  expectedLatchRevision: number,
  reviewedFingerprint: string,
  observedNativeFingerprint: string,
  updatedAt: number,
): Readonly<ProviderReconciliationState> {
  const currentRow = queryReconciliationRow(db, target.locator);
  if (currentRow === null) return fail("RECONCILIATION_CAS_MISMATCH");
  const current = decodeReconciliationRow(currentRow, target);
  if (!current.required || current.latchRevision !== expectedLatchRevision ||
    reviewedFingerprint !== observedNativeFingerprint ||
    current.nativeFingerprint !== observedNativeFingerprint) {
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
  if (row === undefined) return fail("RECONCILIATION_CAS_MISMATCH");
  const acknowledged = decodeReconciliationRow(row, target);
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

export class ProviderTaskIndexStore implements ProviderReconciliationStore {
  private readonly db: SqliteDatabase;
  private readonly config: Readonly<NormalizedProviderIndexStoreConfig>;
  private mutationInProgress = false;

  constructor(db: SqliteDatabase, options?: ProviderIndexStoreOptions) {
    this.db = db;
    this.config = normalizeProviderIndexStoreOptions(options);
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
        return Object.freeze({
          provider: input.provider,
          homeFingerprint: input.homeFingerprint,
          registeredAt: input.registeredAt,
        });
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

  getReconciliation(locatorValue: ProviderTaskLocator): Readonly<ProviderReconciliationState> {
    let target: Readonly<KnownLocator>;
    try {
      target = knownLocator(this.db, locatorValue);
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
  ): void {
    this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const target = knownLocator(this.db, locatorValue);
      const input = normalizeReconciliationInput(inputValue, target.canonicalHome);
      const now = sampleNow(this.config);
      withOwnedImmediateTransaction(this.db, () => {
        recheckRegisteredHomeInsideOwnedTransaction(this.db, target);
        writeRequiredReconciliationInsideOwnedTransaction(this.db, target, input, now);
      });
    });
  }

  acknowledgeReconciliation(
    locatorValue: ProviderTaskLocator,
    expectedLatchRevisionValue: number,
    reviewedFingerprintValue: string,
    observedNativeFingerprintValue: string,
  ): Readonly<ProviderReconciliationState> {
    return this.runMutation(() => {
      assertNoCallerTransaction(this.db);
      const target = knownLocator(this.db, locatorValue);
      const expectedLatchRevision = safeInteger(expectedLatchRevisionValue);
      const reviewedFingerprint = semanticFingerprint(
        reviewedFingerprintValue,
        target.canonicalHome,
      );
      const observedNativeFingerprint = semanticFingerprint(
        observedNativeFingerprintValue,
        target.canonicalHome,
      );
      const now = sampleNow(this.config);
      return withOwnedImmediateTransaction(this.db, () => {
        recheckRegisteredHomeInsideOwnedTransaction(this.db, target);
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
    if (this.mutationInProgress) {
      throw new ProviderIndexStoreError("DATABASE_UNAVAILABLE");
    }
    this.mutationInProgress = true;
    try {
      return mutation();
    } catch (error) {
      throw publicFailure(error, "INVALID_INPUT");
    } finally {
      this.mutationInProgress = false;
    }
  }
}
