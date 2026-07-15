import type {
  JsonRpcRequestId,
  ListTasksInput,
  NativeRevision,
  NativeTask,
  NativeTaskKey,
  NativeTaskSource,
  NativeTaskSummary,
  NativeTurn,
  NativeTurnRef,
  Page,
  ProviderCapabilities,
  ProviderDescriptorCensus,
  ProviderEvent,
  ProviderEventSink,
  ProviderId,
  ProviderRequestIdentity,
  ProviderRequestResponse,
  ProviderResponseDispatchResult,
  StartTaskInput,
  TaskOverrides,
  UserInput,
} from "@devhub/engine/providers";
import { getToken, UnauthorizedError } from "./api.js";

export type {
  JsonRpcRequestId,
  ListTasksInput,
  NativeRevision,
  NativeTask,
  NativeTaskKey,
  NativeTaskSource,
  NativeTaskSummary,
  NativeTurn,
  NativeTurnRef,
  Page,
  ProviderCapabilities,
  ProviderDescriptorCensus,
  ProviderEvent,
  ProviderEventSink,
  ProviderId,
  ProviderRequest,
  ProviderRequestIdentity,
  ProviderRequestResponse,
  ProviderResponseDispatchResult,
  StartTaskInput,
  TaskOverrides,
  UserInput,
} from "@devhub/engine/providers";

const JSON_ACCEPT = "application/json";
const SSE_ACCEPT = "text/event-stream";

const REST_LIMITS = Object.freeze({
  descriptors: 256 * 1_024,
  list: 2 * 1_024 * 1_024,
  task: 16 * 1_024 * 1_024,
  turnRef: 64 * 1_024,
  responseStatus: 16 * 1_024,
  error: 32 * 1_024,
});

const MAX_PROVIDER_DESCRIPTORS = 128;
const MAX_PROVIDER_LIST_ITEMS = 200;
const MAX_NATIVE_TURNS = 10_000;
const MAX_TURN_EVENTS = 50_000;
const MAX_NATIVE_ID_CHARS = 512;
const MAX_CURSOR_CHARS = 8_192;
const MAX_HOME_CHARS = 4_096;
const MAX_DIAGNOSTIC_KEYS = 32;
const MAX_PLAN_STEP_INDEX = Number.MAX_SAFE_INTEGER;
const MIN_AUTO_RESOLUTION_MS = 60_000;
const MAX_AUTO_RESOLUTION_MS = 240_000;

const MAX_SSE_EVENT_BYTES = 256 * 1_024;
const MAX_SSE_FRAME_BYTES = MAX_SSE_EVENT_BYTES + 1_024;
const MAX_SSE_FRAMES_PER_TURN = 64;

const MAX_UNCERTAIN_HOME_SCOPES = 64;
const MAX_UNCERTAIN_TASK_SCOPES = 512;
const TASK_STATE_UNCERTAIN = 1;
const TASK_POLICY_UNVERIFIED = 2;

const CAPABILITY_KEYS = [
  "list",
  "read",
  "start",
  "resume",
  "fork",
  "send",
  "steer",
  "interrupt",
  "subscribe",
  "approveCommand",
  "approveFileChange",
  "approvePermissions",
  "requestUserInput",
  "mcpElicitation",
  "archive",
  "rename",
  "skills",
  "plugins",
  "hooks",
  "mcp",
  "backgroundWork",
] as const satisfies readonly (keyof ProviderCapabilities)[];

const SAFE_PROVIDER_ERROR_CODES = new Set([
  "PROVIDER_ADAPTER_FAILURE",
  "PROVIDER_ADAPTER_NOT_FOUND",
  "PROVIDER_CAPABILITY_UNAVAILABLE",
  "INVALID_INPUT",
  "UNSAFE_OVERRIDE",
  "POLICY_MISMATCH",
  "MUTATION_UNCERTAIN",
  "NATIVE_TASK_MISSING",
  "RECONCILIATION_REQUIRED",
  "UNSUPPORTED_INTERACTION",
  "SUBSCRIPTION_CAPACITY",
  "DISABLED",
  "DISPOSED",
  "OWNERSHIP",
  "provider_not_found",
  "invalid_provider_request",
  "provider_capability_unavailable",
  "provider_invalid_request",
  "provider_policy_mismatch",
  "provider_mutation_uncertain",
  "provider_task_not_found",
  "provider_reconciliation_required",
  "provider_interaction_unavailable",
  "provider_capacity_reached",
  "provider_runtime_disabled",
  "provider_unavailable",
  "provider_request_failed",
  "provider_mutations_disabled",
  "provider_stream_limit_reached",
  "provider_stream_overloaded",
  "unauthorized",
]);

type PartialCode = "PARTIAL_START" | "PARTIAL_FORK";
type ProviderEndpointLabel =
  | "provider discovery"
  | "provider task list"
  | "provider task read"
  | "provider task start"
  | "provider task resume"
  | "provider task fork"
  | "provider task send"
  | "provider task steer"
  | "provider task interrupt"
  | "provider request response"
  | "provider task archive"
  | "provider task rename"
  | "provider task reconciliation"
  | "provider event stream";

export type ProviderCreateOutcome =
  | { outcome: "created"; task: NativeTask }
  | {
      outcome: "partial";
      code: PartialCode;
      provider: ProviderId;
      task: NativeTask;
    };

export interface ProviderListTasksInput extends ListTasksInput {
  provider: ProviderId;
}

export interface ProviderSubscribeOptions {
  signal?: AbortSignal;
  onError?: (error: ProviderStreamError) => void;
}

export interface ProviderReadOptions {
  signal?: AbortSignal;
}

export interface ProviderEventSubscription {
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  unsubscribe(): Promise<void>;
}

export type ProviderReconciliationTarget =
  | { scope: "provider-home"; provider: ProviderId; home: string }
  | { scope: "task"; key: NativeTaskKey; fingerprint: string };

export interface ProviderApiClient {
  providers(): Promise<readonly ProviderDescriptorCensus[]>;
  list(input: ProviderListTasksInput): Promise<Page<NativeTaskSummary>>;
  read(
    key: NativeTaskKey,
    includeTurns?: boolean,
    options?: ProviderReadOptions,
  ): Promise<NativeTask>;
  start(provider: ProviderId, input: StartTaskInput): Promise<ProviderCreateOutcome>;
  resume(key: NativeTaskKey, overrides?: TaskOverrides): Promise<NativeTask>;
  fork(key: NativeTaskKey, lastTurnId?: string): Promise<ProviderCreateOutcome>;
  send(key: NativeTaskKey, input: UserInput): Promise<NativeTurnRef>;
  steer(key: NativeTaskKey, expectedTurnId: string, input: UserInput): Promise<void>;
  interrupt(key: NativeTaskKey, turnId: string): Promise<void>;
  respond(response: ProviderRequestResponse): Promise<ProviderResponseDispatchResult>;
  archive(key: NativeTaskKey): Promise<void>;
  rename(key: NativeTaskKey, name: string): Promise<void>;
  acknowledgeReconciliation(target: ProviderReconciliationTarget): Promise<void>;
  subscribe(
    key: NativeTaskKey,
    sink: ProviderEventSink,
    options?: ProviderSubscribeOptions,
  ): Promise<ProviderEventSubscription>;
}

export class ProviderHttpError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly endpoint: ProviderEndpointLabel,
  ) {
    super(`Provider ${endpoint} request failed`);
    this.name = "ProviderHttpError";
    this.retryable = status === 0 || status === 408 || status === 425 ||
      status === 429 || status >= 500;
  }
}

export type ProviderProtocolErrorCode =
  | "INVALID_JSON_RESPONSE"
  | "INVALID_PARTIAL_OUTCOME"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE";

export class ProviderProtocolError extends Error {
  constructor(
    readonly code: ProviderProtocolErrorCode,
    message = "Provider response was invalid",
  ) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

export class ProviderMutationUncertainError extends Error {
  readonly code = "MUTATION_UNCERTAIN";
  readonly retryable = false;

  constructor() {
    super("Provider mutation outcome is uncertain");
    this.name = "ProviderMutationUncertainError";
  }
}

export class ProviderReconciliationRequiredError extends Error {
  readonly code = "RECONCILIATION_REQUIRED";
  readonly retryable = false;

  constructor(
    readonly scope: "provider-home" | "task" | "task-policy",
    readonly canAcknowledge = false,
  ) {
    super("Provider state must be reconciled before another mutation");
    this.name = "ProviderReconciliationRequiredError";
  }
}

export function isProviderReconciliationRequired(
  value: unknown,
): value is ProviderReconciliationRequiredError {
  return value instanceof ProviderReconciliationRequiredError ||
    (isRecord(value) && value.code === "RECONCILIATION_REQUIRED");
}

export type ProviderStreamErrorCode =
  | "SSE_CONTENT_TYPE"
  | "SSE_BODY_MISSING"
  | "SSE_BUFFER_LIMIT"
  | "SSE_EVENT_LIMIT"
  | "SSE_INVALID_JSON"
  | "SSE_INVALID_EVENT"
  | "SSE_READ_FAILED";

export class ProviderStreamError extends Error {
  constructor(
    readonly code: ProviderStreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderStreamError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function invalidResponse(): ProviderProtocolError {
  return new ProviderProtocolError("INVALID_RESPONSE");
}

function authHeaders(accept: string, jsonBody = false): Record<string, string> {
  const headers: Record<string, string> = { accept };
  if (jsonBody) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function providerPath(provider: ProviderId): string {
  return `/api/providers/${encodeURIComponent(provider)}`;
}

function taskPath(key: NativeTaskKey): string {
  return `${providerPath(key.provider)}/tasks/${encodeURIComponent(key.nativeTaskId)}`;
}

function query(entries: readonly (readonly [string, string | undefined])[]): string {
  const params = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value !== undefined) params.set(name, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function safeProvider(value: unknown): value is ProviderId {
  return value === "openai" || value === "anthropic";
}

function safeText(value: unknown, max = Number.MAX_SAFE_INTEGER): value is string {
  return typeof value === "string" && value.length <= max;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= MAX_NATIVE_ID_CHARS && !value.includes("\u0000");
}

function safeCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_CURSOR_CHARS && !value.includes("\u0000");
}

function nullableId(value: unknown): value is string | null {
  return value === null || safeId(value);
}

function safeHome(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= MAX_HOME_CHARS && !value.includes("\u0000");
}

function nullableDate(value: unknown): value is string | null {
  return value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function safeCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= max;
}

function rpcId(value: unknown, nullable: boolean): value is JsonRpcRequestId | null {
  if (value === null) return nullable;
  return typeof value === "number" ? Number.isSafeInteger(value) : safeId(value);
}

function parseKey(value: unknown, expected?: NativeTaskKey): NativeTaskKey {
  if (!hasExactKeys(value, ["provider", "home", "nativeTaskId"]) ||
    !safeProvider(value.provider) || !safeHome(value.home) || !safeId(value.nativeTaskId)) {
    throw invalidResponse();
  }
  if (expected && (
    value.provider !== expected.provider ||
    value.home !== expected.home ||
    value.nativeTaskId !== expected.nativeTaskId
  )) throw invalidResponse();
  return {
    provider: value.provider,
    home: value.home,
    nativeTaskId: value.nativeTaskId,
  };
}

function parseIdentity(value: unknown, expected: NativeTaskKey): ProviderRequestIdentity {
  if (!hasExactKeys(value, [
    "key",
    "generation",
    "turnId",
    "requestId",
    "itemId",
    "approvalId",
  ])) throw invalidResponse();
  const generation = value.generation;
  if (!(generation === null || safeCount(generation)) ||
    !nullableId(value.turnId) || !rpcId(value.requestId, false) ||
    !nullableId(value.itemId) || !rpcId(value.approvalId, true)) {
    throw invalidResponse();
  }
  return {
    key: parseKey(value.key, expected),
    generation,
    turnId: value.turnId,
    requestId: value.requestId,
    itemId: value.itemId,
    approvalId: value.approvalId,
  } as ProviderRequestIdentity;
}

function parseRevision(value: unknown): NativeRevision {
  if (!hasExactKeys(value, [
    "updatedAt",
    "status",
    "lastTurnId",
    "lastTurnStatus",
    "lastItemId",
    "fingerprint",
  ]) ||
    !(value.updatedAt === null || safeCount(value.updatedAt)) ||
    !safeText(value.status, 256) || !nullableId(value.lastTurnId) ||
    !(value.lastTurnStatus === null || safeText(value.lastTurnStatus, 256)) ||
    !nullableId(value.lastItemId) || !safeText(value.fingerprint, 512)) {
    throw invalidResponse();
  }
  return {
    updatedAt: value.updatedAt,
    status: value.status,
    lastTurnId: value.lastTurnId,
    lastTurnStatus: value.lastTurnStatus,
    lastItemId: value.lastItemId,
    fingerprint: value.fingerprint,
  };
}

function parseSummary(
  value: unknown,
  provider: ProviderId,
  home: string,
  nativeTaskId?: string,
  withTurns = false,
): NativeTaskSummary {
  const required = [
    "key",
    "title",
    "cwd",
    "model",
    "status",
    "createdAt",
    "updatedAt",
    "archived",
    "source",
    ...(withTurns ? ["turns"] : []),
  ];
  if (!hasExactKeys(value, required, ["revision"])) throw invalidResponse();
  const expected = nativeTaskId === undefined
    ? undefined
    : { provider, home, nativeTaskId } satisfies NativeTaskKey;
  const key = parseKey(value.key, expected);
  if (key.provider !== provider || key.home !== home ||
    !safeText(value.title, 4_096) ||
    !(value.cwd === null || safeText(value.cwd, MAX_HOME_CHARS)) ||
    !(value.model === null || safeText(value.model, 256)) ||
    !safeText(value.status, 256) || !nullableDate(value.createdAt) ||
    !nullableDate(value.updatedAt) ||
    !(value.archived === null || typeof value.archived === "boolean") ||
    !(value.source === "native" || value.source === "legacy-history" ||
      value.source === "degraded-fallback")) {
    throw invalidResponse();
  }
  const summary: NativeTaskSummary = {
    key,
    title: value.title,
    cwd: value.cwd,
    model: value.model,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archived: value.archived,
    source: value.source as NativeTaskSource,
    ...(value.revision === undefined ? {} : { revision: parseRevision(value.revision) }),
  };
  return summary;
}

function parseEventBase(
  value: Record<string, unknown>,
  expected: NativeTaskKey,
): { provider: ProviderId; key: NativeTaskKey; occurredAt: string } {
  if (value.provider !== expected.provider ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt))) throw invalidResponse();
  return {
    provider: expected.provider,
    key: parseKey(value.key, expected),
    occurredAt: value.occurredAt,
  };
}

function parseProviderEvent(value: unknown, expected: NativeTaskKey): ProviderEvent {
  if (!isRecord(value) || typeof value.type !== "string") throw invalidResponse();
  const common = ["type", "provider", "key", "occurredAt"];
  const base = parseEventBase(value, expected);
  switch (value.type) {
    case "message":
      if (!hasExactKeys(value, [...common, "role", "text", "turnId", "itemId"]) ||
        !(value.role === "user" || value.role === "assistant" || value.role === "system") ||
        !safeText(value.text) || !nullableId(value.turnId) || !nullableId(value.itemId)) {
        throw invalidResponse();
      }
      return { ...base, type: value.type, role: value.role, text: value.text, turnId: value.turnId, itemId: value.itemId };
    case "message-delta":
      if (!hasExactKeys(value, [...common, "role", "delta", "turnId", "itemId"]) ||
        !(value.role === "user" || value.role === "assistant" || value.role === "system") ||
        !safeText(value.delta) || !nullableId(value.turnId) || !nullableId(value.itemId)) {
        throw invalidResponse();
      }
      return { ...base, type: value.type, role: value.role, delta: value.delta, turnId: value.turnId, itemId: value.itemId };
    case "plan":
      if (!hasExactKeys(value, [...common, "turnId", "itemId", "stepIndex", "text", "status"]) ||
        !nullableId(value.turnId) || !nullableId(value.itemId) ||
        !(value.stepIndex === null || safeCount(value.stepIndex, MAX_PLAN_STEP_INDEX)) ||
        !safeText(value.text) || !safeText(value.status, 256)) throw invalidResponse();
      return {
        ...base,
        type: value.type,
        turnId: value.turnId,
        itemId: value.itemId,
        stepIndex: value.stepIndex,
        text: value.text,
        status: value.status,
      };
    case "activity":
      if (!hasExactKeys(value, [...common, "turnId", "itemId", "activity", "status", "message"]) ||
        !nullableId(value.turnId) || !nullableId(value.itemId) ||
        !safeText(value.activity, 256) || !safeText(value.status, 256) ||
        !(value.message === null || safeText(value.message))) throw invalidResponse();
      return {
        ...base,
        type: value.type,
        turnId: value.turnId,
        itemId: value.itemId,
        activity: value.activity,
        status: value.status,
        message: value.message,
      };
    case "diff-summary":
      if (!hasExactKeys(value, [...common, "turnId", "changedFiles", "additions", "deletions"]) ||
        !nullableId(value.turnId) || !safeCount(value.changedFiles) ||
        !safeCount(value.additions) || !safeCount(value.deletions)) throw invalidResponse();
      return {
        ...base,
        type: value.type,
        turnId: value.turnId,
        changedFiles: value.changedFiles,
        additions: value.additions,
        deletions: value.deletions,
      };
    case "usage":
      if (!hasExactKeys(value, [...common, "turnId", "inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"]) ||
        !nullableId(value.turnId) || !safeCount(value.inputTokens) ||
        !safeCount(value.outputTokens) || !safeCount(value.cachedInputTokens) ||
        !safeCount(value.totalTokens)) throw invalidResponse();
      return {
        ...base,
        type: value.type,
        turnId: value.turnId,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        cachedInputTokens: value.cachedInputTokens,
        totalTokens: value.totalTokens,
      };
    case "status":
      if (!hasExactKeys(value, [...common, "scope", "status", "nativeId"]) ||
        !(value.scope === "task" || value.scope === "turn" || value.scope === "item") ||
        !safeText(value.status, 256) || !nullableId(value.nativeId) ||
        (value.scope === "task" && value.nativeId !== expected.nativeTaskId)) {
        throw invalidResponse();
      }
      return { ...base, type: value.type, scope: value.scope, status: value.status, nativeId: value.nativeId };
    case "request": {
      if (!hasExactKeys(value, [...common, "request"]) || !isRecord(value.request)) {
        throw invalidResponse();
      }
      const request = value.request;
      const requestIdentity = parseIdentity(request.identity, expected);
      switch (request.kind) {
        case "command-approval":
        case "file-change-approval":
        case "mcp-elicitation":
        case "permission":
          if (!hasExactKeys(request, ["kind", "identity"])) throw invalidResponse();
          return { ...base, type: value.type, request: { kind: request.kind, identity: requestIdentity } };
        case "user-input":
          if (!hasExactKeys(request, ["kind", "identity", "autoResolutionMs"]) ||
            !(request.autoResolutionMs === null ||
              safeCount(request.autoResolutionMs, MAX_AUTO_RESOLUTION_MS) &&
              request.autoResolutionMs >= MIN_AUTO_RESOLUTION_MS)) throw invalidResponse();
          return {
            ...base,
            type: value.type,
            request: {
              kind: request.kind,
              identity: requestIdentity,
              autoResolutionMs: request.autoResolutionMs,
            },
          };
        default:
          throw invalidResponse();
      }
    }
    case "request-resolved":
      if (!hasExactKeys(value, [...common, "identity"])) throw invalidResponse();
      return { ...base, type: value.type, identity: parseIdentity(value.identity, expected) };
    case "diagnostic":
      if (!hasExactKeys(value, [...common, "level", "code", "message", "method", "shapeKeys"]) ||
        !(value.level === "warning" || value.level === "error") ||
        !safeText(value.code, 64) || !/^[A-Z][A-Z0-9_]*$/.test(value.code) ||
        !safeText(value.message) || !(value.method === null || safeText(value.method, 256)) ||
        !Array.isArray(value.shapeKeys) || value.shapeKeys.length > MAX_DIAGNOSTIC_KEYS ||
        !value.shapeKeys.every((key) => safeText(key, 64))) throw invalidResponse();
      return {
        ...base,
        type: value.type,
        level: value.level,
        code: value.code,
        message: value.message,
        method: value.method,
        shapeKeys: [...value.shapeKeys] as string[],
      };
    default:
      throw invalidResponse();
  }
}

function assertHistoryEventOwnership(
  event: ProviderEvent,
  key: NativeTaskKey,
  turnId: string,
): void {
  if (event.type === "diagnostic") return;
  if (event.type === "status") {
    if (event.scope === "task" && event.nativeId !== key.nativeTaskId) throw invalidResponse();
    if (event.scope === "turn" && event.nativeId !== turnId) throw invalidResponse();
    return;
  }
  const ownedTurnId = event.type === "request"
    ? event.request.identity.turnId
    : event.type === "request-resolved"
    ? event.identity.turnId
    : event.turnId;
  if (ownedTurnId !== turnId) throw invalidResponse();
}

function parseTurn(value: unknown, expected: NativeTaskKey): NativeTurn {
  if (!hasExactKeys(value, ["id", "status", "startedAt", "completedAt", "events"]) ||
    !safeId(value.id) || !safeText(value.status, 256) ||
    !nullableDate(value.startedAt) || !nullableDate(value.completedAt) ||
    !Array.isArray(value.events) || value.events.length > MAX_TURN_EVENTS) {
    throw invalidResponse();
  }
  const events = value.events.map((event) => parseProviderEvent(event, expected));
  for (const event of events) assertHistoryEventOwnership(event, expected, value.id);
  return {
    id: value.id,
    status: value.status,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    events,
  };
}

function parseTask(
  value: unknown,
  provider: ProviderId,
  home: string,
  nativeTaskId?: string,
): NativeTask {
  const summary = parseSummary(value, provider, home, nativeTaskId, true);
  if (!isRecord(value) || !Array.isArray(value.turns) || value.turns.length > MAX_NATIVE_TURNS) {
    throw invalidResponse();
  }
  const turns = value.turns.map((turn) => parseTurn(turn, summary.key));
  const ids = new Set<string>();
  for (const turn of turns) {
    if (ids.has(turn.id)) throw invalidResponse();
    ids.add(turn.id);
  }
  return { ...summary, turns };
}

function parseCapabilities(value: unknown): ProviderCapabilities {
  if (!hasExactKeys(value, CAPABILITY_KEYS)) throw invalidResponse();
  const result = {} as ProviderCapabilities;
  for (const key of CAPABILITY_KEYS) {
    if (typeof value[key] !== "boolean") throw invalidResponse();
    result[key] = value[key];
  }
  return result;
}

function parseDescriptors(value: unknown): readonly ProviderDescriptorCensus[] {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_DESCRIPTORS) throw invalidResponse();
  const seen = new Set<string>();
  return value.map((entry): ProviderDescriptorCensus => {
    if (!isRecord(entry) || !safeProvider(entry.provider) || !safeHome(entry.home)) {
      throw invalidResponse();
    }
    const id = `${entry.provider}\u0000${entry.home}`;
    if (seen.has(id)) throw invalidResponse();
    seen.add(id);
    if (entry.status === "available") {
      if (!hasExactKeys(entry, ["provider", "home", "status", "capabilities"])) {
        throw invalidResponse();
      }
      return {
        provider: entry.provider,
        home: entry.home,
        status: entry.status,
        capabilities: parseCapabilities(entry.capabilities),
      };
    }
    if (entry.status === "unavailable") {
      if (!hasExactKeys(entry, ["provider", "home", "status", "error"]) ||
        !hasExactKeys(entry.error, ["code", "message"]) ||
        entry.error.code !== "PROVIDER_ADAPTER_FAILURE" ||
        !safeText(entry.error.message, 512)) throw invalidResponse();
      return {
        provider: entry.provider,
        home: entry.home,
        status: entry.status,
        error: {
          code: "PROVIDER_ADAPTER_FAILURE",
          message: "Provider adapter unavailable",
        },
      };
    }
    throw invalidResponse();
  });
}

function parsePage(
  value: unknown,
  provider: ProviderId,
  home: string,
): Page<NativeTaskSummary> {
  if (!hasExactKeys(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) || value.items.length > MAX_PROVIDER_LIST_ITEMS ||
    !(value.nextCursor === null || safeCursor(value.nextCursor))) throw invalidResponse();
  const items = value.items.map((item) => parseSummary(item, provider, home));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key.nativeTaskId)) throw invalidResponse();
    seen.add(item.key.nativeTaskId);
  }
  return { items, nextCursor: value.nextCursor };
}

function parseTurnRef(value: unknown, expected: NativeTaskKey): NativeTurnRef {
  if (!hasExactKeys(value, ["taskKey", "turnId"]) || !safeId(value.turnId)) {
    throw invalidResponse();
  }
  return { taskKey: parseKey(value.taskKey, expected), turnId: value.turnId };
}

function parseResponseStatus(value: unknown): ProviderResponseDispatchResult {
  if (!hasExactKeys(value, ["status"]) ||
    !(value.status === "dispatched" || value.status === "stale")) throw invalidResponse();
  return value.status;
}

function parseCreateOutcome(
  value: unknown,
  expectedCode: PartialCode,
  provider: ProviderId,
  home: string,
  sourceTaskId?: string,
): ProviderCreateOutcome {
  if (isRecord(value) && value.outcome === "partial") {
    if (!hasExactKeys(value, ["outcome", "code", "provider", "task"]) ||
      value.code !== expectedCode || value.provider !== provider) throw invalidResponse();
    const task = parseTask(value.task, provider, home);
    if (sourceTaskId !== undefined && task.key.nativeTaskId === sourceTaskId) {
      throw invalidResponse();
    }
    return { outcome: "partial", code: expectedCode, provider, task };
  }
  const task = parseTask(value, provider, home);
  if (sourceTaskId !== undefined && task.key.nativeTaskId === sourceTaskId) {
    throw invalidResponse();
  }
  return { outcome: "created", task };
}

function checkedContentLength(response: Response, limit: number): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw invalidResponse();
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw invalidResponse();
  if (length > limit) {
    throw new ProviderProtocolError("RESPONSE_TOO_LARGE", "Provider response exceeded its limit");
  }
  return length;
}

function hasExactMediaType(response: Response, expected: string): boolean {
  const value = response.headers.get("content-type");
  if (value === null) return false;
  return value.split(";", 1)[0]!.trim().toLowerCase() === expected;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be locked, closed, or cancelled by fetch.
  }
}

async function readBoundedJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  let declaredLength: number | null;
  try {
    declaredLength = checkedContentLength(response, limit);
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
  if (!hasExactMediaType(response, JSON_ACCEPT)) {
    await cancelResponseBody(response);
    throw invalidResponse();
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const initialCapacity = Math.max(1, Math.min(limit, declaredLength ?? 8 * 1_024));
  let bytes = new Uint8Array(initialCapacity);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > limit) {
        await reader.cancel();
        throw new ProviderProtocolError(
          "RESPONSE_TOO_LARGE",
          "Provider response exceeded its limit",
        );
      }
      const required = length + chunk.value.byteLength;
      if (required > bytes.byteLength) {
        let capacity = bytes.byteLength;
        while (capacity < required) capacity = Math.min(limit, Math.max(capacity * 2, required));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(chunk.value, length);
      length = required;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the bounded read error.
    }
    throw error;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderProtocolError("INVALID_JSON_RESPONSE", "Provider response was not valid JSON");
  }
}

interface SafeProviderErrorDetails {
  readonly code: string | null;
  readonly error: string | null;
}

async function safeErrorDetails(response: Response): Promise<SafeProviderErrorDetails> {
  try {
    const value = await readBoundedJson(response, REST_LIMITS.error);
    if (!isRecord(value)) return { code: null, error: null };
    const code = typeof value.code === "string" && SAFE_PROVIDER_ERROR_CODES.has(value.code)
      ? value.code
      : null;
    const error = typeof value.error === "string" && SAFE_PROVIDER_ERROR_CODES.has(value.error)
      ? value.error
      : null;
    return { code, error };
  } catch {
    // Status and endpoint label remain sufficient; the body is never reflected.
  }
  return { code: null, error: null };
}

async function safeErrorCode(response: Response): Promise<string | null> {
  const details = await safeErrorDetails(response);
  return details.code ?? details.error;
}

async function responseError(
  response: Response,
  endpoint: ProviderEndpointLabel,
): Promise<Error> {
  if (response.status === 401) {
    await cancelResponseBody(response);
    return new UnauthorizedError(endpoint);
  }
  return new ProviderHttpError(response.status, await safeErrorCode(response), endpoint);
}

async function rejectMutationResponse(
  response: Response,
  endpoint: ProviderEndpointLabel,
  markUncertain: () => void,
  markPolicyUnverified: () => void,
): Promise<never> {
  if (response.status >= 500 || response.status === 408) {
    await cancelResponseBody(response);
    markUncertain();
    throw new ProviderMutationUncertainError();
  }
  if (response.status === 401) throw await responseError(response, endpoint);
  const details = await safeErrorDetails(response);
  if (response.status === 409 &&
    details.code === "MUTATION_UNCERTAIN" &&
    details.error === "provider_mutation_uncertain") {
    markUncertain();
    throw new ProviderMutationUncertainError();
  }
  if (response.status === 409 &&
    details.code === "RECONCILIATION_REQUIRED" &&
    details.error === "provider_reconciliation_required") {
    markUncertain();
    const scope = endpoint === "provider task start" || endpoint === "provider task fork"
      ? "provider-home"
      : "task";
    throw new ProviderReconciliationRequiredError(scope);
  }
  if (response.status === 409 &&
    details.code === "POLICY_MISMATCH" &&
    details.error === "provider_policy_mismatch") {
    markPolicyUnverified();
  }
  throw new ProviderHttpError(response.status, details.code ?? details.error, endpoint);
}

async function getValidated<T>(
  url: string,
  endpoint: ProviderEndpointLabel,
  limit: number,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: authHeaders(JSON_ACCEPT),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    throw new ProviderHttpError(0, null, endpoint);
  }
  if (!response.ok) throw await responseError(response, endpoint);
  return parse(await readBoundedJson(response, limit));
}

async function mutationResponse<T>(
  url: string,
  endpoint: ProviderEndpointLabel,
  body: unknown,
  expectedStatus: number,
  limit: number,
  parse: (value: unknown) => T,
  markUncertain: () => void,
  markPolicyUnverified: () => void = markUncertain,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(JSON_ACCEPT, true),
      body: JSON.stringify(body),
    });
  } catch {
    markUncertain();
    throw new ProviderMutationUncertainError();
  }
  if (!response.ok) {
    await rejectMutationResponse(response, endpoint, markUncertain, markPolicyUnverified);
  }
  try {
    if (response.status !== expectedStatus) throw invalidResponse();
    return parse(await readBoundedJson(response, limit));
  } catch {
    markUncertain();
    throw new ProviderMutationUncertainError();
  }
}

async function mutationVoid(
  url: string,
  endpoint: ProviderEndpointLabel,
  body: unknown,
  markUncertain: () => void,
  markPolicyUnverified: () => void = markUncertain,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(JSON_ACCEPT, true),
      body: JSON.stringify(body),
    });
  } catch {
    markUncertain();
    throw new ProviderMutationUncertainError();
  }
  if (!response.ok) {
    await rejectMutationResponse(response, endpoint, markUncertain, markPolicyUnverified);
  }
  if (response.status !== 204) {
    await cancelResponseBody(response);
    markUncertain();
    throw new ProviderMutationUncertainError();
  }
}

function homeScope(provider: ProviderId, home: string): string {
  return `${provider}\u0000${home}`;
}

function taskScope(key: NativeTaskKey): string {
  return `${key.provider}\u0000${key.home}\u0000${key.nativeTaskId}`;
}

function pickOverrides(overrides?: TaskOverrides): TaskOverrides {
  if (!overrides) return {};
  return {
    ...(typeof overrides.model === "string" ? { model: overrides.model } : {}),
    ...(typeof overrides.mode === "string" ? { mode: overrides.mode } : {}),
    ...(typeof overrides.permissionMode === "string"
      ? { permissionMode: overrides.permissionMode }
      : {}),
  };
}

function safeDiagnosticFromSse(error: unknown): ProviderStreamError {
  if (error instanceof ProviderStreamError) return error;
  if (error instanceof ProviderProtocolError) {
    return new ProviderStreamError("SSE_INVALID_EVENT", "Provider SSE event was invalid");
  }
  return new ProviderStreamError("SSE_READ_FAILED", "Provider SSE read failed");
}

class IncrementalSseDecoder {
  private readonly line = new Uint8Array(MAX_SSE_FRAME_BYTES);
  private readonly data = new Uint8Array(MAX_SSE_EVENT_BYTES);
  private lineLength = 0;
  private frameBytes = 0;
  private pendingCr = false;
  private hasData = false;
  private dataLength = 0;
  private framesSinceYield = 0;

  constructor(
    private readonly key: NativeTaskKey,
    private readonly sink: ProviderEventSink,
    private readonly stopped: () => boolean,
  ) {}

  async push(chunk: Uint8Array): Promise<void> {
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (this.stopped()) return;
      const byte = chunk[index]!;
      if (this.pendingCr) {
        this.pendingCr = false;
        if (byte === 0x0a) continue;
      }
      this.frameBytes += 1;
      if (this.frameBytes > MAX_SSE_FRAME_BYTES) {
        throw new ProviderStreamError(
          "SSE_BUFFER_LIMIT",
          "Provider SSE frame exceeded its bounded buffer",
        );
      }
      if (byte === 0x0d) {
        await this.completeLine();
        this.pendingCr = true;
      } else if (byte === 0x0a) {
        await this.completeLine();
      } else {
        if (this.lineLength >= this.line.byteLength) {
          throw new ProviderStreamError(
            "SSE_BUFFER_LIMIT",
            "Provider SSE line exceeded its bounded buffer",
          );
        }
        this.line[this.lineLength] = byte;
        this.lineLength += 1;
      }
    }
  }

  async finish(): Promise<void> {
    if (this.lineLength > 0) await this.completeLine();
    if (this.hasData) {
      await this.dispatch();
      await this.yieldAfterFrame();
    }
    this.resetFrame();
  }

  private async completeLine(): Promise<void> {
    const length = this.lineLength;
    this.lineLength = 0;
    if (length === 0) {
      if (this.hasData) await this.dispatch();
      this.resetFrame();
      await this.yieldAfterFrame();
      return;
    }
    const dataField = length >= 4 &&
      this.line[0] === 0x64 && this.line[1] === 0x61 &&
      this.line[2] === 0x74 && this.line[3] === 0x61 &&
      (length === 4 || this.line[4] === 0x3a);
    if (!dataField) return;
    let start = length === 4 ? 4 : 5;
    if (start < length && this.line[start] === 0x20) start += 1;
    const partLength = length - start;
    const separatorBytes = this.hasData ? 1 : 0;
    if (this.dataLength + separatorBytes + partLength > MAX_SSE_EVENT_BYTES) {
      throw new ProviderStreamError("SSE_EVENT_LIMIT", "Provider SSE event exceeded its limit");
    }
    if (separatorBytes > 0) this.data[this.dataLength++] = 0x0a;
    this.data.set(this.line.subarray(start, length), this.dataLength);
    this.dataLength += partLength;
    this.hasData = true;
  }

  private async dispatch(): Promise<void> {
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        this.data.subarray(0, this.dataLength),
      );
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderStreamError("SSE_INVALID_JSON", "Provider SSE event was not valid JSON");
    }
    let event: ProviderEvent;
    try {
      event = parseProviderEvent(parsed, this.key);
    } catch (error) {
      throw safeDiagnosticFromSse(error);
    }
    this.sink(event);
  }

  private async yieldAfterFrame(): Promise<void> {
    this.framesSinceYield += 1;
    if (this.framesSinceYield >= MAX_SSE_FRAMES_PER_TURN) {
      this.framesSinceYield = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private resetFrame(): void {
    this.frameBytes = 0;
    this.hasData = false;
    this.dataLength = 0;
  }
}

async function subscribe(
  key: NativeTaskKey,
  sink: ProviderEventSink,
  options: ProviderSubscribeOptions = {},
): Promise<ProviderEventSubscription> {
  const url = `${taskPath(key)}/events${query([["home", key.home]])}`;
  const endpoint: ProviderEndpointLabel = "provider event stream";
  const controller = new AbortController();
  const externalSignal = options.signal;
  let stopOnExternalAbort: (() => void) | undefined;
  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
    stopOnExternalAbort?.();
  };
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: authHeaders(SSE_ACCEPT),
      signal: controller.signal,
    });
  } catch {
    const wasAborted = controller.signal.aborted;
    externalSignal?.removeEventListener("abort", onExternalAbort);
    controller.abort();
    if (wasAborted) throw new DOMException("The operation was aborted", "AbortError");
    throw new ProviderStreamError("SSE_READ_FAILED", "Provider stream request failed");
  }
  if (!response.ok) {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    const error = await responseError(response, endpoint);
    controller.abort();
    throw error;
  }
  if (!hasExactMediaType(response, SSE_ACCEPT)) {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    controller.abort();
    await cancelResponseBody(response);
    throw new ProviderStreamError("SSE_CONTENT_TYPE", "Provider stream was not SSE");
  }
  if (!response.body) {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    controller.abort();
    throw new ProviderStreamError("SSE_BODY_MISSING", "Provider stream had no response body");
  }

  const reader = response.body.getReader();
  let stopPromise: Promise<void> | null = null;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: ProviderStreamError) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const stop = (error?: ProviderStreamError, cancelReader = true): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      controller.abort();
      if (cancelReader) {
        try {
          await reader.cancel();
        } catch {
          // Cleanup is complete even if fetch already closed the body.
        }
      }
      if (error) {
        try {
          options.onError?.(error);
        } catch {
          // Observers cannot break stream cleanup.
        }
        rejectClosed(error);
      } else {
        resolveClosed();
      }
    })();
    return stopPromise;
  };
  stopOnExternalAbort = () => {
    void stop();
  };

  const decoder = new IncrementalSseDecoder(key, sink, () => controller.signal.aborted);
  const pump = async (): Promise<void> => {
    try {
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) {
          await decoder.finish();
          await stop(undefined, false);
          return;
        }
        await decoder.push(chunk.value);
      }
      await stop();
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ProviderStreamError)) {
        await stop();
        return;
      }
      await stop(safeDiagnosticFromSse(error));
    }
  };

  if (externalSignal?.aborted) void stop();
  else void pump();

  return {
    signal: controller.signal,
    closed,
    unsubscribe: () => stop(),
  };
}

export function createProviderApiClient(): ProviderApiClient {
  const uncertainHomes = new Set<string>();
  const taskBlocks = new Map<string, number>();
  const homeGenerations = new Map<string, number>();
  const taskGenerations = new Map<string, number>();
  const reviewedHomes = new Map<string, number>();
  const reviewedTasks = new Map<
    string,
    Readonly<{ generation: number; fingerprint: string }>
  >();
  const inFlightHomes = new Set<string>();
  const inFlightTasks = new Set<string>();
  let pendingNewTaskSlots = 0;
  let homeLedgerOverflow = false;
  let taskLedgerOverflow = false;
  let reconciliationGeneration = 0;

  const nextReconciliationGeneration = (): number => {
    if (reconciliationGeneration >= Number.MAX_SAFE_INTEGER) {
      homeLedgerOverflow = true;
      taskLedgerOverflow = true;
      return reconciliationGeneration;
    }
    reconciliationGeneration += 1;
    return reconciliationGeneration;
  };

  const requireHomeReady = (provider: ProviderId, home: string): void => {
    const scope = homeScope(provider, home);
    if (homeLedgerOverflow || uncertainHomes.has(scope)) {
      throw new ProviderReconciliationRequiredError(
        "provider-home",
        !homeLedgerOverflow &&
          reviewedHomes.get(scope) === homeGenerations.get(scope),
      );
    }
  };
  const requireTaskReady = (key: NativeTaskKey, allowPolicyRepair = false): void => {
    if (taskLedgerOverflow) {
      throw new ProviderReconciliationRequiredError("task");
    }
    const flags = taskBlocks.get(taskScope(key)) ?? 0;
    if ((flags & TASK_STATE_UNCERTAIN) !== 0) {
      const scope = taskScope(key);
      throw new ProviderReconciliationRequiredError(
        "task",
        reviewedTasks.get(scope)?.generation === taskGenerations.get(scope),
      );
    }
    if ((flags & TASK_POLICY_UNVERIFIED) !== 0 && !allowPolicyRepair) {
      throw new ProviderReconciliationRequiredError("task-policy");
    }
  };
  const markHome = (provider: ProviderId, home: string): void => {
    const scope = homeScope(provider, home);
    reviewedHomes.delete(scope);
    homeGenerations.set(scope, nextReconciliationGeneration());
    if (uncertainHomes.has(scope)) return;
    if (uncertainHomes.size >= MAX_UNCERTAIN_HOME_SCOPES) {
      homeLedgerOverflow = true;
      return;
    }
    uncertainHomes.add(scope);
  };
  const markTaskFlag = (key: NativeTaskKey, flag: number): void => {
    const scope = taskScope(key);
    if ((flag & TASK_STATE_UNCERTAIN) !== 0) {
      reviewedTasks.delete(scope);
      taskGenerations.set(scope, nextReconciliationGeneration());
    }
    const current = taskBlocks.get(scope);
    if (current !== undefined) {
      taskBlocks.set(scope, current | flag);
      return;
    }
    if (taskBlocks.size >= MAX_UNCERTAIN_TASK_SCOPES) {
      taskLedgerOverflow = true;
      return;
    }
    taskBlocks.set(scope, flag);
  };
  const clearTaskFlag = (key: NativeTaskKey, flag: number): void => {
    const scope = taskScope(key);
    const remaining = (taskBlocks.get(scope) ?? 0) & ~flag;
    if (remaining === 0) taskBlocks.delete(scope);
    else taskBlocks.set(scope, remaining);
    if ((flag & TASK_STATE_UNCERTAIN) !== 0) {
      taskGenerations.delete(scope);
      reviewedTasks.delete(scope);
    }
  };
  const acknowledgeReconciliation = async (
    target: ProviderReconciliationTarget,
  ): Promise<void> => {
    if (target.scope === "provider-home") {
      const scope = homeScope(target.provider, target.home);
      if (!uncertainHomes.has(scope) || !reviewedHomes.has(scope)) {
        throw new ProviderReconciliationRequiredError("provider-home", false);
      }
      if (reviewedHomes.get(scope) !== homeGenerations.get(scope)) {
        throw new ProviderReconciliationRequiredError("provider-home", false);
      }
      uncertainHomes.delete(scope);
      reviewedHomes.delete(scope);
      homeGenerations.delete(scope);
      return;
    }
    const scope = taskScope(target.key);
    const flags = taskBlocks.get(scope) ?? 0;
    if ((flags & TASK_STATE_UNCERTAIN) === 0) {
      throw new ProviderReconciliationRequiredError(
        (flags & TASK_POLICY_UNVERIFIED) !== 0 ? "task-policy" : "task",
        false,
      );
    }
    const reviewed = reviewedTasks.get(scope);
    if (
      reviewed === undefined ||
      reviewed.generation !== taskGenerations.get(scope) ||
      reviewed.fingerprint !== target.fingerprint
    ) {
      throw new ProviderReconciliationRequiredError("task", false);
    }
    let response: Response;
    try {
      response = await fetch(`${taskPath(target.key)}/reconciliation`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify({
          home: target.key.home,
          fingerprint: target.fingerprint,
        }),
      });
    } catch {
      throw new ProviderHttpError(0, null, "provider task reconciliation");
    }
    if (!response.ok) {
      throw await responseError(response, "provider task reconciliation");
    }
    if (response.status !== 204) {
      await cancelResponseBody(response);
      throw new ProviderProtocolError("INVALID_RESPONSE");
    }
    if (
      reviewedTasks.get(scope) !== reviewed ||
      taskGenerations.get(scope) !== reviewed.generation
    ) {
      throw new ProviderReconciliationRequiredError("task", false);
    }
    clearTaskFlag(target.key, TASK_STATE_UNCERTAIN);
    reviewedTasks.delete(scope);
  };
  const markTaskState = (key: NativeTaskKey): void => {
    markTaskFlag(key, TASK_STATE_UNCERTAIN);
  };
  const markTaskPolicy = (key: NativeTaskKey): void => {
    markTaskFlag(key, TASK_POLICY_UNVERIFIED);
  };
  const markTaskStateAndPolicy = (key: NativeTaskKey): void => {
    markTaskFlag(key, TASK_STATE_UNCERTAIN | TASK_POLICY_UNVERIFIED);
  };
  const occupiedTaskSlots = (): number => {
    let occupied = taskBlocks.size + pendingNewTaskSlots;
    for (const scope of inFlightTasks) {
      if (!taskBlocks.has(scope)) occupied += 1;
    }
    return occupied;
  };
  const claimHome = (provider: ProviderId, home: string): (() => void) => {
    requireHomeReady(provider, home);
    const scope = homeScope(provider, home);
    if (inFlightHomes.has(scope) ||
      uncertainHomes.size + inFlightHomes.size >= MAX_UNCERTAIN_HOME_SCOPES) {
      throw new ProviderReconciliationRequiredError("provider-home");
    }
    inFlightHomes.add(scope);
    return () => inFlightHomes.delete(scope);
  };
  const claimTask = (key: NativeTaskKey, allowPolicyRepair = false): (() => void) => {
    requireTaskReady(key, allowPolicyRepair);
    const scope = taskScope(key);
    if (inFlightTasks.has(scope) ||
      (!taskBlocks.has(scope) && occupiedTaskSlots() >= MAX_UNCERTAIN_TASK_SCOPES)) {
      throw new ProviderReconciliationRequiredError("task");
    }
    inFlightTasks.add(scope);
    return () => inFlightTasks.delete(scope);
  };
  const claimNewTaskSlot = (): (() => void) => {
    if (taskLedgerOverflow || occupiedTaskSlots() >= MAX_UNCERTAIN_TASK_SCOPES) {
      throw new ProviderReconciliationRequiredError("task");
    }
    pendingNewTaskSlots += 1;
    return () => {
      pendingNewTaskSlots -= 1;
    };
  };
  const withHomeMutation = async <T>(
    provider: ProviderId,
    home: string,
    operation: () => Promise<T>,
    reserveNewTask = false,
  ): Promise<T> => {
    const releaseHome = claimHome(provider, home);
    let releaseNewTask: (() => void) | undefined;
    try {
      if (reserveNewTask) releaseNewTask = claimNewTaskSlot();
      return await operation();
    } finally {
      releaseNewTask?.();
      releaseHome();
    }
  };
  const withTaskMutation = async <T>(
    key: NativeTaskKey,
    operation: () => Promise<T>,
    options: {
      reserveNewTask?: boolean;
      allowPolicyRepair?: boolean;
    } = {},
  ): Promise<T> => {
    const releaseTask = claimTask(key, options.allowPolicyRepair === true);
    let releaseNewTask: (() => void) | undefined;
    try {
      if (options.reserveNewTask) releaseNewTask = claimNewTaskSlot();
      return await operation();
    } finally {
      releaseNewTask?.();
      releaseTask();
    }
  };

  return {
    providers: () => getValidated(
      "/api/providers",
      "provider discovery",
      REST_LIMITS.descriptors,
      parseDescriptors,
    ),

    list: async ({ provider, home, cursor, limit, includeArchived }) => {
      const scope = homeScope(provider, home);
      const requestedGeneration = homeGenerations.get(scope);
      const page = await getValidated(
        `${providerPath(provider)}/tasks${query([
          ["home", home],
          ["cursor", cursor],
          ["limit", limit === undefined ? undefined : String(limit)],
          ["includeArchived", includeArchived === undefined ? undefined : String(includeArchived)],
        ])}`,
        "provider task list",
        REST_LIMITS.list,
        (value) => parsePage(value, provider, home),
      );
      if (cursor === undefined && requestedGeneration !== undefined &&
        homeGenerations.get(scope) === requestedGeneration && uncertainHomes.has(scope)) {
        reviewedHomes.set(scope, requestedGeneration);
      }
      return page;
    },

    read: async (key, includeTurns = false, options = {}) => {
      const scope = taskScope(key);
      const requestedGeneration = taskGenerations.get(scope);
      const task = await getValidated(
        `${taskPath(key)}${query([
          ["home", key.home],
          ["includeTurns", String(includeTurns)],
        ])}`,
        "provider task read",
        REST_LIMITS.task,
        (value) => parseTask(value, key.provider, key.home, key.nativeTaskId),
        options.signal,
      );
      if (includeTurns === true && requestedGeneration !== undefined &&
        taskGenerations.get(scope) === requestedGeneration &&
        ((taskBlocks.get(scope) ?? 0) & TASK_STATE_UNCERTAIN) !== 0) {
        if (task.revision) {
          reviewedTasks.set(scope, Object.freeze({
            generation: requestedGeneration,
            fingerprint: task.revision.fingerprint,
          }));
        } else {
          reviewedTasks.delete(scope);
        }
      }
      return task;
    },

    start: (provider, input) => withHomeMutation(provider, input.home, async () => {
      const outcome = await mutationResponse(
        `${providerPath(provider)}/tasks`,
        "provider task start",
        input,
        201,
        REST_LIMITS.task,
        (value) => parseCreateOutcome(value, "PARTIAL_START", provider, input.home),
        () => markHome(provider, input.home),
      );
      if (outcome.outcome === "partial") markTaskStateAndPolicy(outcome.task.key);
      return outcome;
    }, true),

    resume: (key, overrides) => withTaskMutation(key, async () => {
      const task = await mutationResponse(
        `${taskPath(key)}/resume`,
        "provider task resume",
        { home: key.home, ...pickOverrides(overrides) },
        200,
        REST_LIMITS.task,
        (value) => parseTask(value, key.provider, key.home, key.nativeTaskId),
        () => markTaskStateAndPolicy(key),
        () => markTaskPolicy(key),
      );
      clearTaskFlag(key, TASK_POLICY_UNVERIFIED);
      return task;
    }, { allowPolicyRepair: true }),

    fork: (key, lastTurnId) => withHomeMutation(
      key.provider,
      key.home,
      () => withTaskMutation(key, async () => {
        const outcome = await mutationResponse(
          `${taskPath(key)}/fork`,
          "provider task fork",
          { home: key.home, ...(lastTurnId === undefined ? {} : { lastTurnId }) },
          201,
          REST_LIMITS.task,
          (value) => parseCreateOutcome(
            value,
            "PARTIAL_FORK",
            key.provider,
            key.home,
            key.nativeTaskId,
          ),
          () => {
            markTaskState(key);
            markHome(key.provider, key.home);
          },
        );
        if (outcome.outcome === "partial") {
          markTaskState(key);
          markTaskStateAndPolicy(outcome.task.key);
        }
        return outcome;
      }, { reserveNewTask: true }),
    ),

    send: (key, input) => withTaskMutation(key, () => mutationResponse(
        `${taskPath(key)}/send`,
        "provider task send",
        { home: key.home, input },
        202,
        REST_LIMITS.turnRef,
        (value) => parseTurnRef(value, key),
        () => markTaskState(key),
      )),

    steer: (key, expectedTurnId, input) => withTaskMutation(key, () => mutationVoid(
        `${taskPath(key)}/steer`,
        "provider task steer",
        { home: key.home, expectedTurnId, input },
        () => markTaskState(key),
      )),

    interrupt: (key, turnId) => withTaskMutation(key, () => mutationVoid(
        `${taskPath(key)}/interrupt`,
        "provider task interrupt",
        { home: key.home, turnId },
        () => markTaskState(key),
      )),

    respond: async (response) => {
      const { key, ...wireIdentity } = response.identity;
      const body = "decision" in response
        ? { home: key.home, kind: response.kind, identity: wireIdentity, decision: response.decision }
        : "permissions" in response
        ? { home: key.home, kind: response.kind, identity: wireIdentity, permissions: response.permissions }
        : { home: key.home, kind: response.kind, identity: wireIdentity, answers: response.answers };
      return withTaskMutation(key, () => mutationResponse(
        `${taskPath(key)}/respond`,
        "provider request response",
        body,
        200,
        REST_LIMITS.responseStatus,
        parseResponseStatus,
        () => markTaskState(key),
      ));
    },

    archive: (key) => withTaskMutation(key, () => mutationVoid(
        `${taskPath(key)}/archive`,
        "provider task archive",
        { home: key.home },
        () => markTaskState(key),
      )),

    rename: (key, name) => withTaskMutation(key, () => mutationVoid(
        `${taskPath(key)}/rename`,
        "provider task rename",
        { home: key.home, name },
        () => markTaskState(key),
      )),

    acknowledgeReconciliation,

    subscribe,
  };
}

export const providerApi: ProviderApiClient = createProviderApiClient();
