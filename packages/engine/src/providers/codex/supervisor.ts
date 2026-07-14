import path from "node:path";
import { canonicalizeProviderHome } from "../task-key.js";
import {
  AppServerProcess,
  type AppServerGenerationContext,
  type AppServerNotificationHandler,
  type AppServerProcessOptions,
  type AppServerReconcileContext,
  type AppServerRequestHandler,
  type CodexAppServerReady,
  type CodexAppServerTerminal,
} from "./app-server-process.js";
import {
  serializeCodexRpcId,
  type CodexClientCallOptions,
  type CodexRpcNotification,
  type CodexRpcRequest,
} from "./protocol/index.js";

export type CodexSupervisorErrorCode =
  | "DISABLED"
  | "SHUTDOWN"
  | "LEASE_RELEASED"
  | "HANDLER_CONFLICT"
  | "UNAVAILABLE"
  | "CIRCUIT_OPEN";

export class CodexSupervisorError extends Error {
  readonly code: CodexSupervisorErrorCode;

  constructor(code: CodexSupervisorErrorCode, message: string) {
    super(message);
    this.name = "CodexSupervisorError";
    this.code = code;
  }
}

export interface CodexSupervisorHandlers {
  readonly owner: symbol;
  readonly onNotification: AppServerNotificationHandler;
  readonly onUnknownNotification?: AppServerNotificationHandler;
  readonly onServerRequest: AppServerRequestHandler;
}

export interface CodexSupervisorAcquireOptions {
  readonly home: string;
  readonly handlers: CodexSupervisorHandlers;
  readonly signal?: AbortSignal;
}

export interface CodexAppServerLease {
  readonly home: string;
  readonly generation: number;
  call<T = unknown>(
    method: string,
    params?: unknown,
    options?: CodexClientCallOptions,
  ): Promise<T>;
  release(): Promise<void>;
}

export interface CodexSupervisorProcess {
  readonly home: string;
  readonly generation: number;
  readonly terminated: Promise<CodexAppServerTerminal>;
  start(): Promise<CodexAppServerReady>;
  call<T = unknown>(
    method: string,
    params?: unknown,
    options?: CodexClientCallOptions,
  ): Promise<T>;
  shutdown(): Promise<CodexAppServerTerminal>;
}

export interface CodexSupervisorProcessOptions {
  readonly executable: string;
  readonly home: string;
  readonly generation: number;
  readonly clientVersion: string;
  readonly reconcile: (context: AppServerReconcileContext) => void | Promise<void>;
  readonly onNotification: AppServerNotificationHandler;
  readonly onUnknownNotification: AppServerNotificationHandler;
  readonly onServerRequest: AppServerRequestHandler;
}

export type CodexSupervisorProcessFactory = (
  options: CodexSupervisorProcessOptions,
) => CodexSupervisorProcess;

export type CodexSupervisorSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type CodexSupervisorClearTimeout = (handle: unknown) => void;

export interface CodexAppServerSupervisorOptions {
  readonly executable: string;
  readonly clientVersion: string;
  readonly isEnabled: () => boolean;
  readonly reconcile: (context: AppServerReconcileContext) => void | Promise<void>;
  readonly processFactory?: CodexSupervisorProcessFactory;
  readonly canonicalizeHome?: (home: string) => string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimeoutFn?: CodexSupervisorSetTimeout;
  readonly clearTimeoutFn?: CodexSupervisorClearTimeout;
  readonly maxTrackedHomes?: number;
  readonly maxDemandPerHome?: number;
  readonly maxPendingRequestsPerHome?: number;
}

export const CODEX_SUPERVISOR_BACKOFF_MS = Object.freeze([
  250,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
] as const);
export const CODEX_SUPERVISOR_FAILURE_WINDOW_MS = 60_000;
export const CODEX_SUPERVISOR_CIRCUIT_OPEN_MS = 60_000;
export const CODEX_SUPERVISOR_HEALTHY_RESET_MS = 60_000;
export const CODEX_SUPERVISOR_JITTER_MS = 250;
export const CODEX_SUPERVISOR_MAX_TRACKED_HOMES = 256;
export const CODEX_SUPERVISOR_MAX_DEMAND_PER_HOME = 256;
export const CODEX_SUPERVISOR_MAX_PENDING_REQUESTS_PER_HOME = 256;

export const codexSupervisorBackoffDelay = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError("backoff attempt must be a non-negative safe integer");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("backoff random sample must be in [0, 1)");
  }
  const base = CODEX_SUPERVISOR_BACKOFF_MS[
    Math.min(attempt, CODEX_SUPERVISOR_BACKOFF_MS.length - 1)
  ]!;
  return base + Math.floor(sample * CODEX_SUPERVISOR_JITTER_MS);
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

type HomeState =
  | "idle"
  | "starting"
  | "ready"
  | "backoff"
  | "open"
  | "stopping"
  | "stopped"
  | "unavailable";

interface CircuitState {
  nextGeneration: number;
  readonly failures: number[];
  attempt: number;
  retryAt: number | null;
  openUntil: number | null;
  halfOpen: boolean;
  lastUsedSequence: number;
  healthyTimer: unknown;
  healthyTimerSet: boolean;
  healthyTimerToken: number;
}

interface HandlerBinding {
  readonly handlers: CodexSupervisorHandlers;
  readonly controller: AbortController;
  readonly pendingRequests: Map<string, AbortController>;
  users: number;
}

interface HomeEntry {
  readonly home: string;
  readonly epoch: number;
  readonly circuit: CircuitState;
  state: HomeState;
  binding: HandlerBinding | null;
  reservations: number;
  readonly leases: Set<CodexLease>;
  process: CodexSupervisorProcess | null;
  generation: number;
  processToken: number;
  handlingToken: number | null;
  change: Deferred<void>;
  failure: CodexSupervisorError | null;
  restartTimer: unknown;
  restartTimerSet: boolean;
  restartTimerToken: number;
  restartSafe: boolean;
  quarantineCleanup: Promise<boolean> | null;
  stopPromise: Promise<void> | null;
}

const supervisorError = (
  code: CodexSupervisorErrorCode,
  message: string,
): CodexSupervisorError => new CodexSupervisorError(code, message);

const nonEmpty = (value: string, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
};

const handlersMatch = (
  left: CodexSupervisorHandlers,
  right: CodexSupervisorHandlers,
): boolean => left.owner === right.owner &&
  left.onNotification === right.onNotification &&
  left.onUnknownNotification === right.onUnknownNotification &&
  left.onServerRequest === right.onServerRequest;

const snapshotHandlers = (
  handlers: CodexSupervisorHandlers,
): CodexSupervisorHandlers => Object.freeze({
  owner: handlers.owner,
  onNotification: handlers.onNotification,
  onUnknownNotification: handlers.onUnknownNotification,
  onServerRequest: handlers.onServerRequest,
});

const positiveSafeInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
};

const boundedPositiveSafeInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const resolved = positiveSafeInteger(value, fallback, label);
  if (resolved > maximum) {
    throw new RangeError(`${label} must be at most ${maximum}`);
  }
  return resolved;
};

const combineSignals = (...signals: AbortSignal[]): AbortSignal =>
  signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

class CodexLease implements CodexAppServerLease {
  readonly home: string;
  readonly inFlight = new Set<Promise<unknown>>();
  private released = false;
  private invalidReason: CodexSupervisorError | null = null;
  private releasePromise: Promise<void> | null = null;

  constructor(
    private readonly supervisor: CodexAppServerSupervisor,
    readonly entry: HomeEntry,
  ) {
    this.home = entry.home;
  }

  get generation(): number {
    return this.entry.generation;
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    options?: CodexClientCallOptions,
  ): Promise<T> {
    if (this.invalidReason) return Promise.reject(this.invalidReason);
    if (this.released) {
      return Promise.reject(supervisorError(
        "LEASE_RELEASED",
        "Codex app-server lease has been released",
      ));
    }
    const process = this.entry.process;
    const generation = this.entry.generation;
    if (
      this.entry.state !== "ready" ||
      !process ||
      process.generation !== generation
    ) {
      return Promise.reject(supervisorError(
        "UNAVAILABLE",
        "Codex app-server generation is unavailable",
      ));
    }

    let operation: Promise<T>;
    try {
      operation = process.call<T>(method, params, options);
    } catch {
      operation = Promise.reject(supervisorError(
        "UNAVAILABLE",
        "Codex app-server call failed before dispatch",
      ));
    }
    let tracked!: Promise<T>;
    tracked = operation.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
    return tracked;
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.released = true;
    this.releasePromise = this.supervisor.releaseLease(this);
    return this.releasePromise;
  }

  invalidate(reason: CodexSupervisorError): void {
    if (!this.invalidReason) this.invalidReason = reason;
  }
}

export class CodexAppServerSupervisor {
  readonly executable: string;
  readonly clientVersion: string;

  private readonly isEnabledFn: () => boolean;
  private readonly reconcile: CodexAppServerSupervisorOptions["reconcile"];
  private readonly processFactory: CodexSupervisorProcessFactory;
  private readonly canonicalizeHome: (home: string) => string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutFn: CodexSupervisorSetTimeout;
  private readonly clearTimeoutFn: CodexSupervisorClearTimeout;
  private readonly maxTrackedHomes: number;
  private readonly maxDemandPerHome: number;
  private readonly maxPendingRequestsPerHome: number;
  private readonly entries = new Map<string, HomeEntry>();
  private readonly circuits = new Map<string, CircuitState>();
  private nextEntryEpoch = 1;
  private nextGeneration = 1;
  private nextCircuitTouch = 1;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private disablePromise: Promise<void> | null = null;

  constructor(options: CodexAppServerSupervisorOptions) {
    this.executable = nonEmpty(options.executable, "executable");
    if (!path.isAbsolute(this.executable)) {
      throw new TypeError("executable must be an absolute path");
    }
    this.clientVersion = nonEmpty(options.clientVersion, "client version");
    if (typeof options.isEnabled !== "function") {
      throw new TypeError("isEnabled must be a function");
    }
    if (typeof options.reconcile !== "function") {
      throw new TypeError("reconcile must be a function");
    }
    this.isEnabledFn = options.isEnabled;
    this.reconcile = options.reconcile;
    this.canonicalizeHome = options.canonicalizeHome ?? canonicalizeProviderHome;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.maxTrackedHomes = boundedPositiveSafeInteger(
      options.maxTrackedHomes,
      CODEX_SUPERVISOR_MAX_TRACKED_HOMES,
      CODEX_SUPERVISOR_MAX_TRACKED_HOMES,
      "maxTrackedHomes",
    );
    this.maxDemandPerHome = boundedPositiveSafeInteger(
      options.maxDemandPerHome,
      CODEX_SUPERVISOR_MAX_DEMAND_PER_HOME,
      CODEX_SUPERVISOR_MAX_DEMAND_PER_HOME,
      "maxDemandPerHome",
    );
    this.maxPendingRequestsPerHome = boundedPositiveSafeInteger(
      options.maxPendingRequestsPerHome,
      CODEX_SUPERVISOR_MAX_PENDING_REQUESTS_PER_HOME,
      CODEX_SUPERVISOR_MAX_PENDING_REQUESTS_PER_HOME,
      "maxPendingRequestsPerHome",
    );
    this.processFactory = options.processFactory ?? ((processOptions) => {
      const appServerOptions: AppServerProcessOptions = {
        executable: processOptions.executable,
        home: processOptions.home,
        generation: processOptions.generation,
        appVersion: processOptions.clientVersion,
        reconcile: processOptions.reconcile,
        onNotification: processOptions.onNotification,
        onUnknownNotification: processOptions.onUnknownNotification,
        onServerRequest: processOptions.onServerRequest,
      };
      return new AppServerProcess(appServerOptions);
    });
  }

  async acquire(options: CodexSupervisorAcquireOptions): Promise<CodexAppServerLease> {
    this.assertAcquireAllowed();
    this.assertHandlers(options.handlers);
    this.assertAcquireSignal(options.signal);
    const home = this.canonicalizeHome(nonEmpty(options.home, "home"));

    while (true) {
      this.assertAcquireAllowed();
      this.assertAcquireSignal(options.signal);
      const current = this.entries.get(home);
      if (current?.state === "stopping") {
        await this.raceAcquire(current.stopPromise!, options.signal);
        continue;
      }
      if (current?.state === "unavailable") {
        throw current.failure ?? supervisorError(
          "UNAVAILABLE",
          "Codex app-server did not confirm a safe restart boundary",
        );
      }
      if (current?.state === "open" && this.readNow() < current.circuit.openUntil!) {
        throw supervisorError("CIRCUIT_OPEN", "Codex app-server circuit is open");
      }

      const entry = current ?? this.createEntry(home, options.handlers);
      this.reserve(entry, options.handlers);
      try {
        if (entry.state === "idle" || entry.state === "open") {
          this.launchGeneration(entry);
        } else if (entry.state === "backoff") {
          this.ensureBackoffWakeup(entry);
        }
        do {
          await this.waitUntilReady(entry, options.signal);
        } while (entry.state !== "ready" || !entry.process);
        if (entry.reservations < 1) {
          throw supervisorError("UNAVAILABLE", "Codex acquire reservation was lost");
        }
        entry.reservations -= 1;
        const lease = new CodexLease(this, entry);
        entry.leases.add(lease);
        return lease;
      } catch (error) {
        await this.rollbackReservation(entry);
        throw error;
      }
    }
  }

  refreshEnabled(): Promise<void> {
    if (this.enabled()) {
      this.disablePromise = null;
      return Promise.resolve();
    }
    if (this.disablePromise) return this.disablePromise;
    this.disablePromise = this.stopAll("DISABLED");
    return this.disablePromise;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.stopAll("SHUTDOWN");
    return this.shutdownPromise;
  }

  releaseLease(lease: CodexLease): Promise<void> {
    if (lease.inFlight.size === 0) return this.finishLeaseRelease(lease);
    return Promise.allSettled([...lease.inFlight]).then(() => this.finishLeaseRelease(lease));
  }

  private finishLeaseRelease(lease: CodexLease): Promise<void> {
    const entry = lease.entry;
    if (!entry.leases.delete(lease)) return Promise.resolve();
    this.releaseBindingUser(entry);
    if (entry.leases.size === 0 && entry.reservations === 0) {
      return this.stopEntry(entry, supervisorError(
        "LEASE_RELEASED",
        "Codex app-server request owner released",
      ));
    }
    return Promise.resolve();
  }

  private createEntry(home: string, handlers: CodexSupervisorHandlers): HomeEntry {
    const now = this.readNow();
    const circuit = this.circuits.get(home) ?? this.createCircuit(home, now);
    this.normalizeInactiveCircuit(circuit, now);
    this.touchCircuit(circuit);
    const open = circuit.openUntil !== null && now < circuit.openUntil;
    const backingOff = !open && circuit.retryAt !== null && now < circuit.retryAt;
    if (!backingOff && circuit.retryAt !== null && now >= circuit.retryAt) {
      circuit.retryAt = null;
    }
    const entry: HomeEntry = {
      home,
      epoch: this.nextEntryEpoch++,
      circuit,
      state: open ? "open" : backingOff ? "backoff" : "idle",
      binding: {
        handlers: snapshotHandlers(handlers),
        controller: new AbortController(),
        pendingRequests: new Map(),
        users: 0,
      },
      reservations: 0,
      leases: new Set(),
      process: null,
      generation: circuit.nextGeneration,
      processToken: 0,
      handlingToken: null,
      change: deferred<void>(),
      failure: open
        ? supervisorError("CIRCUIT_OPEN", "Codex app-server circuit is open")
        : null,
      restartTimer: undefined,
      restartTimerSet: false,
      restartTimerToken: 0,
      restartSafe: true,
      quarantineCleanup: null,
      stopPromise: null,
    };
    this.entries.set(home, entry);
    return entry;
  }

  private createCircuit(home: string, now: number): CircuitState {
    this.admitCircuit(home, now);
    const circuit: CircuitState = {
      nextGeneration: 0,
      failures: [],
      attempt: 0,
      retryAt: null,
      openUntil: null,
      halfOpen: false,
      lastUsedSequence: this.nextCircuitTouch++,
      healthyTimer: undefined,
      healthyTimerSet: false,
      healthyTimerToken: 0,
    };
    this.circuits.set(home, circuit);
    return circuit;
  }

  private launchGeneration(entry: HomeEntry): void {
    if (
      this.entries.get(entry.home) !== entry ||
      !(["idle", "backoff", "open"] as HomeState[]).includes(entry.state) ||
      entry.process !== null ||
      this.shuttingDown
    ) return;
    if (!this.enabled()) {
      void this.stopEntry(entry, supervisorError("DISABLED", "Native Codex was disabled"));
      return;
    }
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.markUnavailable(entry);
      return;
    }
    if (entry.circuit.openUntil !== null) {
      if (now < entry.circuit.openUntil) {
        entry.state = "open";
        entry.failure = supervisorError("CIRCUIT_OPEN", "Codex app-server circuit is open");
        this.bump(entry);
        return;
      }
      entry.circuit.halfOpen = true;
      entry.circuit.openUntil = null;
    }
    if (entry.circuit.retryAt !== null && now < entry.circuit.retryAt) {
      entry.state = "backoff";
      entry.failure = null;
      this.bump(entry);
      this.ensureBackoffWakeup(entry);
      return;
    }
    entry.circuit.retryAt = null;

    this.cancelRestartTimer(entry);
    if (!Number.isSafeInteger(this.nextGeneration)) {
      this.markUnavailable(entry);
      return;
    }
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    entry.circuit.nextGeneration = generation;
    entry.generation = generation;
    entry.processToken += 1;
    entry.handlingToken = null;
    entry.restartSafe = true;
    entry.state = "starting";
    entry.failure = null;
    const token = entry.processToken;
    let candidate: unknown;
    try {
      candidate = this.processFactory({
        executable: this.executable,
        home: entry.home,
        generation,
        clientVersion: this.clientVersion,
        reconcile: this.reconcile,
        onNotification: (notification, context) =>
          this.dispatchNotification(entry, notification, context, false),
        onUnknownNotification: (notification, context) =>
          this.dispatchNotification(entry, notification, context, true),
        onServerRequest: (request, context) => this.dispatchRequest(entry, request, context),
      });
    } catch {
      void this.handleFactoryFailure(entry, token);
      return;
    }
    const process = this.processFacade(candidate);
    if (!process) {
      void this.handleInvalidFactoryResult(entry, candidate, token);
      return;
    }
    if (process.home !== entry.home || process.generation !== generation) {
      entry.process = process;
      void this.handleStartFailure(entry, process, token);
      return;
    }
    entry.process = process;
    void process.terminated.then(
      (result) => this.handleProcessTerminal(entry, process, token, result),
      () => this.handleProcessTerminalFailure(entry, process, token),
    );
    void this.startProcess(entry, process, token);
    this.bump(entry);
  }

  private processFacade(candidate: unknown): CodexSupervisorProcess | null {
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    ) return null;
    try {
      const home = Reflect.get(candidate, "home") as unknown;
      const generation = Reflect.get(candidate, "generation") as unknown;
      const terminatedValue = Reflect.get(candidate, "terminated") as unknown;
      const start = Reflect.get(candidate, "start") as unknown;
      const call = Reflect.get(candidate, "call") as unknown;
      const shutdown = Reflect.get(candidate, "shutdown") as unknown;
      if (
        typeof home !== "string" ||
        !Number.isSafeInteger(generation) ||
        (generation as number) < 1 ||
        (
          terminatedValue === null ||
          (typeof terminatedValue !== "object" && typeof terminatedValue !== "function")
        ) ||
        typeof Reflect.get(terminatedValue, "then") !== "function" ||
        typeof start !== "function" ||
        typeof call !== "function" ||
        typeof shutdown !== "function"
      ) return null;
      const target = candidate;
      const terminated = Promise.resolve(
        terminatedValue as PromiseLike<CodexAppServerTerminal>,
      );
      let shutdownPromise: Promise<CodexAppServerTerminal> | null = null;
      return Object.freeze({
        home,
        generation: generation as number,
        terminated,
        start: async () => await Reflect.apply(start, target, []) as CodexAppServerReady,
        call: async <T = unknown>(
          method: string,
          params?: unknown,
          options?: CodexClientCallOptions,
        ) => await Reflect.apply(call, target, [method, params, options]) as T,
        shutdown: () => {
          shutdownPromise ??= (async () => await Reflect.apply(
            shutdown,
            target,
            [],
          ) as CodexAppServerTerminal)();
          return shutdownPromise;
        },
      });
    } catch {
      return null;
    }
  }

  private async handleInvalidFactoryResult(
    entry: HomeEntry,
    candidate: unknown,
    token: number,
  ): Promise<void> {
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    ) {
      await this.handleFactoryFailure(entry, token);
      return;
    }
    if (!this.claimFailure(entry, null, token)) return;
    let shutdown: unknown;
    try {
      shutdown = Reflect.get(candidate, "shutdown") as unknown;
      if (typeof shutdown !== "function") {
        this.markUnavailable(entry);
        return;
      }
    } catch {
      this.markUnavailable(entry);
      return;
    }
    entry.restartSafe = false;
    const cleanup = (async (): Promise<boolean> => {
      try {
        const result = await Reflect.apply(shutdown, candidate, []);
        return this.terminalConfirmsRestart(result, entry.home, entry.generation);
      } catch {
        return false;
      }
    })();
    entry.quarantineCleanup = cleanup;
    const confirmed = await cleanup;
    if (!this.isEntryCurrent(entry)) return;
    if (entry.quarantineCleanup !== cleanup || !confirmed) {
      this.markUnavailable(entry);
      return;
    }
    entry.restartSafe = true;
    if (entry.state === "stopping") return;
    entry.process = null;
    this.recordFailure(entry);
  }

  private async startProcess(
    entry: HomeEntry,
    process: CodexSupervisorProcess,
    token: number,
  ): Promise<void> {
    try {
      const ready = await process.start();
      if (!this.isCurrentProcess(entry, process, token) || entry.handlingToken === token) return;
      if (entry.state !== "starting") return;
      if (this.shuttingDown || !this.enabled()) {
        await this.stopEntry(entry, supervisorError(
          this.shuttingDown ? "SHUTDOWN" : "DISABLED",
          this.shuttingDown ? "Codex supervisor is shut down" : "Native Codex was disabled",
        ));
        return;
      }
      if (!this.readyMatches(ready, entry.home, entry.generation)) {
        await this.handleStartFailure(entry, process, token);
        return;
      }
      entry.state = "ready";
      entry.failure = null;
      entry.circuit.retryAt = null;
      this.touchCircuit(entry.circuit);
      this.scheduleHealthyReset(entry, process, token);
      this.bump(entry);
    } catch {
      await this.handleStartFailure(entry, process, token);
    }
  }

  private async handleFactoryFailure(entry: HomeEntry, token: number): Promise<void> {
    if (!this.claimFailure(entry, null, token)) return;
    entry.process = null;
    this.recordFailure(entry);
  }

  private async handleStartFailure(
    entry: HomeEntry,
    process: CodexSupervisorProcess,
    token: number,
  ): Promise<void> {
    if (!this.claimFailure(entry, process, token)) return;
    let result: unknown;
    try {
      result = await process.shutdown();
    } catch {
      this.markUnavailable(entry);
      return;
    }
    if (!this.isEntryCurrent(entry)) return;
    if (!this.terminalConfirmsRestart(result, entry.home, entry.generation)) {
      this.markUnavailable(entry);
      return;
    }
    entry.process = null;
    this.recordFailure(entry);
  }

  private handleProcessTerminal(
    entry: HomeEntry,
    process: CodexSupervisorProcess,
    token: number,
    result: unknown,
  ): void {
    if (!this.claimFailure(entry, process, token)) return;
    this.cancelHealthyReset(entry.circuit);
    if (!this.terminalMatches(result, entry.home, entry.generation)) {
      this.markUnavailable(entry);
      return;
    }
    if (!result.safeToRestart || !result.exitSeen) {
      this.markUnavailable(entry);
      return;
    }
    entry.process = null;
    if (entry.state === "stopping") return;
    if (result.intentional) {
      this.markUnavailable(entry);
      return;
    }
    this.recordFailure(entry);
  }

  private handleProcessTerminalFailure(
    entry: HomeEntry,
    process: CodexSupervisorProcess,
    token: number,
  ): void {
    if (!this.claimFailure(entry, process, token)) return;
    this.cancelHealthyReset(entry.circuit);
    this.markUnavailable(entry);
  }

  private claimFailure(
    entry: HomeEntry,
    process: CodexSupervisorProcess | null,
    token: number,
  ): boolean {
    if (!this.isEntryCurrent(entry) || entry.processToken !== token) return false;
    if (process && entry.process !== process) return false;
    if (entry.handlingToken === token) return false;
    entry.handlingToken = token;
    return true;
  }

  private recordFailure(entry: HomeEntry): void {
    if (!this.isEntryCurrent(entry) || entry.state === "stopping") return;
    const circuit = entry.circuit;
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.markUnavailable(entry);
      return;
    }
    this.pruneCircuit(circuit, now);
    this.touchCircuit(circuit);
    circuit.failures.push(now);
    while (circuit.failures.length > 5) circuit.failures.shift();
    this.cancelHealthyReset(circuit);
    const reopen = circuit.halfOpen;
    circuit.halfOpen = false;
    if (reopen || circuit.failures.length >= 5) {
      circuit.retryAt = null;
      circuit.openUntil = now + CODEX_SUPERVISOR_CIRCUIT_OPEN_MS;
      entry.state = "open";
      entry.failure = supervisorError("CIRCUIT_OPEN", "Codex app-server circuit is open");
      this.bump(entry);
      this.scheduleOpenProbe(entry);
      return;
    }

    let delay: number;
    try {
      delay = codexSupervisorBackoffDelay(circuit.attempt, this.random);
    } catch {
      this.markUnavailable(entry);
      return;
    }
    circuit.attempt = Math.min(
      circuit.attempt + 1,
      CODEX_SUPERVISOR_BACKOFF_MS.length - 1,
    );
    circuit.retryAt = now + delay;
    if (entry.leases.size === 0) {
      entry.state = "unavailable";
      entry.failure = supervisorError("UNAVAILABLE", "Codex app-server failed to start");
      this.bump(entry);
      return;
    }
    entry.state = "backoff";
    entry.failure = null;
    this.bump(entry);
    this.scheduleRestart(entry, delay);
  }

  private ensureBackoffWakeup(entry: HomeEntry): void {
    if (entry.restartTimerSet || entry.state !== "backoff") return;
    const retryAt = entry.circuit.retryAt;
    if (retryAt === null) {
      this.launchGeneration(entry);
      return;
    }
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.markUnavailable(entry);
      return;
    }
    if (now >= retryAt) {
      entry.circuit.retryAt = null;
      this.launchGeneration(entry);
      return;
    }
    this.scheduleRestart(entry, retryAt - now);
  }

  private scheduleRestart(entry: HomeEntry, delayMs: number): void {
    this.cancelRestartTimer(entry);
    const epoch = entry.epoch;
    const expectedState = entry.state;
    const expectedProcessToken = entry.processToken;
    const timerToken = entry.restartTimerToken + 1;
    entry.restartTimerToken = timerToken;
    let handle: unknown;
    let installing = true;
    let firedSynchronously = false;
    const callback = (): void => {
      if (installing) {
        firedSynchronously = true;
        return;
      }
      if (
        !entry.restartTimerSet ||
        entry.restartTimerToken !== timerToken ||
        entry.restartTimer !== handle
      ) return;
      entry.restartTimerSet = false;
      entry.restartTimer = undefined;
      if (
        !this.isTimerCurrent(entry, epoch) ||
        !this.hasDemand(entry) ||
        entry.state !== expectedState ||
        entry.processToken !== expectedProcessToken ||
        entry.process !== null ||
        (entry.state !== "backoff" && entry.state !== "open")
      ) return;
      if (!this.enabled()) {
        void this.stopEntry(entry, supervisorError("DISABLED", "Native Codex was disabled"));
        return;
      }
      this.launchGeneration(entry);
    };
    try {
      handle = this.setTimeoutFn(callback, delayMs);
    } catch {
      installing = false;
      entry.restartTimer = undefined;
      entry.restartTimerSet = false;
      this.markUnavailable(entry);
      return;
    }
    installing = false;
    if (firedSynchronously) {
      try { this.clearTimeoutFn(handle); } catch { /* timer is logically fenced */ }
      entry.restartTimer = undefined;
      entry.restartTimerSet = false;
      this.markUnavailable(entry);
      return;
    }
    entry.restartTimer = handle;
    entry.restartTimerSet = true;
  }

  private scheduleOpenProbe(entry: HomeEntry): void {
    if (!this.hasDemand(entry) || entry.circuit.openUntil === null) return;
    let delay: number;
    try {
      delay = Math.max(0, entry.circuit.openUntil - this.readNow());
    } catch {
      this.markUnavailable(entry);
      return;
    }
    this.scheduleRestart(entry, delay);
  }

  private scheduleHealthyReset(
    entry: HomeEntry,
    process: CodexSupervisorProcess,
    token: number,
  ): void {
    const circuit = entry.circuit;
    this.cancelHealthyReset(circuit);
    const timerToken = circuit.healthyTimerToken + 1;
    circuit.healthyTimerToken = timerToken;
    let handle: unknown;
    let installing = true;
    let firedSynchronously = false;
    const callback = (): void => {
      if (installing) {
        firedSynchronously = true;
        return;
      }
      if (
        !circuit.healthyTimerSet ||
        circuit.healthyTimerToken !== timerToken ||
        circuit.healthyTimer !== handle
      ) return;
      circuit.healthyTimerSet = false;
      circuit.healthyTimer = undefined;
      if (!this.isCurrentProcess(entry, process, token) || entry.state !== "ready") return;
      circuit.failures.splice(0);
      circuit.attempt = 0;
      circuit.retryAt = null;
      circuit.openUntil = null;
      circuit.halfOpen = false;
      this.touchCircuit(circuit);
    };
    try {
      handle = this.setTimeoutFn(callback, CODEX_SUPERVISOR_HEALTHY_RESET_MS);
    } catch {
      installing = false;
      circuit.healthyTimer = undefined;
      circuit.healthyTimerSet = false;
      return;
    }
    installing = false;
    if (firedSynchronously) {
      try { this.clearTimeoutFn(handle); } catch { /* timer is logically fenced */ }
      circuit.healthyTimer = undefined;
      circuit.healthyTimerSet = false;
      return;
    }
    circuit.healthyTimer = handle;
    circuit.healthyTimerSet = true;
  }

  private async waitUntilReady(entry: HomeEntry, signal?: AbortSignal): Promise<void> {
    while (true) {
      if (entry.state === "ready") return;
      if (entry.failure) throw entry.failure;
      if (entry.state === "unavailable" || entry.state === "stopped") {
        throw supervisorError("UNAVAILABLE", "Codex app-server generation is unavailable");
      }
      const changed = entry.change.promise;
      await this.raceAcquire(changed, signal);
    }
  }

  private reserve(entry: HomeEntry, handlers: CodexSupervisorHandlers): void {
    const binding = entry.binding;
    if (!binding || !handlersMatch(binding.handlers, handlers)) {
      throw supervisorError(
        "HANDLER_CONFLICT",
        "Codex app-server home already has a different request owner",
      );
    }
    if (binding.users >= this.maxDemandPerHome) {
      throw supervisorError(
        "UNAVAILABLE",
        "Codex app-server home reached its request-owner capacity",
      );
    }
    binding.users += 1;
    entry.reservations += 1;
  }

  private async rollbackReservation(entry: HomeEntry): Promise<void> {
    if (entry.reservations > 0) entry.reservations -= 1;
    this.releaseBindingUser(entry);
    if (entry.reservations === 0 && entry.leases.size === 0) {
      if (entry.stopPromise) return;
      const stopping = this.stopEntry(entry, entry.failure ?? supervisorError(
        "UNAVAILABLE",
        "Codex acquire reservation ended",
      ));
      if (entry.quarantineCleanup) {
        void stopping;
        return;
      }
      await stopping;
    }
  }

  private releaseBindingUser(entry: HomeEntry): void {
    const binding = entry.binding;
    if (!binding || binding.users === 0) return;
    binding.users -= 1;
    if (binding.users === 0 && !binding.controller.signal.aborted) {
      binding.controller.abort(supervisorError(
        "LEASE_RELEASED",
        "Codex app-server request owner released",
      ));
    }
  }

  private stopEntry(entry: HomeEntry, reason: CodexSupervisorError): Promise<void> {
    if (entry.stopPromise) return entry.stopPromise;
    entry.state = "stopping";
    entry.failure = reason;
    this.cancelRestartTimer(entry);
    this.cancelHealthyReset(entry.circuit);
    for (const lease of entry.leases) lease.invalidate(reason);
    if (entry.binding && !entry.binding.controller.signal.aborted) {
      entry.binding.controller.abort(reason);
    }
    this.bump(entry);
    const process = entry.process;
    const quarantineCleanup = entry.quarantineCleanup;
    entry.stopPromise = (async () => {
      let result: unknown = null;
      let shutdownFailed = false;
      let quarantineConfirmed = true;
      if (quarantineCleanup) {
        quarantineConfirmed = await quarantineCleanup;
      } else if (process) {
        try {
          result = await process.shutdown();
        } catch {
          shutdownFailed = true;
        }
      }
      if (!this.isEntryCurrent(entry)) return;
      if (
        !quarantineConfirmed ||
        shutdownFailed ||
        (
          process !== null &&
          !this.terminalConfirmsRestart(result, process.home, process.generation)
        )
      ) {
        entry.restartSafe = false;
        entry.state = "unavailable";
        entry.failure = supervisorError(
          "UNAVAILABLE",
          "Codex app-server did not confirm a safe restart boundary",
        );
        entry.binding = null;
        this.bump(entry);
        return;
      }
      if (quarantineCleanup) entry.restartSafe = true;
      entry.quarantineCleanup = null;
      entry.process = null;
      if (!entry.restartSafe) {
        entry.state = "unavailable";
        entry.failure = supervisorError(
          "UNAVAILABLE",
          "Codex app-server did not confirm a safe restart boundary",
        );
        entry.binding = null;
        this.bump(entry);
        return;
      }
      entry.state = "stopped";
      entry.binding = null;
      this.entries.delete(entry.home);
      this.bump(entry);
    })();
    return entry.stopPromise;
  }

  private async dispatchNotification(
    entry: HomeEntry,
    notification: CodexRpcNotification,
    context: AppServerGenerationContext,
    unknown: boolean,
  ): Promise<void> {
    const binding = this.currentBinding(entry, context);
    if (!binding) return;
    const handler = unknown
      ? binding.handlers.onUnknownNotification
      : binding.handlers.onNotification;
    if (!handler) return;
    const signal = combineSignals(context.signal, binding.controller.signal);
    await handler(notification, Object.freeze({ ...context, signal }));
  }

  private async dispatchRequest(
    entry: HomeEntry,
    request: CodexRpcRequest,
    context: AppServerGenerationContext,
  ): Promise<unknown> {
    const binding = this.currentBinding(entry, context);
    if (!binding) {
      throw supervisorError("UNAVAILABLE", "Codex server request has no active owner");
    }
    const requestKey = `${context.generation}\u0000${serializeCodexRpcId(request.id)}`;
    if (binding.pendingRequests.has(requestKey)) {
      throw supervisorError("UNAVAILABLE", "Duplicate Codex server request id");
    }
    if (binding.pendingRequests.size >= this.maxPendingRequestsPerHome) {
      throw supervisorError("UNAVAILABLE", "Codex server request capacity was reached");
    }
    const requestController = new AbortController();
    binding.pendingRequests.set(requestKey, requestController);
    const signal = combineSignals(
      context.signal,
      binding.controller.signal,
      requestController.signal,
    );
    let removeAbortListener = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        const reason = signal.reason;
        reject(reason instanceof CodexSupervisorError
          ? reason
          : supervisorError("UNAVAILABLE", "Codex server request was cancelled"));
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
    });
    try {
      const handling = Promise.resolve().then(() => binding.handlers.onServerRequest(
        request,
        Object.freeze({ ...context, signal }),
      ));
      return await Promise.race([handling, aborted]);
    } finally {
      removeAbortListener();
      if (binding.pendingRequests.get(requestKey) === requestController) {
        binding.pendingRequests.delete(requestKey);
      }
    }
  }

  private currentBinding(
    entry: HomeEntry,
    context: AppServerGenerationContext,
  ): HandlerBinding | null {
    if (
      !this.isEntryCurrent(entry) ||
      entry.generation !== context.generation ||
      entry.home !== context.home ||
      (entry.state !== "starting" && entry.state !== "ready") ||
      entry.process === null ||
      entry.process.generation !== context.generation ||
      entry.handlingToken === entry.processToken
    ) return null;
    const binding = entry.binding;
    if (!binding || binding.controller.signal.aborted) return null;
    return binding;
  }

  private raceAcquire<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      return Promise.reject(supervisorError("UNAVAILABLE", "Codex acquire was cancelled"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        reject(supervisorError("UNAVAILABLE", "Codex acquire was cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private bump(entry: HomeEntry): void {
    const current = entry.change;
    entry.change = deferred<void>();
    current.resolve();
  }

  private cancelRestartTimer(entry: HomeEntry): void {
    if (!entry.restartTimerSet) return;
    entry.restartTimerSet = false;
    entry.restartTimerToken += 1;
    const handle = entry.restartTimer;
    entry.restartTimer = undefined;
    try {
      this.clearTimeoutFn(handle);
    } catch {
      // Logical timer fencing is authoritative even if host cancellation fails.
    }
  }

  private cancelHealthyReset(circuit: CircuitState): void {
    if (!circuit.healthyTimerSet) return;
    circuit.healthyTimerSet = false;
    circuit.healthyTimerToken += 1;
    const handle = circuit.healthyTimer;
    circuit.healthyTimer = undefined;
    try {
      this.clearTimeoutFn(handle);
    } catch {
      // Logical timer fencing is authoritative even if host cancellation fails.
    }
  }

  private markUnavailable(entry: HomeEntry): void {
    if (!this.isEntryCurrent(entry)) return;
    entry.restartSafe = false;
    entry.state = "unavailable";
    const reason = supervisorError(
      "UNAVAILABLE",
      "Codex app-server did not confirm a safe restart boundary",
    );
    entry.failure = reason;
    for (const lease of entry.leases) lease.invalidate(reason);
    if (entry.binding && !entry.binding.controller.signal.aborted) {
      entry.binding.controller.abort(reason);
    }
    this.bump(entry);
  }

  private readyMatches(
    value: unknown,
    home: string,
    generation: number,
  ): value is CodexAppServerReady {
    if (!value || typeof value !== "object") return false;
    try {
      const signal = Reflect.get(value, "signal") as unknown;
      return Reflect.get(value, "home") === home &&
        Reflect.get(value, "generation") === generation &&
        signal !== null &&
        typeof signal === "object" &&
        typeof Reflect.get(signal, "aborted") === "boolean";
    } catch {
      return false;
    }
  }

  private terminalMatches(
    value: unknown,
    home: string,
    generation: number,
  ): value is CodexAppServerTerminal {
    if (!value || typeof value !== "object") return false;
    try {
      return Reflect.get(value, "home") === home &&
        Reflect.get(value, "generation") === generation &&
        typeof Reflect.get(value, "intentional") === "boolean" &&
        typeof Reflect.get(value, "exitSeen") === "boolean" &&
        typeof Reflect.get(value, "safeToRestart") === "boolean" &&
        Reflect.has(value, "error");
    } catch {
      return false;
    }
  }

  private terminalConfirmsRestart(
    value: unknown,
    home: string,
    generation: number,
  ): value is CodexAppServerTerminal {
    return this.terminalMatches(value, home, generation) &&
      value.intentional &&
      value.exitSeen &&
      value.safeToRestart;
  }

  private touchCircuit(circuit: CircuitState): void {
    if (!Number.isSafeInteger(this.nextCircuitTouch)) {
      let sequence = 1;
      for (const existing of [...this.circuits.values()].sort(
        (left, right) => left.lastUsedSequence - right.lastUsedSequence,
      )) {
        existing.lastUsedSequence = sequence;
        sequence += 1;
      }
      this.nextCircuitTouch = sequence;
    }
    circuit.lastUsedSequence = this.nextCircuitTouch;
    this.nextCircuitTouch += 1;
  }

  private pruneCircuit(circuit: CircuitState, now: number): void {
    const cutoff = now - CODEX_SUPERVISOR_FAILURE_WINDOW_MS;
    while (circuit.failures.length > 0 && circuit.failures[0]! < cutoff) {
      circuit.failures.shift();
    }
  }

  private normalizeInactiveCircuit(circuit: CircuitState, now: number): void {
    this.pruneCircuit(circuit, now);
    if (circuit.retryAt !== null && now >= circuit.retryAt) {
      circuit.retryAt = null;
    }
    if (
      circuit.openUntil !== null &&
      now >= circuit.openUntil &&
      circuit.failures.length === 0
    ) {
      circuit.openUntil = null;
    }
    if (
      !circuit.healthyTimerSet &&
      circuit.retryAt === null &&
      circuit.openUntil === null &&
      circuit.failures.length === 0
    ) {
      circuit.halfOpen = false;
      circuit.attempt = 0;
    }
  }

  private admitCircuit(home: string, now: number): void {
    if (this.circuits.has(home) || this.circuits.size < this.maxTrackedHomes) return;
    let candidateHome: string | null = null;
    let candidateSequence = Number.POSITIVE_INFINITY;
    for (const [trackedHome, circuit] of this.circuits) {
      if (this.entries.has(trackedHome)) continue;
      this.normalizeInactiveCircuit(circuit, now);
      if (
        circuit.healthyTimerSet ||
        circuit.retryAt !== null ||
        circuit.openUntil !== null ||
        circuit.halfOpen ||
        circuit.failures.length > 0 ||
        circuit.attempt !== 0
      ) continue;
      if (circuit.lastUsedSequence < candidateSequence) {
        candidateHome = trackedHome;
        candidateSequence = circuit.lastUsedSequence;
      }
    }
    if (candidateHome === null) {
      throw supervisorError("UNAVAILABLE", "Codex app-server home capacity was reached");
    }
    this.circuits.delete(candidateHome);
  }

  private assertAcquireAllowed(): void {
    if (this.shuttingDown) throw supervisorError("SHUTDOWN", "Codex supervisor is shut down");
    if (!this.enabled()) throw supervisorError("DISABLED", "Native Codex is disabled");
    this.disablePromise = null;
  }

  private assertAcquireSignal(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw supervisorError("UNAVAILABLE", "Codex acquire was cancelled");
    }
  }

  private assertHandlers(handlers: CodexSupervisorHandlers): void {
    if (!handlers || typeof handlers.owner !== "symbol") {
      throw new TypeError("supervisor handlers require an owner symbol");
    }
    if (
      typeof handlers.onNotification !== "function" ||
      typeof handlers.onServerRequest !== "function" ||
      (
        handlers.onUnknownNotification !== undefined &&
        typeof handlers.onUnknownNotification !== "function"
      )
    ) {
      throw new TypeError("supervisor handlers must be functions");
    }
  }

  private enabled(): boolean {
    try { return this.isEnabledFn() === true; } catch { return false; }
  }

  private readNow(): number {
    let value: number;
    try {
      value = this.now();
    } catch {
      throw supervisorError("UNAVAILABLE", "Codex supervisor clock is unavailable");
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw supervisorError("UNAVAILABLE", "Codex supervisor clock is unavailable");
    }
    return value;
  }

  private hasDemand(entry: HomeEntry): boolean {
    return entry.reservations > 0 || entry.leases.size > 0;
  }

  private isEntryCurrent(entry: HomeEntry): boolean {
    return this.entries.get(entry.home) === entry;
  }

  private isCurrentProcess(
    entry: HomeEntry,
    process: CodexSupervisorProcess,
    token: number,
  ): boolean {
    return this.isEntryCurrent(entry) &&
      entry.process === process &&
      entry.processToken === token;
  }

  private isTimerCurrent(entry: HomeEntry, epoch: number): boolean {
    return this.isEntryCurrent(entry) && entry.epoch === epoch && !this.shuttingDown;
  }

  private async stopAll(code: "DISABLED" | "SHUTDOWN"): Promise<void> {
    const reason = supervisorError(
      code,
      code === "DISABLED" ? "Native Codex was disabled" : "Codex supervisor shut down",
    );
    await Promise.all([...this.entries.values()].map((entry) => this.stopEntry(entry, reason)));
  }
}
