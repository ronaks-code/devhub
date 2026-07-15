import { taskLocator } from "../provider-index/identity.js";
import type { ProviderTaskLocator } from "../provider-index/identity.js";
import type {
  ProviderReconciliationReason,
  ProviderReconciliationState,
  ProviderReconciliationStore,
  ReconciliationLatchInput,
} from "../provider-index/store-types.js";
import type { NativeTaskKey } from "./types.js";

/**
 * Narrow, provider-facing durable-reconciliation seam over
 * `provider_reconciliation_state`.
 *
 * A production native adapter never talks to the concrete
 * {@link ProviderReconciliationStore} directly. It receives one of these,
 * keyed by {@link NativeTaskKey}, so the adapter cannot reach any other store
 * capability (task cache, stage lease, metadata, ...). The wrapper carries only
 * the minimal restart-safe latch fields (required, latch revision, reviewed /
 * native fingerprint, writer epoch, reason). No prompts, events, approvals, or
 * secrets ever cross this boundary.
 *
 * Fail-closed: if the underlying durable store throws for any read or write,
 * the wrapper latches permanently unavailable and every later call (including a
 * previously healthy key) throws {@link ProviderReconciliationStoreError} with
 * code `UNAVAILABLE`. The adapter treats that as the unified runtime being
 * unavailable and must not mutate native state. There is no auto-recovery: a
 * transient durable fault is never silently forgiven, because a lost latch read
 * could let a required reconciliation be skipped.
 */
export type AdapterReconciliationSnapshot = Readonly<{
  readonly required: boolean;
  readonly latchRevision: number;
  readonly reviewedFingerprint: string | null;
  readonly nativeFingerprint: string | null;
  readonly writerEpoch: number;
  readonly reason: ProviderReconciliationReason | null;
}>;

export type AdapterReconciliationLatchInput = ReconciliationLatchInput;

export interface AdapterReconciliationStore {
  /** Reads the durable latch for one owned task. Fail-closed on store fault. */
  getReconciliation(key: NativeTaskKey): AdapterReconciliationSnapshot;
  /** Durably latches reconciliation for one owned task. Fail-closed on store fault. */
  requireReconciliation(
    key: NativeTaskKey,
    input: AdapterReconciliationLatchInput,
  ): AdapterReconciliationSnapshot;
  /**
   * Durably clears a latch via store-side CAS on the exact latch revision and
   * the reviewed/native fingerprint. Fail-closed on store fault. A CAS mismatch
   * (stale revision, changed fingerprint, newer same-fingerprint durable latch)
   * surfaces as the store's own error, not `UNAVAILABLE`, and does not latch
   * the wrapper unavailable.
   */
  acknowledgeReconciliation(
    key: NativeTaskKey,
    expectedLatchRevision: number,
    reviewedFingerprint: string | null,
    observedNativeFingerprint: string | null,
  ): AdapterReconciliationSnapshot;
  /** True once a durable read/write has failed closed; never returns to false. */
  readonly unavailable: boolean;
}

export type ProviderReconciliationStoreErrorCode =
  | "UNAVAILABLE"
  | "INVALID_KEY"
  | "STORE_REJECTED";

/** Value-free failure: paths, native ids, fingerprints never appear in the message. */
export class ProviderReconciliationStoreError extends Error {
  readonly code: ProviderReconciliationStoreErrorCode;

  constructor(code: ProviderReconciliationStoreErrorCode, message: string) {
    super(message);
    this.name = "ProviderReconciliationStoreError";
    this.code = code;
    Object.freeze(this);
  }
}

const reconciliationStoreError = (
  code: ProviderReconciliationStoreErrorCode,
  message: string,
): ProviderReconciliationStoreError => new ProviderReconciliationStoreError(code, message);

const snapshotFrom = (
  state: Readonly<ProviderReconciliationState>,
): AdapterReconciliationSnapshot =>
  Object.freeze({
    required: state.required,
    latchRevision: state.latchRevision,
    reviewedFingerprint: state.reviewedFingerprint,
    nativeFingerprint: state.nativeFingerprint,
    writerEpoch: state.writerEpoch,
    reason: state.reason,
  });

/**
 * The concrete narrow durable-reconciliation seam. Delegates every operation to
 * the injected {@link ProviderReconciliationStore} and translates outcomes:
 *   - invalid key -> `INVALID_KEY`, no delegate call, does NOT fail closed.
 *   - a `ProviderReconciliationStoreError` re-thrown from the delegate (never;
 *     the delegate throws its own store error) is not special-cased here.
 *   - ANY throw from the delegate -> fail closed (`UNAVAILABLE`) permanently.
 *
 * The wrapper never inspects error values from the delegate for CAS versus
 * fault, because a durable store that throws is not trustworthy enough to keep
 * mutating native state. Callers that need CAS-mismatch detail read the
 * returned snapshot's `latchRevision`/`required` instead of catching.
 */
class FailClosedReconciliationStore implements AdapterReconciliationStore {
  private failedClosed = false;

  constructor(private readonly store: ProviderReconciliationStore) {}

  get unavailable(): boolean {
    return this.failedClosed;
  }

  getReconciliation(key: NativeTaskKey): AdapterReconciliationSnapshot {
    const locator = this.locatorFor(key);
    return this.guard(() => snapshotFrom(this.store.getReconciliation(locator)));
  }

  requireReconciliation(
    key: NativeTaskKey,
    input: AdapterReconciliationLatchInput,
  ): AdapterReconciliationSnapshot {
    const locator = this.locatorFor(key);
    const exactInput = this.exactLatchInput(input);
    return this.guard(() =>
      snapshotFrom(this.store.requireReconciliation(locator, exactInput)));
  }

  acknowledgeReconciliation(
    key: NativeTaskKey,
    expectedLatchRevision: number,
    reviewedFingerprint: string | null,
    observedNativeFingerprint: string | null,
  ): AdapterReconciliationSnapshot {
    const locator = this.locatorFor(key);
    const expected = this.safeLatchRevision(expectedLatchRevision);
    const reviewed = this.optionalFingerprint(reviewedFingerprint);
    const observed = this.optionalFingerprint(observedNativeFingerprint);
    return this.guard(() =>
      snapshotFrom(this.store.acknowledgeReconciliation(
        locator,
        expected,
        reviewed,
        observed,
      )));
  }

  /**
   * Runs one delegate call under the fail-closed fence. `assertOpen` first, so a
   * store that has already faulted never issues another native-facing decision.
   * Any throw latches `failedClosed` and rethrows as value-free `UNAVAILABLE`.
   */
  private guard(run: () => AdapterReconciliationSnapshot): AdapterReconciliationSnapshot {
    this.assertOpen();
    try {
      return run();
    } catch {
      this.failedClosed = true;
      throw reconciliationStoreError(
        "UNAVAILABLE",
        "Provider reconciliation store is unavailable",
      );
    }
  }

  private assertOpen(): void {
    if (this.failedClosed) {
      throw reconciliationStoreError(
        "UNAVAILABLE",
        "Provider reconciliation store is unavailable",
      );
    }
  }

  private locatorFor(key: NativeTaskKey): ProviderTaskLocator {
    try {
      return taskLocator(key);
    } catch {
      throw reconciliationStoreError(
        "INVALID_KEY",
        "Provider reconciliation key is invalid",
      );
    }
  }

  private exactLatchInput(
    input: AdapterReconciliationLatchInput,
  ): AdapterReconciliationLatchInput {
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new Error();
      const writerEpoch = this.safeLatchRevision((input as { writerEpoch: unknown }).writerEpoch);
      const reason = (input as { reason: unknown }).reason;
      if (typeof reason !== "string") throw new Error();
      return Object.freeze({
        reviewedFingerprint: this.optionalFingerprint(input.reviewedFingerprint),
        nativeFingerprint: this.optionalFingerprint(input.nativeFingerprint),
        writerEpoch,
        reason: reason as ProviderReconciliationReason,
      });
    } catch {
      throw reconciliationStoreError(
        "INVALID_KEY",
        "Provider reconciliation latch input is invalid",
      );
    }
  }

  private safeLatchRevision(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw reconciliationStoreError(
        "INVALID_KEY",
        "Provider reconciliation revision is invalid",
      );
    }
    return value;
  }

  private optionalFingerprint(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || value.length === 0 || value.includes(" ")) {
      throw reconciliationStoreError(
        "INVALID_KEY",
        "Provider reconciliation fingerprint is invalid",
      );
    }
    return value;
  }
}

const hasReconciliationStoreShape = (
  value: ProviderReconciliationStore,
): boolean =>
  typeof value === "object" && value !== null &&
  typeof value.getReconciliation === "function" &&
  typeof value.requireReconciliation === "function" &&
  typeof value.acknowledgeReconciliation === "function";

/**
 * Builds the narrow fail-closed durable-reconciliation seam that both
 * production adapters (Codex and Claude) receive. The same underlying store may
 * back both providers; per-provider isolation comes from the locator
 * (provider + home fingerprint) derived from each task key, not from separate
 * stores.
 */
export function createAdapterReconciliationStore(
  store: ProviderReconciliationStore,
): AdapterReconciliationStore {
  if (!hasReconciliationStoreShape(store)) {
    throw reconciliationStoreError(
      "STORE_REJECTED",
      "Provider reconciliation store dependency is invalid",
    );
  }
  return new FailClosedReconciliationStore(store);
}
