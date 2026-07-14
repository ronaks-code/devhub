import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import { normalizeProviderNativeId } from "./native-id.js";
import { snapshotNativeTaskKey } from "./task-key.js";
import type { NativeTaskKey } from "./types.js";

export const NATIVE_TASK_WRITER_HEARTBEAT_MS = 5_000;
export const NATIVE_TASK_WRITER_EXPIRY_MS = 15_000;
export const NATIVE_TASK_WRITER_DEFAULT_MAX_ACTIVE = 256;
export const NATIVE_TASK_WRITER_HARD_MAX_ACTIVE = 4_096;

const MAX_LEASE_EPOCH = Number.MAX_SAFE_INTEGER;
const TABLE = "native_task_writer_leases";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type NativeTaskWriterLeaseErrorCode =
  | "CLOCK_FAILURE"
  | "CLOSED"
  | "DATABASE_FAILURE"
  | "INVALID_CONFIGURATION"
  | "INVALID_KEY"
  | "TOKEN_FAILURE";

/** Value-free failure: paths, native ids, and owner tokens never appear in the message. */
export class NativeTaskWriterLeaseError extends Error {
  readonly code: NativeTaskWriterLeaseErrorCode;

  constructor(code: NativeTaskWriterLeaseErrorCode, message: string) {
    super(message);
    this.name = "NativeTaskWriterLeaseError";
    this.code = code;
    Object.freeze(this);
  }
}

export type NativeTaskWriterLeaseLossReason =
  | "clock"
  | "database"
  | "expired"
  | "ownership"
  | "timer";

export type NativeTaskWriterLeaseSetTimeout = (
  callback: () => void,
  delayMs: number,
) => unknown;
export type NativeTaskWriterLeaseClearTimeout = (handle: unknown) => void;

export interface NativeTaskWriterLeaseStoreOptions {
  readonly dbPath: string;
  readonly now?: () => number;
  readonly setTimeoutFn?: NativeTaskWriterLeaseSetTimeout;
  readonly clearTimeoutFn?: NativeTaskWriterLeaseClearTimeout;
  readonly ownerTokenFactory?: () => string;
  readonly maxActiveLeases?: number;
}

/**
 * Monotonic DevHub writer identity for one NativeTaskKey. This fence coordinates
 * cooperating DevHub processes only; native providers do not offer a matching CAS.
 */
export interface NativeTaskWriterLeaseFence {
  readonly key: Readonly<NativeTaskKey>;
  readonly epoch: number;
}

export type NativeTaskWriterFencedWriteResult<T> =
  | { readonly started: false }
  | { readonly started: true; readonly value: T };

export type NativeTaskWriterMutationStart<T> = (
  fence: Readonly<NativeTaskWriterLeaseFence>,
) => T;

/**
 * Exclusive writer ownership only. Readers do not participate in this primitive.
 * A new handle is deliberately unusable until the adapter rereads native revision
 * state and calls {@link NativeTaskWriterLease.confirmReread}.
 */
export interface NativeTaskWriterLease {
  readonly key: Readonly<NativeTaskKey>;
  readonly fence: Readonly<NativeTaskWriterLeaseFence>;
  readonly rereadRequired: boolean;
  readonly usable: boolean;
  readonly lost: boolean;
  readonly released: boolean;
  readonly lossReason: NativeTaskWriterLeaseLossReason | null;
  readonly expiresAtMs: number;
  confirmReread(): boolean;
  heartbeat(): boolean;
  /**
   * Revalidates this DevHub lease and invokes `startMutation` synchronously in
   * the same call stack. The callback must dispatch the provider mutation before
   * returning; do not await before dispatch. This cannot CAS provider-side state.
   */
  runFencedWrite<T>(
    startMutation: NativeTaskWriterMutationStart<T>,
  ): NativeTaskWriterFencedWriteResult<T>;
  release(): boolean;
}

type LeaseStatus = "active" | "lost" | "released";

interface LeaseState {
  readonly key: Readonly<NativeTaskKey>;
  readonly fence: Readonly<NativeTaskWriterLeaseFence>;
  readonly ownerToken: string;
  readonly epoch: number;
  status: LeaseStatus;
  lossReason: NativeTaskWriterLeaseLossReason | null;
  rereadConfirmed: boolean;
  expiresAtMs: number;
  timer: unknown;
  timerScheduled: boolean;
  timerEpoch: number;
  timerToken: object | null;
  confirmReread: () => boolean;
  heartbeat: () => boolean;
  runFencedWrite: <T>(
    startMutation: NativeTaskWriterMutationStart<T>,
  ) => NativeTaskWriterFencedWriteResult<T>;
  release: () => boolean;
  isUsable: () => boolean;
}

class SqliteNativeTaskWriterLease implements NativeTaskWriterLease {
  readonly key: Readonly<NativeTaskKey>;
  readonly fence: Readonly<NativeTaskWriterLeaseFence>;

  constructor(private readonly state: LeaseState) {
    this.key = state.key;
    this.fence = state.fence;
  }

  get rereadRequired(): boolean {
    return this.state.status === "active" && !this.state.rereadConfirmed;
  }

  get usable(): boolean {
    return this.state.isUsable();
  }

  get lost(): boolean {
    return this.state.status === "lost";
  }

  get released(): boolean {
    return this.state.status === "released";
  }

  get lossReason(): NativeTaskWriterLeaseLossReason | null {
    return this.state.lossReason;
  }

  get expiresAtMs(): number {
    return this.state.expiresAtMs;
  }

  confirmReread(): boolean {
    return this.state.confirmReread();
  }

  heartbeat(): boolean {
    return this.state.heartbeat();
  }

  runFencedWrite<T>(
    startMutation: NativeTaskWriterMutationStart<T>,
  ): NativeTaskWriterFencedWriteResult<T> {
    return this.state.runFencedWrite(startMutation);
  }

  release(): boolean {
    return this.state.release();
  }
}

const leaseError = (
  code: NativeTaskWriterLeaseErrorCode,
  message: string,
): NativeTaskWriterLeaseError => new NativeTaskWriterLeaseError(code, message);

const exactOptions = (
  value: NativeTaskWriterLeaseStoreOptions,
): Readonly<Record<string, unknown>> => {
  const allowed = [
    "dbPath",
    "now",
    "setTimeoutFn",
    "clearTimeoutFn",
    "ownerTokenFactory",
    "maxActiveLeases",
  ];
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (
      !keys.includes("dbPath") ||
      keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    ) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    throw leaseError("INVALID_CONFIGURATION", "Native task writer lease configuration is invalid");
  }
};

const positiveBoundedInteger = (value: unknown): number => {
  const resolved = value ?? NATIVE_TASK_WRITER_DEFAULT_MAX_ACTIVE;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > NATIVE_TASK_WRITER_HARD_MAX_ACTIVE
  ) {
    throw leaseError("INVALID_CONFIGURATION", "Native task writer lease configuration is invalid");
  }
  return resolved;
};

const exactDatabasePath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw leaseError("INVALID_CONFIGURATION", "Native task writer lease configuration is invalid");
  }
  return value;
};

const exactTaskKey = (value: NativeTaskKey): Readonly<NativeTaskKey> => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 3 ||
      keys.some((key) => typeof key !== "string" ||
        (key !== "provider" && key !== "home" && key !== "nativeTaskId"))
    ) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ["provider", "home", "nativeTaskId"] as const) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
    }
    const candidate = {
      provider: descriptors.provider!.value,
      home: descriptors.home!.value,
      nativeTaskId: descriptors.nativeTaskId!.value,
    } as NativeTaskKey;
    const key = snapshotNativeTaskKey(candidate);
    if (
      candidate.provider !== key.provider ||
      candidate.home !== key.home ||
      candidate.nativeTaskId !== key.nativeTaskId
    ) throw new Error();
    return key;
  } catch {
    throw leaseError("INVALID_KEY", "Native task writer lease key is invalid");
  }
};

const safeEpoch = (value: unknown): number => {
  const resolved = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_LEASE_EPOCH
  ) {
    throw new TypeError("invalid lease epoch");
  }
  return resolved;
};

const changes = (value: number | bigint): number =>
  typeof value === "bigint" ? Number(value) : value;

const FENCED_WRITE_NOT_STARTED = Object.freeze({ started: false as const });

export class NativeTaskWriterLeaseStore {
  private readonly db: SqliteDatabase;
  private readonly acquireStatement: StatementSync;
  private readonly heartbeatStatement: StatementSync;
  private readonly releaseStatement: StatementSync;
  private readonly now: () => number;
  private readonly setTimeoutFn: NativeTaskWriterLeaseSetTimeout;
  private readonly clearTimeoutFn: NativeTaskWriterLeaseClearTimeout;
  private readonly ownerTokenFactory: () => string;
  private readonly maxActiveLeases: number;
  private readonly active = new Map<SqliteNativeTaskWriterLease, LeaseState>();
  private acquisitionsInFlight = 0;
  private closedValue = false;

  constructor(options: NativeTaskWriterLeaseStoreOptions) {
    const supplied = exactOptions(options);
    const dbPath = exactDatabasePath(supplied.dbPath);
    if (supplied.now !== undefined && typeof supplied.now !== "function") {
      throw leaseError("INVALID_CONFIGURATION", "Native task writer lease configuration is invalid");
    }
    if (supplied.setTimeoutFn !== undefined && typeof supplied.setTimeoutFn !== "function") {
      throw leaseError("INVALID_CONFIGURATION", "Native task writer lease configuration is invalid");
    }
    if (supplied.clearTimeoutFn !== undefined && typeof supplied.clearTimeoutFn !== "function") {
      throw leaseError("INVALID_CONFIGURATION", "Native task writer lease configuration is invalid");
    }
    if (supplied.ownerTokenFactory !== undefined && typeof supplied.ownerTokenFactory !== "function") {
      throw leaseError("INVALID_CONFIGURATION", "Native task writer lease configuration is invalid");
    }
    this.now = (supplied.now as (() => number) | undefined) ?? Date.now;
    this.setTimeoutFn = (supplied.setTimeoutFn as NativeTaskWriterLeaseSetTimeout | undefined) ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = (supplied.clearTimeoutFn as NativeTaskWriterLeaseClearTimeout | undefined) ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.ownerTokenFactory = (supplied.ownerTokenFactory as (() => string) | undefined) ?? randomUUID;
    this.maxActiveLeases = positiveBoundedInteger(supplied.maxActiveLeases);

    let opened: SqliteDatabase | null = null;
    try {
      opened = new DatabaseSync(dbPath);
      opened.exec(`PRAGMA busy_timeout = ${NATIVE_TASK_WRITER_HEARTBEAT_MS};`);
      opened.exec("PRAGMA journal_mode = WAL;");
      opened.exec("PRAGMA synchronous = NORMAL;");
      opened.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          provider TEXT NOT NULL,
          home TEXT NOT NULL,
          native_task_id TEXT NOT NULL,
          owner_token TEXT NOT NULL,
          lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
          heartbeat_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          PRIMARY KEY (provider, home, native_task_id)
        ) WITHOUT ROWID;
      `);
      this.acquireStatement = opened.prepare(`
        INSERT INTO ${TABLE} (
          provider, home, native_task_id, owner_token, lease_epoch,
          heartbeat_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (provider, home, native_task_id) DO UPDATE SET
          owner_token = excluded.owner_token,
          lease_epoch = ${TABLE}.lease_epoch + 1,
          heartbeat_at_ms = excluded.heartbeat_at_ms,
          expires_at_ms = excluded.expires_at_ms
        WHERE ${TABLE}.expires_at_ms <= excluded.heartbeat_at_ms
          AND ${TABLE}.lease_epoch < ${MAX_LEASE_EPOCH}
        RETURNING lease_epoch AS leaseEpoch;
      `);
      this.heartbeatStatement = opened.prepare(`
        UPDATE ${TABLE}
        SET heartbeat_at_ms = ?, expires_at_ms = ?
        WHERE provider = ? AND home = ? AND native_task_id = ?
          AND owner_token = ? AND lease_epoch = ?
          AND expires_at_ms > ? AND heartbeat_at_ms <= ?
        RETURNING expires_at_ms AS expiresAtMs;
      `);
      this.releaseStatement = opened.prepare(`
        -- Retain a per-key tombstone so every later owner receives a strictly newer fence.
        UPDATE ${TABLE}
        SET heartbeat_at_ms = 0, expires_at_ms = 0
        WHERE provider = ? AND home = ? AND native_task_id = ?
          AND owner_token = ? AND lease_epoch = ?;
      `);
      this.db = opened;
    } catch {
      try {
        opened?.close();
      } catch {
        // Constructor still fails closed with a value-free database error.
      }
      throw leaseError("DATABASE_FAILURE", "Native task writer lease database is unavailable");
    }
  }

  get activeLeaseCount(): number {
    return this.active.size;
  }

  get closed(): boolean {
    return this.closedValue;
  }

  acquire(keyValue: NativeTaskKey): NativeTaskWriterLease | null {
    this.assertOpen();
    const key = exactTaskKey(keyValue);
    if (this.active.size + this.acquisitionsInFlight >= this.maxActiveLeases) return null;
    this.acquisitionsInFlight += 1;
    let pending: {
      readonly handle: SqliteNativeTaskWriterLease;
      readonly state: LeaseState;
    } | null = null;
    try {
      const now = this.readNow();
      this.assertOpen();
      const expiresAtMs = this.expiryFrom(now);
      const ownerToken = this.createOwnerToken();
      this.assertOpen();
      let row: Record<string, unknown> | undefined;
      try {
        row = this.acquireStatement.get(
          key.provider,
          key.home,
          key.nativeTaskId,
          ownerToken,
          now,
          expiresAtMs,
        );
      } catch {
        throw leaseError("DATABASE_FAILURE", "Native task writer lease database operation failed");
      }
      this.assertOpen();
      if (!row) return null;
      let epoch: number;
      try {
        epoch = safeEpoch(row.leaseEpoch);
      } catch {
        throw leaseError("DATABASE_FAILURE", "Native task writer lease database operation failed");
      }

      const fence = Object.freeze({ key, epoch });
      const state: LeaseState = {
        key,
        fence,
        ownerToken,
        epoch,
        status: "active",
        lossReason: null,
        rereadConfirmed: false,
        expiresAtMs,
        timer: undefined,
        timerScheduled: false,
        timerEpoch: 0,
        timerToken: null,
        confirmReread: () => false,
        heartbeat: () => false,
        runFencedWrite: () => FENCED_WRITE_NOT_STARTED,
        release: () => false,
        isUsable: () => false,
      };
      const handle = new SqliteNativeTaskWriterLease(state);
      state.confirmReread = () => this.confirmReread(handle, state);
      state.heartbeat = () => this.heartbeatLease(handle, state);
      state.runFencedWrite = <T>(startMutation: NativeTaskWriterMutationStart<T>) =>
        this.runFencedWrite(handle, state, startMutation);
      state.release = () => this.releaseLease(handle, state);
      state.isUsable = () => this.isUsable(handle, state);
      pending = { handle, state };
    } finally {
      this.acquisitionsInFlight -= 1;
    }

    const { handle, state } = pending;
    this.active.set(handle, state);
    this.scheduleHeartbeat(handle, state);
    return handle;
  }

  close(): void {
    if (this.closedValue) return;
    this.closedValue = true;
    for (const [handle, state] of [...this.active]) this.releaseLease(handle, state);
    try {
      this.db.close();
    } catch {
      // All handles were already made unusable; close remains idempotent and fail-closed.
    }
  }

  private confirmReread(handle: SqliteNativeTaskWriterLease, state: LeaseState): boolean {
    if (!this.heartbeatLease(handle, state)) return false;
    state.rereadConfirmed = true;
    return true;
  }

  private isUsable(handle: SqliteNativeTaskWriterLease, state: LeaseState): boolean {
    if (this.closedValue || state.status !== "active" || !state.rereadConfirmed) return false;
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.transition(handle, state, "lost", "clock");
      return false;
    }
    if (this.closedValue || state.status !== "active" || !state.rereadConfirmed) return false;
    if (now >= state.expiresAtMs) {
      this.transition(handle, state, "lost", "expired");
      return false;
    }
    return true;
  }

  private runFencedWrite<T>(
    handle: SqliteNativeTaskWriterLease,
    state: LeaseState,
    startMutation: NativeTaskWriterMutationStart<T>,
  ): NativeTaskWriterFencedWriteResult<T> {
    if (typeof startMutation !== "function") {
      throw new TypeError("Native task writer mutation start must be a function");
    }
    if (this.closedValue || state.status !== "active" || !state.rereadConfirmed) {
      return FENCED_WRITE_NOT_STARTED;
    }
    if (!this.heartbeatLease(handle, state) || this.closedValue) {
      return FENCED_WRITE_NOT_STARTED;
    }
    return Object.freeze({ started: true as const, value: startMutation(state.fence) });
  }

  private heartbeatLease(handle: SqliteNativeTaskWriterLease, state: LeaseState): boolean {
    if (state.status !== "active") return false;
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.transition(handle, state, "lost", "clock");
      return false;
    }
    if (this.closedValue || state.status !== "active") return false;
    let expiresAtMs: number;
    try {
      expiresAtMs = this.expiryFrom(now);
    } catch {
      this.transition(handle, state, "lost", "clock");
      return false;
    }
    if (now >= state.expiresAtMs) {
      this.transition(handle, state, "lost", "expired");
      return false;
    }
    try {
      const row = this.heartbeatStatement.get(
        now,
        expiresAtMs,
        state.key.provider,
        state.key.home,
        state.key.nativeTaskId,
        state.ownerToken,
        state.epoch,
        now,
        now,
      );
      if (!row || safeEpoch(row.expiresAtMs) !== expiresAtMs) {
        this.transition(handle, state, "lost", "ownership");
        return false;
      }
    } catch {
      this.transition(handle, state, "lost", "database");
      return false;
    }
    state.expiresAtMs = expiresAtMs;
    return true;
  }

  private releaseLease(handle: SqliteNativeTaskWriterLease, state: LeaseState): boolean {
    if (state.status !== "active") return false;
    let released = false;
    try {
      released = changes(this.releaseStatement.run(
        state.key.provider,
        state.key.home,
        state.key.nativeTaskId,
        state.ownerToken,
        state.epoch,
      ).changes) === 1;
    } catch {
      this.transition(handle, state, "lost", "database");
      return false;
    }
    if (!released) {
      this.transition(handle, state, "lost", "ownership");
      return false;
    }
    this.transition(handle, state, "released", null);
    return state.lossReason === null;
  }

  private scheduleHeartbeat(handle: SqliteNativeTaskWriterLease, state: LeaseState): void {
    if (state.status !== "active") return;
    if (state.timerEpoch >= MAX_LEASE_EPOCH) {
      this.bestEffortRetire(state);
      this.transition(handle, state, "lost", "timer");
      return;
    }
    const timerEpoch = state.timerEpoch + 1;
    const timerToken = Object.freeze({ epoch: timerEpoch });
    let installing = true;
    let firedSynchronously = false;
    let timer: unknown;
    try {
      timer = this.setTimeoutFn(() => {
        if (installing) {
          firedSynchronously = true;
          return;
        }
        if (
          state.status !== "active" ||
          !state.timerScheduled ||
          state.timerEpoch !== timerEpoch ||
          state.timerToken !== timerToken ||
          state.timer !== timer
        ) return;
        state.timerScheduled = false;
        state.timer = undefined;
        state.timerToken = null;
        if (!this.heartbeatLease(handle, state)) return;
        this.scheduleHeartbeat(handle, state);
      }, NATIVE_TASK_WRITER_HEARTBEAT_MS);
      installing = false;
    } catch {
      installing = false;
      this.bestEffortRetire(state);
      this.transition(handle, state, "lost", "timer");
      return;
    }
    if (firedSynchronously || this.closedValue || state.status !== "active") {
      try {
        this.clearTimeoutFn(timer);
      } catch {
        // State is already unusable or transitions to timer loss below.
      }
      if (state.status === "active") {
        this.bestEffortRetire(state);
        this.transition(handle, state, "lost", "timer");
      }
      return;
    }
    state.timer = timer;
    state.timerEpoch = timerEpoch;
    state.timerToken = timerToken;
    state.timerScheduled = true;
  }

  private transition(
    handle: SqliteNativeTaskWriterLease,
    state: LeaseState,
    status: Exclude<LeaseStatus, "active">,
    reason: NativeTaskWriterLeaseLossReason | null,
  ): void {
    if (state.status !== "active") return;
    state.status = status;
    state.lossReason = reason;
    state.rereadConfirmed = false;
    this.active.delete(handle);
    if (!state.timerScheduled) return;
    const timer = state.timer;
    state.timer = undefined;
    state.timerScheduled = false;
    state.timerToken = null;
    try {
      this.clearTimeoutFn(timer);
    } catch {
      state.status = "lost";
      state.lossReason = "timer";
    }
  }

  private bestEffortRetire(state: LeaseState): void {
    try {
      this.releaseStatement.run(
        state.key.provider,
        state.key.home,
        state.key.nativeTaskId,
        state.ownerToken,
        state.epoch,
      );
    } catch {
      // Expiry remains the cross-process fail-closed fallback.
    }
  }

  private readNow(): number {
    try {
      const value = this.now();
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
      return value;
    } catch {
      throw leaseError("CLOCK_FAILURE", "Native task writer lease clock is unavailable");
    }
  }

  private expiryFrom(now: number): number {
    const expiry = now + NATIVE_TASK_WRITER_EXPIRY_MS;
    if (!Number.isSafeInteger(expiry)) {
      throw leaseError("CLOCK_FAILURE", "Native task writer lease clock is unavailable");
    }
    return expiry;
  }

  private createOwnerToken(): string {
    try {
      const value = this.ownerTokenFactory();
      const normalized = normalizeProviderNativeId(value, "writer lease owner token");
      if (value !== normalized) throw new Error();
      return normalized;
    } catch {
      throw leaseError("TOKEN_FAILURE", "Native task writer lease owner token creation failed");
    }
  }

  private assertOpen(): void {
    if (this.closedValue) {
      throw leaseError("CLOSED", "Native task writer lease store is closed");
    }
  }
}
