import {
  normalizeProviderEvent,
  type ProviderEvent,
} from "../events.js";
import {
  createProviderRequestIdentity,
  serializeProviderRequestIdentity,
} from "../request-identity.js";
import type {
  ProviderEventSink,
  ProviderRequestIdentity,
} from "../types.js";
import type {
  ClaudeInboundControlContext,
  ClaudeInboundControlHandler,
  ClaudeInboundControlResult,
  ClaudeInboundControlResultFactory,
} from "./control-peer.js";
import type {
  ClaudeCanUseToolRequest,
  ClaudeControlJsonObject,
  ClaudeParsedControlRequest,
} from "./protocol/control-shapes.js";

export const CLAUDE_PERMISSION_DENY_MESSAGE = "Claude tool request denied by DevHub";
export const CLAUDE_PERMISSION_DEFAULT_MAX_PENDING = 256;
export const CLAUDE_PERMISSION_MAX_PENDING = 4_096;
export const CLAUDE_PERMISSION_DEFAULT_MAX_TOMBSTONES = 4_096;
export const CLAUDE_PERMISSION_MAX_TOMBSTONES = 4_096;

const NATIVE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ClaudePermissionBridgeErrorCode =
  | "INVALID_RESPONSE"
  | "RESPONSE_MISMATCH";

export class ClaudePermissionBridgeError extends Error {
  readonly code: ClaudePermissionBridgeErrorCode;

  constructor(code: ClaudePermissionBridgeErrorCode, message: string) {
    super(message);
    this.name = "ClaudePermissionBridgeError";
    this.code = code;
  }
}

export type ClaudePermissionDiagnosticCode =
  | "ABORTED"
  | "CAPACITY_DENIED"
  | "CLOSED_DENIED"
  | "EVENT_DELIVERY_FAILED"
  | "INVALID_ACTIVE_TURN"
  | "INVALID_BROWSER_RESPONSE"
  | "STALE_BROWSER_RESPONSE"
  | "TERMINAL_CAPACITY_DENIED"
  | "TIMED_OUT"
  | "UNSUPPORTED_CONTROL"
  | "USER_INTERACTION_REQUIRED";

/** Value-free diagnostics: provider-controlled ids, tools, paths, and payloads never cross here. */
export interface ClaudePermissionDiagnostic {
  readonly code: ClaudePermissionDiagnosticCode;
}

export interface ClaudePermissionBridgeOptions {
  readonly emit: ProviderEventSink;
  readonly activeTurnId: () => string | null;
  readonly now?: () => string;
  readonly normalizeEvent?: typeof normalizeProviderEvent;
  readonly maxPendingRequests?: number;
  readonly maxTombstones?: number;
  readonly onDiagnostic?: (diagnostic: ClaudePermissionDiagnostic) => void;
}

export type ClaudePermissionDispatchResult = "dispatched" | "stale";

interface PendingPermission {
  readonly identity: Readonly<ProviderRequestIdentity>;
  readonly identityKey: string;
  readonly controlKey: string;
  readonly request: ClaudeParsedControlRequest;
  readonly originalInput: ClaudeControlJsonObject;
  readonly toolUseId: string;
  readonly occurredAt: string;
  readonly resolve: (result: ClaudeInboundControlResult) => void;
  requestEmitted: boolean;
  requestDeliveryInProgress: boolean;
  deferredResult?: ClaudeInboundControlResult;
  removeAbortListener: () => void;
}

const bridgeError = (
  code: ClaudePermissionBridgeErrorCode,
  message: string,
): ClaudePermissionBridgeError => new ClaudePermissionBridgeError(code, message);

const boundedPositiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${field} must be a positive safe integer no greater than ${maximum}`);
  }
  return resolved;
};

const freezeResult = (
  response: ClaudeControlJsonObject,
): ClaudeInboundControlResult => Object.freeze({
  kind: "success" as const,
  response: Object.freeze(response),
});

const denyResult = (toolUseId?: string): ClaudeInboundControlResult => freezeResult({
  behavior: "deny",
  message: CLAUDE_PERMISSION_DENY_MESSAGE,
  interrupt: false,
  ...(toolUseId === undefined ? {} : { toolUseID: toolUseId }),
});

const allowResult = (input: ClaudeControlJsonObject): ClaudeInboundControlResult => freezeResult({
  behavior: "allow",
  updatedInput: input,
});

const eligibleRequest = (
  request: ClaudeParsedControlRequest,
): ClaudeCanUseToolRequest | null => {
  if (request.request.kind !== "can-use-tool") return null;
  if (request.request.requiresUserInteraction === true) return null;
  return request.request.toolName === "Write" || request.request.toolName === "Edit"
    ? request.request
    : null;
};

const requestToolUseId = (request: ClaudeParsedControlRequest): string | undefined =>
  request.request.kind === "can-use-tool" ? request.request.toolUseId : undefined;

const controlCorrelationKey = (
  request: ClaudeParsedControlRequest,
  context: ClaudeInboundControlContext,
): string => JSON.stringify([
  context.home,
  context.sessionId,
  context.generation,
  request.requestId,
  requestToolUseId(request) ?? null,
]);

const plainDataRecord = (
  value: unknown,
  exactKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bridgeError("INVALID_RESPONSE", `${field} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw bridgeError("INVALID_RESPONSE", `${field} is invalid`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== exactKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
  ) {
    throw bridgeError("INVALID_RESPONSE", `${field} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of exactKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw bridgeError("INVALID_RESPONSE", `${field} is invalid`);
    }
  }
  return Object.freeze(Object.fromEntries(
    exactKeys.map((key) => [key, descriptors[key]!.value]),
  ));
};

const browserIdentity = (value: unknown): Readonly<ProviderRequestIdentity> => {
  const identity = plainDataRecord(
    value,
    ["key", "generation", "turnId", "requestId", "itemId", "approvalId"],
    "provider response identity",
  );
  const key = plainDataRecord(
    identity.key,
    ["provider", "home", "nativeTaskId"],
    "provider response task key",
  );
  const canonical = createProviderRequestIdentity({
    key: {
      provider: key.provider as "anthropic",
      home: key.home as string,
      nativeTaskId: key.nativeTaskId as string,
    },
    generation: identity.generation as number,
    turnId: identity.turnId as string | null,
    requestId: identity.requestId as string | number,
    itemId: identity.itemId as string | null,
    approvalId: identity.approvalId as string | number | null,
  });
  if (
    key.provider !== canonical.key.provider ||
    key.home !== canonical.key.home ||
    key.nativeTaskId !== canonical.key.nativeTaskId ||
    identity.generation !== canonical.generation ||
    identity.turnId !== canonical.turnId ||
    identity.requestId !== canonical.requestId ||
    identity.itemId !== canonical.itemId ||
    identity.approvalId !== canonical.approvalId
  ) {
    throw bridgeError("INVALID_RESPONSE", "Provider response identity is not exact");
  }
  return canonical;
};

export class ClaudePermissionBridge {
  private readonly emit: ProviderEventSink;
  private readonly activeTurnId: () => string | null;
  private readonly now: () => string;
  private readonly normalizeEvent: typeof normalizeProviderEvent;
  private readonly maxPendingRequests: number;
  private readonly maxTombstones: number;
  private readonly onDiagnostic?: (diagnostic: ClaudePermissionDiagnostic) => void;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly pendingByControl = new Map<string, string>();
  private readonly tombstones = new Set<string>();
  private closed = false;

  constructor(options: ClaudePermissionBridgeOptions) {
    if (!options || typeof options.emit !== "function") {
      throw new TypeError("Claude permission bridge requires an event sink");
    }
    if (typeof options.activeTurnId !== "function") {
      throw new TypeError("Claude permission bridge requires an active turn source");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (options.normalizeEvent !== undefined && typeof options.normalizeEvent !== "function") {
      throw new TypeError("normalizeEvent must be a function");
    }
    if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== "function") {
      throw new TypeError("onDiagnostic must be a function");
    }
    this.emit = options.emit;
    this.activeTurnId = options.activeTurnId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.normalizeEvent = options.normalizeEvent ?? normalizeProviderEvent;
    this.maxPendingRequests = boundedPositiveInteger(
      options.maxPendingRequests,
      CLAUDE_PERMISSION_DEFAULT_MAX_PENDING,
      CLAUDE_PERMISSION_MAX_PENDING,
      "maxPendingRequests",
    );
    this.maxTombstones = boundedPositiveInteger(
      options.maxTombstones,
      CLAUDE_PERMISSION_DEFAULT_MAX_TOMBSTONES,
      CLAUDE_PERMISSION_MAX_TOMBSTONES,
      "maxTombstones",
    );
    this.onDiagnostic = options.onDiagnostic;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get tombstoneCount(): number {
    return this.tombstones.size;
  }

  readonly handleControl: ClaudeInboundControlHandler = (request, context) => {
    const toolUseId = requestToolUseId(request);
    if (this.closed) {
      this.diagnostic("CLOSED_DENIED");
      return denyResult(toolUseId);
    }
    const eligible = eligibleRequest(request);
    if (!eligible) {
      this.diagnostic(
        request.request.kind === "can-use-tool" &&
          request.request.requiresUserInteraction === true
          ? "USER_INTERACTION_REQUIRED"
          : "UNSUPPORTED_CONTROL",
      );
      return denyResult(toolUseId);
    }
    if (context.signal.aborted) {
      this.diagnostic("ABORTED");
      return denyResult(eligible.toolUseId);
    }

    let turnId: string | null;
    try {
      turnId = this.activeTurnId();
    } catch {
      turnId = null;
    }
    if (
      typeof turnId !== "string" ||
      turnId.trim().length === 0 ||
      turnId.includes("\u0000")
    ) {
      this.diagnostic("INVALID_ACTIVE_TURN");
      return denyResult(eligible.toolUseId);
    }
    if (this.pending.size >= this.maxPendingRequests) {
      this.diagnostic("CAPACITY_DENIED");
      return denyResult(eligible.toolUseId);
    }
    if (this.pending.size + this.tombstones.size >= this.maxTombstones) {
      this.diagnostic("TERMINAL_CAPACITY_DENIED");
      return denyResult(eligible.toolUseId);
    }

    let identity: Readonly<ProviderRequestIdentity>;
    let event: ProviderEvent;
    let controlKey: string;
    try {
      if (!NATIVE_SESSION_UUID.test(context.sessionId) || !Number.isSafeInteger(context.generation) ||
        context.generation < 1) {
        throw new TypeError("invalid peer identity");
      }
      identity = createProviderRequestIdentity({
        key: {
          provider: "anthropic",
          home: context.home,
          nativeTaskId: context.sessionId,
        },
        generation: context.generation,
        turnId,
        requestId: request.requestId,
        itemId: eligible.toolUseId,
        approvalId: null,
      });
      const occurredAt = this.now();
      event = this.normalizeEvent({
        type: "request",
        request: { kind: "file-change-approval", identity },
      }, {
        provider: "anthropic",
        key: identity.key,
        occurredAt,
      });
      if (
        event.type !== "request" ||
        event.request.kind !== "file-change-approval"
      ) throw new TypeError("request event normalization failed");
      controlKey = controlCorrelationKey(request, context);
    } catch {
      this.diagnostic("EVENT_DELIVERY_FAILED");
      return denyResult(eligible.toolUseId);
    }

    const identityKey = serializeProviderRequestIdentity(identity);
    if (
      this.pending.has(identityKey) ||
      this.tombstones.has(identityKey) ||
      this.pendingByControl.has(controlKey)
    ) {
      this.diagnostic("TERMINAL_CAPACITY_DENIED");
      return denyResult(eligible.toolUseId);
    }

    let resolvePromise!: (result: ClaudeInboundControlResult) => void;
    const promise = new Promise<ClaudeInboundControlResult>((resolve) => {
      resolvePromise = resolve;
    });
    const pending: PendingPermission = {
      identity,
      identityKey,
      controlKey,
      request,
      originalInput: eligible.input,
      toolUseId: eligible.toolUseId,
      occurredAt: event.occurredAt,
      resolve: resolvePromise,
      requestEmitted: false,
      requestDeliveryInProgress: false,
      removeAbortListener: () => undefined,
    };
    this.pending.set(identityKey, pending);
    this.pendingByControl.set(controlKey, identityKey);

    const onAbort = (): void => {
      if (this.pending.get(identityKey) !== pending) return;
      this.diagnostic("ABORTED");
      this.finishPending(pending, denyResult(pending.toolUseId));
    };
    try {
      context.signal.addEventListener("abort", onAbort, { once: true });
      pending.removeAbortListener = () => context.signal.removeEventListener("abort", onAbort);
    } catch {
      onAbort();
    }
    if (context.signal.aborted) onAbort();
    if (this.pending.get(identityKey) !== pending) return promise;

    pending.requestDeliveryInProgress = true;
    try {
      this.emit(event);
      pending.requestDeliveryInProgress = false;
      pending.requestEmitted = true;
      const deferredResult = pending.deferredResult;
      pending.deferredResult = undefined;
      if (deferredResult) this.finishPending(pending, deferredResult);
    } catch {
      pending.requestDeliveryInProgress = false;
      pending.deferredResult = undefined;
      this.diagnostic("EVENT_DELIVERY_FAILED");
      this.finishPending(pending, denyResult(pending.toolUseId));
    }
    return promise;
  };

  readonly createTimeoutResult: ClaudeInboundControlResultFactory = (request, context) => {
    const result = denyResult(requestToolUseId(request));
    let controlKey: string;
    try {
      controlKey = controlCorrelationKey(request, context);
    } catch {
      return result;
    }
    const identityKey = this.pendingByControl.get(controlKey);
    const pending = identityKey ? this.pending.get(identityKey) : undefined;
    if (pending) {
      this.diagnostic("TIMED_OUT");
      this.finishPending(pending, result);
    }
    return result;
  };

  async respond(value: unknown): Promise<ClaudePermissionDispatchResult> {
    let response: Readonly<Record<string, unknown>>;
    let identity: Readonly<ProviderRequestIdentity>;
    try {
      response = plainDataRecord(
        value,
        ["kind", "identity", "decision"],
        "provider response",
      );
      if (response.kind !== "file-change-approval") {
        throw bridgeError("INVALID_RESPONSE", "Provider response kind is invalid");
      }
      if (
        response.decision !== "allow" &&
        response.decision !== "deny" &&
        response.decision !== "cancel"
      ) {
        throw bridgeError("INVALID_RESPONSE", "Provider response decision is invalid");
      }
      identity = browserIdentity(response.identity);
    } catch (error) {
      this.diagnostic("INVALID_BROWSER_RESPONSE");
      if (error instanceof ClaudePermissionBridgeError) throw error;
      throw bridgeError("INVALID_RESPONSE", "Provider response is invalid");
    }

    const identityKey = serializeProviderRequestIdentity(identity);
    const pending = this.pending.get(identityKey);
    if (!pending) {
      if (this.tombstones.has(identityKey)) {
        this.diagnostic("STALE_BROWSER_RESPONSE");
        return "stale";
      }
      this.diagnostic("INVALID_BROWSER_RESPONSE");
      throw bridgeError("RESPONSE_MISMATCH", "Provider response has no matching request");
    }
    if (pending.deferredResult) {
      this.diagnostic("STALE_BROWSER_RESPONSE");
      return "stale";
    }
    const result = response.decision === "allow"
      ? allowResult(pending.originalInput)
      : denyResult(pending.toolUseId);
    this.finishPending(pending, result);
    return "dispatched";
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) {
      this.finishPending(pending, denyResult(pending.toolUseId));
    }
    this.tombstones.clear();
  }

  private finishPending(
    pending: PendingPermission,
    result: ClaudeInboundControlResult,
  ): void {
    if (this.pending.get(pending.identityKey) !== pending) return;
    if (pending.requestDeliveryInProgress) {
      pending.deferredResult = result;
      return;
    }
    this.pending.delete(pending.identityKey);
    if (this.pendingByControl.get(pending.controlKey) === pending.identityKey) {
      this.pendingByControl.delete(pending.controlKey);
    }
    try {
      pending.removeAbortListener();
    } catch {
      // Logical ownership is already removed; a hostile listener cannot revive it.
    }
    if (!this.closed) this.tombstones.add(pending.identityKey);
    if (pending.requestEmitted) {
      this.emitResolution(pending);
    }
    pending.resolve(result);
  }

  private emitResolution(pending: PendingPermission): void {
    try {
      const resolved = this.normalizeEvent({
        type: "request-resolved",
        identity: pending.identity,
      }, {
        provider: "anthropic",
        key: pending.identity.key,
        occurredAt: pending.occurredAt,
      });
      this.emit(resolved);
    } catch {
      this.diagnostic("EVENT_DELIVERY_FAILED");
    }
  }

  private diagnostic(code: ClaudePermissionDiagnosticCode): void {
    try {
      this.onDiagnostic?.(Object.freeze({ code }));
    } catch {
      // Diagnostic observers cannot affect permission ownership or outcomes.
    }
  }
}
