import {
  normalizeProviderEvent,
  timeoutResponseForRequest,
  type ProviderEvent,
  type ProviderRequest,
} from "../events.js";
import {
  createProviderRequestIdentity,
  serializeProviderRequestIdentity,
} from "../request-identity.js";
import { canonicalizeProviderHome, createNativeTaskKey } from "../task-key.js";
import type {
  NativeTaskKey,
  ProviderEventSink,
  ProviderRequestIdentity,
  ProviderRequestResponse,
} from "../types.js";
import {
  type CodexNormalizationContext,
  normalizeCodexServerRequest,
  type NormalizedCodexServerRequest,
} from "./normalizer.js";
import {
  assertCodexFallbackParams,
  serializeCodexRpcId,
  type CodexRpcNotification,
  type CodexRpcRequest,
} from "./protocol/index.js";

export const CODEX_REQUEST_BROKER_MAX_PENDING = 4_096;
export const CODEX_REQUEST_BROKER_DEFAULT_PENDING = 256;
export const CODEX_REQUEST_BROKER_MAX_TOMBSTONES = 4_096;
export const CODEX_REQUEST_BROKER_DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
export const CODEX_REQUEST_BROKER_MAX_TIMEOUT_MS = 10 * 60 * 1_000;

export type CodexRequestBrokerErrorCode =
  | "ABORTED"
  | "CAPACITY"
  | "CLOSED"
  | "DUPLICATE"
  | "EVENT_DELIVERY_FAILED"
  | "EXTERNAL_RESOLUTION"
  | "GENERATION_CANCELLED"
  | "INVALID_RESPONSE"
  | "RESPONSE_MISMATCH"
  | "TASK_CANCELLED"
  | "TIMER_FAILURE"
  | "TURN_CANCELLED"
  | "UNSAFE_TIMEOUT"
  | "UNSUPPORTED_PERMISSION_GRANT";

export class CodexRequestBrokerError extends Error {
  readonly code: CodexRequestBrokerErrorCode;

  constructor(code: CodexRequestBrokerErrorCode, message: string) {
    super(message);
    this.name = "CodexRequestBrokerError";
    this.code = code;
  }
}

export type CodexRequestBrokerSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type CodexRequestBrokerClearTimeout = (handle: unknown) => void;

export interface CodexRequestBrokerOptions {
  readonly emit: ProviderEventSink;
  readonly maxPendingRequests?: number;
  readonly maxTombstones?: number;
  readonly requestTimeoutMs?: number;
  readonly setTimeoutFn?: CodexRequestBrokerSetTimeout;
  readonly clearTimeoutFn?: CodexRequestBrokerClearTimeout;
}

export interface CodexRequestBrokerContext extends CodexNormalizationContext {
  readonly signal?: AbortSignal;
}

export type CodexRequestDispatchResult = "dispatched" | "stale";

interface PendingRequest {
  readonly key: string;
  readonly correlationKey: string;
  readonly normalized: Readonly<NormalizedCodexServerRequest>;
  readonly context: CodexRequestBrokerContext;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  timer: unknown;
  timerSet: boolean;
  requestEmitted: boolean;
  removeAbortListener: () => void;
}

interface Tombstone {
  readonly key: string;
  readonly correlationKey: string;
  readonly identity: Readonly<ProviderRequestIdentity>;
  readonly occurredAt: string;
  readonly resolutionEmitted: boolean;
}

const brokerError = (
  code: CodexRequestBrokerErrorCode,
  message: string,
): CodexRequestBrokerError => new CodexRequestBrokerError(code, message);

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} must be a positive safe integer at most ${maximum}`);
  }
  return resolved;
};

const requestTimeout = (value: number | undefined): number => {
  const resolved = value ?? CODEX_REQUEST_BROKER_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > CODEX_REQUEST_BROKER_MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `requestTimeoutMs must be a positive safe integer at most ${CODEX_REQUEST_BROKER_MAX_TIMEOUT_MS}`,
    );
  }
  return resolved;
};

const contextGeneration = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw brokerError("INVALID_RESPONSE", "Codex generation must be a positive safe integer");
  }
  return value as number;
};

const correlationKey = (
  home: string,
  generation: number,
  threadId: string,
  requestId: string | number,
): string => JSON.stringify([
  canonicalizeProviderHome(home),
  generation,
  threadId,
  serializeCodexRpcId(requestId),
]);

const identityCorrelationKey = (identity: ProviderRequestIdentity): string => correlationKey(
  identity.key.home,
  contextGeneration(identity.generation),
  identity.key.nativeTaskId,
  identity.requestId,
);

const createDeferred = (): {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
} => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const responseKindMatches = (
  request: ProviderRequest,
  response: ProviderRequestResponse,
): boolean => request.kind === response.kind;

const mappedDecision = (
  decision: unknown,
): "accept" | "decline" | "cancel" => {
  if (decision === "allow") return "accept";
  if (decision === "deny") return "decline";
  if (decision === "cancel") return "cancel";
  throw brokerError("INVALID_RESPONSE", "Provider response decision is invalid");
};

const mappedAnswers = (
  answersValue: unknown,
  allowedQuestionIds: readonly string[],
): Readonly<Record<string, { readonly answers: readonly string[] }>> => {
  if (answersValue === null || typeof answersValue !== "object" || Array.isArray(answersValue)) {
    throw brokerError("INVALID_RESPONSE", "User-input answers must be an object");
  }
  const allowed = new Set(allowedQuestionIds);
  const result: Record<string, { readonly answers: readonly string[] }> = {};
  for (const [questionId, answer] of Object.entries(answersValue)) {
    if (!allowed.has(questionId) || typeof answer !== "string") {
      throw brokerError(
        "RESPONSE_MISMATCH",
        "User-input answer does not belong to the pending request",
      );
    }
    Object.defineProperty(result, questionId, {
      value: Object.freeze({ answers: Object.freeze([answer]) }),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
};

const mapProviderResponse = (
  pending: PendingRequest,
  response: ProviderRequestResponse,
): unknown => {
  const request = pending.normalized.request;
  if (!responseKindMatches(request, response)) {
    throw brokerError("RESPONSE_MISMATCH", "Response kind does not match the pending request");
  }
  switch (request.kind) {
    case "command-approval":
    case "file-change-approval": {
      if (
        response.kind !== "command-approval" &&
        response.kind !== "file-change-approval"
      ) {
        throw brokerError("RESPONSE_MISMATCH", "Approval response kind is invalid");
      }
      return Object.freeze({ decision: mappedDecision(response.decision) });
    }
    case "mcp-elicitation": {
      if (response.kind !== "mcp-elicitation") {
        throw brokerError("RESPONSE_MISMATCH", "MCP response kind is invalid");
      }
      const decision = mappedDecision(response.decision);
      return Object.freeze({
        action: decision === "accept" ? "accept" : decision === "decline" ? "decline" : "cancel",
      });
    }
    case "permission": {
      if (response.kind !== "permission" || !Array.isArray(response.permissions)) {
        throw brokerError("INVALID_RESPONSE", "Permission response is invalid");
      }
      if (response.permissions.length !== 0) {
        throw brokerError(
          "UNSUPPORTED_PERMISSION_GRANT",
          "Provider-neutral string permissions cannot authorize a native Codex profile",
        );
      }
      return Object.freeze({ permissions: Object.freeze({}) });
    }
    case "user-input": {
      if (response.kind !== "user-input") {
        throw brokerError("RESPONSE_MISMATCH", "User-input response kind is invalid");
      }
      return Object.freeze({
        answers: mappedAnswers(response.answers, pending.normalized.questionIds),
      });
    }
  }
};

export class CodexRequestBroker {
  private readonly emit: ProviderEventSink;
  private readonly maxPendingRequests: number;
  private readonly maxTombstones: number;
  private readonly requestTimeoutMs: number;
  private readonly setTimeoutFn: CodexRequestBrokerSetTimeout;
  private readonly clearTimeoutFn: CodexRequestBrokerClearTimeout;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingByCorrelation = new Map<string, string>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly tombstonesByCorrelation = new Map<string, string>();
  private closed = false;

  constructor(options: CodexRequestBrokerOptions) {
    if (!options || typeof options.emit !== "function") {
      throw new TypeError("CodexRequestBroker requires an event sink");
    }
    this.emit = options.emit;
    this.maxPendingRequests = boundedInteger(
      options.maxPendingRequests,
      CODEX_REQUEST_BROKER_DEFAULT_PENDING,
      CODEX_REQUEST_BROKER_MAX_PENDING,
      "maxPendingRequests",
    );
    this.maxTombstones = boundedInteger(
      options.maxTombstones,
      CODEX_REQUEST_BROKER_MAX_TOMBSTONES,
      CODEX_REQUEST_BROKER_MAX_TOMBSTONES,
      "maxTombstones",
    );
    this.requestTimeoutMs = requestTimeout(options.requestTimeoutMs);
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get tombstoneCount(): number {
    return this.tombstones.size;
  }

  /** Hold a stable server request until the exact UI response, safe timeout, or cancellation. */
  handle(request: CodexRpcRequest, context: CodexRequestBrokerContext): Promise<unknown> {
    if (this.closed) return Promise.reject(brokerError("CLOSED", "Codex request broker is closed"));
    if (context.signal?.aborted) {
      return Promise.reject(brokerError("ABORTED", "Codex server request was cancelled"));
    }

    let normalized: Readonly<NormalizedCodexServerRequest>;
    try {
      normalized = normalizeCodexServerRequest(request, context);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = serializeProviderRequestIdentity(normalized.request.identity);
    if (this.pending.has(key) || this.tombstones.has(key)) {
      return Promise.reject(brokerError("DUPLICATE", "Duplicate or replayed Codex server request"));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(brokerError("CAPACITY", "Codex request broker capacity was reached"));
    }
    const correlated = identityCorrelationKey(normalized.request.identity);
    if (
      this.pendingByCorrelation.has(correlated) ||
      this.tombstonesByCorrelation.has(correlated)
    ) {
      return Promise.reject(brokerError("DUPLICATE", "Duplicate Codex request correlation"));
    }

    const deferred = createDeferred();
    const pending: PendingRequest = {
      key,
      correlationKey: correlated,
      normalized,
      context: Object.freeze({ ...context }),
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer: undefined,
      timerSet: false,
      requestEmitted: false,
      removeAbortListener: () => undefined,
    };
    this.pending.set(key, pending);
    this.pendingByCorrelation.set(correlated, key);

    if (context.signal) {
      const onAbort = (): void => {
        this.rejectPending(
          pending,
          brokerError("ABORTED", "Codex server request was cancelled"),
          pending.requestEmitted,
        );
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      pending.removeAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
      if (context.signal.aborted) onAbort();
    }

    if (this.pending.get(key) !== pending) return deferred.promise;
    const declaredAutoResolution = normalized.request.kind === "user-input"
      ? normalized.request.autoResolutionMs
      : null;
    const timeoutMs = declaredAutoResolution === null
      ? this.requestTimeoutMs
      : Math.min(this.requestTimeoutMs, declaredAutoResolution);
    try {
      const timer = this.setTimeoutFn(() => this.onTimeout(pending), timeoutMs);
      if (this.pending.get(key) !== pending) {
        try {
          this.clearTimeoutFn(timer);
        } catch {
          // The request is already terminal; a hostile clear implementation cannot revive it.
        }
        return deferred.promise;
      }
      pending.timer = timer;
      pending.timerSet = true;
      if (timer && typeof timer === "object" && "unref" in timer) {
        try {
          const unref = Reflect.get(timer, "unref");
          if (typeof unref === "function") Reflect.apply(unref, timer, []);
        } catch {
          // Timer liveness hints are optional and never affect request safety.
        }
      }
    } catch {
      this.rollbackPending(
        pending,
        brokerError("TIMER_FAILURE", "Codex request timeout could not be scheduled"),
      );
      return deferred.promise;
    }

    try {
      for (const detailEvent of normalized.detailEvents) this.emit(detailEvent);
      // Mark delivery before invoking user code so a synchronous abort can publish
      // the matching resolution event and never strand a visible request.
      pending.requestEmitted = true;
      this.emit(normalized.event);
    } catch {
      this.rollbackPending(
        pending,
        brokerError("EVENT_DELIVERY_FAILED", "Codex request event could not be delivered"),
      );
    }
    return deferred.promise;
  }

  /** Dispatch an exact response once. Unknown, late, foreign, and stale identities are no-ops. */
  async respond(response: ProviderRequestResponse): Promise<CodexRequestDispatchResult> {
    let identity: Readonly<ProviderRequestIdentity>;
    try {
      identity = createProviderRequestIdentity(response.identity);
    } catch {
      throw brokerError("INVALID_RESPONSE", "Provider response identity is invalid");
    }
    const key = serializeProviderRequestIdentity(identity);
    const pending = this.pending.get(key);
    if (!pending) return "stale";
    let wireResponse: unknown;
    try {
      wireResponse = mapProviderResponse(pending, response);
    } catch (error) {
      if (error instanceof CodexRequestBrokerError) throw error;
      throw brokerError("INVALID_RESPONSE", "Provider response payload is invalid");
    }
    this.resolvePending(pending, wireResponse, true);
    return "dispatched";
  }

  /** Correlate the app-server's resolution notification without trusting partial ownership. */
  observeResolved(
    notification: CodexRpcNotification,
    context: CodexRequestBrokerContext,
  ): ProviderEvent | null {
    if (notification.method !== "serverRequest/resolved") return null;
    try {
      assertCodexFallbackParams("server-notification", notification.method, notification.params);
      if (!notification.params || typeof notification.params !== "object" || Array.isArray(notification.params)) {
        return null;
      }
      const params = notification.params as Record<string, unknown>;
      if (
        typeof params.threadId !== "string" ||
        params.threadId.trim().length === 0 ||
        (typeof params.requestId !== "string" &&
          !(typeof params.requestId === "number" && Number.isSafeInteger(params.requestId)))
      ) return null;
      const correlated = correlationKey(
        context.home,
        contextGeneration(context.generation),
        params.threadId.trim(),
        params.requestId,
      );
      const key = this.pendingByCorrelation.get(correlated);
      if (key) {
        const pending = this.pending.get(key);
        if (!pending) return null;
        return this.rejectPending(
          pending,
          brokerError("EXTERNAL_RESOLUTION", "Codex request was resolved outside this broker"),
          pending.requestEmitted,
        );
      }
      const tombstoneKey = this.tombstonesByCorrelation.get(correlated);
      const tombstone = tombstoneKey ? this.tombstones.get(tombstoneKey) : undefined;
      if (!tombstone || tombstone.resolutionEmitted) return null;
      const event = this.resolvedEvent(tombstone.identity, tombstone.occurredAt);
      this.replaceTombstone(tombstone, true);
      this.safeEmit(event);
      return event;
    } catch {
      return null;
    }
  }

  cancelGeneration(home: string, generation: number): number {
    const canonicalHome = canonicalizeProviderHome(home);
    contextGeneration(generation);
    const matches = [...this.pending.values()].filter((pending) =>
      pending.normalized.request.identity.key.home === canonicalHome &&
      pending.normalized.request.identity.generation === generation);
    for (const pending of matches) {
      this.rejectPending(
        pending,
        brokerError("GENERATION_CANCELLED", "Codex app-server generation was cancelled"),
        pending.requestEmitted,
      );
    }
    return matches.length;
  }

  cancelTurn(identity: NativeTaskKey, turnId: string, generation: number): number {
    const key = createNativeTaskKey(identity.provider, identity.home, identity.nativeTaskId);
    const exactGeneration = contextGeneration(generation);
    if (typeof turnId !== "string" || turnId.trim().length === 0 || turnId.includes("\u0000")) {
      throw new TypeError("turnId must be a non-empty native id");
    }
    const exactTurnId = turnId.trim();
    const matches = [...this.pending.values()].filter((pending) => {
      const requestIdentity = pending.normalized.request.identity;
      return requestIdentity.key.provider === key.provider &&
        requestIdentity.key.home === key.home &&
        requestIdentity.key.nativeTaskId === key.nativeTaskId &&
        requestIdentity.generation === exactGeneration &&
        requestIdentity.turnId === exactTurnId;
    });
    for (const pending of matches) {
      this.rejectPending(
        pending,
        brokerError("TURN_CANCELLED", "Codex turn request was cancelled"),
        pending.requestEmitted,
      );
    }
    return matches.length;
  }

  cancelTask(identity: NativeTaskKey): number {
    const exactKey = createNativeTaskKey(identity.provider, identity.home, identity.nativeTaskId);
    const matches = [...this.pending.values()].filter((pending) => {
      const key = pending.normalized.request.identity.key;
      return key.provider === exactKey.provider &&
        key.home === exactKey.home &&
        key.nativeTaskId === exactKey.nativeTaskId;
    });
    for (const pending of matches) {
      this.rejectPending(
        pending,
        brokerError("TASK_CANCELLED", "Codex task request was cancelled"),
        pending.requestEmitted,
      );
    }
    return matches.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) {
      this.rejectPending(
        pending,
        brokerError("CLOSED", "Codex request broker is closed"),
        pending.requestEmitted,
      );
    }
  }

  private onTimeout(pending: PendingRequest): void {
    if (this.pending.get(pending.key) !== pending) return;
    const safeResponse = timeoutResponseForRequest(pending.normalized.request);
    if (safeResponse === null) {
      this.rejectPending(
        pending,
        brokerError("UNSAFE_TIMEOUT", "Codex request has no safe automatic timeout response"),
        pending.requestEmitted,
      );
      return;
    }
    try {
      this.resolvePending(
        pending,
        mapProviderResponse(pending, safeResponse),
        pending.requestEmitted,
      );
    } catch {
      this.rejectPending(
        pending,
        brokerError("UNSAFE_TIMEOUT", "Codex request timeout could not fail closed"),
        pending.requestEmitted,
      );
    }
  }

  private resolvePending(pending: PendingRequest, value: unknown, emitResolution: boolean): ProviderEvent | null {
    const event = this.finishPending(pending, emitResolution);
    pending.resolve(value);
    return event;
  }

  private rejectPending(
    pending: PendingRequest,
    error: CodexRequestBrokerError,
    emitResolution: boolean,
  ): ProviderEvent | null {
    if (this.pending.get(pending.key) !== pending) return null;
    const event = this.finishPending(pending, emitResolution);
    pending.reject(error);
    return event;
  }

  private rollbackPending(pending: PendingRequest, error: CodexRequestBrokerError): void {
    if (this.pending.get(pending.key) !== pending) return;
    this.removePending(pending);
    pending.reject(error);
  }

  private finishPending(pending: PendingRequest, emitResolution: boolean): ProviderEvent | null {
    this.removePending(pending);
    const event = emitResolution
      ? this.resolvedEvent(pending.normalized.request.identity, pending.normalized.event.occurredAt)
      : null;
    this.addTombstone({
      key: pending.key,
      correlationKey: pending.correlationKey,
      identity: pending.normalized.request.identity,
      occurredAt: pending.normalized.event.occurredAt,
      // A terminal request whose UI event was suppressed must also suppress any
      // later app-server resolution, or that late notification becomes phantom UI.
      resolutionEmitted: true,
    });
    if (event) this.safeEmit(event);
    return event;
  }

  private removePending(pending: PendingRequest): void {
    this.pending.delete(pending.key);
    if (this.pendingByCorrelation.get(pending.correlationKey) === pending.key) {
      this.pendingByCorrelation.delete(pending.correlationKey);
    }
    pending.removeAbortListener();
    pending.removeAbortListener = () => undefined;
    if (pending.timerSet) {
      const timer = pending.timer;
      pending.timer = undefined;
      pending.timerSet = false;
      try {
        this.clearTimeoutFn(timer);
      } catch {
        // Logical removal happens first, so a stale callback remains harmless.
      }
    }
  }

  private addTombstone(tombstone: Tombstone): void {
    const existing = this.tombstones.get(tombstone.key);
    if (existing) this.tombstonesByCorrelation.delete(existing.correlationKey);
    this.tombstones.delete(tombstone.key);
    this.tombstones.set(tombstone.key, Object.freeze(tombstone));
    this.tombstonesByCorrelation.set(tombstone.correlationKey, tombstone.key);
    while (this.tombstones.size > this.maxTombstones) {
      const oldestKey = this.tombstones.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.tombstones.get(oldestKey);
      this.tombstones.delete(oldestKey);
      if (oldest && this.tombstonesByCorrelation.get(oldest.correlationKey) === oldestKey) {
        this.tombstonesByCorrelation.delete(oldest.correlationKey);
      }
    }
  }

  private replaceTombstone(tombstone: Tombstone, resolutionEmitted: boolean): void {
    this.addTombstone({ ...tombstone, resolutionEmitted });
  }

  private resolvedEvent(
    identity: Readonly<ProviderRequestIdentity>,
    occurredAt: string,
  ): ProviderEvent {
    return normalizeProviderEvent({ type: "request-resolved", identity }, {
      provider: "openai",
      key: identity.key,
      occurredAt,
    });
  }

  private safeEmit(event: ProviderEvent): void {
    try {
      this.emit(event);
    } catch {
      // Request safety and app-server correlation cannot depend on a UI subscriber.
    }
  }
}
