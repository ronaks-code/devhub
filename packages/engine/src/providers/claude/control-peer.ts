import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalizeProviderHome } from "../task-key.js";
import {
  buildClaudeControlErrorResponse,
  buildClaudeControlRequest,
  buildClaudeControlSuccessResponse,
  classifyClaudeControlEnvelope,
  CLAUDE_CONTROL_MAX_IDENTIFIER_CHARS,
  type ClaudeControlJsonObject,
  type ClaudeParsedControlRequest,
  type ClaudeControlSuccessResponse,
  type ClaudeParsedControlResponse,
} from "./protocol/control-shapes.js";

export const CLAUDE_CONTROL_DEFAULT_MAX_PENDING = 256;
export const CLAUDE_CONTROL_HARD_MAX_PENDING = 4_096;
export const CLAUDE_CONTROL_DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;
export const CLAUDE_CONTROL_DEFAULT_INBOUND_TIMEOUT_MS = 5 * 60_000;
export const CLAUDE_CONTROL_MAX_INBOUND_TIMEOUT_MS = 10 * 60_000;
export const CLAUDE_CONTROL_MAX_TOMBSTONES = 4_096;
export const CLAUDE_CONTROL_MAX_INTERRUPT_RECEIPT_ITEMS = 256;
export const CLAUDE_CONTROL_INBOUND_DENIED_MESSAGE = "Claude control request was denied";
export const CLAUDE_CONTROL_INBOUND_FAILED_MESSAGE = "Claude control request failed";
export const CLAUDE_CONTROL_INBOUND_TIMEOUT_MESSAGE = "Claude control request timed out";
export const CLAUDE_CONTROL_INBOUND_UNSUPPORTED_MESSAGE =
  "Claude control request is unsupported";

const NATIVE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ClaudeControlPeerErrorCode =
  | "ABORTED"
  | "CAPACITY"
  | "CLOSED"
  | "ID_COLLISION"
  | "ID_EXHAUSTED"
  | "INVALID_REQUEST"
  | "INVALID_REQUEST_ID"
  | "PROTOCOL_FAULT"
  | "REMOTE_ERROR"
  | "SEND_FAILED"
  | "TIMEOUT"
  | "TIMER_FAILURE";

/** A value-free correlation error. Provider and transport values are never reflected. */
export class ClaudeControlPeerError extends Error {
  readonly code: ClaudeControlPeerErrorCode;

  constructor(code: ClaudeControlPeerErrorCode, message: string) {
    super(message);
    this.name = "ClaudeControlPeerError";
    this.code = code;
  }
}

export type ClaudeControlDiagnosticCode =
  | "ABORT_LISTENER_FAILURE"
  | "CLOSED_CONTROL_ENVELOPE"
  | "DUPLICATE_OUTBOUND_RESPONSE"
  | "INBOUND_CONTROL_CANCELLED"
  | "LATE_OUTBOUND_RESPONSE"
  | "PENDING_REPLAY_UNSUPPORTED"
  | "STALE_INBOUND_CANCEL"
  | "TIMER_CLEAR_FAILURE"
  | "UNKNOWN_OUTBOUND_RESPONSE"
  | "UNSUPPORTED_INBOUND_CONTROL";

/** Diagnostics deliberately contain no request ids, homes, payloads, or provider text. */
export interface ClaudeControlDiagnostic {
  readonly code: ClaudeControlDiagnosticCode;
  readonly direction: "outbound" | "inbound" | "peer";
}

export type ClaudeControlSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type ClaudeControlClearTimeout = (handle: unknown) => void;
export type ClaudeControlEnvelopeSender = (
  value: ClaudeControlJsonObject,
) => Promise<void>;

export interface ClaudeControlRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ClaudeInterruptOptions extends ClaudeControlRequestOptions {
  readonly receiptRequired: boolean;
}

export type ClaudeInboundControlErrorCode =
  | "DENIED"
  | "FAILED"
  | "TIMEOUT"
  | "UNSUPPORTED";

export type ClaudeInboundControlResult =
  | {
    readonly kind: "success";
    readonly response?: ClaudeControlJsonObject;
  }
  | {
    readonly kind: "error";
    readonly error: ClaudeInboundControlErrorCode;
  };

export interface ClaudeInboundControlContext {
  readonly signal: AbortSignal;
  readonly home: string;
  readonly sessionId: string;
  readonly generation: number;
}

export type ClaudeInboundControlHandler = (
  request: ClaudeParsedControlRequest,
  context: ClaudeInboundControlContext,
) => ClaudeInboundControlResult | Promise<ClaudeInboundControlResult>;

export type ClaudeInboundControlResultFactory = (
  request: ClaudeParsedControlRequest,
  context: ClaudeInboundControlContext,
) => ClaudeInboundControlResult;

export interface ClaudeControlPeerOptions {
  readonly configHome: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly sendEnvelope: ClaudeControlEnvelopeSender;
  readonly requestIdFactory: () => string;
  readonly canonicalizeHome?: (home: string) => string;
  readonly setTimeoutFn?: ClaudeControlSetTimeout;
  readonly clearTimeoutFn?: ClaudeControlClearTimeout;
  readonly maxPendingControls?: number;
  readonly maxTombstones?: number;
  readonly outboundTimeoutMs?: number;
  readonly inboundTimeoutMs?: number;
  readonly handleInboundControl?: ClaudeInboundControlHandler;
  readonly createInboundTimeoutResult?: ClaudeInboundControlResultFactory;
  readonly createInboundErrorResult?: ClaudeInboundControlResultFactory;
  readonly onInboundCancellation?: (request: ClaudeParsedControlRequest) => void;
  readonly onDiagnostic?: (diagnostic: ClaudeControlDiagnostic) => void;
  readonly onFault?: (fault: ClaudeControlPeerError) => void;
}

type OutboundTerminalKind = "completed" | "late";
type OutboundSendPhase = "sending" | "sent";

interface PendingOutboundControl {
  readonly resolve: (response: ClaudeControlSuccessResponse) => void;
  readonly reject: (reason: ClaudeControlPeerError) => void;
  phase: OutboundSendPhase;
  stagedResponse?: ClaudeParsedControlResponse;
  timer: unknown;
  timerScheduled: boolean;
  removeAbortListener?: () => void;
}

interface PendingInboundControl {
  readonly request: ClaudeParsedControlRequest;
  readonly fingerprint: string;
  readonly abortController: AbortController;
  readonly context: ClaudeInboundControlContext;
  timer: unknown;
  timerScheduled: boolean;
}

interface TerminalInboundControl {
  readonly fingerprint: string;
  readonly kind: "responded" | "cancelled";
  readonly response?: ClaudeControlJsonObject;
  sending: boolean;
  retransmitQueued: boolean;
}

const peerError = (
  code: ClaudeControlPeerErrorCode,
  message: string,
): ClaudeControlPeerError => new ClaudeControlPeerError(code, message);

const positiveBoundedInteger = (
  name: string,
  value: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
};

const validRequestId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= CLAUDE_CONTROL_MAX_IDENTIFIER_CHARS &&
  value.trim() === value &&
  !value.includes("\u0000");

export class ClaudeControlPeer {
  private readonly configHomeValue: string;
  private readonly sessionIdValue: string;
  private readonly generationValue: number;
  private readonly sendEnvelope: ClaudeControlEnvelopeSender;
  private readonly requestIdFactory: () => string;
  private readonly setTimeoutFn: ClaudeControlSetTimeout;
  private readonly clearTimeoutFn: ClaudeControlClearTimeout;
  private readonly maxPendingControls: number;
  private readonly maxTombstones: number;
  private readonly outboundTimeoutMs: number;
  private readonly inboundTimeoutMs: number;
  private readonly handleInboundControl: ClaudeInboundControlHandler;
  private readonly createInboundTimeoutResult: ClaudeInboundControlResultFactory;
  private readonly createInboundErrorResult: ClaudeInboundControlResultFactory;
  private readonly onInboundCancellation?: (request: ClaudeParsedControlRequest) => void;
  private readonly onDiagnostic?: (diagnostic: ClaudeControlDiagnostic) => void;
  private readonly onFault?: (fault: ClaudeControlPeerError) => void;
  private readonly pendingOutbound = new Map<string, PendingOutboundControl>();
  private readonly outboundTombstones = new Map<string, OutboundTerminalKind>();
  private readonly pendingInbound = new Map<string, PendingInboundControl>();
  private readonly inboundTerminals = new Map<string, TerminalInboundControl>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private closeReason: ClaudeControlPeerError | null = null;

  constructor(options: ClaudeControlPeerOptions) {
    const canonicalizeHome = options.canonicalizeHome ?? canonicalizeProviderHome;
    let canonicalHome: string;
    try {
      canonicalHome = typeof options.configHome === "string"
        ? canonicalizeHome(options.configHome)
        : "";
    } catch {
      throw new TypeError("configHome must be a canonical config home");
    }
    if (
      typeof options.configHome !== "string" ||
      options.configHome.trim() !== options.configHome ||
      options.configHome.includes("\u0000") ||
      !path.isAbsolute(options.configHome) ||
      canonicalHome !== options.configHome
    ) {
      throw new TypeError("configHome must be a canonical config home");
    }
    if (typeof options.sessionId !== "string" || !NATIVE_SESSION_UUID.test(options.sessionId)) {
      throw new TypeError("sessionId must be a native session UUID");
    }
    positiveBoundedInteger("generation", options.generation);
    if (typeof options.sendEnvelope !== "function") {
      throw new TypeError("sendEnvelope must be a function");
    }
    if (typeof options.requestIdFactory !== "function") {
      throw new TypeError("requestIdFactory must be a function");
    }
    if (options.setTimeoutFn !== undefined && typeof options.setTimeoutFn !== "function") {
      throw new TypeError("setTimeoutFn must be a function");
    }
    if (options.clearTimeoutFn !== undefined && typeof options.clearTimeoutFn !== "function") {
      throw new TypeError("clearTimeoutFn must be a function");
    }
    if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== "function") {
      throw new TypeError("onDiagnostic must be a function");
    }
    if (options.onFault !== undefined && typeof options.onFault !== "function") {
      throw new TypeError("onFault must be a function");
    }
    if (
      options.handleInboundControl !== undefined &&
      typeof options.handleInboundControl !== "function"
    ) {
      throw new TypeError("handleInboundControl must be a function");
    }
    if (
      options.createInboundTimeoutResult !== undefined &&
      typeof options.createInboundTimeoutResult !== "function"
    ) {
      throw new TypeError("createInboundTimeoutResult must be a function");
    }
    if (
      options.createInboundErrorResult !== undefined &&
      typeof options.createInboundErrorResult !== "function"
    ) {
      throw new TypeError("createInboundErrorResult must be a function");
    }
    if (
      options.onInboundCancellation !== undefined &&
      typeof options.onInboundCancellation !== "function"
    ) {
      throw new TypeError("onInboundCancellation must be a function");
    }

    this.configHomeValue = canonicalHome;
    this.sessionIdValue = options.sessionId;
    this.generationValue = options.generation;
    this.sendEnvelope = options.sendEnvelope;
    this.requestIdFactory = options.requestIdFactory;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.maxPendingControls = positiveBoundedInteger(
      "maxPendingControls",
      options.maxPendingControls ?? CLAUDE_CONTROL_DEFAULT_MAX_PENDING,
      CLAUDE_CONTROL_HARD_MAX_PENDING,
    );
    this.maxTombstones = positiveBoundedInteger(
      "maxTombstones",
      options.maxTombstones ?? CLAUDE_CONTROL_MAX_TOMBSTONES,
      CLAUDE_CONTROL_MAX_TOMBSTONES,
    );
    this.outboundTimeoutMs = positiveBoundedInteger(
      "outboundTimeoutMs",
      options.outboundTimeoutMs ?? CLAUDE_CONTROL_DEFAULT_OUTBOUND_TIMEOUT_MS,
    );
    this.inboundTimeoutMs = positiveBoundedInteger(
      "inboundTimeoutMs",
      options.inboundTimeoutMs ?? CLAUDE_CONTROL_DEFAULT_INBOUND_TIMEOUT_MS,
      CLAUDE_CONTROL_MAX_INBOUND_TIMEOUT_MS,
    );
    this.handleInboundControl = options.handleInboundControl ?? (() => ({
      kind: "error",
      error: "UNSUPPORTED",
    }));
    this.createInboundTimeoutResult = options.createInboundTimeoutResult ?? (() => ({
      kind: "error",
      error: "TIMEOUT",
    }));
    this.createInboundErrorResult = options.createInboundErrorResult ?? (() => ({
      kind: "error",
      error: "FAILED",
    }));
    this.onInboundCancellation = options.onInboundCancellation;
    this.onDiagnostic = options.onDiagnostic;
    this.onFault = options.onFault;
  }

  get configHome(): string {
    return this.configHomeValue;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  get closed(): boolean {
    return this.closeReason !== null;
  }

  get pendingRequestCount(): number {
    return this.pendingOutbound.size;
  }

  get outboundTombstoneCount(): number {
    return this.outboundTombstones.size;
  }

  get pendingInboundRequestCount(): number {
    return this.pendingInbound.size;
  }

  get inboundTerminalCount(): number {
    return this.inboundTerminals.size;
  }

  get backgroundTaskCount(): number {
    return this.backgroundTasks.size;
  }

  request(
    inner: unknown,
    options: ClaudeControlRequestOptions = {},
  ): Promise<ClaudeControlSuccessResponse> {
    if (this.closeReason) return Promise.reject(this.closeReason);
    if (options.signal?.aborted) {
      return Promise.reject(peerError("ABORTED", "Claude control request was aborted"));
    }

    let timeoutMs: number;
    try {
      timeoutMs = positiveBoundedInteger(
        "timeoutMs",
        options.timeoutMs ?? this.outboundTimeoutMs,
      );
    } catch {
      return Promise.reject(peerError("INVALID_REQUEST", "Claude control request is invalid"));
    }
    if (this.totalPendingControls() >= this.maxPendingControls) {
      return Promise.reject(peerError(
        "CAPACITY",
        "Claude control pending request capacity is exhausted",
      ));
    }
    if (this.totalReservedControls() >= this.maxTombstones) {
      return Promise.reject(peerError(
        "ID_EXHAUSTED",
        "Claude control request id reservations are exhausted for this generation",
      ));
    }

    let requestId: unknown;
    try {
      requestId = this.requestIdFactory();
    } catch {
      return Promise.reject(peerError(
        "INVALID_REQUEST_ID",
        "Claude control request id creation failed",
      ));
    }
    if (!validRequestId(requestId)) {
      return Promise.reject(peerError(
        "INVALID_REQUEST_ID",
        "Claude control request id is invalid",
      ));
    }
    if (this.pendingOutbound.has(requestId) || this.outboundTombstones.has(requestId)) {
      return Promise.reject(peerError(
        "ID_COLLISION",
        "Claude control request id is not unique",
      ));
    }

    let envelope: ClaudeControlJsonObject;
    try {
      envelope = buildClaudeControlRequest(requestId, inner);
    } catch {
      return Promise.reject(peerError("INVALID_REQUEST", "Claude control request is invalid"));
    }

    let resolvePromise!: (response: ClaudeControlSuccessResponse) => void;
    let rejectPromise!: (reason: ClaudeControlPeerError) => void;
    const promise = new Promise<ClaudeControlSuccessResponse>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingOutboundControl = {
      resolve: resolvePromise,
      reject: rejectPromise,
      phase: "sending",
      timer: undefined,
      timerScheduled: false,
    };
    this.pendingOutbound.set(requestId, pending);

    try {
      const timer = this.setTimeoutFn(() => {
        this.settleLocalFailure(
          requestId,
          pending,
          peerError("TIMEOUT", "Claude control request timed out"),
        );
      }, timeoutMs);
      pending.timer = timer;
      pending.timerScheduled = true;
      if (this.pendingOutbound.get(requestId) !== pending) this.safeClearTimer(timer);
    } catch {
      if (this.pendingOutbound.get(requestId) === pending) {
        if (this.transitionPendingToTerminal(requestId, pending, "late")) {
          pending.reject(peerError(
            "TIMER_FAILURE",
            "Claude control request deadline could not be scheduled",
          ));
        }
      }
      return promise;
    }
    if (this.pendingOutbound.get(requestId) !== pending) return promise;

    if (options.signal) {
      const signal = options.signal;
      const onAbort = (): void => {
        this.settleLocalFailure(
          requestId,
          pending,
          peerError("ABORTED", "Claude control request was aborted"),
        );
      };
      try {
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      } catch {
        this.settleLocalFailure(
          requestId,
          pending,
          peerError("ABORTED", "Claude control request was aborted"),
        );
        this.diagnostic("ABORT_LISTENER_FAILURE", "outbound");
      }
      if (signal.aborted) onAbort();
    }
    if (this.pendingOutbound.get(requestId) !== pending) return promise;

    let sending: Promise<void>;
    try {
      sending = Promise.resolve(this.sendEnvelope(envelope));
    } catch {
      this.failPeer(peerError("SEND_FAILED", "Claude control envelope send failed"));
      return promise;
    }
    void sending.then(
      () => this.confirmOutboundSend(requestId, pending),
      () => this.failPeer(peerError("SEND_FAILED", "Claude control envelope send failed")),
    );
    return promise;
  }

  async interrupt(options: ClaudeInterruptOptions): Promise<readonly string[] | undefined> {
    if (!options || typeof options.receiptRequired !== "boolean") {
      throw peerError("INVALID_REQUEST", "Claude interrupt options are invalid");
    }
    const result = await this.request(
      { subtype: "interrupt" },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    );
    return this.validateInterruptReceipt(result.response, options.receiptRequired);
  }

  private validateInterruptReceipt(
    response: ClaudeControlJsonObject | undefined,
    required: boolean,
  ): readonly string[] | undefined {
    if (response === undefined || Object.keys(response).length === 0) {
      if (required) throw this.interruptReceiptFault();
      return undefined;
    }
    if (Object.keys(response).length !== 1 || !("still_queued" in response)) {
      throw this.interruptReceiptFault();
    }
    const queued = response.still_queued;
    if (
      !Array.isArray(queued) ||
      queued.length > CLAUDE_CONTROL_MAX_INTERRUPT_RECEIPT_ITEMS ||
      queued.some((value) =>
        typeof value !== "string" || value.trim().length === 0 ||
        value.length > CLAUDE_CONTROL_MAX_IDENTIFIER_CHARS ||
        /[\u0000-\u001f\u007f]/u.test(value))
    ) {
      throw this.interruptReceiptFault();
    }
    return Object.freeze([...queued]) as readonly string[];
  }

  receive(decodedEnvelope: unknown): boolean {
    let classified;
    try {
      classified = classifyClaudeControlEnvelope(decodedEnvelope);
    } catch {
      const fault = peerError("PROTOCOL_FAULT", "Claude control envelope is invalid");
      this.failPeer(fault);
      throw fault;
    }
    if (classified.kind === "not-control") return false;
    if (this.closeReason) {
      this.diagnostic("CLOSED_CONTROL_ENVELOPE", "peer");
      return true;
    }
    if (classified.kind === "control-request") {
      this.receiveInboundRequest(classified);
      return true;
    }
    if (classified.kind === "control-cancel-request") {
      this.receiveInboundCancel(classified.requestId);
      return true;
    }
    this.receiveOutboundResponse(classified.response);
    return true;
  }

  close(): void {
    if (this.closeReason) return;
    this.closeWith(peerError("CLOSED", "Claude control peer is closed"));
  }

  private receiveInboundRequest(request: ClaudeParsedControlRequest): void {
    let fingerprint: string;
    try {
      // The snapshot preserves wire key order, so this is deliberately a byte-level
      // replay fingerprint rather than a semantic/canonical JSON comparison.
      fingerprint = createHash("sha256")
        .update(JSON.stringify(request.raw), "utf8")
        .digest("hex");
    } catch {
      this.throwInboundFault("PROTOCOL_FAULT", "Claude inbound control fingerprint failed");
    }

    const pending = this.pendingInbound.get(request.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        this.throwInboundFault("PROTOCOL_FAULT", "Claude inbound control id was reused");
      }
      return;
    }

    const terminal = this.inboundTerminals.get(request.requestId);
    if (terminal) {
      if (terminal.fingerprint !== fingerprint) {
        this.throwInboundFault("PROTOCOL_FAULT", "Claude inbound control id was reused");
      }
      if (terminal.kind === "responded") {
        this.sendInboundTerminal(request.requestId, terminal);
      }
      return;
    }

    if (this.totalPendingControls() >= this.maxPendingControls) {
      this.throwInboundFault("CAPACITY", "Claude control pending request capacity is exhausted");
    }
    if (this.totalReservedControls() >= this.maxTombstones) {
      this.throwInboundFault(
        "ID_EXHAUSTED",
        "Claude control request id reservations are exhausted for this generation",
      );
    }

    const abortController = new AbortController();
    const context = Object.freeze({
      signal: abortController.signal,
      home: this.configHomeValue,
      sessionId: this.sessionIdValue,
      generation: this.generationValue,
    });
    const installed: PendingInboundControl = {
      request,
      fingerprint,
      abortController,
      context,
      timer: undefined,
      timerScheduled: false,
    };
    this.pendingInbound.set(request.requestId, installed);

    try {
      const timer = this.setTimeoutFn(() => {
        this.settleInboundFromFactory(
          request.requestId,
          installed,
          this.createInboundTimeoutResult,
          true,
        );
      }, this.inboundTimeoutMs);
      installed.timer = timer;
      installed.timerScheduled = true;
      if (this.pendingInbound.get(request.requestId) !== installed) this.safeClearTimer(timer);
    } catch {
      this.settleInboundFromFactory(
        request.requestId,
        installed,
        this.createInboundTimeoutResult,
        true,
      );
      return;
    }
    if (this.pendingInbound.get(request.requestId) !== installed || this.closeReason) return;

    const task = Promise.resolve().then(async () => {
      if (this.pendingInbound.get(request.requestId) !== installed || this.closeReason) return;
      let result: ClaudeInboundControlResult;
      try {
        result = await this.handleInboundControl(request, context);
      } catch {
        this.settleInboundFromFactory(
          request.requestId,
          installed,
          this.createInboundErrorResult,
          false,
        );
        return;
      }
      this.settleInboundResult(request.requestId, installed, result);
    }).catch(() => {
      this.settleInboundFromFactory(
        request.requestId,
        installed,
        this.createInboundErrorResult,
        false,
      );
    });
    this.trackBackgroundTask(task);
  }

  private receiveInboundCancel(requestId: string): void {
    const pending = this.pendingInbound.get(requestId);
    if (!pending) {
      this.diagnostic("STALE_INBOUND_CANCEL", "inbound");
      return;
    }
    this.pendingInbound.delete(requestId);
    this.inboundTerminals.set(requestId, {
      fingerprint: pending.fingerprint,
      kind: "cancelled",
      sending: false,
      retransmitQueued: false,
    });
    this.cleanupPendingInbound(pending);
    this.safeAbortInbound(pending);
    this.diagnostic("INBOUND_CONTROL_CANCELLED", "inbound");
    try {
      this.onInboundCancellation?.(pending.request);
    } catch {
      // Cancellation observers cannot affect fail-closed lifecycle ownership.
    }
  }

  private settleInboundResult(
    requestId: string,
    pending: PendingInboundControl,
    result: ClaudeInboundControlResult,
  ): void {
    if (this.pendingInbound.get(requestId) !== pending || this.closeReason) return;
    let response: ClaudeControlJsonObject;
    try {
      response = this.buildInboundResponse(requestId, result);
    } catch {
      this.settleInboundFromFactory(
        requestId,
        pending,
        this.createInboundErrorResult,
        false,
      );
      return;
    }
    if (this.pendingInbound.get(requestId) !== pending || this.closeReason) return;
    this.pendingInbound.delete(requestId);
    const terminal: TerminalInboundControl = {
      fingerprint: pending.fingerprint,
      kind: "responded",
      response,
      sending: false,
      retransmitQueued: false,
    };
    // Reserve and cache the exact immutable response before cleanup or send can re-enter.
    this.inboundTerminals.set(requestId, terminal);
    this.cleanupPendingInbound(pending);
    this.sendInboundTerminal(requestId, terminal);
  }

  private settleInboundFromFactory(
    requestId: string,
    pending: PendingInboundControl,
    factory: ClaudeInboundControlResultFactory,
    abort: boolean,
  ): void {
    if (this.pendingInbound.get(requestId) !== pending || this.closeReason) return;
    let response: ClaudeControlJsonObject;
    try {
      response = this.buildInboundResponse(
        requestId,
        factory(pending.request, pending.context),
      );
    } catch {
      response = buildClaudeControlErrorResponse(
        requestId,
        CLAUDE_CONTROL_INBOUND_FAILED_MESSAGE,
      );
    }
    if (this.pendingInbound.get(requestId) !== pending || this.closeReason) return;
    this.pendingInbound.delete(requestId);
    const terminal: TerminalInboundControl = {
      fingerprint: pending.fingerprint,
      kind: "responded",
      response,
      sending: false,
      retransmitQueued: false,
    };
    this.inboundTerminals.set(requestId, terminal);
    this.cleanupPendingInbound(pending);
    if (abort) this.safeAbortInbound(pending);
    this.sendInboundTerminal(requestId, terminal);
  }

  private buildInboundResponse(
    requestId: string,
    supplied: ClaudeInboundControlResult,
  ): ClaudeControlJsonObject {
    if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied)) {
      throw new TypeError("inbound result must be an object");
    }
    const prototype = Object.getPrototypeOf(supplied);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("inbound result must be a plain object");
    }
    const keys = Reflect.ownKeys(supplied);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("inbound result keys must be strings");
    }
    const descriptors = Object.getOwnPropertyDescriptors(supplied);
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
      throw new TypeError("inbound result accessors are forbidden");
    }
    const kind = descriptors.kind?.value;
    if (kind === "success") {
      if (keys.some((key) => key !== "kind" && key !== "response")) {
        throw new TypeError("inbound success result has unknown keys");
      }
      if (!("response" in descriptors)) return buildClaudeControlSuccessResponse(requestId);
      return buildClaudeControlSuccessResponse(requestId, {
        response: descriptors.response?.value,
      });
    }
    if (kind === "error") {
      if (keys.length !== 2 || !keys.includes("error")) {
        throw new TypeError("inbound error result has invalid keys");
      }
      const code = descriptors.error?.value;
      const message = code === "DENIED"
        ? CLAUDE_CONTROL_INBOUND_DENIED_MESSAGE
        : code === "FAILED"
          ? CLAUDE_CONTROL_INBOUND_FAILED_MESSAGE
          : code === "TIMEOUT"
            ? CLAUDE_CONTROL_INBOUND_TIMEOUT_MESSAGE
            : code === "UNSUPPORTED"
              ? CLAUDE_CONTROL_INBOUND_UNSUPPORTED_MESSAGE
              : null;
      if (!message) throw new TypeError("inbound error code is invalid");
      return buildClaudeControlErrorResponse(requestId, message);
    }
    throw new TypeError("inbound result kind is invalid");
  }

  private sendInboundTerminal(requestId: string, terminal: TerminalInboundControl): void {
    if (
      this.closeReason ||
      terminal.kind !== "responded" ||
      !terminal.response ||
      this.inboundTerminals.get(requestId) !== terminal
    ) return;
    if (terminal.sending) {
      terminal.retransmitQueued = true;
      return;
    }
    terminal.sending = true;
    let sending: Promise<void>;
    try {
      sending = Promise.resolve(this.sendEnvelope(terminal.response));
    } catch {
      terminal.sending = false;
      this.failPeer(peerError("SEND_FAILED", "Claude control envelope send failed"));
      return;
    }
    const task = sending.then(
      () => {
        terminal.sending = false;
        if (
          this.closeReason ||
          this.inboundTerminals.get(requestId) !== terminal ||
          !terminal.retransmitQueued
        ) return;
        terminal.retransmitQueued = false;
        this.sendInboundTerminal(requestId, terminal);
      },
      () => {
        terminal.sending = false;
        terminal.retransmitQueued = false;
        this.failPeer(peerError("SEND_FAILED", "Claude control envelope send failed"));
      },
    );
    this.trackBackgroundTask(task);
  }

  private cleanupPendingInbound(pending: PendingInboundControl): void {
    if (pending.timerScheduled) this.safeClearTimer(pending.timer);
  }

  private safeAbortInbound(pending: PendingInboundControl): void {
    try {
      pending.abortController.abort();
    } catch {
      this.diagnostic("ABORT_LISTENER_FAILURE", "inbound");
    }
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    }).catch(() => {
      // Every task is already contained; this only absorbs hostile Promise subclasses.
    });
  }

  private throwInboundFault(
    code: "CAPACITY" | "ID_EXHAUSTED" | "PROTOCOL_FAULT",
    message: string,
  ): never {
    const fault = peerError(code, message);
    this.failPeer(fault);
    throw fault;
  }

  private receiveOutboundResponse(response: ClaudeParsedControlResponse): void {
    const requestId = response.requestId;
    const pending = this.pendingOutbound.get(requestId);
    if (!pending) {
      const terminal = this.outboundTombstones.get(requestId);
      this.diagnostic(
        terminal === "completed"
          ? "DUPLICATE_OUTBOUND_RESPONSE"
          : terminal === "late"
            ? "LATE_OUTBOUND_RESPONSE"
            : "UNKNOWN_OUTBOUND_RESPONSE",
        "outbound",
      );
      return;
    }
    if (pending.stagedResponse) {
      this.diagnostic("DUPLICATE_OUTBOUND_RESPONSE", "outbound");
      return;
    }
    if (pending.phase === "sending") {
      pending.stagedResponse = response;
      return;
    }
    this.settleOutboundResponse(requestId, pending, response);
  }

  private confirmOutboundSend(requestId: string, pending: PendingOutboundControl): void {
    if (this.pendingOutbound.get(requestId) !== pending || this.closeReason) return;
    pending.phase = "sent";
    const staged = pending.stagedResponse;
    if (staged) this.settleOutboundResponse(requestId, pending, staged);
  }

  private settleOutboundResponse(
    requestId: string,
    pending: PendingOutboundControl,
    response: ClaudeParsedControlResponse,
  ): void {
    if (!this.transitionPendingToTerminal(requestId, pending, "completed")) return;
    const pendingReplay = [
      ...(response.pendingPermissionRequests ?? []),
      ...(response.pendingUserDialogRequests ?? []),
    ];
    if (response.kind === "error") {
      pending.reject(peerError("REMOTE_ERROR", "Claude control request failed remotely"));
    } else {
      pending.resolve(response);
    }
    this.schedulePendingReplay(pendingReplay);
  }

  private schedulePendingReplay(requests: readonly ClaudeParsedControlRequest[]): void {
    if (requests.length === 0 || this.closeReason) return;
    const task = Promise.resolve().then(() => {
      if (this.closeReason) return;
      try {
        for (const request of requests) {
          if (this.closeReason) return;
          this.receiveInboundRequest(request);
        }
      } catch (error) {
        if (!this.closeReason) {
          this.failPeer(
            error instanceof ClaudeControlPeerError
              ? error
              : peerError("PROTOCOL_FAULT", "Claude pending control replay failed"),
          );
        }
      }
    });
    this.trackBackgroundTask(task);
  }

  private settleLocalFailure(
    requestId: string,
    pending: PendingOutboundControl,
    error: ClaudeControlPeerError,
  ): void {
    if (!this.transitionPendingToTerminal(requestId, pending, "late")) return;
    pending.reject(error);
  }

  private transitionPendingToTerminal(
    requestId: string,
    pending: PendingOutboundControl,
    kind: OutboundTerminalKind,
  ): boolean {
    if (this.pendingOutbound.get(requestId) !== pending) return false;
    this.pendingOutbound.delete(requestId);
    this.rememberTombstone(requestId, kind);
    this.cleanupPending(pending);
    return true;
  }

  private cleanupPending(pending: PendingOutboundControl): void {
    if (pending.timerScheduled) this.safeClearTimer(pending.timer);
    if (pending.removeAbortListener) {
      try {
        pending.removeAbortListener();
      } catch {
        this.diagnostic("ABORT_LISTENER_FAILURE", "outbound");
      }
    }
  }

  private rememberTombstone(requestId: string, kind: OutboundTerminalKind): void {
    this.outboundTombstones.set(requestId, kind);
  }

  private totalPendingControls(): number {
    return this.pendingOutbound.size + this.pendingInbound.size;
  }

  private totalReservedControls(): number {
    return this.pendingOutbound.size +
      this.outboundTombstones.size +
      this.pendingInbound.size +
      this.inboundTerminals.size;
  }

  private safeClearTimer(handle: unknown): void {
    try {
      this.clearTimeoutFn(handle);
    } catch {
      this.diagnostic("TIMER_CLEAR_FAILURE", "peer");
    }
  }

  private interruptReceiptFault(): ClaudeControlPeerError {
    const fault = peerError("PROTOCOL_FAULT", "Claude interrupt receipt is invalid");
    this.failPeer(fault);
    return fault;
  }

  private diagnostic(
    code: ClaudeControlDiagnosticCode,
    direction: ClaudeControlDiagnostic["direction"],
  ): void {
    try {
      this.onDiagnostic?.(Object.freeze({ code, direction }));
    } catch {
      // Diagnostic hooks cannot affect correlation state.
    }
  }

  private failPeer(fault: ClaudeControlPeerError): void {
    if (this.closeReason) return;
    this.closeWith(fault);
    try {
      this.onFault?.(fault);
    } catch {
      // Fault hooks cannot keep an uncertain peer alive.
    }
  }

  private closeWith(reason: ClaudeControlPeerError): void {
    if (this.closeReason) return;
    this.closeReason = reason;
    for (const [requestId, pending] of [...this.pendingOutbound]) {
      if (this.pendingOutbound.get(requestId) !== pending) continue;
      this.pendingOutbound.delete(requestId);
      this.cleanupPending(pending);
      pending.reject(reason);
    }
    for (const [requestId, pending] of [...this.pendingInbound]) {
      if (this.pendingInbound.get(requestId) !== pending) continue;
      this.pendingInbound.delete(requestId);
      this.cleanupPendingInbound(pending);
      this.safeAbortInbound(pending);
    }
    this.outboundTombstones.clear();
    this.inboundTerminals.clear();
  }
}
