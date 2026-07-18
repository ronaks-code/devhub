import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  isProviderActiveStatus,
  isProviderTerminalStatus,
  isRuntimeFailureUncertainStatus,
} from "../../provider-status-contract.js";
import {
  ProviderCapabilityError,
  defineProviderCapabilities,
} from "../capabilities.js";
import { normalizeProviderEvent, type ProviderEvent } from "../events.js";
import {
  ProviderOperationError,
  type ProviderOperationErrorCode,
} from "../operation-error.js";
import { createProviderRequestIdentity } from "../request-identity.js";
import {
  canonicalizeProviderHome,
  createNativeTaskKey,
  nativeTaskKeyId,
} from "../task-key.js";
import type {
  ListTasksInput,
  NativeRevision,
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  NativeTurn,
  NativeTurnRef,
  Page,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEventSink,
  ProviderRequestResponse,
  StartTaskInput,
  TaskOverrides,
  Unsubscribe,
  UserInput,
} from "../types.js";
import type { NativeTaskWriterLease } from "../writer-lease.js";
import type { AdapterReconciliationStore } from "../reconciliation-store.js";
import type { ProviderReconciliationReason } from "../../provider-index/store-types.js";
import { buildClaudeNativeRevision } from "./revision.js";
import type { ClaudeCliPermissionMode } from "./cli-process.js";
import {
  CLAUDE_SESSION_HELPER_DEFAULT_LIMIT,
  CLAUDE_SESSION_HELPER_MAX_LIMIT,
  CLAUDE_SESSION_HELPER_MAX_OFFSET,
  CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES,
  type ClaudeSessionMessagesSnapshot,
  type ClaudeSessionSummarySnapshot,
  type ClaudeSessionTextMessageSnapshot,
} from "./session-helpers.js";
import type {
  ClaudePersistentLease,
  ClaudeSupervisorAcquireOptions,
  ClaudeSupervisorReconcileContext,
} from "./supervisor.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PATH_CHARS = 16_384;
const MAX_INPUT_CHARS = 1_048_576;
const MAX_TITLE_CHARS = 1_024;
const MAX_MODEL_CHARS = 256;
const MAX_MESSAGE_CHARS = 32_768;
const MAX_CURSOR_CHARS = 256;
const MAX_REVISION_FINGERPRINT_CHARS = 512;
const MAX_ACTIVE_TASKS = 256;
const MAX_SUBSCRIBED_TASKS = 256;
const MAX_SUBSCRIBERS_PER_TASK = 64;
const MAX_PENDING_RUNTIME_EVENTS = 256;
const MAX_TRACKED_REVISIONS = 4_096;
const MAX_PENDING_MUTATIONS = 256;
const MAX_TRACKED_TERMINAL_TURNS = 256;

const ENABLED_CAPABILITIES = defineProviderCapabilities({
  list: true,
  read: true,
  start: true,
  resume: true,
  fork: true,
  send: true,
  interrupt: true,
  subscribe: true,
  rename: true,
});
const DISABLED_CAPABILITIES = defineProviderCapabilities();

export type ClaudeNativeAdapterErrorCode = ProviderOperationErrorCode;

/** Adapter errors deliberately contain no paths, ids, input text, or provider values. */
export class ClaudeNativeAdapterError
  extends ProviderOperationError<ClaudeNativeAdapterErrorCode> {
  constructor(
    code: ClaudeNativeAdapterErrorCode,
    message: string,
    options: { readonly task?: Readonly<NativeTask> } = {},
  ) {
    super(code, message, options);
    this.name = "ClaudeNativeAdapterError";
  }
}

const adapterError = (
  code: ClaudeNativeAdapterErrorCode,
  message: string,
  options?: { readonly task?: Readonly<NativeTask> },
): ClaudeNativeAdapterError => new ClaudeNativeAdapterError(code, message, options);

export interface ClaudeNativeAdapterHelpers {
  listSessions(options: {
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly ClaudeSessionSummarySnapshot[]>;
  getSessionInfo(sessionId: string): Promise<Readonly<ClaudeSessionSummarySnapshot> | null>;
  getSessionMessages(
    sessionId: string,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<Readonly<ClaudeSessionMessagesSnapshot>>;
  renameSession(sessionId: string, title: string): Promise<void>;
  forkSession(
    sessionId: string,
    options?: { readonly upToMessageId?: string },
  ): Promise<string>;
}

export interface ClaudeNativeAdapterSupervisor {
  acquire(options: ClaudeSupervisorAcquireOptions): Promise<ClaudePersistentLease>;
}

export interface ClaudeNativeAdapterWriterLeases {
  acquire(key: NativeTaskKey): NativeTaskWriterLease | null;
}

export interface ClaudeNativeAdapterOptions {
  readonly home: string;
  readonly helpers: ClaudeNativeAdapterHelpers;
  readonly supervisor: ClaudeNativeAdapterSupervisor;
  readonly writerLeases: ClaudeNativeAdapterWriterLeases;
  readonly isEnabled?: () => boolean;
  readonly idFactory?: () => string;
  readonly canonicalizeHome?: (home: string) => string;
  readonly maxTrackedRevisions?: number;
  /**
   * Optional durable mirror of the in-memory reconciliation latch over
   * `provider_reconciliation_state`. When injected, Claude keeps its existing
   * in-memory/reentrancy behavior but also mirrors required/acknowledged state
   * durably and restores a required latch before accepting any post-restart
   * mutation. A durable read/write fault fails closed and makes the unified
   * runtime unavailable. Absent, behavior is exactly the in-memory-only path.
   */
  readonly reconciliationStore?: AdapterReconciliationStore;
}

interface SubscriberState {
  readonly sink: ProviderEventSink;
  status: "quarantined" | "active";
  readonly replay: readonly ProviderEvent[];
  readonly pending: ProviderEvent[];
  overflowed: boolean;
}

interface SubscriptionState {
  readonly key: Readonly<NativeTaskKey>;
  readonly sinks: Map<symbol, SubscriberState>;
}

interface WriterAcquisition {
  readonly lease: NativeTaskWriterLease;
  readonly stale: boolean;
}

interface RevisionState {
  fingerprint: string | null;
  everPersisted: boolean;
  reconciliationRequired: boolean;
  reconciliationEpoch: bigint;
  lastAcknowledgedFingerprint: string | null;
  lastWriterEpoch: number;
  policy: Readonly<{
    permissionMode: ClaudeCliPermissionMode;
    requestedModel: string | null;
  }> | null;
}

interface RuntimeState {
  readonly key: Readonly<NativeTaskKey>;
  readonly owner: symbol;
  cwd: string | null;
  requestedModel: string | null;
  permissionMode: ClaudeCliPermissionMode | null;
  initialLaunch: "new" | "resume" | null;
  runtime: ClaudePersistentLease | null;
  runtimePromise: Promise<ClaudePersistentLease> | null;
  writer: NativeTaskWriterLease | null;
  writerPromise: Promise<WriterAcquisition> | null;
  readonly pendingEvents: ProviderEvent[];
  readonly replayEvents: ProviderEvent[];
  replayOverflow: boolean;
  nativeInitialized: boolean;
  activeTurnId: string | null;
  readonly terminalTurnIds: Set<string>;
  readonly activeActivities: Set<string>;
  lastWriterEpoch: number;
  mutationTail: Promise<void>;
  pendingMutations: number;
  releasePromise: Promise<void> | null;
  refreshPromise: Promise<void> | null;
  refreshDirty: boolean;
  idleReleaseRequested: boolean;
  mcpReloadRequested: boolean;
  modelDivergenceGeneration: number | null;
  terminalFinalizerDirty: boolean;
  terminalFinalizerKey: string | null;
}

interface NativeSnapshot {
  readonly summary: Readonly<ClaudeSessionSummarySnapshot>;
  readonly messages: readonly Readonly<ClaudeSessionTextMessageSnapshot>[];
  readonly revision: Readonly<NativeRevision>;
}

function safeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw adapterError("INVALID_INPUT", "Claude native id is invalid");
  }
  return value;
}

function safeAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS ||
    value !== value.trim() || value.includes("\u0000") || !path.isAbsolute(value)
  ) {
    throw adapterError("INVALID_INPUT", "Claude working directory is invalid");
  }
  const normalized = path.normalize(value);
  if (normalized !== value) {
    throw adapterError("INVALID_INPUT", "Claude working directory is invalid");
  }
  return normalized;
}

function safeModel(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_MODEL_CHARS ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw adapterError("INVALID_INPUT", "Claude model override is invalid");
  }
  return value;
}

function safeRevisionFingerprint(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_REVISION_FINGERPRINT_CHARS || value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw adapterError("INVALID_INPUT", "Claude reviewed revision is invalid");
  }
  return value;
}

function safeInput(value: UserInput): Readonly<UserInput> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const textDescriptor = Object.getOwnPropertyDescriptor(value, "text");
    const attachmentsDescriptor = Object.getOwnPropertyDescriptor(value, "attachments");
    if (
      !textDescriptor || !("value" in textDescriptor) ||
      typeof textDescriptor.value !== "string" || textDescriptor.value.length === 0 ||
      textDescriptor.value.length > MAX_INPUT_CHARS || textDescriptor.value.includes("\u0000") ||
      (attachmentsDescriptor !== undefined &&
        (!("value" in attachmentsDescriptor) ||
          (attachmentsDescriptor.value !== undefined &&
            (!Array.isArray(attachmentsDescriptor.value) || attachmentsDescriptor.value.length > 0))))
    ) throw new Error();
    return Object.freeze({ text: textDescriptor.value });
  } catch {
    throw adapterError("INVALID_INPUT", "Claude task input is invalid");
  }
}

function safeTitle(value: unknown): string {
  if (
    typeof value !== "string" || value.trim().length === 0 ||
    value.length > MAX_TITLE_CHARS || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw adapterError("INVALID_INPUT", "Claude task title is invalid");
  }
  return value.trim();
}

function safeTimestamp(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 32) {
    throw adapterError("OWNERSHIP", "Claude session metadata is invalid");
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw adapterError("OWNERSHIP", "Claude session metadata is invalid");
  }
  return value;
}

function snapshotSummary(value: ClaudeSessionSummarySnapshot): Readonly<ClaudeSessionSummarySnapshot> {
  try {
    const sessionId = safeUuid(value.sessionId);
    const title = value.title === null ? null : safeTitle(value.title);
    const summary = typeof value.summary === "string" && value.summary.trim().length > 0 &&
        value.summary.length <= MAX_TITLE_CHARS && !/[\u0000-\u001f\u007f]/u.test(value.summary)
      ? value.summary.trim()
      : "Claude task";
    const cwd = value.cwd === null ? null : safeAbsolutePath(value.cwd);
    const createdAt = safeTimestamp(value.createdAt, true);
    const updatedAt = safeTimestamp(value.updatedAt, false)!;
    const fileSize = value.fileSize;
    if (
      fileSize !== null &&
      (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize < 0)
    ) throw new Error();
    return Object.freeze({ sessionId, title, summary, cwd, createdAt, updatedAt, fileSize });
  } catch {
    throw adapterError("OWNERSHIP", "Claude session metadata is invalid");
  }
}

function snapshotMessage(
  value: ClaudeSessionTextMessageSnapshot,
): Readonly<ClaudeSessionTextMessageSnapshot> {
  try {
    const id = safeUuid(value.id);
    if (value.role !== "user" && value.role !== "assistant" && value.role !== "system") {
      throw new Error();
    }
    if (
      typeof value.text !== "string" || value.text.length > MAX_MESSAGE_CHARS ||
      value.text.includes("\u0000")
    ) throw new Error();
    return Object.freeze({ id, role: value.role, text: value.text });
  } catch (error) {
    if (error instanceof ClaudeNativeAdapterError) {
      throw adapterError("OWNERSHIP", "Claude session history is invalid");
    }
    throw adapterError("OWNERSHIP", "Claude session history is invalid");
  }
}

function pageLimit(value: unknown): number {
  if (value === undefined) return CLAUDE_SESSION_HELPER_DEFAULT_LIMIT;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > CLAUDE_SESSION_HELPER_MAX_LIMIT
  ) throw adapterError("INVALID_INPUT", "Claude list limit is invalid");
  return value;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): number {
  if (value === undefined) return 0;
  try {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_CHARS) {
      throw new Error();
    }
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error();
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const keys = Object.keys(parsed);
    const record = parsed as Record<string, unknown>;
    if (
      keys.length !== 2 || !keys.includes("v") || !keys.includes("offset") ||
      record.v !== 1 || typeof record.offset !== "number" ||
      !Number.isSafeInteger(record.offset) || record.offset < 0 ||
      record.offset > CLAUDE_SESSION_HELPER_MAX_OFFSET
    ) throw new Error();
    return record.offset;
  } catch {
    throw adapterError("INVALID_INPUT", "Claude list cursor is invalid");
  }
}

function safePermissionMode(value: unknown): ClaudeCliPermissionMode | null {
  if (value === undefined) return null;
  if (
    value !== "manual" && value !== "acceptEdits" && value !== "auto" &&
    value !== "dontAsk" && value !== "plan"
  ) {
    throw adapterError("UNSAFE_OVERRIDE", "Claude runtime override is unsupported");
  }
  return value;
}

function assertNoUnsafeOverrides(overrides: TaskOverrides | undefined): Readonly<{
  requestedModel: string | null;
  permissionMode: ClaudeCliPermissionMode | null;
}>;
function assertNoUnsafeOverrides(
  overrides: TaskOverrides | undefined,
  requirePermission: boolean,
): Readonly<{
  requestedModel: string | null;
  permissionMode: ClaudeCliPermissionMode;
}>;
function assertNoUnsafeOverrides(
  overrides: TaskOverrides | undefined,
  requirePermission = false,
): Readonly<{
  requestedModel: string | null;
  permissionMode: ClaudeCliPermissionMode | null;
}> {
  if (overrides?.mode !== undefined) {
    throw adapterError("UNSAFE_OVERRIDE", "Claude runtime override is unsupported");
  }
  const permissionMode = safePermissionMode(overrides?.permissionMode);
  if (requirePermission && permissionMode === null) {
    throw adapterError("POLICY_MISMATCH", "Claude runtime safety policy is unverified");
  }
  return Object.freeze({
    requestedModel: safeModel(overrides?.model),
    permissionMode,
  });
}

function statusForSnapshot(): string {
  return "complete";
}

function providerFailureCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const code = (value as Record<string, unknown>).code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function knownRuntimeFailure(value: unknown): ClaudeNativeAdapterError | null {
  switch (providerFailureCode(value)) {
    case "TURN_ACTIVE":
      return adapterError("UNSUPPORTED_INTERACTION", "Claude turn is already active");
    case "TURN_MISMATCH":
      return adapterError("INVALID_INPUT", "Claude turn does not match active ownership");
    default:
      return null;
  }
}

function summaryFromSnapshot(
  home: string,
  snapshot: Readonly<ClaudeSessionSummarySnapshot>,
  revision?: Readonly<NativeRevision>,
): Readonly<NativeTaskSummary> {
  return Object.freeze({
    key: createNativeTaskKey("anthropic", home, snapshot.sessionId),
    title: snapshot.title ?? snapshot.summary,
    cwd: snapshot.cwd,
    model: null,
    status: statusForSnapshot(),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    archived: null,
    source: "native" as const,
    ...(revision === undefined ? {} : { revision }),
  });
}

function turnsFromMessages(
  home: string,
  summary: Readonly<ClaudeSessionSummarySnapshot>,
  messages: readonly Readonly<ClaudeSessionTextMessageSnapshot>[],
): readonly Readonly<NativeTurn>[] {
  const key = createNativeTaskKey("anthropic", home, summary.sessionId);
  const turns: NativeTurn[] = [];
  let pending: ProviderEvent[] = [];
  let current: { id: string; events: ProviderEvent[] } | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      if (current !== null) {
        turns.push(Object.freeze({
          id: current.id,
          status: "complete",
          startedAt: null,
          completedAt: null,
          events: Object.freeze(current.events),
        }));
      }
      current = { id: message.id, events: pending };
      pending = [];
    }
    const turnId = current?.id ?? null;
    const event = normalizeProviderEvent({
      type: "message",
      role: message.role,
      text: message.text,
      turnId: message.role === "user" ? message.id : turnId,
      itemId: message.id,
    }, {
      provider: "anthropic",
      key,
      occurredAt: summary.updatedAt,
    });
    if (current === null) pending.push(event);
    else current.events.push(event);
  }
  if (current !== null) {
    turns.push(Object.freeze({
      id: current.id,
      status: "complete",
      startedAt: null,
      completedAt: null,
      events: Object.freeze(current.events),
    }));
  }
  return Object.freeze(turns);
}

export class ClaudeNativeAdapter implements ProviderAdapter {
  readonly provider = "anthropic" as const;
  readonly home: string;

  private readonly helpers: ClaudeNativeAdapterHelpers;
  private readonly supervisor: ClaudeNativeAdapterSupervisor;
  private readonly writerLeases: ClaudeNativeAdapterWriterLeases;
  private readonly reconciliationStore: AdapterReconciliationStore | null;
  private readonly isEnabledFn: () => boolean;
  private readonly idFactory: () => string;
  private readonly canonicalizeHome: (home: string) => string;
  private readonly maxTrackedRevisions: number;
  private readonly states = new Map<string, RuntimeState>();
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly revisions = new Map<string, RevisionState>();
  private readonly pendingForkTargets = new Set<string>();
  private pendingRevisionReservations = 0;
  private suspended = false;
  private disposed = false;
  private refreshChain: Promise<void> = Promise.resolve();
  private disposePromise: Promise<void> | null = null;

  constructor(options: ClaudeNativeAdapterOptions) {
    if (
      !options || typeof options !== "object" || typeof options.home !== "string" ||
      !options.helpers || typeof options.helpers !== "object" ||
      !options.supervisor || typeof options.supervisor.acquire !== "function" ||
      !options.writerLeases || typeof options.writerLeases.acquire !== "function" ||
      (options.isEnabled !== undefined && typeof options.isEnabled !== "function") ||
      (options.idFactory !== undefined && typeof options.idFactory !== "function") ||
      (options.canonicalizeHome !== undefined && typeof options.canonicalizeHome !== "function") ||
      (options.reconciliationStore !== undefined && (
        typeof options.reconciliationStore !== "object" || options.reconciliationStore === null ||
        typeof options.reconciliationStore.getReconciliation !== "function" ||
        typeof options.reconciliationStore.requireReconciliation !== "function" ||
        typeof options.reconciliationStore.acknowledgeReconciliation !== "function"
      )) ||
      (options.maxTrackedRevisions !== undefined && (
        !Number.isSafeInteger(options.maxTrackedRevisions) ||
        options.maxTrackedRevisions < 1 ||
        options.maxTrackedRevisions > MAX_TRACKED_REVISIONS
      ))
    ) throw adapterError("INVALID_INPUT", "Claude adapter configuration is invalid");
    this.canonicalizeHome = options.canonicalizeHome ?? canonicalizeProviderHome;
    let home: string;
    try { home = this.canonicalizeHome(options.home); } catch {
      throw adapterError("INVALID_INPUT", "Claude adapter configuration is invalid");
    }
    if (home !== options.home || !path.isAbsolute(home)) {
      throw adapterError("INVALID_INPUT", "Claude adapter configuration is invalid");
    }
    this.home = home;
    this.helpers = options.helpers;
    this.supervisor = options.supervisor;
    this.writerLeases = options.writerLeases;
    this.reconciliationStore = options.reconciliationStore ?? null;
    this.isEnabledFn = options.isEnabled ?? (() => true);
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxTrackedRevisions = options.maxTrackedRevisions ?? MAX_TRACKED_REVISIONS;
  }

  async capabilities(): Promise<Readonly<ProviderCapabilities>> {
    return this.isAvailable() ? ENABLED_CAPABILITIES : DISABLED_CAPABILITIES;
  }

  async listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>> {
    this.assertHome(input?.home);
    const limit = pageLimit(input?.limit);
    const offset = decodeCursor(input?.cursor);
    const helperLimit = limit < CLAUDE_SESSION_HELPER_MAX_LIMIT ? limit + 1 : limit;
    let rows: readonly ClaudeSessionSummarySnapshot[];
    try { rows = await this.helpers.listSessions({ limit: helperLimit, offset }); } catch {
      throw adapterError("OWNERSHIP", "Claude session history is unavailable");
    }
    if (!Array.isArray(rows) || rows.length > helperLimit) {
      throw adapterError("OWNERSHIP", "Claude session history is invalid");
    }
    const snapshots = rows.map((row) => snapshotSummary(row));
    let hasNext = snapshots.length > limit;
    if (limit === CLAUDE_SESSION_HELPER_MAX_LIMIT && snapshots.length === limit) {
      const nextOffset = offset + limit;
      if (nextOffset > CLAUDE_SESSION_HELPER_MAX_OFFSET) {
        throw adapterError("SUBSCRIPTION_CAPACITY", "Claude list pagination capacity was reached");
      }
      let probe: readonly ClaudeSessionSummarySnapshot[];
      try { probe = await this.helpers.listSessions({ limit: 1, offset: nextOffset }); } catch {
        throw adapterError("OWNERSHIP", "Claude session history is unavailable");
      }
      if (!Array.isArray(probe) || probe.length > 1) {
        throw adapterError("OWNERSHIP", "Claude session history is invalid");
      }
      probe.forEach((row) => snapshotSummary(row));
      hasNext = probe.length === 1;
    }
    if (hasNext && offset + limit > CLAUDE_SESSION_HELPER_MAX_OFFSET) {
      throw adapterError("SUBSCRIPTION_CAPACITY", "Claude list pagination capacity was reached");
    }
    return Object.freeze({
      items: Object.freeze(snapshots.slice(0, limit).map((row) =>
        summaryFromSnapshot(this.home, row))),
      nextCursor: hasNext ? encodeCursor(offset + limit) : null,
    });
  }

  async readTask(key: NativeTaskKey, includeTurns: boolean): Promise<NativeTask> {
    const owned = this.assertKey(key);
    if (typeof includeTurns !== "boolean") {
      throw adapterError("INVALID_INPUT", "Claude read projection is invalid");
    }
    const snapshot = await this.loadSnapshot(owned, false);
    if (snapshot === null) throw this.nativeTaskMissingError(owned.nativeTaskId);
    this.observeRevision(owned.nativeTaskId, snapshot.revision.fingerprint, true);
    const task = this.taskFromSnapshot(snapshot, includeTurns);
    const state = includeTurns ? this.states.get(owned.nativeTaskId) : undefined;
    return state ? this.taskWithActiveTurn(task, state) : task;
  }

  async acknowledgeReconciliation(
    key: NativeTaskKey,
    reviewedFingerprint: string,
  ): Promise<void> {
    const owned = this.assertKey(key);
    const reviewed = safeRevisionFingerprint(reviewedFingerprint);
    const state = this.stateFor(owned);
    await this.serializeMutation(state, async () => {
      // A durable-required latch from a prior process must gate the ack too.
      this.restoreDurableLatch(owned.nativeTaskId);
      const revision = this.revisions.get(owned.nativeTaskId);
      const reconciliationEpoch = revision?.reconciliationEpoch;
      const current = await this.currentFingerprint(owned);
      const latest = this.revisions.get(owned.nativeTaskId);
      if (
        latest !== revision ||
        latest?.reconciliationEpoch !== reconciliationEpoch
      ) {
        if (!latest?.reconciliationRequired) {
          this.latchRevision(owned.nativeTaskId, true);
        }
        throw adapterError(
          "RECONCILIATION_REQUIRED",
          "Claude native task requires authoritative reconciliation",
        );
      }
      if (!current.exists || current.fingerprint !== reviewed) {
        this.latchRevision(owned.nativeTaskId, true);
        throw adapterError(
          "RECONCILIATION_REQUIRED",
          "Claude native task requires authoritative reconciliation",
        );
      }
      if (!revision?.reconciliationRequired) {
        if (revision?.lastAcknowledgedFingerprint === reviewed) return;
        throw adapterError(
          "RECONCILIATION_REQUIRED",
          "Claude native task requires authoritative reconciliation",
        );
      }
      // Durable clear (CAS) occurs before the in-memory clear. A CAS mismatch or
      // newer same-fingerprint durable relatch keeps the task latched.
      if (this.reconciliationStore !== null) {
        let durable: ReturnType<AdapterReconciliationStore["getReconciliation"]>;
        try {
          durable = this.reconciliationStore.getReconciliation(
            this.reconciliationKey(owned.nativeTaskId),
          );
        } catch {
          throw adapterError("DISABLED", "Claude reconciliation store is unavailable");
        }
        if (durable.required) {
          let cleared: ReturnType<AdapterReconciliationStore["acknowledgeReconciliation"]>;
          try {
            cleared = this.reconciliationStore.acknowledgeReconciliation(
              this.reconciliationKey(owned.nativeTaskId),
              durable.latchRevision,
              reviewed,
              current.fingerprint,
            );
          } catch {
            throw adapterError("DISABLED", "Claude reconciliation store is unavailable");
          }
          if (cleared.required) {
            this.latchRevision(owned.nativeTaskId, true);
            throw adapterError(
              "RECONCILIATION_REQUIRED",
              "Claude native task requires authoritative reconciliation",
            );
          }
        }
      }
      this.rememberRevision(owned.nativeTaskId, reviewed, true, true);
      const acknowledged = this.revisions.get(owned.nativeTaskId);
      if (acknowledged) acknowledged.lastAcknowledgedFingerprint = reviewed;
      state.replayEvents.length = 0;
      state.replayOverflow = false;
    });
  }

  async startTask(input: StartTaskInput): Promise<NativeTask> {
    this.assertHome(input?.home);
    const cwd = safeAbsolutePath(input?.cwd);
    const { requestedModel, permissionMode } = assertNoUnsafeOverrides(input, true);
    if (input.input === undefined) {
      throw adapterError("INVALID_INPUT", "Claude start requires a first message");
    }
    const firstInput = safeInput(input.input);
    let sessionId: string;
    try { sessionId = safeUuid(this.idFactory()); } catch {
      throw adapterError("INVALID_INPUT", "Claude session id generation failed");
    }
    const key = createNativeTaskKey(this.provider, this.home, sessionId);
    if (this.states.has(sessionId) || this.revisions.has(sessionId)) {
      throw adapterError("OWNERSHIP", "Claude session id was already in use");
    }
    const existing = await this.currentFingerprint(key);
    if (existing.exists) {
      throw adapterError("OWNERSHIP", "Claude session id was already in use");
    }
    this.rememberRevision(sessionId, null, false, false);
    const state = this.stateFor(key);
    state.cwd = cwd;
    state.requestedModel = requestedModel;
    state.permissionMode = permissionMode;
    state.initialLaunch = "new";
    try {
      const runtime = await this.ensureRuntime(
        state,
        "new",
        cwd,
        requestedModel,
        permissionMode,
        true,
      );
      this.rememberPolicy(sessionId, permissionMode, requestedModel);
      await this.serializeMutation(state, async () => {
        const writer = await this.writerForMutation(state, true);
        let turn: NativeTurnRef;
        try {
          turn = await this.fencedMutation(state, writer, () => runtime.send(firstInput));
        } catch (error) {
          if (error instanceof ClaudeNativeAdapterError) throw error;
          const known = knownRuntimeFailure(error);
          if (known !== null) throw known;
          this.latchRevision(sessionId, true);
          throw adapterError("MUTATION_UNCERTAIN", "Claude send outcome is uncertain");
        }
        try {
          const exact = this.assertTurnRef(turn, key);
          this.markTurnActive(state, exact.turnId);
        } catch {
          this.latchRevision(sessionId, true);
          throw adapterError("MUTATION_UNCERTAIN", "Claude send outcome is uncertain");
        }
      });
    } catch (error) {
      if (!state.nativeInitialized) {
        await this.cleanupFailedStart(state);
        throw error;
      }
      const task = await this.partialTask(key, cwd);
      throw adapterError(
        "PARTIAL_START",
        "Claude native task did not finish starting",
        { task },
      );
    }
    try {
      const snapshot = await this.loadSnapshot(key, true);
      if (snapshot !== null) {
        this.rememberRevision(sessionId, snapshot.revision.fingerprint, true, false);
        return this.taskWithActiveTurn(this.taskFromSnapshot(snapshot, true), state);
      }
    } catch {
      // Fall through to a frozen partial projection. A provider-acknowledged id is
      // not enough to claim durable history until the authoritative helper sees it.
    }
    this.latchRevision(sessionId, true);
    const task = await this.partialTask(key, cwd);
    throw adapterError("PARTIAL_START", "Claude native task did not finish starting", { task });
  }

  async resumeTask(key: NativeTaskKey, overrides?: TaskOverrides): Promise<NativeTask> {
    const owned = this.assertKey(key);
    this.assertRevisionReady(owned.nativeTaskId);
    const requested = assertNoUnsafeOverrides(overrides);
    const knownPolicy = this.policyFor(owned.nativeTaskId);
    const permissionMode = requested.permissionMode ?? knownPolicy?.permissionMode ?? null;
    if (permissionMode === null) {
      throw adapterError("POLICY_MISMATCH", "Claude runtime safety policy is unverified");
    }
    const requestedModel = overrides?.model === undefined
      ? knownPolicy?.requestedModel ?? null
      : requested.requestedModel;
    const state = this.stateFor(owned);
    if (
      (state.pendingMutations > 0 || state.runtimePromise !== null || state.writerPromise !== null) &&
      (state.permissionMode !== permissionMode || state.requestedModel !== requestedModel)
    ) {
      throw adapterError("OWNERSHIP", "Claude runtime configuration changed");
    }
    return this.serializeMutation(state, async () => {
      const snapshot = await this.loadSnapshot(owned, false);
      if (snapshot === null) {
        throw this.nativeTaskMissingError(owned.nativeTaskId);
      }
      if (snapshot.summary.cwd === null) {
        throw adapterError("OWNERSHIP", "Claude task working directory is unavailable");
      }
      this.observeRevision(owned.nativeTaskId, snapshot.revision.fingerprint, true);
      this.assertRevisionReady(owned.nativeTaskId);
      const revision = this.revisions.get(owned.nativeTaskId);
      const reconciliationEpoch = revision?.reconciliationEpoch;
      await this.prepareIdleRuntimeConfiguration(
        state,
        snapshot.summary.cwd,
        requestedModel,
        permissionMode,
      );
      let runtime: ClaudePersistentLease | null = null;
      try {
        runtime = await this.ensureRuntime(
          state,
          "resume",
          snapshot.summary.cwd,
          requestedModel,
          permissionMode,
          false,
        );
        const latest = this.revisions.get(owned.nativeTaskId);
        if (
          latest !== revision ||
          latest?.reconciliationEpoch !== reconciliationEpoch ||
          latest?.reconciliationRequired === true
        ) {
          if (!latest?.reconciliationRequired) {
            this.latchRevision(owned.nativeTaskId, true);
          }
          throw adapterError(
            "RECONCILIATION_REQUIRED",
            "Claude native task requires authoritative reconciliation",
          );
        }
        this.rememberPolicy(owned.nativeTaskId, permissionMode, requestedModel);
        return this.taskWithActiveTurn(this.taskFromSnapshot(snapshot, true), state);
      } catch (error) {
        if (runtime !== null && state.runtime === runtime) {
          await this.releaseRuntimeOwnership(state, runtime);
        }
        throw error;
      }
    });
  }

  async forkTask(key: NativeTaskKey, lastTurnId?: string): Promise<NativeTask> {
    const owned = this.assertKey(key);
    const boundary = lastTurnId === undefined ? undefined : safeUuid(lastTurnId);
    const state = this.stateFor(owned);
    return this.serializeMutation(state, async () => {
      const sourceSnapshot = await this.loadSnapshot(owned, false);
      if (sourceSnapshot === null) {
        throw this.nativeTaskMissingError(owned.nativeTaskId);
      }
      if (boundary !== undefined) {
        if (!sourceSnapshot.messages.some((message) =>
          message.id === boundary && message.role === "user")) {
          throw adapterError("INVALID_INPUT", "Claude fork boundary is invalid");
        }
      }
      const sourceFingerprint = sourceSnapshot.revision.fingerprint;
      if (!this.revisions.has(owned.nativeTaskId)) {
        this.rememberRevision(owned.nativeTaskId, sourceFingerprint, true, false);
      }
      const writer = await this.writerForMutation(state, false);
      const releaseTargetRevision = this.reservePendingRevisionSlot();
      let targetRevisionReserved = true;
      const consumeTargetRevision = (): void => {
        if (!targetRevisionReserved) return;
        targetRevisionReserved = false;
        releaseTargetRevision();
      };
      let pinnedTargetId: string | null = null;
      try {
        let rawForkedId: string;
        try {
          rawForkedId = await this.fencedMutation(state, writer, () =>
            this.helpers.forkSession(
              owned.nativeTaskId,
              boundary === undefined ? {} : { upToMessageId: boundary },
            ));
        } catch (error) {
          if (error instanceof ClaudeNativeAdapterError) throw error;
          this.latchRevision(owned.nativeTaskId);
          throw adapterError("MUTATION_UNCERTAIN", "Claude fork outcome is uncertain");
        }
        let forkedId: string;
        try { forkedId = safeUuid(rawForkedId); } catch {
          this.latchRevision(owned.nativeTaskId);
          throw adapterError("MUTATION_UNCERTAIN", "Claude fork outcome is uncertain");
        }
        if (forkedId === owned.nativeTaskId) {
          this.latchRevision(owned.nativeTaskId);
          throw adapterError("MUTATION_UNCERTAIN", "Claude fork outcome is uncertain");
        }
        const forkedKey = createNativeTaskKey(this.provider, this.home, forkedId);
        const partialTask = this.syntheticTask(forkedKey, sourceSnapshot.summary.cwd);
        if (
          this.revisions.has(forkedId) || this.states.has(forkedId) ||
          this.subscriptions.has(forkedId) || this.pendingForkTargets.has(forkedId)
        ) {
          consumeTargetRevision();
          this.latchPartialFork(owned.nativeTaskId, forkedId);
          throw adapterError("PARTIAL_FORK", "Claude fork target identity collided", {
            task: partialTask,
          });
        }
        this.pendingForkTargets.add(forkedId);
        pinnedTargetId = forkedId;
        let forkedTask: Readonly<NativeTask> = partialTask;
        try {
          const snapshot = await this.loadSnapshot(forkedKey, false);
          if (snapshot === null) throw new Error("fork target is not helper-visible");
          forkedTask = this.taskFromSnapshot(snapshot, true);
          consumeTargetRevision();
          this.rememberRevision(forkedId, snapshot.revision.fingerprint, true, false);
          const sourceAfter = await this.currentFingerprint(owned);
          if (!sourceAfter.exists || sourceAfter.fingerprint !== sourceFingerprint) {
            throw new Error("fork source revision changed");
          }
          this.assertRevisionReady(forkedId);
          return forkedTask;
        } catch {
          consumeTargetRevision();
          this.latchPartialFork(owned.nativeTaskId, forkedId);
          throw adapterError("PARTIAL_FORK", "Claude fork could not be verified", {
            task: forkedTask,
          });
        }
      } finally {
        if (pinnedTargetId !== null) this.pendingForkTargets.delete(pinnedTargetId);
        consumeTargetRevision();
      }
    });
  }

  async send(key: NativeTaskKey, input: UserInput): Promise<NativeTurnRef> {
    const owned = this.assertKey(key);
    const prepared = safeInput(input);
    this.assertRevisionReady(owned.nativeTaskId);
    let state = this.states.get(owned.nativeTaskId);
    const knownPolicy = this.policyFor(owned.nativeTaskId);
    const permissionMode = knownPolicy?.permissionMode ?? null;
    if (permissionMode === null) {
      throw adapterError("POLICY_MISMATCH", "Claude runtime safety policy is unverified");
    }
    state = state ?? this.stateFor(owned);
    if (state.permissionMode === null) state.permissionMode = permissionMode;
    if (state.requestedModel === null && knownPolicy !== null) {
      state.requestedModel = knownPolicy.requestedModel;
    }
    return this.serializeMutation(state, async () => {
      if (!state!.runtime) {
        const snapshot = await this.loadSnapshot(owned, false);
        if (snapshot === null) throw this.nativeTaskMissingError(owned.nativeTaskId);
        if (snapshot.summary.cwd === null) {
          throw adapterError("OWNERSHIP", "Claude task working directory is unavailable");
        }
        await this.ensureRuntime(
          state!,
          "resume",
          snapshot.summary.cwd,
          state!.requestedModel,
          permissionMode,
          false,
        );
      }
      const runtime = state!.runtime ?? await state!.runtimePromise;
      if (!runtime) throw adapterError("OWNERSHIP", "Claude runtime is unavailable");
      const allowMissing = state!.initialLaunch === "new";
      const writer = await this.writerForMutation(state!, allowMissing);
      let result: NativeTurnRef;
      try {
        result = await this.fencedMutation(state!, writer, () => runtime.send(prepared));
      } catch (error) {
        if (error instanceof ClaudeNativeAdapterError) throw error;
        const known = knownRuntimeFailure(error);
        if (known !== null) throw known;
        this.latchRevision(owned.nativeTaskId);
        throw adapterError("MUTATION_UNCERTAIN", "Claude send outcome is uncertain");
      }
      let exact: Readonly<NativeTurnRef>;
      try { exact = this.assertTurnRef(result, owned); } catch {
        this.latchRevision(owned.nativeTaskId);
        throw adapterError("MUTATION_UNCERTAIN", "Claude send outcome is uncertain");
      }
      this.markTurnActive(state!, exact.turnId);
      return exact;
    });
  }

  async steer(
    _key: NativeTaskKey,
    _expectedTurnId: string,
    _input: UserInput,
  ): Promise<void> {
    throw new ProviderCapabilityError("steer", this.provider);
  }

  async interrupt(key: NativeTaskKey, turnId: string): Promise<void> {
    const owned = this.assertKey(key);
    const exactTurnId = safeUuid(turnId);
    const state = this.states.get(owned.nativeTaskId);
    if (!state?.runtime) throw adapterError("OWNERSHIP", "Claude runtime is unavailable");
    await this.serializeMutation(state, async () => {
      const writer = this.writerForOwnedControl(state);
      try {
        await this.fencedMutation(state, writer, () => state.runtime!.interrupt(exactTurnId));
      } catch (error) {
        if (error instanceof ClaudeNativeAdapterError) throw error;
        const known = knownRuntimeFailure(error);
        if (known !== null) throw known;
        this.latchRevision(owned.nativeTaskId);
        throw adapterError("MUTATION_UNCERTAIN", "Claude interrupt outcome is uncertain");
      }
    });
  }

  async respond(response: ProviderRequestResponse): Promise<void> {
    this.assertAvailable();
    let identity: ReturnType<typeof createProviderRequestIdentity>;
    try { identity = createProviderRequestIdentity(response?.identity); } catch {
      throw adapterError("INVALID_INPUT", "Claude provider response is invalid");
    }
    const owned = this.assertKey(identity.key);
    const state = this.states.get(owned.nativeTaskId);
    if (!state?.runtime || identity.generation !== state.runtime.generation) {
      throw adapterError("OWNERSHIP", "Claude provider response ownership is invalid");
    }
    const exactResponse = Object.freeze({ ...response, identity }) as ProviderRequestResponse;
    await this.serializeMutation(state, async () => {
      const writer = this.writerForOwnedControl(state);
      try {
        await this.fencedMutation(state, writer, () => state.runtime!.respond(exactResponse));
      } catch (error) {
        if (error instanceof ClaudeNativeAdapterError) throw error;
        const known = knownRuntimeFailure(error);
        if (known !== null) throw known;
        this.latchRevision(owned.nativeTaskId);
        throw adapterError("MUTATION_UNCERTAIN", "Claude response outcome is uncertain");
      }
    });
  }

  async archive(_key: NativeTaskKey): Promise<void> {
    throw new ProviderCapabilityError("archive", this.provider);
  }

  async rename(key: NativeTaskKey, name: string): Promise<void> {
    const owned = this.assertKey(key);
    const title = safeTitle(name);
    const state = this.stateFor(owned);
    await this.serializeMutation(state, async () => {
      const writer = await this.writerForMutation(state, false);
      try {
        await this.fencedMutation(
          state,
          writer,
          () => this.helpers.renameSession(owned.nativeTaskId, title),
        );
      } catch (error) {
        if (error instanceof ClaudeNativeAdapterError) throw error;
        this.latchRevision(owned.nativeTaskId);
        throw adapterError("MUTATION_UNCERTAIN", "Claude rename outcome is uncertain");
      }
      try { await this.refreshRevision(owned); } catch {
        this.latchRevision(owned.nativeTaskId);
        throw adapterError("MUTATION_UNCERTAIN", "Claude rename outcome is uncertain");
      }
    });
  }

  async subscribe(key: NativeTaskKey, sink: ProviderEventSink): Promise<Unsubscribe> {
    const owned = this.assertKey(key);
    if (typeof sink !== "function") {
      throw adapterError("INVALID_INPUT", "Claude event sink is invalid");
    }
    const runtimeState = this.states.get(owned.nativeTaskId);
    if (runtimeState?.replayOverflow) {
      throw adapterError("SUBSCRIPTION_CAPACITY", "Claude replay capacity was reached");
    }
    let subscription = this.subscriptions.get(owned.nativeTaskId);
    if (!subscription) {
      if (this.subscriptions.size >= MAX_SUBSCRIBED_TASKS) {
        throw adapterError("SUBSCRIPTION_CAPACITY", "Claude subscription capacity was reached");
      }
      subscription = { key: owned, sinks: new Map() };
      this.subscriptions.set(owned.nativeTaskId, subscription);
    }
    if (subscription.sinks.size >= MAX_SUBSCRIBERS_PER_TASK) {
      throw adapterError("SUBSCRIPTION_CAPACITY", "Claude subscriber capacity was reached");
    }
    const id = Symbol("ClaudeSubscriber");
    const subscriber: SubscriberState = {
      sink,
      status: "quarantined",
      replay: Object.freeze([...(runtimeState?.replayEvents ?? [])]),
      pending: [],
      overflowed: false,
    };
    subscription.sinks.set(id, subscriber);
    try {
      const snapshot = await this.loadSnapshot(owned, true);
      if (snapshot === null) {
        if (this.revisions.get(owned.nativeTaskId)?.everPersisted) {
          throw this.nativeTaskMissingError(owned.nativeTaskId);
        }
        if (runtimeState?.nativeInitialized !== true) {
          if (runtimeState?.initialLaunch === "new") {
            throw adapterError("INVALID_INPUT", "Claude native task is not initialized");
          }
          throw this.nativeTaskMissingError(owned.nativeTaskId);
        }
      }
      if (snapshot !== null) {
        this.observeRevision(
          owned.nativeTaskId,
          snapshot.revision.fingerprint,
          true,
        );
      }
      if (subscriber.overflowed || runtimeState?.replayOverflow) {
        throw adapterError("SUBSCRIPTION_CAPACITY", "Claude subscriber event capacity was reached");
      }
      subscriber.status = "active";
      const pending = subscriber.pending.splice(0);
      for (const event of [...subscriber.replay, ...pending]) {
        this.deliverSubscriber(subscriber, event);
      }
    } catch (error) {
      subscription.sinks.delete(id);
      if (
        subscription.sinks.size === 0 &&
        this.subscriptions.get(owned.nativeTaskId) === subscription
      ) this.subscriptions.delete(owned.nativeTaskId);
      throw error;
    }
    let closed = false;
    return async (): Promise<void> => {
      if (closed) return;
      closed = true;
      subscription!.sinks.delete(id);
      if (
        subscription!.sinks.size === 0 &&
        this.subscriptions.get(owned.nativeTaskId) === subscription
      ) {
        this.subscriptions.delete(owned.nativeTaskId);
      }
      const state = this.states.get(owned.nativeTaskId);
      if (state) {
        state.idleReleaseRequested = true;
        await this.releaseIfIdle(state);
      }
    };
  }

  /** Called by the persistent supervisor before every resume or restart generation. */
  async reconcile(context: ClaudeSupervisorReconcileContext): Promise<void> {
    this.assertAvailable();
    let home: string;
    try { home = this.canonicalizeHome(context.configHome); } catch {
      throw adapterError("OWNERSHIP", "Claude reconciliation ownership is invalid");
    }
    if (
      home !== this.home || context.configHome !== home ||
      !Number.isSafeInteger(context.generation) || context.generation < 1 ||
      (context.reason !== "resume" && context.reason !== "restart")
    ) throw adapterError("OWNERSHIP", "Claude reconciliation ownership is invalid");
    const key = this.assertKey(createNativeTaskKey(this.provider, this.home, safeUuid(context.sessionId)));
    const cwd = safeAbsolutePath(context.cwd);
    const state = this.stateFor(key);
    if (state.cwd !== null && state.cwd !== cwd) {
      throw adapterError("OWNERSHIP", "Claude reconciliation configuration changed");
    }
    state.cwd = cwd;
    await this.serializeMutation(state, async () => {
      const writer = await this.writerForMutation(state, state.initialLaunch === "new");
      await this.fencedMutation(state, writer, () => undefined);
    });
  }

  refreshEnabled(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(adapterError("DISPOSED", "Claude native adapter is disposed"));
    }
    const target = this.flagEnabled();
    if (!target) this.suspended = true;
    const refresh = async (): Promise<void> => {
      if (this.disposed) return;
      if (!target) {
        await this.releaseAll();
        return;
      }
      if (this.flagEnabled()) this.suspended = false;
    };
    this.refreshChain = this.refreshChain.then(refresh, refresh);
    return this.refreshChain;
  }

  /** Recycle idle CLI generations so the next turn in each session reads current MCP config. */
  async reloadMcpConfig(): Promise<boolean> {
    if (this.disposed) throw adapterError("DISPOSED", "Claude native adapter is disposed");
    let recycled = false;
    await Promise.all([...this.states.values()].map(async (state) => {
      const hadRuntime = state.runtime !== null;
      state.mcpReloadRequested = state.runtime !== null || state.runtimePromise !== null;
      state.idleReleaseRequested = true;
      await this.releaseIfIdle(state);
      if (hadRuntime && state.runtime === null) recycled = true;
    }));
    return recycled;
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      try { await this.refreshChain; } catch { /* Release still proceeds. */ }
      await this.releaseAll();
      this.subscriptions.clear();
      this.revisions.clear();
    })();
    return this.disposePromise;
  }

  private taskFromSnapshot(snapshot: NativeSnapshot, includeTurns: boolean): Readonly<NativeTask> {
    return Object.freeze({
      ...summaryFromSnapshot(this.home, snapshot.summary, snapshot.revision),
      turns: includeTurns
        ? turnsFromMessages(this.home, snapshot.summary, snapshot.messages)
        : Object.freeze([]),
    });
  }

  private taskWithActiveTurn(task: Readonly<NativeTask>, state: RuntimeState): Readonly<NativeTask> {
    const activeTurnId = state.activeTurnId;
    if (activeTurnId === null) return task;
    let found = false;
    const turns = task.turns.map((turn) => {
      if (turn.id !== activeTurnId) return turn;
      found = true;
      return Object.freeze({
        ...turn,
        status: "active",
        completedAt: null,
      });
    });
    if (found) {
      return Object.freeze({ ...task, status: "active", turns: Object.freeze(turns) });
    }
    const activeTurn: Readonly<NativeTurn> = Object.freeze({
      id: activeTurnId,
      status: "active",
      startedAt: null,
      completedAt: null,
      events: Object.freeze(state.replayEvents.filter((event) =>
        "turnId" in event && event.turnId === activeTurnId)),
    });
    return Object.freeze({ ...task, status: "active", turns: Object.freeze([...turns, activeTurn]) });
  }

  private syntheticTask(
    key: Readonly<NativeTaskKey>,
    cwd: string | null,
  ): Readonly<NativeTask> {
    return Object.freeze({
      key,
      title: "Claude task",
      cwd,
      model: null,
      status: "unknown",
      createdAt: null,
      updatedAt: null,
      archived: null,
      source: "native" as const,
      turns: Object.freeze([]),
    });
  }

  private async partialTask(
    key: Readonly<NativeTaskKey>,
    cwd: string | null,
  ): Promise<Readonly<NativeTask>> {
    try {
      const snapshot = await this.loadSnapshot(key, true);
      if (snapshot !== null) {
        const task = this.taskFromSnapshot(snapshot, true);
        const state = this.states.get(key.nativeTaskId);
        return state ? this.taskWithActiveTurn(task, state) : task;
      }
    } catch {
      // The verified runtime identity still permits a value-free partial projection.
    }
    const task = this.syntheticTask(key, cwd);
    const state = this.states.get(key.nativeTaskId);
    return state ? this.taskWithActiveTurn(task, state) : task;
  }

  private async loadSnapshot(
    key: Readonly<NativeTaskKey>,
    allowMissing: boolean,
  ): Promise<NativeSnapshot | null> {
    let rawSummary: Readonly<ClaudeSessionSummarySnapshot> | null;
    try { rawSummary = await this.helpers.getSessionInfo(key.nativeTaskId); } catch {
      throw adapterError("OWNERSHIP", "Claude session metadata is unavailable");
    }
    if (rawSummary === null) {
      if (allowMissing) return null;
      return null;
    }
    const summary = snapshotSummary(rawSummary);
    if (summary.sessionId !== key.nativeTaskId) {
      throw adapterError("OWNERSHIP", "Claude helper returned another native task");
    }
    const messages: Readonly<ClaudeSessionTextMessageSnapshot>[] = [];
    const messageIds = new Set<string>();
    let offset = 0;
    while (offset < CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES) {
      const limit = Math.min(
        CLAUDE_SESSION_HELPER_MAX_LIMIT,
        CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES - offset,
      );
      let page: Readonly<ClaudeSessionMessagesSnapshot>;
      try {
        page = await this.helpers.getSessionMessages(key.nativeTaskId, { limit, offset });
      } catch {
        throw adapterError("OWNERSHIP", "Claude session history is unavailable");
      }
      if (
        !page || !Array.isArray(page.messages) || page.messages.length > limit ||
        page.limit !== limit || page.offset !== offset ||
        !Number.isSafeInteger(page.rawCount) || page.rawCount < 0 ||
        page.rawCount > limit || page.messages.length > page.rawCount
      ) {
        throw adapterError("OWNERSHIP", "Claude session history is invalid");
      }
      for (const message of page.messages) {
        const snapshot = snapshotMessage(message);
        if (messageIds.has(snapshot.id)) {
          throw adapterError("OWNERSHIP", "Claude session history is invalid");
        }
        messageIds.add(snapshot.id);
        messages.push(snapshot);
      }
      offset += page.rawCount;
      if (page.rawCount < limit) break;
    }
    if (offset === CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES) {
      let overflow: Readonly<ClaudeSessionMessagesSnapshot>;
      try {
        overflow = await this.helpers.getSessionMessages(key.nativeTaskId, {
          limit: 1,
          offset: CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES,
        });
      } catch {
        throw adapterError("OWNERSHIP", "Claude session history is unavailable");
      }
      if (
        !overflow || !Array.isArray(overflow.messages) || overflow.messages.length > 1 ||
        overflow.limit !== 1 || overflow.offset !== CLAUDE_SESSION_HELPER_MAX_TEXT_MESSAGES ||
        !Number.isSafeInteger(overflow.rawCount) || overflow.rawCount < 0 ||
        overflow.rawCount > 1 || overflow.messages.length > overflow.rawCount
      ) {
        throw adapterError("OWNERSHIP", "Claude session history is invalid");
      }
      if (overflow.rawCount !== 0) {
        throw adapterError("OWNERSHIP", "Claude session history exceeds the safe projection bound");
      }
    }
    const revision = buildClaudeNativeRevision({
      sessionId: summary.sessionId,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      fileSize: summary.fileSize,
      status: statusForSnapshot(),
      messages: messages.map(({ id, role }) => Object.freeze({ id, role })),
    });
    return Object.freeze({ summary, messages: Object.freeze(messages), revision });
  }

  private async currentFingerprint(
    key: Readonly<NativeTaskKey>,
  ): Promise<{ readonly exists: boolean; readonly fingerprint: string | null }> {
    const snapshot = await this.loadSnapshot(key, true);
    return snapshot === null
      ? Object.freeze({ exists: false, fingerprint: null })
      : Object.freeze({ exists: true, fingerprint: snapshot.revision.fingerprint });
  }

  private nativeTaskMissingError(nativeTaskId: string): ClaudeNativeAdapterError {
    const revision = this.revisions.get(nativeTaskId);
    if (revision?.everPersisted) {
      if (!revision.reconciliationRequired) this.latchRevision(nativeTaskId, true);
      return adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    return adapterError("NATIVE_TASK_MISSING", "Provider native task is missing");
  }

  private async refreshRevision(key: Readonly<NativeTaskKey>): Promise<void> {
    const current = await this.currentFingerprint(key);
    if (this.disposed) return;
    const revision = this.revisions.get(key.nativeTaskId);
    if (revision?.reconciliationRequired) return;
    if (revision?.everPersisted && !current.exists) {
      this.latchRevision(key.nativeTaskId, true);
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    this.rememberRevision(key.nativeTaskId, current.fingerprint, current.exists, false);
  }

  private rememberRevision(
    nativeTaskId: string,
    fingerprint: string | null,
    persisted: boolean,
    clearReconciliation: boolean,
  ): void {
    this.reserveRevisionSlot(nativeTaskId);
    const previous = this.revisions.get(nativeTaskId);
    const revision: RevisionState = previous ?? {
      fingerprint,
      everPersisted: false,
      reconciliationRequired: false,
      reconciliationEpoch: 0n,
      lastAcknowledgedFingerprint: null,
      lastWriterEpoch: 0,
      policy: null,
    };
    if (
      revision.lastAcknowledgedFingerprint !== null &&
      revision.lastAcknowledgedFingerprint !== fingerprint
    ) revision.lastAcknowledgedFingerprint = null;
    revision.fingerprint = fingerprint;
    revision.everPersisted ||= persisted;
    if (clearReconciliation) revision.reconciliationRequired = false;
    this.revisions.delete(nativeTaskId);
    this.revisions.set(nativeTaskId, revision);
  }

  private reserveRevisionSlot(nativeTaskId: string): void {
    if (this.revisions.has(nativeTaskId)) return;
    while (this.revisions.size + this.pendingRevisionReservations >= this.maxTrackedRevisions) {
      let evictable: string | null = null;
      for (const [candidateId, candidate] of this.revisions) {
        if (!candidate.reconciliationRequired && !this.revisionIsPinned(candidateId)) {
          evictable = candidateId;
          break;
        }
      }
      if (evictable === null) {
        throw adapterError(
          "SUBSCRIPTION_CAPACITY",
          "Claude revision reconciliation capacity was reached",
        );
      }
      this.revisions.delete(evictable);
    }
  }

  private reservePendingRevisionSlot(): () => void {
    this.reserveRevisionSlot(`pending-fork-${this.pendingRevisionReservations}`);
    this.pendingRevisionReservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingRevisionReservations -= 1;
    };
  }

  private revisionIsPinned(nativeTaskId: string): boolean {
    if (this.pendingForkTargets.has(nativeTaskId)) return true;
    if ((this.subscriptions.get(nativeTaskId)?.sinks.size ?? 0) > 0) return true;
    const state = this.states.get(nativeTaskId);
    if (state === undefined) return false;
    return state.pendingMutations > 0 || state.runtime !== null ||
      state.runtimePromise !== null || state.writer !== null ||
      state.writerPromise !== null || state.releasePromise !== null ||
      state.refreshPromise !== null || state.refreshDirty ||
      state.activeTurnId !== null || state.activeActivities.size > 0;
  }

  /**
   * Records an automatic read projection without silently accepting idle
   * provider-side mutation. Only an owned in-flight turn (or its terminal
   * refresh) may advance the remembered revision without explicit review.
   */
  private observeRevision(
    nativeTaskId: string,
    fingerprint: string | null,
    persisted: boolean,
  ): void {
    const previous = this.revisions.get(nativeTaskId);
    const runtime = this.states.get(nativeTaskId);
    const ownedTransition = runtime !== undefined && (
      runtime.activeTurnId !== null ||
      runtime.activeActivities.size > 0 ||
      runtime.refreshPromise !== null
    );
    if (
      previous?.everPersisted === true &&
      previous.fingerprint !== fingerprint &&
      !ownedTransition
    ) {
      this.latchRevision(nativeTaskId, true);
    }
    this.rememberRevision(nativeTaskId, fingerprint, persisted, false);
  }

  private assertRevisionReady(nativeTaskId: string): void {
    if (this.revisions.get(nativeTaskId)?.reconciliationRequired) {
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
  }

  private latchRevision(nativeTaskId: string, invalidatePolicy = false): void {
    this.reserveRevisionSlot(nativeTaskId);
    const revision = this.revisions.get(nativeTaskId) ?? {
      fingerprint: null,
      everPersisted: false,
      reconciliationRequired: false,
      reconciliationEpoch: 0n,
      lastAcknowledgedFingerprint: null,
      lastWriterEpoch: 0,
      policy: null,
    };
    revision.reconciliationRequired = true;
    revision.reconciliationEpoch += 1n;
    revision.lastAcknowledgedFingerprint = null;
    if (invalidatePolicy) revision.policy = null;
    this.revisions.set(nativeTaskId, revision);
    this.mirrorRequireReconciliation(nativeTaskId, "NATIVE_REVISION_MISMATCH");
  }

  private latchPartialFork(sourceTaskId: string, targetTaskId: string): void {
    this.latchRevision(sourceTaskId, true);
    try {
      this.latchRevision(targetTaskId, true);
    } catch {
      // The pinned source consumes the remaining revision capacity, so every
      // target mutation fails before dispatch until the source is reconciled.
    }
  }

  private policyFor(nativeTaskId: string): RevisionState["policy"] {
    const revision = this.revisions.get(nativeTaskId);
    const policy = revision?.policy ?? null;
    if (policy !== null) {
      this.revisions.delete(nativeTaskId);
      this.revisions.set(nativeTaskId, revision!);
    }
    return policy;
  }

  private rememberPolicy(
    nativeTaskId: string,
    permissionMode: ClaudeCliPermissionMode,
    requestedModel: string | null,
  ): void {
    const revision = this.revisions.get(nativeTaskId);
    if (revision === undefined) {
      throw adapterError("OWNERSHIP", "Claude policy revision ownership is unavailable");
    }
    if (revision.reconciliationRequired) {
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    revision.policy = Object.freeze({ permissionMode, requestedModel });
    this.revisions.delete(nativeTaskId);
    this.revisions.set(nativeTaskId, revision);
  }

  private async validateMutationRevision(
    state: RuntimeState,
    allowMissing: boolean,
  ): Promise<{ readonly exists: boolean; readonly fingerprint: string | null }> {
    const previous = this.revisions.get(state.key.nativeTaskId);
    const reconciliationEpoch = previous?.reconciliationEpoch;
    if (previous?.reconciliationRequired) {
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    const current = await this.currentFingerprint(state.key);
    const latest = this.revisions.get(state.key.nativeTaskId);
    if (
      latest !== previous ||
      latest?.reconciliationEpoch !== reconciliationEpoch ||
      latest?.reconciliationRequired === true
    ) {
      if (!latest?.reconciliationRequired) {
        this.latchRevision(state.key.nativeTaskId, true);
      }
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    if (previous?.everPersisted && !current.exists) {
      this.latchRevision(state.key.nativeTaskId, true);
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    if (!current.exists && !allowMissing) {
      throw this.nativeTaskMissingError(state.key.nativeTaskId);
    }
    if (previous && previous.fingerprint !== current.fingerprint) {
      this.latchRevision(state.key.nativeTaskId, true);
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    this.rememberRevision(
      state.key.nativeTaskId,
      current.fingerprint,
      current.exists,
      false,
    );
    return current;
  }

  private stateFor(key: Readonly<NativeTaskKey>): RuntimeState {
    let state = this.states.get(key.nativeTaskId);
    if (state) return state;
    if (this.states.size >= MAX_ACTIVE_TASKS) {
      throw adapterError("SUBSCRIPTION_CAPACITY", "Claude active task capacity was reached");
    }
    state = {
      key,
      owner: Symbol("ClaudeNativeAdapterOwner"),
      cwd: null,
      requestedModel: null,
      permissionMode: null,
      initialLaunch: null,
      runtime: null,
      runtimePromise: null,
      writer: null,
      writerPromise: null,
      pendingEvents: [],
      replayEvents: [],
      replayOverflow: false,
      nativeInitialized: false,
      activeTurnId: null,
      terminalTurnIds: new Set(),
      activeActivities: new Set(),
      lastWriterEpoch: 0,
      mutationTail: Promise.resolve(),
      pendingMutations: 0,
      releasePromise: null,
      refreshPromise: null,
      refreshDirty: false,
      idleReleaseRequested: false,
      mcpReloadRequested: false,
      modelDivergenceGeneration: null,
      terminalFinalizerDirty: false,
      terminalFinalizerKey: null,
    };
    this.states.set(key.nativeTaskId, state);
    return state;
  }

  private async serializeMutation<T>(
    state: RuntimeState,
    work: () => Promise<T>,
  ): Promise<T> {
    if (state.pendingMutations >= MAX_PENDING_MUTATIONS) {
      throw adapterError("SUBSCRIPTION_CAPACITY", "Claude mutation capacity was reached");
    }
    state.pendingMutations += 1;
    const run = state.mutationTail.then(async () => {
      this.assertAvailable();
      return work();
    });
    state.mutationTail = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      state.pendingMutations -= 1;
      if (state.pendingMutations === 0) await this.releaseIfIdle(state);
    }
  }

  private async writerForMutation(
    state: RuntimeState,
    allowMissing: boolean,
  ): Promise<NativeTaskWriterLease> {
    this.assertAvailable();
    const pendingRefresh = state.refreshPromise;
    if (pendingRefresh !== null) {
      await pendingRefresh;
      this.assertAvailable();
    }
    // Restore a durable latch before accepting any post-restart mutation.
    this.restoreDurableLatch(state.key.nativeTaskId);
    if (this.revisions.get(state.key.nativeTaskId)?.reconciliationRequired) {
      throw adapterError(
        "RECONCILIATION_REQUIRED",
        "Claude native task requires authoritative reconciliation",
      );
    }
    if (state.writer !== null) {
      let usable = false;
      try { usable = state.writer.usable && !state.writer.lost && !state.writer.released; } catch {
        usable = false;
      }
      if (!usable) {
        this.releaseWriter(state, state.writer);
      } else {
        await this.validateMutationRevision(state, allowMissing);
        return state.writer;
      }
    }
    if (state.writerPromise === null) {
      state.writerPromise = (async (): Promise<WriterAcquisition> => {
        let lease: NativeTaskWriterLease | null;
        try { lease = this.writerLeases.acquire(state.key); } catch {
          throw adapterError("OWNERSHIP", "Claude writer ownership is unavailable");
        }
        if (lease === null) {
          throw adapterError("OWNERSHIP", "Claude writer ownership is unavailable");
        }
        try {
          this.validateWriterIdentity(state, lease);
          await this.validateMutationRevision(state, allowMissing);
          const revision = this.revisions.get(state.key.nativeTaskId);
          if (revision) revision.lastWriterEpoch = Math.max(
            revision.lastWriterEpoch,
            state.lastWriterEpoch,
          );
          this.assertAvailable();
          if (!lease.confirmReread()) {
            throw adapterError("OWNERSHIP", "Claude writer ownership is unavailable");
          }
          state.writer = lease;
          return Object.freeze({ lease, stale: false });
        } catch (error) {
          if (state.writer !== lease) {
            try { lease.release(); } catch { /* The validation error remains primary. */ }
          }
          throw error;
        }
      })();
    }
    const pending = state.writerPromise;
    try {
      const acquired = await pending;
      return acquired.lease;
    } finally {
      if (state.writerPromise === pending) state.writerPromise = null;
    }
  }

  private writerForOwnedControl(state: RuntimeState): NativeTaskWriterLease {
    this.assertAvailable();
    if (
      state.runtime === null || state.writer === null ||
      !state.writer.usable || state.writer.lost || state.writer.released
    ) {
      throw adapterError("OWNERSHIP", "Claude control ownership is unavailable");
    }
    return state.writer;
  }

  private validateWriterIdentity(state: RuntimeState, lease: NativeTaskWriterLease): void {
    let valid = false;
    let epoch = 0;
    const revision = this.revisions.get(state.key.nativeTaskId);
    const previousEpoch = Math.max(state.lastWriterEpoch, revision?.lastWriterEpoch ?? 0);
    try {
      epoch = lease.fence.epoch;
      valid = nativeTaskKeyId(lease.key) === nativeTaskKeyId(state.key) &&
        nativeTaskKeyId(lease.fence.key) === nativeTaskKeyId(state.key) &&
        Number.isSafeInteger(epoch) && epoch >= 1 && epoch > previousEpoch;
    } catch {
      valid = false;
    }
    if (!valid) throw adapterError("OWNERSHIP", "Claude writer ownership is unavailable");
    state.lastWriterEpoch = epoch;
    if (revision) revision.lastWriterEpoch = epoch;
  }

  private releaseWriter(state: RuntimeState, writer: NativeTaskWriterLease): void {
    if (state.writer === writer) state.writer = null;
    try { writer.release(); } catch { /* Ownership is already unusable. */ }
  }

  private async prepareIdleRuntimeConfiguration(
    state: RuntimeState,
    cwd: string,
    requestedModel: string | null,
    permissionMode: ClaudeCliPermissionMode,
  ): Promise<void> {
    if (state.releasePromise !== null) await state.releasePromise;
    const hasPriorConfiguration = state.initialLaunch !== null || state.cwd !== null ||
      state.permissionMode !== null || state.requestedModel !== null;
    if (!hasPriorConfiguration) return;
    if (state.cwd !== null && state.cwd !== cwd) {
      throw adapterError("OWNERSHIP", "Claude runtime configuration changed");
    }
    if (
      state.requestedModel === requestedModel &&
      state.permissionMode === permissionMode
    ) return;
    if (
      state.activeTurnId !== null || state.activeActivities.size > 0 ||
      state.runtimePromise !== null || state.writerPromise !== null ||
      state.pendingMutations !== 1
    ) {
      throw adapterError("OWNERSHIP", "Claude runtime configuration changed");
    }
    await this.releaseRuntimeOwnership(state);
    state.cwd = cwd;
    state.requestedModel = requestedModel;
    state.permissionMode = permissionMode;
    state.initialLaunch = state.nativeInitialized ? "resume" : null;
  }

  private async releaseRuntimeOwnership(
    state: RuntimeState,
    expectedRuntime?: ClaudePersistentLease,
  ): Promise<void> {
    if (expectedRuntime !== undefined && state.runtime !== expectedRuntime) return;
    const runtime = state.runtime;
    const writer = state.writer;
    state.runtime = null;
    state.writer = null;
    state.idleReleaseRequested = false;
    state.mcpReloadRequested = false;
    state.pendingEvents.length = 0;
    state.modelDivergenceGeneration = null;
    state.terminalFinalizerDirty = false;
    state.terminalFinalizerKey = null;
    if (state.nativeInitialized) state.initialLaunch = "resume";
    if (runtime !== null) {
      try { await runtime.release(); } catch { /* The caller's state fence remains primary. */ }
    }
    if (writer !== null) {
      try { writer.release(); } catch { /* The caller's state fence remains primary. */ }
    }
  }

  private async ensureRuntime(
    state: RuntimeState,
    launch: "new" | "resume",
    cwd: string,
    requestedModel: string | null,
    permissionMode: ClaudeCliPermissionMode | null,
    allowMissing: boolean,
  ): Promise<ClaudePersistentLease> {
    this.assertAvailable();
    if (state.runtime !== null) {
      if (
        state.cwd !== cwd || state.requestedModel !== requestedModel ||
        state.permissionMode !== permissionMode
      ) {
        throw adapterError("OWNERSHIP", "Claude runtime configuration changed");
      }
      return state.runtime;
    }
    if (state.runtimePromise !== null) {
      if (
        state.cwd !== cwd || state.requestedModel !== requestedModel ||
        state.permissionMode !== permissionMode
      ) {
        throw adapterError("OWNERSHIP", "Claude runtime configuration changed");
      }
      return state.runtimePromise;
    }
    if (
      state.initialLaunch !== null &&
      (state.initialLaunch !== launch || state.cwd !== cwd ||
        state.requestedModel !== requestedModel || state.permissionMode !== permissionMode)
    ) {
      throw adapterError("OWNERSHIP", "Claude runtime configuration changed");
    }
    state.cwd = cwd;
    state.requestedModel = requestedModel;
    state.permissionMode = permissionMode;
    state.initialLaunch ??= launch;
    const acquire = async (): Promise<ClaudePersistentLease> => {
      const writer = await this.writerForMutation(state, allowMissing);
      const options: ClaudeSupervisorAcquireOptions = {
        configHome: this.home,
        cwd,
        sessionId: state.key.nativeTaskId,
        launch,
        ...(requestedModel === null ? {} : { requestedModel }),
        ...(permissionMode === null ? {} : { permissionMode }),
        handlers: Object.freeze({
          owner: state.owner,
          emit: (event: ProviderEvent) => this.receiveRuntimeEvent(state, event),
        }),
      };
      let lease: ClaudePersistentLease;
      try {
        lease = await this.fencedMutation(
          state,
          writer,
          () => this.supervisor.acquire(options),
        );
      } catch (error) {
        if (state.writer === writer) {
          state.writer = null;
          try { writer.release(); } catch { /* The acquisition error remains primary. */ }
        }
        if (error instanceof ClaudeNativeAdapterError) throw error;
        throw adapterError("OWNERSHIP", "Claude persistent runtime is unavailable");
      }
      let owned = false;
      try {
        owned = lease.configHome === this.home && lease.sessionId === state.key.nativeTaskId &&
          Number.isSafeInteger(lease.generation) && lease.generation >= 1;
      } catch { owned = false; }
      if (!owned || !this.isAvailable()) {
        try { await lease.release(); } catch { /* Invalid lease is already rejected. */ }
        throw adapterError("OWNERSHIP", "Claude supervisor returned invalid ownership");
      }
      state.nativeInitialized = true;
      state.runtime = lease;
      const pendingEvents = state.pendingEvents.splice(0);
      for (const event of pendingEvents) this.onRuntimeEvent(state, event);
      try {
        await this.refreshRevision(state.key);
      } catch (error) {
        state.runtime = null;
        state.pendingEvents.length = 0;
        try { await lease.release(); } catch { /* The original refresh failure remains primary. */ }
        if (state.writer === writer) {
          state.writer = null;
          try { writer.release(); } catch { /* The original refresh failure remains primary. */ }
        }
        throw error;
      }
      return lease;
    };
    const pending = acquire();
    state.runtimePromise = pending;
    try { return await pending; } finally {
      if (state.runtimePromise === pending) state.runtimePromise = null;
      if (state.runtime === null) state.pendingEvents.length = 0;
      if (state.idleReleaseRequested) void this.releaseIfIdle(state);
    }
  }

  private async fencedMutation<T>(
    state: RuntimeState,
    writer: NativeTaskWriterLease,
    start: () => T,
  ): Promise<Awaited<T>> {
    this.assertAvailable();
    let result: ReturnType<NativeTaskWriterLease["runFencedWrite"]>;
    let callbackThrew = false;
    let callbackError: unknown;
    try {
      result = writer.runFencedWrite((fence) => {
        try {
          let exact = false;
          try {
            exact = nativeTaskKeyId(fence.key) === nativeTaskKeyId(state.key) &&
              fence.epoch === writer.fence.epoch &&
              Number.isSafeInteger(fence.epoch) && fence.epoch >= 1;
          } catch {
            exact = false;
          }
          if (!exact) {
            this.releaseWriter(state, writer);
            throw adapterError("OWNERSHIP", "Claude writer ownership is unavailable");
          }
          this.assertAvailable();
          this.assertRevisionReady(state.key.nativeTaskId);
          return start();
        } catch (error) {
          callbackThrew = true;
          callbackError = error;
          throw error;
        }
      });
    } catch {
      if (callbackThrew) throw callbackError;
      throw adapterError("OWNERSHIP", "Claude writer ownership is unavailable");
    }
    if (!result.started) {
      this.releaseWriter(state, writer);
      throw adapterError("OWNERSHIP", "Claude writer ownership is unavailable");
    }
    return await result.value as Awaited<T>;
  }

  private assertTurnRef(
    value: NativeTurnRef,
    expected: Readonly<NativeTaskKey>,
  ): Readonly<NativeTurnRef> {
    try {
      if (nativeTaskKeyId(value.taskKey) !== nativeTaskKeyId(expected)) throw new Error();
      const turnId = safeUuid(value.turnId);
      return Object.freeze({ taskKey: expected, turnId });
    } catch {
      throw adapterError("OWNERSHIP", "Claude runtime returned invalid ownership");
    }
  }

  private markTurnActive(state: RuntimeState, turnId: string): void {
    if (!state.terminalTurnIds.has(turnId)) state.activeTurnId = turnId;
  }

  private markTurnTerminal(state: RuntimeState, turnId: string): void {
    state.terminalTurnIds.delete(turnId);
    while (state.terminalTurnIds.size >= MAX_TRACKED_TERMINAL_TURNS) {
      const oldest = state.terminalTurnIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      state.terminalTurnIds.delete(oldest);
    }
    state.terminalTurnIds.add(turnId);
    if (state.activeTurnId === turnId) state.activeTurnId = null;
    state.idleReleaseRequested = true;
  }

  private updateReplay(
    state: RuntimeState,
    event: ProviderEvent,
    terminalTurn: boolean,
  ): void {
    if (terminalTurn) {
      state.replayEvents.length = 0;
      state.replayOverflow = false;
      return;
    }
    if (event.type === "request-resolved") {
      const resolved = event.identity;
      for (let index = state.replayEvents.length - 1; index >= 0; index -= 1) {
        const candidate = state.replayEvents[index];
        if (
          candidate?.type === "request" &&
          candidate.request.identity.generation === resolved.generation &&
          candidate.request.identity.requestId === resolved.requestId &&
          candidate.request.identity.turnId === resolved.turnId &&
          candidate.request.identity.approvalId === resolved.approvalId
        ) state.replayEvents.splice(index, 1);
      }
      return;
    }
    if (
      "turnId" in event && event.turnId !== null &&
      state.terminalTurnIds.has(event.turnId)
    ) return;
    if (
      event.type === "status" && event.scope === "turn" && event.nativeId !== null &&
      state.terminalTurnIds.has(event.nativeId)
    ) return;
    if (state.replayOverflow) return;
    if (state.replayEvents.length >= MAX_PENDING_RUNTIME_EVENTS) {
      state.replayOverflow = true;
      return;
    }
    state.replayEvents.push(event);
  }

  private onRuntimeEvent(state: RuntimeState, event: ProviderEvent): void {
    if (!this.isAvailable() || state.runtime === null) return;
    try {
      if (
        event.provider !== this.provider ||
        nativeTaskKeyId(event.key) !== nativeTaskKeyId(state.key)
      ) return;
      if (
        event.type === "request" &&
        event.request.identity.generation !== state.runtime.generation
      ) return;
      const normalized = normalizeProviderEvent(event, {
        provider: this.provider,
        key: state.key,
        occurredAt: event.occurredAt,
      });
      let terminalTurn = false;
      let terminalTurnId: string | null = null;
      let uncertainTerminal = false;
      if (normalized.type === "status" && normalized.scope === "turn") {
        if (normalized.nativeId !== null && isProviderActiveStatus(normalized.status)) {
          this.markTurnActive(state, normalized.nativeId);
        } else if (normalized.nativeId !== null && isProviderTerminalStatus(normalized.status)) {
          if (isRuntimeFailureUncertainStatus(normalized.status)) {
            this.latchRevision(state.key.nativeTaskId);
            state.activeActivities.clear();
            uncertainTerminal = true;
          }
          this.markTurnTerminal(state, normalized.nativeId);
          terminalTurn = true;
          terminalTurnId = normalized.nativeId;
        }
      }
      this.updateReplay(state, normalized, terminalTurn);
      this.publishToSubscribers(state, normalized);
      if (normalized.type === "activity") {
        const activityKey = `${normalized.turnId ?? ""}:${normalized.itemId ?? ""}:${normalized.activity}`;
        if (["active", "pending", "running", "started"].includes(normalized.status)) {
          state.activeActivities.add(activityKey);
        } else {
          state.activeActivities.delete(activityKey);
        }
        void this.releaseIfIdle(state);
      }
      if (terminalTurn) {
        if (uncertainTerminal) {
          const diagnostic = Object.freeze({
            provider: this.provider,
            key: state.key,
            occurredAt: normalized.occurredAt,
            type: "diagnostic" as const,
            level: "error" as const,
            code: "CLAUDE_RUNTIME_MUTATION_UNCERTAIN",
            message: "Claude runtime ended before the active turn outcome could be verified",
            method: null,
            shapeKeys: Object.freeze([]),
          });
          this.updateReplay(state, diagnostic, false);
          this.publishToSubscribers(state, diagnostic);
        }
        this.scheduleTerminalFinalizer(
          state,
          terminalTurnId ?? "unknown",
          normalized.occurredAt,
          uncertainTerminal,
        );
      } else if (normalized.type === "request-resolved") {
        void this.releaseIfIdle(state);
      }
    } catch {
      // Malformed or foreign runtime events are dropped at the ownership boundary.
    }
  }

  private scheduleTerminalFinalizer(
    state: RuntimeState,
    turnId: string,
    occurredAt: string,
    uncertain: boolean,
  ): void {
    const runtime = state.runtime;
    if (runtime === null) return;
    let generation: number;
    try { generation = runtime.generation; } catch { return; }
    if (!Number.isSafeInteger(generation) || generation < 1) return;
    const finalizerKey = `${generation}:${turnId}:${uncertain ? "uncertain" : "terminal"}`;
    if (state.terminalFinalizerKey === finalizerKey) {
      state.terminalFinalizerDirty = true;
      return;
    }
    state.terminalFinalizerDirty = false;
    state.terminalFinalizerKey = finalizerKey;
    void Promise.resolve().then(async () => {
      if (state.terminalFinalizerKey !== finalizerKey) return;
      const dirty = state.terminalFinalizerDirty;
      state.terminalFinalizerDirty = false;
      state.terminalFinalizerKey = null;
      if (!this.isAvailable() || state.runtime !== runtime) return;
      let currentGeneration: number;
      try { currentGeneration = runtime.generation; } catch { return; }
      if (currentGeneration !== generation) return;
      if (uncertain) {
        await this.detachUncertainRuntime(state, runtime, generation);
        return;
      }
      this.publishModelDivergence(state, occurredAt);
      this.scheduleRevisionRefresh(state);
      if (dirty) this.scheduleRevisionRefresh(state);
    }).catch(() => undefined);
  }

  private async detachUncertainRuntime(
    state: RuntimeState,
    runtime: ClaudePersistentLease,
    generation: number,
  ): Promise<void> {
    if (state.runtime !== runtime) return;
    try {
      if (runtime.generation !== generation) return;
    } catch {
      return;
    }
    const writer = state.writer;
    state.runtime = null;
    state.writer = null;
    state.idleReleaseRequested = false;
    state.mcpReloadRequested = false;
    if (state.nativeInitialized) state.initialLaunch = "resume";
    try { await runtime.release(); } catch { /* The reconciliation latch remains authoritative. */ }
    if (writer !== null) {
      try { writer.release(); } catch { /* The reconciliation latch remains authoritative. */ }
    }
  }

  private receiveRuntimeEvent(state: RuntimeState, event: ProviderEvent): void {
    if (!this.isAvailable()) return;
    if (state.runtime !== null) {
      this.onRuntimeEvent(state, event);
      return;
    }
    if (state.runtimePromise === null) return;
    if (state.pendingEvents.length >= MAX_PENDING_RUNTIME_EVENTS) {
      state.replayOverflow = true;
      return;
    }
    try {
      if (
        event.provider !== this.provider ||
        nativeTaskKeyId(event.key) !== nativeTaskKeyId(state.key)
      ) return;
      state.pendingEvents.push(normalizeProviderEvent(event, {
        provider: this.provider,
        key: state.key,
        occurredAt: event.occurredAt,
      }));
    } catch {
      // Startup events remain quarantined until their exact ownership is safe.
    }
  }

  private publishModelDivergence(state: RuntimeState, occurredAt: string): void {
    const runtime = state.runtime;
    if (runtime === null || state.modelDivergenceGeneration === runtime.generation) return;
    let diverged = false;
    try { diverged = runtime.modelEvidence().hasDivergence === true; } catch { return; }
    if (!diverged) return;
    state.modelDivergenceGeneration = runtime.generation;
    this.publishToSubscribers(state, Object.freeze({
      provider: this.provider,
      key: state.key,
      occurredAt,
      type: "diagnostic" as const,
      level: "warning" as const,
      code: "CLAUDE_MODEL_DIVERGENCE",
      message: "Claude reported divergent requested and observed model evidence",
      method: null,
      shapeKeys: Object.freeze([]),
    }));
  }

  private publishToSubscribers(state: RuntimeState, event: ProviderEvent): void {
    const subscription = this.subscriptions.get(state.key.nativeTaskId);
    if (!subscription || subscription.sinks.size === 0) return;
    for (const subscriber of [...subscription.sinks.values()]) {
      if (subscriber.status === "active") {
        this.deliverSubscriber(subscriber, event);
        continue;
      }
      if (subscriber.pending.length >= MAX_PENDING_RUNTIME_EVENTS) {
        subscriber.pending.length = 0;
        subscriber.overflowed = true;
        continue;
      }
      subscriber.pending.push(event);
    }
  }

  private deliverSubscriber(subscriber: SubscriberState, event: ProviderEvent): void {
    try { subscriber.sink(event); } catch { /* A consumer cannot break runtime ownership. */ }
  }

  private scheduleRevisionRefresh(state: RuntimeState): void {
    if (state.refreshPromise !== null) {
      state.refreshDirty = true;
      return;
    }
    const refresh = (async (): Promise<void> => {
      do {
        state.refreshDirty = false;
        try { await this.refreshRevision(state.key); } catch { /* Detached refresh is best-effort. */ }
      } while (state.refreshDirty && !this.disposed);
    })().finally(() => {
      if (state.refreshPromise === refresh) {
        state.refreshPromise = null;
        if (state.refreshDirty && !this.disposed) {
          this.scheduleRevisionRefresh(state);
        } else {
          void this.releaseIfIdle(state);
        }
      }
    });
    state.refreshPromise = refresh;
  }

  private assertHome(value: unknown): void {
    this.assertAvailable();
    let canonical: string;
    try {
      if (typeof value !== "string") throw new Error();
      canonical = this.canonicalizeHome(value);
    } catch {
      throw adapterError("INVALID_INPUT", "Claude provider home is invalid");
    }
    if (canonical !== value || canonical !== this.home) {
      throw adapterError("OWNERSHIP", "Claude provider home does not belong to this adapter");
    }
  }

  private assertKey(value: NativeTaskKey): Readonly<NativeTaskKey> {
    this.assertAvailable();
    let key: Readonly<NativeTaskKey>;
    try {
      key = createNativeTaskKey(value.provider, value.home, safeUuid(value.nativeTaskId));
    } catch {
      throw adapterError("INVALID_INPUT", "Claude native task key is invalid");
    }
    let expected: Readonly<NativeTaskKey>;
    try { expected = createNativeTaskKey(this.provider, this.home, key.nativeTaskId); } catch {
      throw adapterError("INVALID_INPUT", "Claude native task key is invalid");
    }
    if (nativeTaskKeyId(key) !== nativeTaskKeyId(expected)) {
      throw adapterError("OWNERSHIP", "Claude native task does not belong to this adapter");
    }
    return expected;
  }

  private flagEnabled(): boolean {
    try { return this.isEnabledFn() === true; } catch { return false; }
  }

  private isAvailable(): boolean {
    if (this.disposed || this.suspended || !this.flagEnabled()) return false;
    // A durable-store read/write fault latches the wrapper permanently
    // unavailable; the whole unified runtime then fails closed.
    if (this.reconciliationStore?.unavailable === true) return false;
    return true;
  }

  /**
   * Best-effort durable mirror of an in-memory latch. A durable fault latches the
   * fail-closed wrapper unavailable (so `isAvailable()` reports the runtime
   * unavailable); the live in-memory latch is already set, so the process stays
   * conservatively closed. Never throws from a sync latch call site.
   */
  private mirrorRequireReconciliation(
    nativeTaskId: string,
    reason: ProviderReconciliationReason,
  ): void {
    if (this.reconciliationStore === null) return;
    const revision = this.revisions.get(nativeTaskId);
    try {
      this.reconciliationStore.requireReconciliation(
        this.reconciliationKey(nativeTaskId),
        {
          reviewedFingerprint: revision?.lastAcknowledgedFingerprint ?? null,
          nativeFingerprint: revision?.fingerprint ?? null,
          writerEpoch: revision?.lastWriterEpoch ?? 0,
          reason,
        },
      );
    } catch {
      // The wrapper self-latches unavailable; isAvailable() now fails closed.
    }
  }

  private reconciliationKey(nativeTaskId: string): Readonly<NativeTaskKey> {
    return Object.freeze({ provider: "anthropic" as const, home: this.home, nativeTaskId });
  }

  /**
   * Restart-safe restore: when the durable store still says a task is required
   * but the fresh live process has no latch yet, reinstate the in-memory latch
   * before any mutation proceeds. A durable read fault fails closed.
   */
  private restoreDurableLatch(nativeTaskId: string): void {
    if (this.reconciliationStore === null) return;
    if (this.revisions.get(nativeTaskId)?.reconciliationRequired) return;
    let required = false;
    try {
      required = this.reconciliationStore.getReconciliation(
        this.reconciliationKey(nativeTaskId),
      ).required;
    } catch {
      throw adapterError("DISABLED", "Claude reconciliation store is unavailable");
    }
    if (required) this.latchRevision(nativeTaskId, true);
  }

  private assertAvailable(): void {
    if (this.disposed) throw adapterError("DISPOSED", "Claude native adapter is disposed");
    if (!this.isAvailable()) throw adapterError("DISABLED", "Claude native runtime is disabled");
  }

  private async cleanupFailedStart(state: RuntimeState): Promise<void> {
    if (this.states.get(state.key.nativeTaskId) === state) {
      this.states.delete(state.key.nativeTaskId);
    }
    this.revisions.delete(state.key.nativeTaskId);
    const runtime = state.runtime;
    const writer = state.writer;
    state.runtime = null;
    state.runtimePromise = null;
    state.writer = null;
    state.writerPromise = null;
    state.pendingEvents.length = 0;
    state.replayEvents.length = 0;
    state.replayOverflow = false;
    state.activeTurnId = null;
    state.terminalTurnIds.clear();
    state.activeActivities.clear();
    if (runtime !== null) {
      try { await runtime.release(); } catch { /* The start error remains primary. */ }
    }
    if (writer !== null) {
      try { writer.release(); } catch { /* The start error remains primary. */ }
    }
  }

  private evictStateIfResourceFree(state: RuntimeState): void {
    const subscription = this.subscriptions.get(state.key.nativeTaskId);
    const revision = this.revisions.get(state.key.nativeTaskId);
    if (
      this.states.get(state.key.nativeTaskId) !== state || subscription?.sinks.size ||
      revision?.reconciliationRequired || state.runtime !== null ||
      state.runtimePromise !== null || state.writer !== null || state.writerPromise !== null ||
      state.releasePromise !== null || state.refreshPromise !== null ||
      state.refreshDirty ||
      state.pendingMutations > 0 || state.activeTurnId !== null ||
      state.activeActivities.size > 0 || state.replayEvents.length > 0 || state.replayOverflow
    ) return;
    this.states.delete(state.key.nativeTaskId);
  }

  private async releaseIfIdle(state: RuntimeState): Promise<void> {
    if (state.releasePromise !== null) return state.releasePromise;
    const subscription = this.subscriptions.get(state.key.nativeTaskId);
    if (
      (subscription?.sinks.size && !state.mcpReloadRequested) || state.activeTurnId !== null ||
      state.activeActivities.size > 0 || state.pendingMutations > 0 ||
      state.runtimePromise !== null || state.replayEvents.length > 0 || state.replayOverflow
    ) return;
    if (state.runtime !== null && !state.idleReleaseRequested) return;
    if (state.runtime === null && state.writer === null) {
      state.idleReleaseRequested = false;
      state.mcpReloadRequested = false;
      this.evictStateIfResourceFree(state);
      return;
    }
    let release!: Promise<void>;
    release = (async (): Promise<void> => {
      const runtime = state.runtime;
      const writer = state.writer;
      state.runtime = null;
      state.writer = null;
      state.idleReleaseRequested = false;
      state.mcpReloadRequested = false;
      if (state.nativeInitialized) state.initialLaunch = "resume";
      if (runtime !== null) {
        try { await runtime.release(); } catch { /* Best-effort idle release. */ }
      }
      if (writer !== null) {
        try { writer.release(); } catch { /* Best-effort idle release. */ }
      }
    })().finally(() => {
      if (state.releasePromise === release) {
        state.releasePromise = null;
        this.evictStateIfResourceFree(state);
      }
    });
    state.releasePromise = release;
    return release;
  }

  private async releaseAll(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    await Promise.all(states.map(async (state) => {
      let runtime = state.runtime;
      if (runtime === null && state.runtimePromise !== null) {
        try { runtime = await state.runtimePromise; } catch { runtime = null; }
      }
      state.runtime = null;
      state.runtimePromise = null;
      state.pendingEvents.length = 0;
      state.replayEvents.length = 0;
      state.replayOverflow = false;
      state.activeTurnId = null;
      state.terminalTurnIds.clear();
      state.activeActivities.clear();
      if (runtime !== null) {
        try { await runtime.release(); } catch { /* Best-effort shutdown. */ }
      }
      let writer = state.writer;
      if (writer === null && state.writerPromise !== null) {
        try { writer = (await state.writerPromise).lease; } catch { writer = null; }
      }
      state.writer = null;
      state.writerPromise = null;
      if (writer !== null) {
        try { writer.release(); } catch { /* Best-effort ownership release. */ }
      }
    }));
  }
}
