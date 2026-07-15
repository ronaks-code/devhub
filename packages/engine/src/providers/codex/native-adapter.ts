import path from "node:path";
import { defineProviderCapabilities } from "../capabilities.js";
import { normalizeProviderEvent, type ProviderEvent } from "../events.js";
import {
  canonicalizeProviderHome,
  createNativeTaskKey,
  nativeTaskKeyId,
} from "../task-key.js";
import type {
  ListTasksInput,
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
import { ProviderOperationError } from "../operation-error.js";
import type {
  AppServerGenerationContext,
  AppServerReconcileContext,
} from "./app-server-process.js";
import {
  advanceCodexListCursorState,
  CodexListCursorCodec,
  createCodexThreadListRequests,
  initialCodexListCursorState,
  MAX_CODEX_LIST_LIMIT,
  type CodexListScope,
  type CodexThreadListLaneResult,
} from "./list-cursor.js";
import {
  normalizeCodexNotification,
  normalizeCodexServerRequest,
} from "./normalizer.js";
import {
  parseCodexThreadForkResult,
  parseCodexThreadListResult,
  parseCodexThreadReadResult,
  parseCodexThreadResumeResult,
  parseCodexThreadStartResult,
  parseCodexTurnStartResult,
  type CodexNativeConfiguredThreadResult,
  type CodexNativeThreadMetadata,
  type CodexNativeTurnMetadata,
} from "./native-shapes.js";
import type { CodexRpcNotification, CodexRpcRequest } from "./protocol/index.js";
import { CodexRemoteRpcError } from "./protocol/rpc-peer.js";
import { CodexRequestBroker } from "./request-broker.js";
import { buildCodexNativeRevision } from "./revision.js";
import {
  StreamingSecretGate,
  type StreamingSecretKey,
} from "./streaming-secret-gate.js";
import type {
  CodexAppServerLease,
  CodexSupervisorAcquireOptions,
} from "./supervisor.js";
import type { NativeTaskWriterLease } from "../writer-lease.js";
import type {
  AdapterReconciliationLatchInput,
  AdapterReconciliationStore,
} from "../reconciliation-store.js";
import type { ProviderReconciliationReason } from "../../provider-index/store-types.js";

const MAX_INPUT_CHARS = 1_048_576;
const MAX_INPUT_ATTACHMENTS = 32;
const MAX_ATTACHMENT_NAME_CHARS = 1_024;
const MAX_PATH_CHARS = 16_384;
const MAX_SUBSCRIBED_TASKS = 256;
const MAX_SUBSCRIBERS_PER_TASK = 64;
const MAX_TRACKED_TASK_POLICIES = 256;
const DEFAULT_LIST_LIMIT = 50;

type SafePermissionMode = "read-only" | "workspace-write";

export type CodexNativeAdapterErrorCode =
  | "DISABLED"
  | "DISPOSED"
  | "INVALID_INPUT"
  | "MUTATION_UNCERTAIN"
  | "NATIVE_TASK_MISSING"
  | "OWNERSHIP"
  | "PARTIAL_FORK"
  | "PARTIAL_START"
  | "POLICY_MISMATCH"
  | "RECONCILIATION_REQUIRED"
  | "SUBSCRIPTION_CAPACITY"
  | "UNSAFE_OVERRIDE"
  | "UNSUPPORTED_INTERACTION";

export class CodexNativeAdapterError
  extends ProviderOperationError<CodexNativeAdapterErrorCode> {
  constructor(
    code: CodexNativeAdapterErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly task?: Readonly<NativeTask> } = {},
  ) {
    super(code, message, options);
    this.name = "CodexNativeAdapterError";
  }
}

export interface CodexNativeAdapterSupervisor {
  acquire(options: CodexSupervisorAcquireOptions): Promise<CodexAppServerLease>;
}

/**
 * The exact writer-lease acquire seam Claude uses. Codex never constructs a
 * second competing lease: the server runtime injects the same shared
 * {@link NativeTaskWriterLeaseStore} (backed by `native-task-writer-leases.sqlite`).
 */
export interface CodexNativeAdapterWriterLeases {
  acquire(key: NativeTaskKey): NativeTaskWriterLease | null;
}

export interface CodexNativeAdapterOptions {
  readonly home: string;
  readonly supervisor: CodexNativeAdapterSupervisor;
  readonly cursorSecret: string | Uint8Array;
  readonly isEnabled?: () => boolean;
  /**
   * Manual is an internal integration seam only. Public interaction capability
   * flags remain false until request details have a safe provider-neutral shape.
   */
  readonly requestMode?: "fail-closed" | "manual";
  /**
   * DevHub writer-lease fence over existing-task mutations. Optional so hermetic
   * projection tests can exercise the read/list surface without a lease store;
   * the server runtime always injects the shared store, so every production
   * existing-task mutation runs through the fenced-write path.
   */
  readonly writerLeases?: CodexNativeAdapterWriterLeases;
  /**
   * Narrow durable-reconciliation seam over `provider_reconciliation_state`.
   * Optional for the same reason as {@link writerLeases}. When both are injected,
   * every existing-task mutation reads the durable latch first and mirrors any
   * new latch/ack durably; a durable read/write fault fails closed and marks the
   * unified runtime unavailable.
   */
  readonly reconciliationStore?: AdapterReconciliationStore;
  readonly maxTrackedRevisions?: number;
}

const DEFAULT_MAX_TRACKED_REVISIONS = 512;
const MAX_TRACKED_REVISIONS_HARD = 4_096;

interface CodexRevisionState {
  reviewedFingerprint: string | null;
  everPersisted: boolean;
  reconciliationRequired: boolean;
  reconciliationEpoch: number;
  lastWriterEpoch: number;
}

interface SubscriptionState {
  readonly key: Readonly<NativeTaskKey>;
  readonly sinks: Map<symbol, ProviderEventSink>;
  loadPromise: Promise<void> | null;
  revision: string | null;
  closePromise: Promise<void> | null;
}

interface TaskExecutionPolicy {
  readonly mode: SafePermissionMode;
  readonly cwd?: string;
  readonly model?: string;
}

function adapterError(
  code: CodexNativeAdapterErrorCode,
  message: string,
  options?: { readonly cause?: unknown; readonly task?: Readonly<NativeTask> },
): CodexNativeAdapterError {
  return new CodexNativeAdapterError(code, message, options);
}

async function readCodexThread<T>(
  nativeTaskId: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof CodexRemoteRpcError &&
      error.code === -32600 &&
      error.message === `thread not loaded: ${nativeTaskId}` &&
      error.data === undefined
    ) {
      throw adapterError("NATIVE_TASK_MISSING", "Provider native task is missing");
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rawThread(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.thread)) {
    // A parser must always run before this helper, so this is an internal guard.
    throw adapterError("INVALID_INPUT", "Codex returned an incompatible thread envelope");
  }
  return value.thread;
}

function controlCwdFromThreadEnvelope(value: unknown): string {
  const thread = rawThread(value);
  return absolutePath(thread.cwd as string, "Provider working directory");
}

function isoFromSeconds(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function eventTime(turn: CodexNativeTurnMetadata, completed: boolean): string | undefined {
  return isoFromSeconds(completed ? turn.completedAt ?? turn.startedAt : turn.startedAt) ?? undefined;
}

function millisFromSeconds(value: number | null): number {
  if (value === null || value > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) return 0;
  return value * 1_000;
}

function safeTitle(thread: CodexNativeThreadMetadata): string {
  const title = thread.name?.trim() || thread.preview.trim();
  return title.length > 0 ? title : `Codex task ${thread.id}`;
}

function summaryFromThread(
  home: string,
  thread: CodexNativeThreadMetadata,
): Readonly<NativeTaskSummary> {
  return Object.freeze({
    key: createNativeTaskKey("openai", home, thread.id),
    title: safeTitle(thread),
    cwd: thread.cwd || null,
    model: null,
    status: thread.status,
    createdAt: isoFromSeconds(thread.createdAt),
    updatedAt: isoFromSeconds(thread.updatedAt),
    archived: thread.archived,
    source: "native" as const,
    revision: buildCodexNativeRevision(thread),
  });
}

function rawTurnsFromThread(thread: Record<string, unknown>): readonly unknown[] {
  return Array.isArray(thread.turns) ? thread.turns : [];
}

function rawItemsFromTurn(turn: unknown): readonly unknown[] {
  return isRecord(turn) && Array.isArray(turn.items) ? turn.items : [];
}

function historyEvents(
  home: string,
  generation: number,
  thread: CodexNativeThreadMetadata,
  turn: CodexNativeTurnMetadata,
  rawTurnValue: unknown,
): readonly ProviderEvent[] {
  if (!isRecord(rawTurnValue)) return Object.freeze([]);
  const events: ProviderEvent[] = [];
  const lifecycleMethod = turn.status === "inProgress" ? "turn/started" : "turn/completed";
  const lifecycleEvents = normalizeCodexNotification({
    method: lifecycleMethod,
    params: { threadId: thread.id, turn: rawTurnValue },
  }, {
    home,
    generation,
    occurredAt: eventTime(turn, lifecycleMethod === "turn/completed"),
  });
  if (lifecycleMethod === "turn/started") events.push(...lifecycleEvents);

  const rawItems = rawItemsFromTurn(rawTurnValue);
  turn.items.forEach((item, index) => {
    const rawItem = rawItems[index];
    if (!isRecord(rawItem)) return;
    // In-progress provider snapshots may contain a partial assistant/plan token.
    // Never project that text as completed history: the live stateful gate owns
    // streaming, and the canonical completed item owns final text.
    const started = item.type === "userMessage" || turn.status === "inProgress";
    events.push(...normalizeCodexNotification({
      method: started ? "item/started" : "item/completed",
      params: started
        ? {
            threadId: thread.id,
            turnId: turn.id,
            startedAtMs: millisFromSeconds(turn.startedAt),
            item: rawItem,
          }
        : {
            threadId: thread.id,
            turnId: turn.id,
            completedAtMs: millisFromSeconds(turn.completedAt ?? turn.startedAt),
            item: rawItem,
          },
    }, {
      home,
      generation,
      occurredAt: eventTime(turn, !started),
    }));
  });
  if (lifecycleMethod === "turn/completed") events.push(...lifecycleEvents);
  return Object.freeze(events);
}

function taskFromThread(
  home: string,
  generation: number,
  thread: CodexNativeThreadMetadata,
  rawThreadValue: Record<string, unknown>,
  includeTurns: boolean,
  model: string | null = null,
): Readonly<NativeTask> {
  const base = summaryFromThread(home, thread);
  const rawTurns = rawTurnsFromThread(rawThreadValue);
  const turns: readonly NativeTurn[] = includeTurns
    ? Object.freeze(thread.turns.map((turn, index) => Object.freeze({
        id: turn.id,
        status: turn.status,
        startedAt: isoFromSeconds(turn.startedAt),
        completedAt: isoFromSeconds(turn.completedAt),
        events: historyEvents(home, generation, thread, turn, rawTurns[index]),
      })))
    : Object.freeze([]);
  return Object.freeze({ ...base, model, turns });
}

function permissionMode(value: string | undefined): SafePermissionMode {
  const resolved = value ?? "read-only";
  if (resolved !== "read-only" && resolved !== "workspace-write") {
    throw adapterError("UNSAFE_OVERRIDE", "Only read-only and workspace-write modes are allowed");
  }
  return resolved;
}

function assertNoUnsafeOverrides(overrides: TaskOverrides | undefined): SafePermissionMode {
  if (overrides?.mode !== undefined) {
    throw adapterError("UNSAFE_OVERRIDE", "Native Codex mode overrides are not supported");
  }
  if (
    overrides?.model !== undefined &&
    (typeof overrides.model !== "string" || overrides.model.trim().length === 0 ||
      overrides.model.length > 256 ||
      overrides.model !== overrides.model.trim() ||
      /[\u0000-\u001f\u007f]/u.test(overrides.model))
  ) {
    throw adapterError("INVALID_INPUT", "Model must be a bounded non-empty value");
  }
  return permissionMode(overrides?.permissionMode);
}

function absolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS ||
    value.includes("\u0000") || value !== value.trim() || !path.isAbsolute(value)
  ) {
    throw adapterError("INVALID_INPUT", `${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function inputItems(input: UserInput): readonly Readonly<Record<string, unknown>>[] {
  if (!input || typeof input.text !== "string" || input.text.length > MAX_INPUT_CHARS ||
    input.text.includes("\u0000")) {
    throw adapterError("INVALID_INPUT", "Task input is invalid or too large");
  }
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > MAX_INPUT_ATTACHMENTS) {
    throw adapterError("INVALID_INPUT", "Task input has too many attachments");
  }
  const result: Readonly<Record<string, unknown>>[] = [];
  if (input.text.length > 0) {
    result.push(Object.freeze({ type: "text", text: input.text, text_elements: Object.freeze([]) }));
  }
  attachments.forEach((attachment) => {
    if (!attachment || typeof attachment.name !== "string" || attachment.name.length === 0 ||
      attachment.name.length > MAX_ATTACHMENT_NAME_CHARS || attachment.name.includes("\u0000")) {
      throw adapterError("INVALID_INPUT", "Attachment metadata is invalid");
    }
    const attachmentPath = absolutePath(attachment.path, "Attachment path");
    result.push(attachment.mediaType?.startsWith("image/")
      ? Object.freeze({ type: "localImage", path: attachmentPath })
      : Object.freeze({ type: "mention", name: attachment.name, path: attachmentPath }));
  });
  if (result.length === 0) throw adapterError("INVALID_INPUT", "Task input must not be empty");
  return Object.freeze(result);
}

function sandboxPolicy(mode: SafePermissionMode, cwd?: string): Readonly<Record<string, unknown>> {
  return mode === "read-only"
    ? Object.freeze({ type: "readOnly", networkAccess: false })
    : Object.freeze({
        type: "workspaceWrite",
        writableRoots: Object.freeze([absolutePath(cwd ?? "", "Working directory")]),
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      });
}

function threadPolicy(
  mode: SafePermissionMode,
  cwd: string,
  model?: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    cwd,
    ...(model === undefined ? {} : { model }),
    sandbox: mode,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
}

function expectedSandboxType(mode: SafePermissionMode): "readOnly" | "workspaceWrite" {
  return mode === "read-only" ? "readOnly" : "workspaceWrite";
}

function verifyConfiguredResult(
  result: CodexNativeConfiguredThreadResult,
  rawResult: unknown,
  expected: {
    readonly mode: SafePermissionMode;
    readonly cwd: string;
    readonly model?: string;
    readonly threadId?: string;
    readonly forkedFromId?: string;
    readonly ephemeral?: boolean;
  },
): void {
  const raw = isRecord(rawResult) && isRecord(rawResult.sandbox) ? rawResult.sandbox : null;
  const rawResultRecord = isRecord(rawResult) ? rawResult : null;
  const rawThreadRecord = rawResultRecord && isRecord(rawResultRecord.thread)
    ? rawResultRecord.thread
    : null;
  const exactControlCwd = rawResultRecord?.cwd === expected.cwd &&
    rawThreadRecord?.cwd === expected.cwd;
  const correctWorkspacePolicy = expected.mode !== "workspace-write" || (
    raw?.networkAccess === false && raw.excludeTmpdirEnvVar === true && raw.excludeSlashTmp === true &&
    Array.isArray(raw.writableRoots) && raw.writableRoots.length === 1 &&
    raw.writableRoots[0] === expected.cwd
  );
  const correctReadPolicy = expected.mode !== "read-only" || raw?.networkAccess === false;
  const mismatch = result.approvalPolicy !== "on-request" ||
    result.approvalsReviewer !== "user" ||
    result.sandboxType !== expectedSandboxType(expected.mode) ||
    !exactControlCwd ||
    (expected.model !== undefined && rawResultRecord?.model !== expected.model) ||
    (expected.threadId !== undefined && result.thread.id !== expected.threadId) ||
    (expected.forkedFromId !== undefined && result.thread.forkedFromId !== expected.forkedFromId) ||
    (expected.ephemeral !== undefined && result.thread.ephemeral !== expected.ephemeral) ||
    !correctWorkspacePolicy || !correctReadPolicy;
  if (mismatch) {
    throw adapterError("POLICY_MISMATCH", "Codex did not preserve the requested safe policy");
  }
}

function enabledCapabilities(): Readonly<ProviderCapabilities> {
  return defineProviderCapabilities({
    list: true,
    read: true,
    start: true,
    resume: true,
    fork: true,
    send: true,
    // Schema presence alone is not enough to advertise a user-facing capability.
    steer: false,
    interrupt: true,
    subscribe: true,
    approveCommand: false,
    approveFileChange: false,
    approvePermissions: false,
    requestUserInput: false,
    mcpElicitation: false,
    archive: true,
    rename: true,
  });
}

export class CodexNativeAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  readonly home: string;
  private readonly supervisor: CodexNativeAdapterSupervisor;
  private readonly cursorCodec: CodexListCursorCodec;
  private readonly isEnabledFn: () => boolean;
  private readonly requestMode: "fail-closed" | "manual";
  private readonly writerLeases: CodexNativeAdapterWriterLeases | null;
  private readonly reconciliationStore: AdapterReconciliationStore | null;
  private readonly maxTrackedRevisions: number;
  /** Bounded per-task last-observed native revision and explicit latch. */
  private readonly revisions = new Map<string, CodexRevisionState>();
  private readonly owner = Symbol("CodexNativeAdapter");
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly taskPolicies = new Map<string, Readonly<TaskExecutionPolicy>>();
  private readonly broker: CodexRequestBroker;
  private readonly streamingSecrets = new StreamingSecretGate();
  private lease: CodexAppServerLease | null = null;
  private leasePromise: Promise<CodexAppServerLease> | null = null;
  private activeGeneration: number | null = null;
  private suspended = false;
  private refreshChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  private readonly onNotification = async (
    notification: CodexRpcNotification,
    context: AppServerGenerationContext,
  ): Promise<void> => {
    if (!this.isAvailable() || canonicalizeProviderHome(context.home) !== this.home) return;
    if (!this.adoptGeneration(context.generation)) return;
    if (notification.method === "serverRequest/resolved") {
      const resolved = this.broker.observeResolved(notification, context);
      if (resolved !== null) return;
    }
    this.dispatchNotification(notification, context);
  };

  private readonly onUnknownNotification = async (
    notification: CodexRpcNotification,
    context: AppServerGenerationContext,
  ): Promise<void> => {
    if (!this.isAvailable() || canonicalizeProviderHome(context.home) !== this.home) return;
    if (!this.adoptGeneration(context.generation)) return;
    this.dispatchNotification(notification, context);
  };

  private readonly onServerRequest = (
    request: CodexRpcRequest,
    context: AppServerGenerationContext,
  ): unknown | Promise<unknown> => {
    if (canonicalizeProviderHome(context.home) !== this.home) {
      throw adapterError("OWNERSHIP", "Codex request does not belong to this adapter");
    }
    this.assertAvailable();
    if (!this.adoptGeneration(context.generation)) {
      throw adapterError("DISABLED", "Stale Codex generation was rejected");
    }
    if (this.requestMode === "manual") return this.broker.handle(request, context);
    const normalized = normalizeCodexServerRequest(request, context).request;
    switch (normalized.kind) {
      case "command-approval":
      case "file-change-approval":
        return Object.freeze({ decision: "cancel" });
      case "permission":
        return Object.freeze({ permissions: Object.freeze({}) });
      case "mcp-elicitation":
        return Object.freeze({ action: "cancel" });
      case "user-input":
        if (normalized.autoResolutionMs !== null) {
          return Object.freeze({ answers: Object.freeze({}) });
        }
        throw adapterError(
          "UNSUPPORTED_INTERACTION",
          "Codex user input requires a safe request-detail surface",
        );
    }
  };

  private readonly handlers = Object.freeze({
    owner: this.owner,
    onNotification: this.onNotification,
    onUnknownNotification: this.onUnknownNotification,
    onServerRequest: this.onServerRequest,
  });

  constructor(options: CodexNativeAdapterOptions) {
    if (!options || !options.supervisor || typeof options.supervisor.acquire !== "function") {
      throw new TypeError("CodexNativeAdapter requires a supervisor");
    }
    this.home = canonicalizeProviderHome(options.home);
    this.supervisor = options.supervisor;
    this.cursorCodec = new CodexListCursorCodec(options.cursorSecret);
    this.isEnabledFn = options.isEnabled ?? (() => true);
    if (options.requestMode !== undefined && options.requestMode !== "fail-closed" &&
      options.requestMode !== "manual") {
      throw new TypeError("requestMode must be fail-closed or manual");
    }
    this.requestMode = options.requestMode ?? "fail-closed";
    if (options.writerLeases !== undefined &&
      (typeof options.writerLeases !== "object" || options.writerLeases === null ||
        typeof options.writerLeases.acquire !== "function")) {
      throw new TypeError("CodexNativeAdapter writerLeases must expose acquire");
    }
    this.writerLeases = options.writerLeases ?? null;
    if (options.reconciliationStore !== undefined &&
      (typeof options.reconciliationStore !== "object" || options.reconciliationStore === null ||
        typeof options.reconciliationStore.getReconciliation !== "function" ||
        typeof options.reconciliationStore.requireReconciliation !== "function" ||
        typeof options.reconciliationStore.acknowledgeReconciliation !== "function")) {
      throw new TypeError("CodexNativeAdapter reconciliationStore is invalid");
    }
    this.reconciliationStore = options.reconciliationStore ?? null;
    const maxTracked = options.maxTrackedRevisions ?? DEFAULT_MAX_TRACKED_REVISIONS;
    if (!Number.isSafeInteger(maxTracked) || maxTracked < 1 ||
      maxTracked > MAX_TRACKED_REVISIONS_HARD) {
      throw new TypeError("CodexNativeAdapter maxTrackedRevisions is invalid");
    }
    this.maxTrackedRevisions = maxTracked;
    this.suspended = !this.flagEnabled();
    this.broker = new CodexRequestBroker({ emit: (event) => this.publish(event) });
  }

  async capabilities(): Promise<Readonly<ProviderCapabilities>> {
    return this.isAvailable() ? enabledCapabilities() : defineProviderCapabilities();
  }

  async listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>> {
    const home = this.assertHome(input.home);
    if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean") {
      throw adapterError("INVALID_INPUT", "includeArchived must be a boolean");
    }
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CODEX_LIST_LIMIT) {
      throw adapterError("INVALID_INPUT", `List limit must be between 1 and ${MAX_CODEX_LIST_LIMIT}`);
    }
    const scope: CodexListScope = {
      home,
      includeArchived: input.includeArchived === true,
      limit,
    };
    const state = input.cursor === undefined
      ? initialCodexListCursorState(scope.includeArchived)
      : this.cursorCodec.decode(input.cursor, scope);
    const requests = createCodexThreadListRequests(scope, state);
    if (requests.length === 0) return Object.freeze({ items: Object.freeze([]), nextCursor: null });
    const lease = await this.getLease();
    const laneResults: CodexThreadListLaneResult[] = [];
    const summaries: Readonly<NativeTaskSummary>[] = [];
    const rawResults = await Promise.all(requests.map(async (request) => ({
      request,
      raw: await lease.call("thread/list", request.params),
    })));
    for (const { request, raw } of rawResults) {
      const parsed = parseCodexThreadListResult(raw, { archived: request.lane === "archived" });
      if (parsed.threads.length > request.params.limit) {
        throw adapterError("INVALID_INPUT", "Codex list lane exceeded its issued quota");
      }
      parsed.threads.forEach((thread) => summaries.push(summaryFromThread(home, thread)));
      laneResults.push({ lane: request.lane, nextCursor: parsed.nextCursor });
    }
    const next = advanceCodexListCursorState(scope, state, laneResults);
    const deduped = new Map<string, Readonly<NativeTaskSummary>>();
    for (const summary of summaries) {
      const existing = deduped.get(summary.key.nativeTaskId);
      const nextUpdated = summary.revision?.updatedAt ?? -1;
      const priorUpdated = existing?.revision?.updatedAt ?? -1;
      if (!existing || nextUpdated > priorUpdated ||
        (nextUpdated === priorUpdated && existing.archived === true && summary.archived === false)) {
        deduped.set(summary.key.nativeTaskId, summary);
      }
    }
    const items = Object.freeze([...deduped.values()].sort((left, right) => {
      const byTime = (right.revision?.updatedAt ?? -1) - (left.revision?.updatedAt ?? -1);
      return byTime || left.key.nativeTaskId.localeCompare(right.key.nativeTaskId);
    }));
    const done = next.activeDone && next.archivedDone;
    return Object.freeze({
      items,
      nextCursor: done ? null : this.cursorCodec.encode(scope, next),
    });
  }

  async readTask(key: NativeTaskKey, includeTurns: boolean): Promise<NativeTask> {
    const owned = this.assertKey(key);
    if (typeof includeTurns !== "boolean") {
      throw adapterError("INVALID_INPUT", "includeTurns must be a boolean");
    }
    const lease = await this.getLease();
    const raw = await readCodexThread(owned.nativeTaskId, () => lease.call("thread/read", {
      threadId: owned.nativeTaskId,
      includeTurns,
    }));
    const parsed = parseCodexThreadReadResult(raw);
    if (parsed.thread.id !== owned.nativeTaskId) {
      throw adapterError("OWNERSHIP", "Codex read returned a different task");
    }
    return taskFromThread(this.home, lease.generation, parsed.thread, rawThread(raw), includeTurns);
  }

  async startTask(input: StartTaskInput): Promise<NativeTask> {
    const home = this.assertHome(input.home);
    const mode = assertNoUnsafeOverrides(input);
    const cwd = absolutePath(input.cwd, "Working directory");
    const preparedInput = input.input === undefined ? null : inputItems(input.input);
    const lease = await this.getLease();
    const params = Object.freeze({
      ...threadPolicy(mode, cwd, input.model),
      ephemeral: false,
      serviceName: "devhub",
      threadSource: "appServer",
    });
    const rawStart = await this.mutationCall(lease, "thread/start", params);
    const started = this.parseMutation(() => parseCodexThreadStartResult(rawStart));
    const created = taskFromThread(
      home,
      lease.generation,
      started.thread,
      rawThread(rawStart),
      true,
      started.model,
    );
    try {
      verifyConfiguredResult(started, rawStart, {
        mode,
        cwd,
        model: input.model,
        ephemeral: false,
      });
    } catch (cause) {
      throw adapterError(
        "PARTIAL_START",
        "Codex created the task but did not preserve the requested safe policy",
        { cause, task: created },
      );
    }
    this.rememberTaskPolicy(created.key.nativeTaskId, { mode, cwd, model: input.model });
    if (preparedInput === null) return created;
    try {
      await this.startTurn(lease, created.key, preparedInput, mode, cwd, input.model);
      const reread = await this.readTask(created.key, true);
      return Object.freeze({ ...reread, model: started.model });
    } catch (cause) {
      throw adapterError(
        "PARTIAL_START",
        "Codex created the task but a later start step failed",
        { cause, task: created },
      );
    }
  }

  async resumeTask(key: NativeTaskKey, overrides?: TaskOverrides): Promise<NativeTask> {
    const owned = this.assertKey(key);
    const mode = assertNoUnsafeOverrides(overrides);
    const lease = await this.getLease();
    const rawRead = await readCodexThread(owned.nativeTaskId, () => lease.call("thread/read", {
      threadId: owned.nativeTaskId,
      includeTurns: true,
    }));
    const current = parseCodexThreadReadResult(rawRead);
    if (current.thread.id !== owned.nativeTaskId) {
      throw adapterError("OWNERSHIP", "Codex read returned a different task");
    }
    const cwd = controlCwdFromThreadEnvelope(rawRead);
    return this.fencedExistingMutation(
      owned,
      lease,
      async () => {
        const rawResume = await this.mutationCall(lease, "thread/resume", {
          threadId: owned.nativeTaskId,
          ...threadPolicy(mode, cwd, overrides?.model),
        });
        const resumed = this.parseMutation(() => parseCodexThreadResumeResult(rawResume));
        verifyConfiguredResult(resumed, rawResume, {
          mode,
          cwd,
          model: overrides?.model,
          threadId: owned.nativeTaskId,
        });
        this.rememberTaskPolicy(owned.nativeTaskId, { mode, cwd, model: overrides?.model });
        return taskFromThread(
          this.home,
          lease.generation,
          resumed.thread,
          rawThread(rawResume),
          true,
          resumed.model,
        );
      },
      (task) => task.revision?.fingerprint ?? null,
    );
  }

  async forkTask(key: NativeTaskKey, lastTurnId?: string): Promise<NativeTask> {
    const owned = this.assertKey(key);
    if (lastTurnId !== undefined) this.nativeId(lastTurnId, "Last turn id");
    const lease = await this.getLease();
    const rawRead = await readCodexThread(owned.nativeTaskId, () => lease.call("thread/read", {
      threadId: owned.nativeTaskId,
      includeTurns: false,
    }));
    const current = parseCodexThreadReadResult(rawRead);
    if (current.thread.id !== owned.nativeTaskId) {
      throw adapterError("OWNERSHIP", "Codex read returned a different task");
    }
    const cwd = controlCwdFromThreadEnvelope(rawRead);
    const mode: SafePermissionMode = "read-only";
    return this.fencedExistingMutation(owned, lease, async () => {
      const rawFork = await this.mutationCall(lease, "thread/fork", {
        threadId: owned.nativeTaskId,
        ...(lastTurnId === undefined ? {} : { lastTurnId }),
        ...threadPolicy(mode, cwd),
        ephemeral: false,
      });
      const forked = this.parseMutation(() => parseCodexThreadForkResult(rawFork));
      if (forked.thread.id === owned.nativeTaskId) {
        throw adapterError("OWNERSHIP", "Codex fork reused the source task id");
      }
      const forkedTask = taskFromThread(
        this.home,
        lease.generation,
        forked.thread,
        rawThread(rawFork),
        true,
        forked.model,
      );
      try {
        verifyConfiguredResult(forked, rawFork, {
          mode,
          cwd,
          forkedFromId: owned.nativeTaskId,
          ephemeral: false,
        });
      } catch (cause) {
        throw adapterError(
          "PARTIAL_FORK",
          "Codex created a fork but did not preserve its safe ownership policy",
          { cause, task: forkedTask },
        );
      }
      this.rememberTaskPolicy(forked.thread.id, { mode, cwd });
      return forkedTask;
    });
  }

  async send(key: NativeTaskKey, input: UserInput): Promise<NativeTurnRef> {
    const owned = this.assertKey(key);
    const preparedInput = inputItems(input);
    const lease = await this.getLease();
    const policy = this.taskPolicy(owned.nativeTaskId);
    return this.fencedExistingMutation(owned, lease, () => this.startTurn(
      lease,
      owned,
      preparedInput,
      policy.mode,
      policy.cwd,
      policy.model,
    ));
  }

  async steer(key: NativeTaskKey, expectedTurnId: string, input: UserInput): Promise<void> {
    const owned = this.assertKey(key);
    const turnId = this.nativeId(expectedTurnId, "Expected turn id");
    const preparedInput = inputItems(input);
    const lease = await this.getLease();
    await this.fencedExistingMutation(owned, lease, async () => {
      await this.mutationCall(lease, "turn/steer", {
        threadId: owned.nativeTaskId,
        expectedTurnId: turnId,
        input: preparedInput,
      });
    });
  }

  async interrupt(key: NativeTaskKey, turnId: string): Promise<void> {
    const owned = this.assertKey(key);
    const exactTurnId = this.nativeId(turnId, "Turn id");
    const lease = await this.getLease();
    await this.fencedExistingMutation(owned, lease, async () => {
      this.broker.cancelTurn(owned, exactTurnId, lease.generation);
      this.streamingSecrets.cancelTurn(lease.generation, owned.nativeTaskId, exactTurnId);
      await this.mutationCall(lease, "turn/interrupt", {
        threadId: owned.nativeTaskId,
        turnId: exactTurnId,
      });
    });
  }

  async respond(response: ProviderRequestResponse): Promise<void> {
    this.assertAvailable();
    const owned = this.fencingActive() ? this.respondKey(response) : null;
    if (owned === null) {
      // The broker rejects unknown/late/foreign/stale request+generation
      // identities before dispatch (no-op single dispatch).
      await this.broker.respond(response);
      return;
    }
    const lease = await this.getLease();
    await this.fencedExistingMutation(owned, lease, () => this.broker.respond(response));
  }

  async archive(key: NativeTaskKey): Promise<void> {
    const owned = this.assertKey(key);
    const lease = await this.getLease();
    await this.fencedExistingMutation(owned, lease, async () => {
      this.broker.cancelTask(owned);
      this.streamingSecrets.cancelTask(lease.generation, owned.nativeTaskId);
      this.taskPolicies.delete(owned.nativeTaskId);
      await this.mutationCall(lease, "thread/archive", { threadId: owned.nativeTaskId });
    });
  }

  async rename(key: NativeTaskKey, name: string): Promise<void> {
    const owned = this.assertKey(key);
    if (typeof name !== "string" || name.trim().length === 0 || name !== name.trim() ||
      name.length > 4_096 || name.includes("\u0000")) {
      throw adapterError("INVALID_INPUT", "Task name must be a bounded non-empty value");
    }
    const lease = await this.getLease();
    await this.fencedExistingMutation(owned, lease, async () => {
      await this.mutationCall(lease, "thread/name/set", { threadId: owned.nativeTaskId, name });
    });
  }

  /**
   * Clears a provider-private reconciliation latch only for an exact reviewed
   * revision. Rereads exact native state, then durably clears via the store CAS
   * on the returned latch revision plus reviewed/native fingerprint before the
   * in-memory clear. A CAS mismatch, stale revision, or newer same-fingerprint
   * durable relatch keeps the task latched.
   */
  async acknowledgeReconciliation(
    key: NativeTaskKey,
    reviewedFingerprint: string,
  ): Promise<void> {
    const owned = this.assertKey(key);
    const reviewed = this.safeReviewedFingerprint(reviewedFingerprint);
    const state = this.revisions.get(owned.nativeTaskId);
    if (this.reconciliationStore === null) {
      if (!state?.reconciliationRequired) return;
      throw this.reconciliationRequired();
    }
    let durable: ReturnType<AdapterReconciliationStore["getReconciliation"]>;
    try {
      durable = this.reconciliationStore.getReconciliation(owned);
    } catch (cause) {
      throw this.storeUnavailable(cause);
    }
    if (!durable.required && !state?.reconciliationRequired) return;
    // Authoritative reread of exact native state; a deletion resolves with a null
    // native fingerprint.
    const lease = await this.getLease();
    let observedNative: string | null;
    try {
      observedNative = await this.fenceReread(owned, lease);
    } catch (cause) {
      if (cause instanceof CodexNativeAdapterError && cause.code === "NATIVE_TASK_MISSING") {
        observedNative = null;
      } else {
        throw cause;
      }
    }
    let cleared: ReturnType<AdapterReconciliationStore["acknowledgeReconciliation"]>;
    try {
      cleared = this.reconciliationStore.acknowledgeReconciliation(
        owned,
        durable.latchRevision,
        reviewed,
        observedNative,
      );
    } catch (cause) {
      throw this.storeUnavailable(cause);
    }
    if (cleared.required) {
      this.restoreLatch(owned);
      throw this.reconciliationRequired();
    }
    // Durable clear committed; clear the live latch and reviewed baseline.
    const live = this.ensureRevisionState(owned.nativeTaskId);
    live.reconciliationRequired = false;
    live.reviewedFingerprint = observedNative;
    if (observedNative !== null) live.everPersisted = true;
  }

  private respondKey(response: ProviderRequestResponse): Readonly<NativeTaskKey> | null {
    try {
      const identity = (response as { identity?: { key?: NativeTaskKey } })?.identity;
      if (!identity || !identity.key) return null;
      return this.assertKey(identity.key);
    } catch {
      return null;
    }
  }

  private safeReviewedFingerprint(value: unknown): string {
    if (
      typeof value !== "string" || value.length === 0 || value.length > 4_096 ||
      value !== value.trim() || value.includes(" ") || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw adapterError("INVALID_INPUT", "Codex reviewed revision is invalid");
    }
    return value;
  }

  async subscribe(key: NativeTaskKey, sink: ProviderEventSink): Promise<Unsubscribe> {
    const owned = this.assertKey(key);
    if (typeof sink !== "function") throw adapterError("INVALID_INPUT", "Event sink must be a function");
    let state = this.subscriptions.get(owned.nativeTaskId);
    if (state?.closePromise !== null && state?.closePromise !== undefined) {
      await state.closePromise;
      this.assertAvailable();
      state = this.subscriptions.get(owned.nativeTaskId);
    }
    if (!state) {
      if (this.subscriptions.size >= MAX_SUBSCRIBED_TASKS) {
        throw adapterError("SUBSCRIPTION_CAPACITY", "Codex subscription capacity was reached");
      }
      state = {
        key: owned,
        sinks: new Map(),
        loadPromise: null,
        revision: null,
        closePromise: null,
      };
      this.subscriptions.set(owned.nativeTaskId, state);
    }
    if (state.sinks.size >= MAX_SUBSCRIBERS_PER_TASK) {
      throw adapterError("SUBSCRIPTION_CAPACITY", "Codex task subscriber capacity was reached");
    }
    const subscriptionId = Symbol("CodexSubscriber");
    state.sinks.set(subscriptionId, sink);
    if (state.loadPromise === null) {
      const exactState = state;
      state.loadPromise = this.readTask(owned, false).then((task) => {
        exactState.revision = task.revision?.fingerprint ?? null;
      });
    }
    try {
      await state.loadPromise;
      this.assertAvailable();
    } catch (error) {
      state.sinks.delete(subscriptionId);
      if (state.sinks.size === 0 && this.subscriptions.get(owned.nativeTaskId) === state) {
        this.subscriptions.delete(owned.nativeTaskId);
      }
      throw error;
    }

    let unsubscribed = false;
    return async (): Promise<void> => {
      if (unsubscribed) return;
      unsubscribed = true;
      state!.sinks.delete(subscriptionId);
      if (state!.sinks.size !== 0 || this.subscriptions.get(owned.nativeTaskId) !== state) return;
      this.broker.cancelTask(owned);
      if (this.activeGeneration !== null) {
        this.streamingSecrets.cancelTask(this.activeGeneration, owned.nativeTaskId);
      }
      if (state!.closePromise === null) {
        const exactState = state!;
        exactState.closePromise = this.unsubscribeNative(owned.nativeTaskId).finally(() => {
          if (this.subscriptions.get(owned.nativeTaskId) === exactState) {
            this.subscriptions.delete(owned.nativeTaskId);
          }
        });
      }
      await state!.closePromise;
    };
  }

  /** Re-establishes reads/subscriptions after a supervised process generation change. */
  async reconcile(context: AppServerReconcileContext): Promise<void> {
    this.assertAvailable();
    if (canonicalizeProviderHome(context.home) !== this.home) {
      throw adapterError("OWNERSHIP", "Codex reconciliation does not belong to this adapter");
    }
    if (!this.adoptGeneration(context.generation)) {
      throw adapterError("DISABLED", "Stale Codex reconciliation was rejected");
    }
    for (const state of [...this.subscriptions.values()]) {
      if (context.signal.aborted) throw adapterError("DISABLED", "Codex reconciliation was cancelled");
      const rawRead = await readCodexThread(state.key.nativeTaskId, () =>
        context.rpc.call("thread/read", {
          threadId: state.key.nativeTaskId,
          includeTurns: false,
        }));
      const current = parseCodexThreadReadResult(rawRead);
      if (current.thread.id !== state.key.nativeTaskId) {
        throw adapterError("OWNERSHIP", "Codex reconciliation returned a different task");
      }
      const revision = buildCodexNativeRevision(current.thread);
      if (state.revision !== null && state.revision !== revision.fingerprint) {
        this.publish(normalizeProviderEvent({
          type: "status",
          scope: "task",
          status: current.thread.status,
          nativeId: current.thread.id,
        }, {
          provider: "openai",
          key: state.key,
        }));
      }
      state.revision = revision.fingerprint;
      const cwd = controlCwdFromThreadEnvelope(rawRead);
      if (context.signal.aborted) throw adapterError("DISABLED", "Codex reconciliation was cancelled");
      const rawResume = await context.rpc.call("thread/resume", {
        threadId: state.key.nativeTaskId,
        ...threadPolicy("read-only", cwd),
      });
      const resumed = parseCodexThreadResumeResult(rawResume);
      verifyConfiguredResult(resumed, rawResume, {
        mode: "read-only",
        cwd,
        threadId: state.key.nativeTaskId,
      });
      state.revision = buildCodexNativeRevision(resumed.thread).fingerprint;
      this.rememberTaskPolicy(state.key.nativeTaskId, { mode: "read-only", cwd });
    }
  }

  /** Synchronize a persisted feature toggle without retaining a released lease. */
  refreshEnabled(): Promise<void> {
    if (this.disposed) return Promise.reject(
      adapterError("DISPOSED", "Codex native adapter is disposed"),
    );
    const targetEnabled = this.flagEnabled();
    if (!targetEnabled) this.suspended = true;
    const refresh = async (): Promise<void> => {
      if (this.disposed) return;
      if (!targetEnabled) {
        await this.suspendLease();
        return;
      }
      // A newer disable wins over this queued enable.
      if (!this.flagEnabled()) return;
      this.suspended = false;
      if (this.subscriptions.size > 0) await this.getLease();
    };
    this.refreshChain = this.refreshChain.then(refresh, refresh);
    return this.refreshChain;
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeImpl();
    return this.disposePromise;
  }

  private async startTurn(
    lease: CodexAppServerLease,
    key: NativeTaskKey,
    input: readonly Readonly<Record<string, unknown>>[],
    mode: SafePermissionMode,
    cwd?: string,
    model?: string,
  ): Promise<NativeTurnRef> {
    const raw = await this.mutationCall(lease, "turn/start", {
      threadId: key.nativeTaskId,
      input,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: sandboxPolicy(mode, cwd),
      ...(cwd === undefined ? {} : { cwd }),
      ...(model === undefined ? {} : { model }),
    });
    const parsed = this.parseMutation(() => parseCodexTurnStartResult(raw));
    return Object.freeze({ taskKey: createNativeTaskKey("openai", this.home, key.nativeTaskId), turnId: parsed.turn.id });
  }

  private async unsubscribeNative(threadId: string): Promise<void> {
    const lease = this.lease;
    if (!lease || this.disposed) return;
    await lease.call("thread/unsubscribe", { threadId });
  }

  private async mutationCall(
    lease: CodexAppServerLease,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    try {
      return await lease.call(method, params);
    } catch (cause) {
      if (cause instanceof CodexNativeAdapterError && cause.code === "MUTATION_UNCERTAIN") {
        throw cause;
      }
      throw adapterError(
        "MUTATION_UNCERTAIN",
        "Codex mutation outcome is uncertain and must not be retried automatically",
        { cause },
      );
    }
  }

  private parseMutation<T>(parse: () => T): T {
    try { return parse(); } catch (cause) {
      if (cause instanceof CodexNativeAdapterError) throw cause;
      throw adapterError(
        "MUTATION_UNCERTAIN",
        "Codex mutation committed but its response could not be verified",
        { cause },
      );
    }
  }

  // --- Writer-lease fence + durable reconciliation over existing-task mutations ---

  /**
   * The fenced-write path only engages when the runtime injected both the shared
   * writer-lease store and the durable reconciliation seam. Hermetic projection
   * tests without those dependencies keep the pre-fence direct-dispatch behavior.
   */
  private fencingActive(): boolean {
    return this.writerLeases !== null && this.reconciliationStore !== null;
  }

  private reconciliationRequired(): CodexNativeAdapterError {
    return adapterError(
      "RECONCILIATION_REQUIRED",
      "Codex native task requires authoritative reconciliation",
    );
  }

  private storeUnavailable(cause: unknown): CodexNativeAdapterError {
    // A durable read/write fault latches the wrapper unavailable; isAvailable()
    // then reports the whole unified runtime unavailable and every later call
    // fails closed.
    return adapterError("DISABLED", "Codex reconciliation store is unavailable", { cause });
  }

  private ensureRevisionState(nativeTaskId: string): CodexRevisionState {
    const existing = this.revisions.get(nativeTaskId);
    if (existing) {
      // Preserve recency ordering for bounded eviction.
      this.revisions.delete(nativeTaskId);
      this.revisions.set(nativeTaskId, existing);
      return existing;
    }
    while (this.revisions.size >= this.maxTrackedRevisions) {
      let evictable: string | null = null;
      for (const [candidateId, candidate] of this.revisions) {
        // Never evict a latched task: a lost latch could let a required
        // reconciliation be skipped after eviction.
        if (!candidate.reconciliationRequired) { evictable = candidateId; break; }
      }
      if (evictable === null) {
        throw adapterError(
          "SUBSCRIPTION_CAPACITY",
          "Codex revision reconciliation capacity was reached",
        );
      }
      this.revisions.delete(evictable);
    }
    const created: CodexRevisionState = {
      reviewedFingerprint: null,
      everPersisted: false,
      reconciliationRequired: false,
      reconciliationEpoch: 0,
      lastWriterEpoch: 0,
    };
    this.revisions.set(nativeTaskId, created);
    return created;
  }

  private durableRequire(
    owned: Readonly<NativeTaskKey>,
    state: CodexRevisionState,
    reason: ProviderReconciliationReason,
    nativeFingerprint: string | null,
  ): void {
    if (this.reconciliationStore === null) return;
    const input: AdapterReconciliationLatchInput = {
      reviewedFingerprint: state.reviewedFingerprint,
      nativeFingerprint,
      writerEpoch: state.lastWriterEpoch,
      reason,
    };
    try {
      this.reconciliationStore.requireReconciliation(owned, input);
    } catch (cause) {
      throw this.storeUnavailable(cause);
    }
  }

  /**
   * Latches reconciliation for one owned task. The in-memory latch is set before
   * the durable mirror so a durable fault leaves the live process conservatively
   * latched. Never clears a reviewed fingerprint; a required latch survives cache
   * clears because it lives in DevHub-owned reconciliation state.
   */
  private latchReconciliation(
    owned: Readonly<NativeTaskKey>,
    reason: ProviderReconciliationReason,
    nativeFingerprint: string | null,
  ): void {
    const state = this.ensureRevisionState(owned.nativeTaskId);
    state.reconciliationRequired = true;
    state.reconciliationEpoch += 1;
    this.durableRequire(owned, state, reason, nativeFingerprint);
  }

  private restoreLatch(owned: Readonly<NativeTaskKey>): void {
    const state = this.ensureRevisionState(owned.nativeTaskId);
    if (!state.reconciliationRequired) {
      state.reconciliationRequired = true;
      state.reconciliationEpoch += 1;
    }
  }

  /**
   * Fails closed when an existing latch is present. Reads the durable latch first
   * (restart-safe) and restores the live latch before rejecting; a durable fault
   * fails closed.
   */
  private guardReconciliation(owned: Readonly<NativeTaskKey>): void {
    if (this.revisions.get(owned.nativeTaskId)?.reconciliationRequired) {
      throw this.reconciliationRequired();
    }
    if (this.reconciliationStore === null) return;
    let snapshotRequired = false;
    try {
      snapshotRequired = this.reconciliationStore.getReconciliation(owned).required;
    } catch (cause) {
      throw this.storeUnavailable(cause);
    }
    if (snapshotRequired) {
      this.restoreLatch(owned);
      throw this.reconciliationRequired();
    }
  }

  private validateWriterIdentity(
    owned: Readonly<NativeTaskKey>,
    writer: NativeTaskWriterLease,
  ): void {
    const state = this.ensureRevisionState(owned.nativeTaskId);
    const previousEpoch = state.lastWriterEpoch;
    let epoch = 0;
    let valid = false;
    try {
      epoch = writer.fence.epoch;
      valid = nativeTaskKeyId(writer.key) === nativeTaskKeyId(owned) &&
        nativeTaskKeyId(writer.fence.key) === nativeTaskKeyId(owned) &&
        Number.isSafeInteger(epoch) && epoch >= 1 && epoch > previousEpoch;
    } catch {
      valid = false;
    }
    if (!valid) {
      // Lost/ABA/stale writer identity is a fail-closed reconciliation trigger.
      this.latchReconciliation(owned, "WRITER_LEASE_LOST", null);
      throw this.reconciliationRequired();
    }
    state.lastWriterEpoch = epoch;
  }

  /** Reads the exact native revision. Missing throws NATIVE_TASK_MISSING; a
   * parser/ownership break fails closed after latching. */
  private async fenceReread(
    owned: Readonly<NativeTaskKey>,
    lease: CodexAppServerLease,
  ): Promise<string> {
    const raw = await readCodexThread(owned.nativeTaskId, () => lease.call("thread/read", {
      threadId: owned.nativeTaskId,
      includeTurns: false,
    }));
    let fingerprint: string;
    try {
      const parsed = parseCodexThreadReadResult(raw);
      if (parsed.thread.id !== owned.nativeTaskId) throw new Error("id mismatch");
      fingerprint = buildCodexNativeRevision(parsed.thread).fingerprint;
    } catch {
      this.latchReconciliation(owned, "NATIVE_STATE_INVALID", null);
      throw this.reconciliationRequired();
    }
    return fingerprint;
  }

  private compareReviewed(
    owned: Readonly<NativeTaskKey>,
    current: { readonly exists: boolean; readonly fingerprint: string | null },
  ): void {
    const state = this.ensureRevisionState(owned.nativeTaskId);
    if (!current.exists) {
      if (state.everPersisted || state.reviewedFingerprint !== null) {
        this.latchReconciliation(owned, "NATIVE_TASK_MISSING", null);
        throw this.reconciliationRequired();
      }
      throw adapterError("NATIVE_TASK_MISSING", "Provider native task is missing");
    }
    if (
      state.reviewedFingerprint !== null &&
      state.reviewedFingerprint !== current.fingerprint
    ) {
      this.latchReconciliation(owned, "NATIVE_REVISION_MISMATCH", current.fingerprint);
      throw this.reconciliationRequired();
    }
    state.reviewedFingerprint = current.fingerprint;
    state.everPersisted = true;
  }

  private rememberReviewed(owned: Readonly<NativeTaskKey>, fingerprint: string | null): void {
    const state = this.ensureRevisionState(owned.nativeTaskId);
    state.reviewedFingerprint = fingerprint;
    state.everPersisted = true;
  }

  /**
   * Runs one existing-task mutation. When fencing is active every mutation
   * acquires the exact task's writer lease, rereads the exact native revision,
   * compares it with the last reviewed revision, confirms the lease reread, and
   * starts the provider dispatch only through `runFencedWrite`. Any mismatch,
   * lost lease, deletion, generation change, thrown parser, or uncertain
   * post-dispatch outcome fails closed with reconciliation required and never
   * replays.
   */
  private async fencedExistingMutation<T>(
    owned: Readonly<NativeTaskKey>,
    lease: CodexAppServerLease,
    dispatch: () => Promise<T>,
    revisionAfter?: (result: T) => string | null,
  ): Promise<T> {
    if (!this.fencingActive()) return await dispatch();
    this.assertAvailable();
    this.guardReconciliation(owned);

    let writer: NativeTaskWriterLease | null = null;
    try { writer = this.writerLeases!.acquire(owned); } catch { writer = null; }
    if (writer === null) {
      this.latchReconciliation(owned, "WRITER_LEASE_LOST", null);
      throw this.reconciliationRequired();
    }

    try {
      this.validateWriterIdentity(owned, writer);
      const capturedGeneration = this.activeGeneration;

      let current: { readonly exists: boolean; readonly fingerprint: string | null };
      try {
        current = { exists: true, fingerprint: await this.fenceReread(owned, lease) };
      } catch (cause) {
        if (cause instanceof CodexNativeAdapterError && cause.code === "NATIVE_TASK_MISSING") {
          current = { exists: false, fingerprint: null };
        } else {
          throw cause;
        }
      }
      this.compareReviewed(owned, current);

      this.assertAvailable();
      if (!writer.confirmReread()) {
        this.latchReconciliation(owned, "WRITER_LEASE_LOST", null);
        throw this.reconciliationRequired();
      }

      let callbackThrew = false;
      let callbackError: unknown;
      let outcome: { readonly started: false } | { readonly started: true; readonly value: Promise<T> };
      try {
        outcome = writer.runFencedWrite((fence) => {
          try {
            let exact = false;
            try {
              exact = nativeTaskKeyId(fence.key) === nativeTaskKeyId(owned) &&
                fence.epoch === writer!.fence.epoch &&
                Number.isSafeInteger(fence.epoch) && fence.epoch >= 1;
            } catch { exact = false; }
            if (!exact) {
              throw adapterError("OWNERSHIP", "Codex writer ownership is unavailable");
            }
            this.assertAvailable();
            if (this.revisions.get(owned.nativeTaskId)?.reconciliationRequired) {
              throw this.reconciliationRequired();
            }
            return dispatch();
          } catch (error) {
            callbackThrew = true;
            callbackError = error;
            throw error;
          }
        });
      } catch {
        if (callbackThrew) throw callbackError;
        throw adapterError("OWNERSHIP", "Codex writer ownership is unavailable");
      }
      if (!outcome.started) {
        this.latchReconciliation(owned, "WRITER_LEASE_LOST", null);
        throw this.reconciliationRequired();
      }

      let result: T;
      try {
        result = await outcome.value;
      } catch (cause) {
        // The provider dispatch started but its outcome is uncertain. Latch
        // reconciliation so it is never replayed automatically, then surface the
        // exact cause.
        this.latchReconciliation(owned, "MUTATION_OUTCOME_UNCERTAIN", null);
        throw cause;
      }

      if (this.activeGeneration !== capturedGeneration) {
        this.latchReconciliation(owned, "PROCESS_GENERATION_CHANGED", null);
        throw this.reconciliationRequired();
      }

      this.rememberReviewed(owned, revisionAfter ? revisionAfter(result) : null);
      return result;
    } finally {
      try { writer.release(); } catch { /* The primary outcome remains authoritative. */ }
    }
  }

  private publish(event: ProviderEvent): void {
    if (!this.isAvailable() || event.key.home !== this.home) return;
    const state = this.subscriptions.get(event.key.nativeTaskId);
    if (!state) return;
    for (const sink of [...state.sinks.values()]) {
      try { sink(event); } catch { /* One consumer cannot break the app-server boundary. */ }
    }
  }

  private dispatchNotification(
    notification: CodexRpcNotification,
    context: AppServerGenerationContext,
  ): void {
    if (
      notification.method === "item/agentMessage/delta" ||
      notification.method === "item/plan/delta"
    ) {
      // Validate shape/ownership with an empty delta. The raw fragment must reach
      // only the stateful gate: normalizing it first would run whole-string secret
      // patterns before the gate's deterministic work and suppression budgets.
      const rawParams = isRecord(notification.params) ? notification.params : null;
      const rawDelta = rawParams?.delta;
      const validation = normalizeCodexNotification({
        method: notification.method,
        params: rawParams === null
          ? notification.params
          : { ...rawParams, delta: typeof rawDelta === "string" ? "" : rawDelta },
      }, context);
      if (validation.some((event) => event.type === "diagnostic")) {
        for (const event of validation) this.publish(event);
        return;
      }
      const params = rawParams!;
      const normalized = validation[0]!;
      const turnId = normalized.type === "message-delta" || normalized.type === "plan"
        ? normalized.turnId
        : null;
      const itemId = normalized.type === "message-delta" || normalized.type === "plan"
        ? normalized.itemId
        : null;
      if (turnId === null || itemId === null) return;
      const streamKey: StreamingSecretKey = {
        generation: context.generation,
        threadId: normalized.key.nativeTaskId,
        turnId,
        itemId,
        kind: notification.method === "item/plan/delta" ? "plan" : "message",
      };
      const gated = this.streamingSecrets.feed(streamKey, rawDelta as string);
      if (gated.suppressed) {
        this.publish(normalizeProviderEvent({
          type: "diagnostic",
          level: "warning",
          code: "CODEX_STREAM_TEXT_SUPPRESSED",
          message: "Codex stream text exceeded the safe redaction boundary; final item text remains authoritative",
          method: notification.method,
          shapeKeys: [],
        }, {
          provider: "openai",
          key: createNativeTaskKey("openai", this.home, streamKey.threadId),
        }));
      }
      for (const chunk of gated.chunks) {
        for (const event of normalizeCodexNotification({
          method: notification.method,
          params: {
            ...params,
            threadId: streamKey.threadId,
            turnId: streamKey.turnId,
            itemId: streamKey.itemId,
            delta: chunk,
          },
        }, context)) this.publish(event);
      }
      return;
    }

    const params = isRecord(notification.params) ? notification.params : null;
    if (notification.method === "item/completed" && params && isRecord(params.item)) {
      const common = {
        generation: context.generation,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.item.id,
      };
      if (
        typeof common.threadId === "string" && typeof common.turnId === "string" &&
        typeof common.itemId === "string"
      ) {
        for (const kind of ["message", "plan"] as const) {
          try { this.streamingSecrets.complete({ ...common, kind } as StreamingSecretKey); } catch { /* malformed notification is normalized below */ }
        }
      }
    }
    for (const event of normalizeCodexNotification(notification, context)) this.publish(event);
    if (
      (notification.method === "turn/completed" || notification.method === "error") && params &&
      typeof params.threadId === "string" && typeof params.turnId === "string"
    ) {
      this.streamingSecrets.cancelTurn(context.generation, params.threadId, params.turnId);
    } else if (
      notification.method === "thread/archived" && params && typeof params.threadId === "string"
    ) {
      this.streamingSecrets.cancelTask(context.generation, params.threadId);
    }
  }

  private async getLease(): Promise<CodexAppServerLease> {
    this.assertAvailable();
    if (this.lease !== null) return this.lease;
    if (this.leasePromise === null) {
      this.leasePromise = this.supervisor.acquire({ home: this.home, handlers: this.handlers })
        .then(async (lease) => {
          let validLease = false;
          try {
            validLease = canonicalizeProviderHome(lease.home) === this.home &&
              Number.isSafeInteger(lease.generation) && lease.generation >= 1;
          } catch {
            validLease = false;
          }
          if (!validLease) {
            await lease.release();
            throw adapterError("OWNERSHIP", "Codex supervisor returned an invalid lease");
          }
          if (!this.isAvailable()) {
            await lease.release();
            throw adapterError(
              this.disposed ? "DISPOSED" : "DISABLED",
              this.disposed ? "Codex native adapter is disposed" : "Native Codex is disabled",
            );
          }
          this.lease = lease;
          if (!this.adoptGeneration(lease.generation)) {
            this.lease = null;
            await lease.release();
            throw adapterError("DISABLED", "Stale Codex lease generation was rejected");
          }
          return lease;
        })
        .catch((error) => {
          this.leasePromise = null;
          throw error;
        });
    }
    return this.leasePromise;
  }

  private assertHome(home: string): string {
    this.assertAvailable();
    let canonical: string;
    try { canonical = canonicalizeProviderHome(home); } catch (cause) {
      throw adapterError("INVALID_INPUT", "Provider home is invalid", { cause });
    }
    if (canonical !== this.home) throw adapterError("OWNERSHIP", "Provider home does not belong to this adapter");
    return canonical;
  }

  private assertKey(key: NativeTaskKey): Readonly<NativeTaskKey> {
    this.assertAvailable();
    let owned: Readonly<NativeTaskKey>;
    try { owned = createNativeTaskKey(key.provider, key.home, key.nativeTaskId); } catch (cause) {
      throw adapterError("INVALID_INPUT", "Native task key is invalid", { cause });
    }
    const expected = createNativeTaskKey("openai", this.home, owned.nativeTaskId);
    if (nativeTaskKeyId(owned) !== nativeTaskKeyId(expected)) {
      throw adapterError("OWNERSHIP", "Native task does not belong to this adapter");
    }
    return expected;
  }

  private nativeId(value: string, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() ||
      value.length > 512 || value.includes("\u0000")) {
      throw adapterError("INVALID_INPUT", `${label} is invalid`);
    }
    return value;
  }

  private isAvailable(): boolean {
    if (this.disposed || this.suspended || !this.flagEnabled()) return false;
    // A durable-store read/write fault latches the wrapper permanently
    // unavailable; the whole unified runtime then fails closed.
    if (this.reconciliationStore?.unavailable === true) return false;
    return true;
  }

  private flagEnabled(): boolean {
    try { return this.isEnabledFn() === true; } catch { return false; }
  }

  private adoptGeneration(generation: number): boolean {
    if (!Number.isSafeInteger(generation) || generation < 1) return false;
    if (this.activeGeneration !== null && generation < this.activeGeneration) return false;
    if (this.activeGeneration === generation) return true;
    if (this.activeGeneration !== null) {
      this.broker.cancelGeneration(this.home, this.activeGeneration);
      this.streamingSecrets.cancelGeneration(this.activeGeneration);
    }
    this.activeGeneration = generation;
    return true;
  }

  private assertAvailable(): void {
    if (this.disposed) throw adapterError("DISPOSED", "Codex native adapter is disposed");
    if (!this.isAvailable()) throw adapterError("DISABLED", "Native Codex is disabled");
  }

  private async disposeImpl(): Promise<void> {
    this.broker.close();
    this.streamingSecrets.close();
    try { await this.refreshChain; } catch { /* shutdown still releases retained resources */ }
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    let lease = this.lease;
    if (lease === null && this.leasePromise !== null) {
      try { lease = await this.leasePromise; } catch { lease = null; }
    }
    if (lease !== null) {
      await Promise.all(subscriptions.map(async (state) => {
        try {
          if (state.closePromise !== null) await state.closePromise;
          else await lease!.call("thread/unsubscribe", { threadId: state.key.nativeTaskId });
        } catch { /* best effort */ }
      }));
      await lease.release();
    }
    this.lease = null;
    this.leasePromise = null;
    this.taskPolicies.clear();
  }

  private taskPolicy(nativeTaskId: string): Readonly<TaskExecutionPolicy> {
    const policy = this.taskPolicies.get(nativeTaskId);
    if (!policy) return Object.freeze({ mode: "read-only" as const });
    this.taskPolicies.delete(nativeTaskId);
    this.taskPolicies.set(nativeTaskId, policy);
    return policy;
  }

  private rememberTaskPolicy(nativeTaskId: string, policy: TaskExecutionPolicy): void {
    this.taskPolicies.delete(nativeTaskId);
    while (this.taskPolicies.size >= MAX_TRACKED_TASK_POLICIES) {
      const oldest = this.taskPolicies.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.taskPolicies.delete(oldest);
    }
    this.taskPolicies.set(nativeTaskId, Object.freeze({ ...policy }));
  }

  private async suspendLease(): Promise<void> {
    const generation = this.activeGeneration;
    if (generation !== null) {
      this.broker.cancelGeneration(this.home, generation);
      this.streamingSecrets.cancelGeneration(generation);
    }
    const lease = this.lease;
    const pending = this.leasePromise;
    this.lease = null;
    this.leasePromise = null;
    this.activeGeneration = null;
    let acquired = lease;
    if (acquired === null && pending !== null) {
      try { acquired = await pending; } catch { acquired = null; }
    }
    if (acquired !== null) await acquired.release();
  }
}
