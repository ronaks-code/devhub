import {
  BoundedCodexIngressQueue,
  type CodexIngressLimits,
} from "./bounded-queue.js";
import {
  isCodexServerNotificationMethod,
  isCodexServerRequestMethod,
} from "./contract.js";
import {
  isCodexRpcError,
  isCodexRpcNotification,
  isCodexRpcRequest,
  serializeCodexRpcId,
  type CodexRpcEnvelope,
  type CodexRpcErrorBody,
  type CodexRpcNotification,
  type CodexRpcRequest,
} from "./envelope.js";
import {
  assertCodexFallbackParams,
  assertCodexFallbackResult,
} from "./fallback-shapes.js";
import { CodexProtocolFault } from "./fault.js";
import { CodexJsonlDecoder, type CodexJsonlDecoderOptions } from "./jsonl-decoder.js";
import {
  BoundedCodexJsonlWriter,
  type CodexAsyncWrite,
  type CodexOutboundLimits,
} from "./jsonl-writer.js";

export const CODEX_DEFAULT_MAX_CLIENT_REQUESTS = 512;
export const CODEX_DEFAULT_MAX_SERVER_REQUESTS = 512;
export const CODEX_DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const CODEX_DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 30 * 1000;
export const CODEX_DEFAULT_NOTIFICATION_TIMEOUT_MS = 30 * 1000;
export const CODEX_MAX_SETTLED_SERVER_REQUESTS = 4096;
const CODEX_MAX_RESPONSE_TOMBSTONES = 4096;

export interface CodexServerRequestContext {
  readonly signal: AbortSignal;
}

export interface CodexNotificationContext {
  readonly signal: AbortSignal;
}

export type CodexNotificationHandler = (
  notification: CodexRpcNotification,
  context: CodexNotificationContext,
) => void | Promise<void>;

export type CodexServerRequestHandler = (
  request: CodexRpcRequest,
  context: CodexServerRequestContext,
) => unknown | Promise<unknown>;

export type CodexSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type CodexClearTimeout = (handle: unknown) => void;

export interface CodexClientCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CodexRpcPeerOptions {
  readonly write: CodexAsyncWrite;
  readonly decoder?: CodexJsonlDecoderOptions;
  readonly ingressLimits?: CodexIngressLimits;
  readonly outboundLimits?: CodexOutboundLimits;
  readonly pauseIngress?: () => void;
  readonly resumeIngress?: () => void;
  readonly onNotification?: CodexNotificationHandler;
  readonly onUnknownNotification?: CodexNotificationHandler;
  readonly onServerRequest?: CodexServerRequestHandler;
  readonly onProtocolFault?: (fault: CodexProtocolFault) => void;
  readonly maxPendingClientRequests?: number;
  readonly maxConcurrentServerRequests?: number;
  readonly maxSettledServerRequests?: number;
  readonly serverRequestTimeoutMs?: number;
  readonly clientRequestTimeoutMs?: number;
  readonly notificationTimeoutMs?: number;
  readonly initialRequestId?: number;
  readonly setTimeoutFn?: CodexSetTimeout;
  readonly clearTimeoutFn?: CodexClearTimeout;
}

interface PendingClientRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  timer: unknown;
  timerScheduled: boolean;
  removeAbortListener?: () => void;
}

interface ActiveServerRequest {
  readonly controller: AbortController;
}

type ServerRequestOutcome =
  | { readonly type: "result"; readonly result: unknown }
  | { readonly type: "error"; readonly code: number; readonly message: string };

class CodexServerRequestTimeoutError extends Error {}
class CodexNotificationTimeoutError extends Error {}

export class CodexRemoteRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: CodexRpcErrorBody) {
    super(error.message);
    this.name = "CodexRemoteRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

const assertPositiveLimit = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
};

const closedFault = (cause?: unknown): CodexProtocolFault =>
  cause instanceof CodexProtocolFault && cause.code === "PEER_CLOSED"
    ? cause
    : new CodexProtocolFault("PEER_CLOSED", "Codex RPC peer is closed", { cause });

export class CodexRpcPeer {
  private readonly decoder: CodexJsonlDecoder;
  private readonly ingress: BoundedCodexIngressQueue<CodexRpcEnvelope>;
  private readonly writer: BoundedCodexJsonlWriter;
  private readonly onNotification?: CodexNotificationHandler;
  private readonly onUnknownNotification?: CodexNotificationHandler;
  private readonly onServerRequest?: CodexServerRequestHandler;
  private readonly onProtocolFault?: (fault: CodexProtocolFault) => void;
  private readonly maxPendingClientRequests: number;
  private readonly maxConcurrentServerRequests: number;
  private readonly maxSettledServerRequests: number;
  private readonly serverRequestTimeoutMs: number;
  private readonly clientRequestTimeoutMs: number;
  private readonly notificationTimeoutMs: number;
  private readonly setTimeoutFn: CodexSetTimeout;
  private readonly clearTimeoutFn: CodexClearTimeout;
  private readonly pendingClient = new Map<string, PendingClientRequest>();
  private readonly settledClientIds = new Set<string>();
  private readonly settledClientOrder: string[] = [];
  private readonly activeServer = new Map<string, ActiveServerRequest>();
  private readonly activeNotifications = new Set<AbortController>();
  private readonly inflightServerIds = new Set<string>();
  private readonly settledServerIds = new Set<string>();
  private readonly serverTasks = new Set<Promise<void>>();
  private ingressDrain: Promise<void> | null = null;
  private ingressFinished = false;
  private ingressEndingReason: CodexProtocolFault | null = null;
  private nextRequestId: number | null;
  private closeReason: CodexProtocolFault | null = null;
  private faultReported = false;

  constructor(options: CodexRpcPeerOptions) {
    const maxPending = options.maxPendingClientRequests ?? CODEX_DEFAULT_MAX_CLIENT_REQUESTS;
    const maxServer = options.maxConcurrentServerRequests ?? CODEX_DEFAULT_MAX_SERVER_REQUESTS;
    const maxSettledServer = options.maxSettledServerRequests ??
      CODEX_MAX_SETTLED_SERVER_REQUESTS;
    const timeout = options.serverRequestTimeoutMs ?? CODEX_DEFAULT_SERVER_REQUEST_TIMEOUT_MS;
    const clientTimeout = options.clientRequestTimeoutMs ??
      CODEX_DEFAULT_CLIENT_REQUEST_TIMEOUT_MS;
    const notificationTimeout = options.notificationTimeoutMs ??
      CODEX_DEFAULT_NOTIFICATION_TIMEOUT_MS;
    const initialId = options.initialRequestId ?? 1;
    assertPositiveLimit("maxPendingClientRequests", maxPending);
    assertPositiveLimit("maxConcurrentServerRequests", maxServer);
    assertPositiveLimit("maxSettledServerRequests", maxSettledServer);
    assertPositiveLimit("serverRequestTimeoutMs", timeout);
    assertPositiveLimit("clientRequestTimeoutMs", clientTimeout);
    assertPositiveLimit("notificationTimeoutMs", notificationTimeout);
    if (!Number.isSafeInteger(initialId) || initialId < 0) {
      throw new RangeError("initialRequestId must be a non-negative safe integer");
    }

    this.decoder = new CodexJsonlDecoder(options.decoder);
    this.ingress = new BoundedCodexIngressQueue({
      limits: options.ingressLimits,
      onPause: options.pauseIngress,
      onResume: options.resumeIngress,
    });
    this.writer = new BoundedCodexJsonlWriter(
      options.write,
      options.outboundLimits,
      this.decoder.maxLineBytes,
    );
    this.onNotification = options.onNotification;
    this.onUnknownNotification = options.onUnknownNotification;
    this.onServerRequest = options.onServerRequest;
    this.onProtocolFault = options.onProtocolFault;
    this.maxPendingClientRequests = maxPending;
    this.maxConcurrentServerRequests = maxServer;
    this.maxSettledServerRequests = maxSettledServer;
    this.serverRequestTimeoutMs = timeout;
    this.clientRequestTimeoutMs = clientTimeout;
    this.notificationTimeoutMs = notificationTimeout;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.nextRequestId = initialId;
  }

  get closed(): boolean {
    return this.closeReason !== null;
  }

  get pendingClientRequests(): number {
    return this.pendingClient.size;
  }

  get activeServerRequests(): number {
    return this.activeServer.size;
  }

  get settledServerRequests(): number {
    return this.settledServerIds.size;
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    options: CodexClientCallOptions = {},
  ): Promise<T> {
    const terminal = this.terminalReason();
    if (terminal) return Promise.reject(terminal);
    try {
      assertCodexFallbackParams("client-request", method, params);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) {
      return Promise.reject(new CodexProtocolFault(
        "REQUEST_CANCELLED",
        `Codex RPC ${method} was cancelled before enqueue`,
        { cause: options.signal.reason },
      ));
    }
    const timeoutMs = options.timeoutMs ?? this.clientRequestTimeoutMs;
    try {
      assertPositiveLimit("client call timeoutMs", timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pendingClient.size >= this.maxPendingClientRequests) {
      return Promise.reject(new CodexProtocolFault(
        "REQUEST_LIMIT",
        `Codex RPC peer has ${this.maxPendingClientRequests} pending client requests`,
      ));
    }
    if (this.nextRequestId === null) {
      return Promise.reject(new CodexProtocolFault(
        "ID_EXHAUSTED",
        "Codex RPC request id space is exhausted",
      ));
    }

    const id = this.nextRequestId;
    this.nextRequestId = id === Number.MAX_SAFE_INTEGER ? null : id + 1;
    const key = serializeCodexRpcId(id);
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingClientRequest = {
      method,
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
      timer: undefined,
      timerScheduled: false,
    };
    this.pendingClient.set(key, pending);
    try {
      pending.timer = this.setTimeoutFn(() => {
        if (this.pendingClient.get(key) !== pending) return;
        this.failPeer(new CodexProtocolFault(
          "PEER_CLOSED",
          `Codex RPC ${method} timed out after enqueue; mutation outcome is uncertain`,
        ));
      }, timeoutMs);
      pending.timerScheduled = true;
    } catch (error) {
      this.deletePendingClient(key, pending);
      pending.reject(error);
      return promise;
    }
    if (options.signal) {
      const onAbort = (): void => {
        if (this.pendingClient.get(key) !== pending) return;
        this.failPeer(new CodexProtocolFault(
          "PEER_CLOSED",
          `Codex RPC ${method} was cancelled after enqueue; mutation outcome is uncertain`,
          { cause: options.signal?.reason },
        ));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      pending.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    }

    const envelope: CodexRpcRequest = params === undefined
      ? { id, method }
      : { id, method, params };
    void this.writer.send(envelope).catch((error: unknown) => {
      if (this.pendingClient.get(key) === pending) {
        this.deletePendingClient(key, pending);
        pending.reject(error);
      }
      this.failPeer(closedFault(error));
    });
    return promise;
  }

  notify(method: string, params?: unknown): Promise<void> {
    const terminal = this.terminalReason();
    if (terminal) return Promise.reject(terminal);
    try {
      assertCodexFallbackParams("client-notification", method, params);
    } catch (error) {
      return Promise.reject(error);
    }
    const notification: CodexRpcNotification = params === undefined
      ? { method }
      : { method, params };
    return this.writer.send(notification).catch((error: unknown) => {
      this.failPeer(closedFault(error));
      throw error;
    });
  }

  async receive(chunk: string | Uint8Array): Promise<void> {
    const terminal = this.terminalReason();
    if (terminal) throw terminal;
    try {
      this.decoder.push(chunk, ({ envelope, frameBytes }) => {
        this.ingress.enqueue(envelope, frameBytes);
      });
      await this.drainIngress();
    } catch (error) {
      const fault = error instanceof CodexProtocolFault
        ? error
        : new CodexProtocolFault("INVALID_ENVELOPE", "Codex RPC ingress failed", {
          cause: error,
        });
      this.failPeer(fault);
      throw fault;
    }
  }

  async finishIngress(): Promise<void> {
    if (this.ingressFinished || this.closeReason) return;
    this.ingressFinished = true;
    this.ingressEndingReason = new CodexProtocolFault(
      "PEER_CLOSED",
      "Codex stdout reached EOF",
    );
    for (const controller of this.activeNotifications) {
      controller.abort(this.ingressEndingReason);
    }
    for (const { controller } of this.activeServer.values()) {
      controller.abort(this.ingressEndingReason);
    }
    try {
      if (this.ingressDrain) await this.ingressDrain;
      this.decoder.finish();
      this.close(this.ingressEndingReason);
      while (this.serverTasks.size > 0) {
        await Promise.all([...this.serverTasks]);
      }
    } catch (error) {
      const fault = error instanceof CodexProtocolFault
        ? error
        : new CodexProtocolFault("INVALID_ENVELOPE", "Codex RPC EOF handling failed", {
          cause: error,
        });
      this.failPeer(fault);
      throw fault;
    }
  }

  close(cause?: unknown): void {
    if (this.closeReason) return;
    this.closeReason = closedFault(cause);
    this.ingress.clear();
    for (const controller of this.activeNotifications) controller.abort(this.closeReason);
    for (const { controller } of this.activeServer.values()) controller.abort(this.closeReason);
    for (const [key, pending] of [...this.pendingClient.entries()]) {
      this.deletePendingClient(key, pending);
      pending.reject(this.closeReason);
    }
    this.writer.close(this.closeReason);
  }

  outboundIdle(): Promise<void> {
    return this.writer.idle();
  }

  async idle(): Promise<void> {
    if (this.ingressDrain) await this.ingressDrain;
    while (this.serverTasks.size > 0) {
      await Promise.all([...this.serverTasks]);
    }
    await this.writer.idle();
  }

  private drainIngress(): Promise<void> {
    if (this.ingressDrain) return this.ingressDrain;
    const drain = this.runIngressDrain();
    const tracked = drain.finally(() => {
      if (this.ingressDrain === tracked) this.ingressDrain = null;
    });
    this.ingressDrain = tracked;
    return tracked;
  }

  private async runIngressDrain(): Promise<void> {
    while (!this.closeReason) {
      const entry = this.ingress.dequeueRetained();
      if (!entry) return;
      let retainedByServerTask = false;
      try {
        retainedByServerTask = await this.processEnvelope(entry.value, entry.bytes);
      } finally {
        if (!retainedByServerTask) this.ingress.releaseRetained(entry.bytes);
      }
    }
  }

  private async processEnvelope(
    envelope: CodexRpcEnvelope,
    frameBytes: number,
  ): Promise<boolean> {
    if (isCodexRpcNotification(envelope)) {
      if (isCodexServerNotificationMethod(envelope.method)) {
        assertCodexFallbackParams("server-notification", envelope.method, envelope.params);
        if (this.onNotification) await this.runNotification(envelope, this.onNotification);
      } else {
        if (this.onUnknownNotification) {
          await this.runNotification(envelope, this.onUnknownNotification);
        }
      }
      return false;
    }
    if (isCodexRpcRequest(envelope)) {
      this.dispatchServerRequest(envelope, frameBytes);
      return true;
    }
    this.resolveClientResponse(envelope);
    return false;
  }

  private resolveClientResponse(envelope: Exclude<CodexRpcEnvelope, CodexRpcRequest | CodexRpcNotification>): void {
    const key = serializeCodexRpcId(envelope.id);
    const pending = this.pendingClient.get(key);
    if (!pending) {
      throw new CodexProtocolFault(
        this.settledClientIds.has(key) ? "DUPLICATE_RESPONSE" : "UNKNOWN_RESPONSE",
        this.settledClientIds.has(key)
          ? `Duplicate Codex RPC response for ${key}`
          : `Unknown Codex RPC response for ${key}`,
      );
    }
    if (!isCodexRpcError(envelope)) {
      assertCodexFallbackResult("client-request", pending.method, envelope.result);
    }
    this.deletePendingClient(key, pending);
    this.rememberSettledClientId(key);
    if (isCodexRpcError(envelope)) pending.reject(new CodexRemoteRpcError(envelope.error));
    else pending.resolve(envelope.result);
  }

  private rememberSettledClientId(key: string): void {
    this.settledClientIds.add(key);
    this.settledClientOrder.push(key);
    if (this.settledClientOrder.length <= CODEX_MAX_RESPONSE_TOMBSTONES) return;
    const expired = this.settledClientOrder.shift();
    if (expired !== undefined) this.settledClientIds.delete(expired);
  }

  private dispatchServerRequest(request: CodexRpcRequest, frameBytes: number): void {
    const key = serializeCodexRpcId(request.id);
    if (this.inflightServerIds.has(key) || this.settledServerIds.has(key)) {
      throw new CodexProtocolFault(
        "DUPLICATE_SERVER_REQUEST",
        `Duplicate Codex server request for ${key}`,
      );
    }
    if (
      this.inflightServerIds.size + this.settledServerIds.size >=
        this.maxSettledServerRequests
    ) {
      throw new CodexProtocolFault(
        "REQUEST_LIMIT",
        `Codex server request history is full at ${this.maxSettledServerRequests} ids`,
      );
    }
    this.inflightServerIds.add(key);
    const knownMethod = isCodexServerRequestMethod(request.method);
    if (knownMethod) {
      assertCodexFallbackParams("server-request", request.method, request.params);
    }
    if (!knownMethod || !this.onServerRequest) {
      const task = this.sendTerminalServerError(
        request.id,
        -32_601,
        "Server request method is not supported",
      ).finally(() => this.inflightServerIds.delete(key));
      this.trackServerTask(task, frameBytes);
      return;
    }
    if (this.activeServer.size >= this.maxConcurrentServerRequests) {
      const task = this.sendTerminalServerError(
        request.id,
        -32_002,
        "Too many concurrent server requests",
      ).finally(() => this.inflightServerIds.delete(key));
      this.trackServerTask(task, frameBytes);
      return;
    }

    const controller = new AbortController();
    if (this.ingressEndingReason) controller.abort(this.ingressEndingReason);
    this.activeServer.set(key, { controller });
    const task = this.runServerRequest(request, controller).finally(() => {
      this.activeServer.delete(key);
      this.inflightServerIds.delete(key);
    });
    this.trackServerTask(task, frameBytes);
  }

  private async runServerRequest(
    request: CodexRpcRequest,
    controller: AbortController,
  ): Promise<void> {
    let timer: unknown;
    let timerScheduled = false;
    let removeAbortListener: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.setTimeoutFn(() => {
        const error = new CodexServerRequestTimeoutError();
        controller.abort(error);
        reject(error);
      }, this.serverRequestTimeoutMs);
      timerScheduled = true;
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
      }
    });

    let outcome: ServerRequestOutcome;
    try {
      const handling = Promise.resolve().then(() =>
        this.onServerRequest!(request, { signal: controller.signal }));
      const result = await Promise.race([handling, timeout, aborted]);
      assertCodexFallbackResult("server-request", request.method, result);
      outcome = { type: "result", result };
    } catch (error) {
      if (this.terminalReason()) return;
      if (error instanceof CodexServerRequestTimeoutError) {
        outcome = { type: "error", code: -32_001, message: "Server request timed out" };
      } else {
        outcome = { type: "error", code: -32_003, message: "Server request handler failed" };
      }
    } finally {
      if (timerScheduled) this.clearTimeoutFn(timer);
      removeAbortListener?.();
    }

    if (this.terminalReason()) return;
    if (outcome.type === "result") {
      await this.writer.send({ id: request.id, result: outcome.result });
    } else {
      await this.writer.send({
        id: request.id,
        error: { code: outcome.code, message: outcome.message },
      });
    }
    this.rememberSettledServerId(request.id);
  }

  private async sendTerminalServerError(
    id: string | number,
    code: number,
    message: string,
  ): Promise<void> {
    if (this.terminalReason()) return;
    await this.writer.send({ id, error: { code, message } });
    this.rememberSettledServerId(id);
  }

  private rememberSettledServerId(id: string | number): void {
    const key = serializeCodexRpcId(id);
    this.settledServerIds.add(key);
  }

  private trackServerTask(task: Promise<void>, retainedBytes: number): void {
    const tracked = task.catch((error: unknown) => {
      this.failPeer(closedFault(error));
    }).finally(() => {
      this.ingress.releaseRetained(retainedBytes);
      this.serverTasks.delete(tracked);
    });
    this.serverTasks.add(tracked);
  }

  private async runNotification(
    notification: CodexRpcNotification,
    handler: CodexNotificationHandler,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeNotifications.add(controller);
    if (this.ingressEndingReason) controller.abort(this.ingressEndingReason);
    let timer: unknown;
    let timerScheduled = false;
    let removeAbortListener: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.setTimeoutFn(() => {
        const error = new CodexNotificationTimeoutError();
        controller.abort(error);
        reject(error);
      }, this.notificationTimeoutMs);
      timerScheduled = true;
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
      }
    });

    try {
      const handling = Promise.resolve().then(() =>
        handler(notification, { signal: controller.signal }));
      await Promise.race([handling, timeout, aborted]);
    } catch (error) {
      if (this.closeReason || this.ingressEndingReason) return;
      if (error instanceof CodexNotificationTimeoutError) {
        throw new CodexProtocolFault(
          "PEER_CLOSED",
          "Codex notification handler timed out",
        );
      }
      throw new CodexProtocolFault(
        "PEER_CLOSED",
        "Codex notification handler failed",
      );
    } finally {
      if (timerScheduled) this.clearTimeoutFn(timer);
      removeAbortListener?.();
      this.activeNotifications.delete(controller);
    }
  }

  private deletePendingClient(key: string, pending: PendingClientRequest): void {
    if (this.pendingClient.get(key) !== pending) return;
    this.pendingClient.delete(key);
    if (pending.timerScheduled) this.clearTimeoutFn(pending.timer);
    pending.removeAbortListener?.();
  }

  private terminalReason(): CodexProtocolFault | null {
    return this.closeReason ?? this.ingressEndingReason;
  }

  private failPeer(fault: CodexProtocolFault): void {
    if (!this.faultReported) {
      this.faultReported = true;
      try {
        this.onProtocolFault?.(fault);
      } catch {
        // Diagnostic hooks cannot keep a faulted transport alive.
      }
    }
    this.close(fault);
  }
}
