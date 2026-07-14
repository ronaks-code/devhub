import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { canonicalizeProviderHome } from "../task-key.js";
import {
  CodexProtocolFault,
  CodexRpcPeer,
  RedactedCodexStderrRing,
  type CodexClientCallOptions,
  type CodexNotificationHandler,
  type CodexRpcNotification,
  type CodexRpcPeerOptions,
  type CodexRpcRequest,
  type CodexServerRequestHandler,
} from "./protocol/index.js";

export type AppServerProcessPhase =
  | "idle"
  | "spawning"
  | "handshaking"
  | "transportReady"
  | "reconciling"
  | "ready"
  | "terminal"
  | "stopping"
  | "stopped";

export type AppServerProcessErrorCode =
  | "ALREADY_STARTED"
  | "NOT_READY"
  | "TERMINAL"
  | "SPAWN_FAILED"
  | "CHILD_ERROR"
  | "CHILD_EXIT"
  | "CHILD_CLOSE"
  | "STDIN_ERROR"
  | "STDOUT_ERROR"
  | "STDERR_ERROR"
  | "STDOUT_EOF"
  | "PEER_FAULT"
  | "PROTOCOL_FAULT"
  | "STARTUP_TIMEOUT"
  | "HANDSHAKE_FAILED"
  | "HOME_MISMATCH"
  | "RECONCILE_FAILED"
  | "RECONCILE_METHOD_DENIED"
  | "RECONCILE_CLOSED"
  | "SHUTDOWN";

export class AppServerProcessError extends Error {
  readonly code: AppServerProcessErrorCode;

  constructor(code: AppServerProcessErrorCode, message: string) {
    super(message);
    this.name = "AppServerProcessError";
    this.code = code;
  }
}

export interface AppServerReadable {
  on(event: string, listener: (...args: any[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
}

export interface AppServerWritable {
  readonly writable?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  end(): void;
}

export interface AppServerChild {
  readonly stdin: AppServerWritable;
  readonly stdout: AppServerReadable;
  readonly stderr: AppServerReadable;
  readonly pid?: number;
  readonly killed?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export interface AppServerSpawnOptions {
  readonly shell: false;
  readonly detached: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export type AppServerSpawn = (
  executable: string,
  args: readonly string[],
  options: AppServerSpawnOptions,
) => AppServerChild;

export interface AppServerPeer {
  call<T = unknown>(method: string, params?: unknown, options?: CodexClientCallOptions): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  receive(chunk: string | Uint8Array): Promise<void>;
  finishIngress(): Promise<void>;
  outboundIdle(): Promise<void>;
  close(reason?: unknown): void;
}

export type AppServerPeerFactory = (options: CodexRpcPeerOptions) => AppServerPeer;

export type AppServerReconcileMethod = "thread/list" | "thread/read" | "thread/resume";

export interface AppServerReconcileRpc {
  call<T = unknown>(method: AppServerReconcileMethod, params?: unknown): Promise<T>;
}

export interface AppServerGenerationContext {
  readonly home: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface AppServerReconcileContext extends AppServerGenerationContext {
  readonly rpc: AppServerReconcileRpc;
}

export interface CodexAppServerReady extends AppServerGenerationContext {}

export interface CodexAppServerTerminal {
  readonly home: string;
  readonly generation: number;
  readonly intentional: boolean;
  readonly exitSeen: boolean;
  readonly safeToRestart: boolean;
  readonly error: AppServerProcessError;
}

export type AppServerNotificationHandler = (
  notification: CodexRpcNotification,
  context: AppServerGenerationContext,
) => void | Promise<void>;

export type AppServerRequestHandler = (
  request: CodexRpcRequest,
  context: AppServerGenerationContext,
) => unknown | Promise<unknown>;

export type AppServerSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type AppServerClearTimeout = (handle: unknown) => void;

export interface AppServerProcessOptions {
  readonly executable: string;
  readonly home: string;
  readonly generation: number;
  readonly appVersion: string;
  readonly reconcile: (context: AppServerReconcileContext) => void | Promise<void>;
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly canonicalizeHome?: (home: string) => string;
  readonly spawnFn?: AppServerSpawn;
  readonly peerFactory?: AppServerPeerFactory;
  readonly setTimeoutFn?: AppServerSetTimeout;
  readonly clearTimeoutFn?: AppServerClearTimeout;
  readonly startupTimeoutMs?: number;
  readonly exitDrainTimeoutMs?: number;
  readonly sigintTimeoutMs?: number;
  readonly sigtermTimeoutMs?: number;
  readonly killConfirmationTimeoutMs?: number;
  readonly stderrMaxBytes?: number;
  readonly onNotification?: AppServerNotificationHandler;
  readonly onUnknownNotification?: AppServerNotificationHandler;
  readonly onServerRequest?: AppServerRequestHandler;
}

export const CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 30_000;
export const CODEX_APP_SERVER_EXIT_DRAIN_TIMEOUT_MS = 1_000;
export const CODEX_APP_SERVER_SIGINT_TIMEOUT_MS = 2_000;
export const CODEX_APP_SERVER_SIGTERM_TIMEOUT_MS = 1_000;
export const CODEX_APP_SERVER_KILL_CONFIRMATION_TIMEOUT_MS = 1_000;

const RECONCILE_METHODS: ReadonlySet<string> = new Set([
  "thread/list",
  "thread/read",
  "thread/resume",
]);

const positiveSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
};

const nonEmpty = (name: string, value: string): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty immutable string`);
  }
  return value;
};

const processError = (
  code: AppServerProcessErrorCode,
  message: string,
): AppServerProcessError => new AppServerProcessError(code, message);

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

interface SignalWaiter {
  readonly handle: unknown;
  readonly resolve: () => void;
  settled: boolean;
}

interface InitializeResult {
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
  readonly userAgent: string;
}

export class AppServerProcess {
  readonly executable: string;
  readonly home: string;
  readonly generation: number;
  readonly appVersion: string;
  readonly terminated: Promise<CodexAppServerTerminal>;

  private readonly reconcileHook: AppServerProcessOptions["reconcile"];
  private readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  private readonly canonicalizeHome: (home: string) => string;
  private readonly spawnFn: AppServerSpawn;
  private readonly peerFactory: AppServerPeerFactory;
  private readonly setTimeoutFn: AppServerSetTimeout;
  private readonly clearTimeoutFn: AppServerClearTimeout;
  private readonly startupTimeoutMs: number;
  private readonly exitDrainTimeoutMs: number;
  private readonly sigintTimeoutMs: number;
  private readonly sigtermTimeoutMs: number;
  private readonly killConfirmationTimeoutMs: number;
  private readonly onNotification?: AppServerNotificationHandler;
  private readonly onUnknownNotification?: AppServerNotificationHandler;
  private readonly onServerRequest?: AppServerRequestHandler;
  private readonly stderrRing: RedactedCodexStderrRing;
  private readonly lifecycleController = new AbortController();
  private readonly transportController = new AbortController();
  private readonly terminalNotice = createDeferred<AppServerProcessError>();
  private readonly terminatedDeferred = createDeferred<CodexAppServerTerminal>();
  private readonly spawnDeferred = createDeferred<void>();
  private readonly spawnOutcome = createDeferred<"spawned" | "failed">();
  private readonly stdoutDone = createDeferred<void>();
  private readonly signalWaiters = new Set<SignalWaiter>();
  private readonly prePeerStdout: Array<string | Uint8Array> = [];

  private _phase: AppServerProcessPhase = "idle";
  private child: AppServerChild | null = null;
  private peer: AppServerPeer | null = null;
  private _terminalError: AppServerProcessError | null = null;
  private terminalIntentional = false;
  private terminalValue: CodexAppServerTerminal | null = null;
  private startPromise: Promise<CodexAppServerReady> | null = null;
  private shutdownPromise: Promise<CodexAppServerTerminal> | null = null;
  private cleanupPromise: Promise<CodexAppServerTerminal> | null = null;
  private childTerminationPromise: Promise<void> | null = null;
  private startupTimer: unknown;
  private startupTimerSet = false;
  private exitDrainTimer: unknown;
  private exitDrainTimerSet = false;
  private stdoutChain: Promise<void> = Promise.resolve();
  private stdoutFinishRequested = false;
  private stdoutDoneResolved = false;
  private spawned = false;
  private spawnFailed = false;
  private noChildConfirmed = false;
  private terminalPreservesIngress = false;
  private shutdownRequested = false;
  private _exitSeen = false;
  private closeSeen = false;
  private stdinEnded = false;

  constructor(options: AppServerProcessOptions) {
    this.executable = nonEmpty("executable", options.executable);
    if (!path.isAbsolute(this.executable)) {
      throw new TypeError("executable must be an absolute path");
    }
    this.home = nonEmpty("home", options.home);
    if (!path.isAbsolute(this.home)) throw new TypeError("home must be absolute");
    this.generation = positiveSafeInteger("generation", options.generation);
    this.appVersion = nonEmpty("app version", options.appVersion);
    if (typeof options.reconcile !== "function") {
      throw new TypeError("reconcile must be a function");
    }
    this.reconcileHook = options.reconcile;
    this.canonicalizeHome = options.canonicalizeHome ?? canonicalizeProviderHome;
    if (this.canonicalizeHome(this.home) !== this.home) {
      throw new TypeError("home must already be canonical");
    }
    this.baseEnv = Object.freeze({ ...(options.baseEnv ?? process.env) });
    this.spawnFn = options.spawnFn ?? ((executable, args, spawnOptions) =>
      nodeSpawn(executable, [...args], spawnOptions as any) as unknown as AppServerChild);
    this.peerFactory = options.peerFactory ?? ((peerOptions) => new CodexRpcPeer(peerOptions));
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.startupTimeoutMs = positiveSafeInteger(
      "startupTimeoutMs",
      options.startupTimeoutMs ?? CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
    );
    this.exitDrainTimeoutMs = positiveSafeInteger(
      "exitDrainTimeoutMs",
      options.exitDrainTimeoutMs ?? CODEX_APP_SERVER_EXIT_DRAIN_TIMEOUT_MS,
    );
    this.sigintTimeoutMs = positiveSafeInteger(
      "sigintTimeoutMs",
      options.sigintTimeoutMs ?? CODEX_APP_SERVER_SIGINT_TIMEOUT_MS,
    );
    this.sigtermTimeoutMs = positiveSafeInteger(
      "sigtermTimeoutMs",
      options.sigtermTimeoutMs ?? CODEX_APP_SERVER_SIGTERM_TIMEOUT_MS,
    );
    this.killConfirmationTimeoutMs = positiveSafeInteger(
      "killConfirmationTimeoutMs",
      options.killConfirmationTimeoutMs ?? CODEX_APP_SERVER_KILL_CONFIRMATION_TIMEOUT_MS,
    );
    this.stderrRing = new RedactedCodexStderrRing(
      options.stderrMaxBytes === undefined ? {} : { maxBytes: options.stderrMaxBytes },
    );
    this.onNotification = options.onNotification;
    this.onUnknownNotification = options.onUnknownNotification;
    this.onServerRequest = options.onServerRequest;
    this.terminated = this.terminatedDeferred.promise;
  }

  get phase(): AppServerProcessPhase {
    return this._phase;
  }

  get terminalError(): AppServerProcessError | null {
    return this._terminalError;
  }

  get exitObserved(): boolean {
    return this._exitSeen;
  }

  get safeToRestart(): boolean {
    return this._exitSeen || this.noChildConfirmed;
  }

  get stderrDiagnostics(): string {
    return this.stderrRing.snapshot();
  }

  start(): Promise<CodexAppServerReady> {
    if (this._phase !== "idle") {
      return Promise.reject(processError("ALREADY_STARTED", "Codex app-server already started"));
    }
    this._phase = "spawning";
    this.startPromise = this.startGeneration();
    return this.startPromise;
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    options: CodexClientCallOptions = {},
  ): Promise<T> {
    const peer = this.readyPeer();
    if (peer instanceof AppServerProcessError) return Promise.reject(peer);
    const signal = options.signal
      ? AbortSignal.any([this.transportController.signal, options.signal])
      : this.transportController.signal;
    return this.raceTerminal(peer.call<T>(method, params, { ...options, signal }));
  }

  notify(method: string, params?: unknown): Promise<void> {
    const peer = this.readyPeer();
    if (peer instanceof AppServerProcessError) return Promise.reject(peer);
    return this.raceTerminal(peer.notify(method, params));
  }

  shutdown(): Promise<CodexAppServerTerminal> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    if (this._phase === "idle" && this.child === null) {
      this.noChildConfirmed = true;
      this.spawnFailed = true;
      this.spawnOutcome.resolve("failed");
    }
    if (!this._terminalError) {
      this.latchTerminal(
        processError("SHUTDOWN", "Codex app-server shutdown requested"),
        true,
        true,
      );
    }
    if (this._phase !== "stopped") this._phase = "stopping";
    this.shutdownPromise = this.ensureCleanup();
    return this.shutdownPromise;
  }

  private async startGeneration(): Promise<CodexAppServerReady> {
    this.armStartupTimer();
    let child: AppServerChild;
    try {
      child = this.spawnFn(
        this.executable,
        ["app-server", "--stdio"],
        {
          shell: false,
          detached: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...this.baseEnv, CODEX_HOME: this.home },
        },
      );
    } catch {
      this.noChildConfirmed = true;
      this.spawnFailed = true;
      this.spawnOutcome.resolve("failed");
      const error = this.latchTerminal(
        processError("SPAWN_FAILED", "Codex app-server spawn failed"),
        false,
      );
      this.settleTerminal();
      throw error;
    }
    this.child = child;
    this.installListeners(child);
    try {
      this.peer = this.peerFactory(this.createPeerOptions(child));
    } catch {
      const error = this.latchTerminal(
        processError("HANDSHAKE_FAILED", "Codex RPC peer construction failed"),
      );
      throw error;
    }
    for (const chunk of this.prePeerStdout.splice(0)) this.queueStdout(chunk);
    if (this._terminalError && !this.terminalPreservesIngress) {
      this.peer.close(this._terminalError);
    }

    await this.raceTerminal(this.spawnDeferred.promise);
    this.throwIfTerminal();
    this._phase = "handshaking";

    let initialize: InitializeResult;
    try {
      initialize = await this.raceTerminal(this.peer.call<InitializeResult>(
        "initialize",
        {
          clientInfo: { name: "devhub", title: "DevHub", version: this.appVersion },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
          },
        },
        { signal: this.transportController.signal },
      ));
      this.validateInitialize(initialize);
      await this.raceTerminal(this.peer.notify("initialized"));
      await this.raceTerminal(this.peer.outboundIdle());
    } catch (error) {
      if (this._terminalError) throw this._terminalError;
      if (error instanceof AppServerProcessError && error.code === "HOME_MISMATCH") {
        throw this.latchTerminal(error);
      }
      throw this.latchTerminal(
        processError("HANDSHAKE_FAILED", "Codex app-server handshake failed"),
      );
    }

    this.throwIfTerminal();
    this._phase = "transportReady";
    this._phase = "reconciling";
    const rpc = this.createReconcileFacade();
    try {
      await this.raceTerminal(Promise.resolve(this.reconcileHook(Object.freeze({
        rpc,
        home: this.home,
        generation: this.generation,
        signal: this.lifecycleController.signal,
      }))));
    } catch {
      if (this._terminalError) throw this._terminalError;
      throw this.latchTerminal(
        processError("RECONCILE_FAILED", "Codex app-server reconciliation failed"),
      );
    }

    this.throwIfTerminal();
    this.clearStartupTimer();
    this._phase = "ready";
    return Object.freeze({
      home: this.home,
      generation: this.generation,
      signal: this.lifecycleController.signal,
    });
  }

  private createPeerOptions(child: AppServerChild): CodexRpcPeerOptions {
    const wrapNotification = (
      handler: AppServerNotificationHandler | undefined,
    ): CodexNotificationHandler | undefined => handler
      ? (notification, { signal }) => handler(notification, Object.freeze({
          home: this.home,
          generation: this.generation,
          signal,
        }))
      : undefined;
    const wrapRequest = (
      handler: AppServerRequestHandler | undefined,
    ): CodexServerRequestHandler | undefined => handler
      ? (request, { signal }) => handler(request, Object.freeze({
          home: this.home,
          generation: this.generation,
          signal,
        }))
      : undefined;
    return {
      write: (chunk) => this.writeStdin(chunk),
      pauseIngress: () => { child.stdout.pause(); },
      resumeIngress: () => { child.stdout.resume(); },
      onNotification: wrapNotification(this.onNotification),
      onUnknownNotification: wrapNotification(this.onUnknownNotification),
      onServerRequest: wrapRequest(this.onServerRequest),
      onProtocolFault: () => {
        this.latchTerminal(processError("PEER_FAULT", "Codex RPC peer faulted"));
      },
    };
  }

  private installListeners(child: AppServerChild): void {
    child.on("spawn", () => this.onSpawn());
    child.on("error", () => this.onChildError());
    child.on("exit", () => this.onExit());
    child.on("close", () => this.onClose());
    child.stdin.on("error", () => {
      this.latchTerminal(processError("STDIN_ERROR", "Codex app-server stdin failed"));
    });
    child.stdout.on("data", (chunk: string | Uint8Array) => this.queueStdout(chunk));
    child.stdout.on("error", () => {
      this.latchTerminal(processError("STDOUT_ERROR", "Codex app-server stdout failed"));
    });
    child.stdout.on("end", () => this.onStdoutEnd());
    child.stderr.on("data", (chunk: string | Uint8Array) => this.stderrRing.append(chunk));
    child.stderr.on("error", () => {
      this.latchTerminal(processError("STDERR_ERROR", "Codex app-server stderr failed"));
    });
  }

  private onSpawn(): void {
    if (this.spawned) return;
    this.spawned = true;
    this.noChildConfirmed = false;
    this.spawnDeferred.resolve();
    this.spawnOutcome.resolve("spawned");
    if (this._terminalError) void this.terminateSpawnedChild();
  }

  private onChildError(): void {
    if (!this.spawned && !this.spawnFailed) {
      this.spawnFailed = true;
      this.noChildConfirmed = true;
      this.spawnOutcome.resolve("failed");
    }
    this.latchTerminal(processError("CHILD_ERROR", "Codex app-server child error"));
  }

  private onExit(): void {
    if (this._exitSeen) return;
    this._exitSeen = true;
    this.cancelSignalWaiters();
    this.latchTerminal(
      processError("CHILD_EXIT", "Codex app-server exited"),
      false,
    );
    this.armExitDrainTimer();
  }

  private onClose(): void {
    if (this.closeSeen) return;
    this.closeSeen = true;
    this.clearExitDrainTimer();
    this.latchTerminal(
      processError("CHILD_CLOSE", "Codex app-server closed"),
      false,
    );
    void this.requestStdoutFinish().then(() => {
      if (this._exitSeen) this.settleTerminal();
    });
  }

  private onStdoutEnd(): void {
    this.clearExitDrainTimer();
    this.latchTerminal(
      processError("STDOUT_EOF", "Codex app-server stdout ended"),
      false,
    );
    void this.requestStdoutFinish().then(() => {
      if (this._exitSeen || this.closeSeen) this.settleTerminal();
    });
  }

  private queueStdout(chunk: string | Uint8Array): void {
    if (this.stdoutFinishRequested) return;
    if (!this.peer) {
      this.prePeerStdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk));
      return;
    }
    this.stdoutChain = this.stdoutChain.then(async () => {
      await this.peer!.receive(chunk);
    }).catch(() => {
      this.latchTerminal(processError("PROTOCOL_FAULT", "Codex stdout protocol failed"));
    });
  }

  private requestStdoutFinish(): Promise<void> {
    if (this.stdoutFinishRequested) return this.stdoutDone.promise;
    this.stdoutFinishRequested = true;
    this.stdoutChain = this.stdoutChain.then(async () => {
      await this.peer?.finishIngress();
    }).catch(() => {
      this.latchTerminal(processError("PROTOCOL_FAULT", "Codex stdout finalization failed"));
    }).finally(() => this.resolveStdoutDone());
    return this.stdoutDone.promise;
  }

  private writeStdin(chunk: Uint8Array): Promise<void> {
    const child = this.child;
    if (!child || this._terminalError || child.stdin.writable === false) {
      return Promise.reject(processError("TERMINAL", "Codex app-server stdin is unavailable"));
    }
    return new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private validateInitialize(value: unknown): asserts value is InitializeResult {
    if (!value || typeof value !== "object") {
      throw processError("HANDSHAKE_FAILED", "Codex initialize result is invalid");
    }
    const result = value as Partial<InitializeResult>;
    for (const field of ["codexHome", "platformFamily", "platformOs", "userAgent"] as const) {
      if (typeof result[field] !== "string" || result[field]!.trim().length === 0) {
        throw processError("HANDSHAKE_FAILED", `Codex initialize ${field} is invalid`);
      }
    }
    if (!path.isAbsolute(result.codexHome!)) {
      throw processError("HOME_MISMATCH", "Codex initialize home is not absolute");
    }
    let canonical: string;
    try {
      canonical = this.canonicalizeHome(result.codexHome!);
    } catch {
      throw processError("HOME_MISMATCH", "Codex initialize home cannot be canonicalized");
    }
    if (canonical !== this.home) {
      throw processError("HOME_MISMATCH", "Codex initialize home does not match supervisor key");
    }
  }

  private createReconcileFacade(): AppServerReconcileRpc {
    const phase = this.generation;
    return Object.freeze({
      call: <T>(method: AppServerReconcileMethod, params?: unknown): Promise<T> => {
        if (!RECONCILE_METHODS.has(method)) {
          return Promise.reject(processError(
            "RECONCILE_METHOD_DENIED",
            `Reconciliation method ${String(method)} is not allowed`,
          ));
        }
        if (
          this._phase !== "reconciling" ||
          this.generation !== phase ||
          this.lifecycleController.signal.aborted ||
          !this.peer
        ) {
          return Promise.reject(processError(
            "RECONCILE_CLOSED",
            "Reconciliation facade is no longer active",
          ));
        }
        return this.raceTerminal(this.peer.call<T>(method, params, {
          signal: this.transportController.signal,
        }));
      },
    });
  }

  private readyPeer(): AppServerPeer | AppServerProcessError {
    if (this._terminalError) {
      return processError("TERMINAL", "Codex app-server generation is terminal");
    }
    if (this._phase !== "ready" || !this.peer) {
      return processError("NOT_READY", "Codex app-server generation is not ready");
    }
    return this.peer;
  }

  private ensureCleanup(): Promise<CodexAppServerTerminal> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.cleanupGeneration();
    }
    return this.cleanupPromise;
  }

  private async cleanupGeneration(): Promise<CodexAppServerTerminal> {
    if (this.terminalValue) return this.terminalValue;
    this.endStdin();

    if (this.child && !this.spawned && !this.spawnFailed) {
      await this.waitForSpawnDecision();
    }
    if (this.spawned && !this._exitSeen) await this.terminateSpawnedChild();

    if (this._exitSeen) {
      await this.stdoutDone.promise;
    } else {
      try { this.child?.stdout.destroy(); } catch { /* sanitized teardown */ }
      try { this.child?.stderr.destroy(); } catch { /* sanitized teardown */ }
      await this.requestStdoutFinish();
    }
    return this.settleTerminal();
  }

  private waitForSpawnDecision(): Promise<void> {
    if (this.spawned || this.spawnFailed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let timerSet = false;
      let timer: unknown;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timerSet) this.clearTimeoutFn(timer);
        resolve();
      };
      void this.spawnOutcome.promise.then(finish);
      timer = this.setTimeoutFn(finish, this.killConfirmationTimeoutMs);
      timerSet = true;
      if (settled) this.clearTimeoutFn(timer);
    });
  }

  private terminateSpawnedChild(): Promise<void> {
    if (this.childTerminationPromise) return this.childTerminationPromise;
    this.childTerminationPromise = (async () => {
      this.endStdin();
      if (this._exitSeen) return;
      this.sendSignal("SIGINT");
      await this.waitSignalDelay(this.sigintTimeoutMs);
      if (!this._exitSeen) {
        this.sendSignal("SIGTERM");
        await this.waitSignalDelay(this.sigtermTimeoutMs);
      }
      if (!this._exitSeen) {
        this.sendSignal("SIGKILL");
        await this.waitSignalDelay(this.killConfirmationTimeoutMs);
      }
    })();
    return this.childTerminationPromise;
  }

  private sendSignal(signal: NodeJS.Signals): void {
    if (!this.child || !this.spawned || this._exitSeen) return;
    try { this.child.kill(signal); } catch { /* signal races are diagnostic-free */ }
  }

  private waitSignalDelay(delayMs: number): Promise<void> {
    if (this._exitSeen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter: SignalWaiter = {
        handle: undefined,
        resolve: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.signalWaiters.delete(waiter);
          resolve();
        },
        settled: false,
      };
      (waiter as { handle: unknown }).handle = this.setTimeoutFn(waiter.resolve, delayMs);
      this.signalWaiters.add(waiter);
    });
  }

  private cancelSignalWaiters(): void {
    for (const waiter of [...this.signalWaiters]) {
      this.clearTimeoutFn(waiter.handle);
      waiter.resolve();
    }
  }

  private endStdin(): void {
    if (this.stdinEnded || !this.child) return;
    this.stdinEnded = true;
    try { this.child.stdin.end(); } catch { /* sanitized teardown */ }
  }

  private armStartupTimer(): void {
    this.startupTimer = this.setTimeoutFn(() => {
      this.latchTerminal(processError(
        "STARTUP_TIMEOUT",
        "Codex app-server startup timed out",
      ));
    }, this.startupTimeoutMs);
    this.startupTimerSet = true;
  }

  private clearStartupTimer(): void {
    if (!this.startupTimerSet) return;
    this.startupTimerSet = false;
    this.clearTimeoutFn(this.startupTimer);
  }

  private armExitDrainTimer(): void {
    if (this.stdoutFinishRequested || this.exitDrainTimerSet) return;
    this.exitDrainTimer = this.setTimeoutFn(() => {
      this.exitDrainTimerSet = false;
      try { this.child?.stdout.destroy(); } catch { /* sanitized teardown */ }
      try { this.child?.stderr.destroy(); } catch { /* sanitized teardown */ }
      void this.requestStdoutFinish().then(() => this.settleTerminal());
    }, this.exitDrainTimeoutMs);
    this.exitDrainTimerSet = true;
  }

  private clearExitDrainTimer(): void {
    if (!this.exitDrainTimerSet) return;
    this.exitDrainTimerSet = false;
    this.clearTimeoutFn(this.exitDrainTimer);
  }

  private resolveStdoutDone(): void {
    if (this.stdoutDoneResolved) return;
    this.stdoutDoneResolved = true;
    this.stdoutDone.resolve();
  }

  private latchTerminal(
    error: AppServerProcessError,
    closePeer = true,
    intentional = false,
  ): AppServerProcessError {
    if (this._terminalError) return this._terminalError;
    this._terminalError = error;
    this.terminalIntentional = intentional;
    this.terminalPreservesIngress = !closePeer;
    if (this._phase !== "stopping" && this._phase !== "stopped") this._phase = "terminal";
    this.clearStartupTimer();
    this.terminalNotice.resolve(error);
    if (!this.lifecycleController.signal.aborted) this.lifecycleController.abort(error);
    if (closePeer) {
      if (!this.transportController.signal.aborted) this.transportController.abort(error);
      this.peer?.close(error);
    }
    void this.ensureCleanup();
    return error;
  }

  private settleTerminal(): CodexAppServerTerminal {
    if (this.terminalValue) return this.terminalValue;
    const error = this._terminalError ?? this.latchTerminal(
      processError("SHUTDOWN", "Codex app-server stopped"),
      true,
      true,
    );
    if (!this.transportController.signal.aborted) this.transportController.abort(error);
    this.peer?.close(error);
    this.terminalValue = Object.freeze({
      home: this.home,
      generation: this.generation,
      intentional: this.terminalIntentional,
      exitSeen: this._exitSeen,
      safeToRestart: this.safeToRestart,
      error,
    });
    if (this.shutdownRequested || this.spawned || !this.noChildConfirmed) {
      this._phase = "stopped";
    }
    this.terminatedDeferred.resolve(this.terminalValue);
    return this.terminalValue;
  }

  private raceTerminal<T>(promise: Promise<T>): Promise<T> {
    if (this._terminalError) return Promise.reject(this._terminalError);
    return Promise.race([
      promise,
      this.terminalNotice.promise.then((error) => { throw error; }),
    ]);
  }

  private throwIfTerminal(): void {
    if (this._terminalError) throw this._terminalError;
  }
}
