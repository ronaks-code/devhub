import path from "node:path";
import type { ProviderEventSink } from "../types.js";
import {
  canonicalizeProviderHome,
  createNativeTaskKey,
  nativeTaskKeyId,
} from "../task-key.js";
import type {
  NativeTurnRef,
  ProviderRequestResponse,
  UserInput,
} from "../types.js";
import {
  ClaudeCliProcess,
  type ClaudeCliPermissionMode,
} from "./cli-process.js";
import {
  ClaudeBackendDiagnosticStore,
  claudeBackendDiagnosticTaskScope,
  type ClaudeBackendDiagnosticRecord,
  type ClaudeBackendDiagnosticSnapshot,
} from "./backend-diagnostic-store.js";
import {
  resolveClaudeAuth,
  type ClaudeAuthDecision,
} from "./auth-policy.js";
import type { ClaudeModelEvidenceSnapshot } from "./model-evidence.js";
import {
  ClaudeTaskRuntime,
  type ClaudeTaskRuntimeProcessTerminal,
} from "./task-runtime.js";

export const CLAUDE_SUPERVISOR_BACKOFF_MS = Object.freeze([
  250,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
] as const);
export const CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS = 60_000;
export const CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS = 60_000;
export const CLAUDE_SUPERVISOR_JITTER_MS = 250;
export const CLAUDE_SUPERVISOR_DEFAULT_MAX_TASKS = 256;
export const CLAUDE_SUPERVISOR_DEFAULT_MAX_LEASES_PER_TASK = 256;
export const CLAUDE_SUPERVISOR_DEFAULT_MAX_BACKEND_DIAGNOSTICS = 4_096;
export const CLAUDE_SUPERVISOR_HARD_MAX = 4_096;
const CIRCUIT_FAILURES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ClaudeSupervisorErrorCode =
  | "CIRCUIT_OPEN"
  | "CONFIGURATION_CONFLICT"
  | "DISABLED"
  | "HANDLER_CONFLICT"
  | "INVALID_CONFIGURATION"
  | "LEASE_RELEASED"
  | "SHUTDOWN"
  | "UNAUTHORIZED_AUTH"
  | "UNAVAILABLE";

export class ClaudeSupervisorError extends Error {
  readonly code: ClaudeSupervisorErrorCode;

  constructor(code: ClaudeSupervisorErrorCode, message: string) {
    super(message);
    this.name = "ClaudeSupervisorError";
    this.code = code;
    Object.freeze(this);
  }
}

export interface ClaudeSupervisorHandlers {
  readonly owner: symbol;
  readonly emit: ProviderEventSink;
}

export interface ClaudeSupervisorReconcileContext {
  readonly configHome: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly reason: "resume" | "restart";
}

export type ClaudeSupervisorReconcile = (
  context: ClaudeSupervisorReconcileContext,
) => void | Promise<void>;

export interface ClaudeSupervisorRuntimeOptions {
  readonly executable: string;
  readonly configHome: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly launch: "new" | "resume";
  readonly requestedModel?: string;
  readonly permissionMode?: ClaudeCliPermissionMode;
  readonly emit: ProviderEventSink;
  readonly onBackendDiagnostic: (record: Readonly<ClaudeBackendDiagnosticRecord>) => void;
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
}

export interface ClaudeSupervisorRuntime {
  readonly terminated: Promise<ClaudeTaskRuntimeProcessTerminal>;
  start(): Promise<void>;
  send(input: UserInput): Promise<NativeTurnRef>;
  interrupt(turnId: string): Promise<void>;
  respond(response: ProviderRequestResponse): Promise<void>;
  modelEvidence(): Readonly<ClaudeModelEvidenceSnapshot>;
  shutdown(): Promise<ClaudeTaskRuntimeProcessTerminal>;
}

export type ClaudeSupervisorRuntimeFactory = (
  options: ClaudeSupervisorRuntimeOptions,
) => ClaudeSupervisorRuntime;

export interface ClaudePersistentSupervisorOptions {
  readonly executable: string;
  readonly isEnabled: () => boolean;
  readonly reconcile: ClaudeSupervisorReconcile;
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly runtimeFactory?: ClaudeSupervisorRuntimeFactory;
  readonly canonicalizeHome?: (home: string) => string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly maxTasks?: number;
  readonly maxLeasesPerTask?: number;
  readonly maxBackendDiagnostics?: number;
}

export interface ClaudeSupervisorAcquireOptions {
  readonly configHome: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly launch: "new" | "resume";
  readonly requestedModel?: string;
  readonly permissionMode?: ClaudeCliPermissionMode;
  handlers: ClaudeSupervisorHandlers;
}

export interface ClaudePersistentLease {
  readonly configHome: string;
  readonly sessionId: string;
  readonly generation: number;
  send(input: UserInput): Promise<NativeTurnRef>;
  interrupt(turnId: string): Promise<void>;
  respond(response: ProviderRequestResponse): Promise<void>;
  modelEvidence(): Readonly<ClaudeModelEvidenceSnapshot>;
  release(): Promise<void>;
}

type EntryState = "starting" | "ready" | "backoff" | "open" | "stopping" | "stopped";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

const deferred = <T>(): Deferred<T> => {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject: (reason) => {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(reason);
    },
    settled: false,
  };
  void result.promise.catch(() => undefined);
  return result;
};

interface TaskEntry {
  readonly id: string;
  readonly configHome: string;
  readonly cwd: string;
  readonly sessionId: string;
  requestedModel: string | null;
  permissionMode: ClaudeCliPermissionMode | null;
  handlers: ClaudeSupervisorHandlers;
  readonly initialLaunch: "new" | "resume";
  state: EntryState;
  generation: number;
  token: number;
  runtime: ClaudeSupervisorRuntime | null;
  ready: Deferred<void>;
  users: number;
  pendingAcquires: number;
  readonly leases: Set<PersistentLease>;
  failures: number[];
  recoveryDeadline: number | null;
  recoveryEpoch: number;
  timer: unknown;
  timerSet: boolean;
  factoryBarrier: Deferred<void> | null;
  retirement: RuntimeRetirement | null;
  stopPromise: Promise<void> | null;
  stopReady: Deferred<void> | null;
  removeOnStop: boolean;
  dormantSince: number | null;
}

interface RuntimeRetirement {
  readonly runtime: ClaudeSupervisorRuntime;
  readonly confirmation: Promise<void>;
}

const supervisorError = (
  code: ClaudeSupervisorErrorCode,
  message: string,
): ClaudeSupervisorError => new ClaudeSupervisorError(code, message);

const bounded = (value: unknown, fallback: number): number => {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" || !Number.isSafeInteger(resolved) ||
    resolved < 1 || resolved > CLAUDE_SUPERVISOR_HARD_MAX
  ) throw supervisorError("INVALID_CONFIGURATION", "Claude supervisor limit is invalid");
  return resolved;
};

const exactHandlers = (value: ClaudeSupervisorHandlers): ClaudeSupervisorHandlers => {
  if (!value || typeof value !== "object" || typeof value.owner !== "symbol" ||
    typeof value.emit !== "function") {
    throw supervisorError("INVALID_CONFIGURATION", "Claude supervisor handlers are invalid");
  }
  return Object.freeze({ owner: value.owner, emit: value.emit });
};

const handlersMatch = (left: ClaudeSupervisorHandlers, right: ClaudeSupervisorHandlers): boolean =>
  left.owner === right.owner && left.emit === right.emit;

const safeModel = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (
    typeof value !== "string" || value.length === 0 || value.length > 256 ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw supervisorError("INVALID_CONFIGURATION", "Claude requested model is invalid");
  return value;
};

const safePermissionMode = (value: unknown): ClaudeCliPermissionMode | null => {
  if (value === undefined) return null;
  if (
    value !== "manual" && value !== "acceptEdits" && value !== "auto" &&
    value !== "dontAsk" && value !== "plan"
  ) {
    throw supervisorError("INVALID_CONFIGURATION", "Claude permission mode is invalid");
  }
  return value;
};

const defaultRuntimeFactory: ClaudeSupervisorRuntimeFactory = (options) =>
  new ClaudeTaskRuntime({
    executable: options.executable,
    configHome: options.configHome,
    cwd: options.cwd,
    sessionId: options.sessionId,
    generation: options.generation,
    launch: options.launch,
    ...(options.requestedModel === undefined ? {} : { requestedModel: options.requestedModel }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    emit: options.emit,
    onBackendDiagnostic: options.onBackendDiagnostic,
    processFactory: (processOptions) => new ClaudeCliProcess({
      executable: processOptions.executable,
      configHome: processOptions.configHome,
      cwd: processOptions.cwd,
      baseEnv: options.baseEnv,
      launch: { kind: processOptions.launch, sessionId: processOptions.sessionId },
      ...(processOptions.requestedModel === undefined
        ? {}
        : { model: processOptions.requestedModel }),
      ...(processOptions.permissionMode === undefined
        ? {}
        : { permissionMode: processOptions.permissionMode }),
      permissionPromptStdio: true,
      onEnvelope: processOptions.onEnvelope,
    }),
  });

class PersistentLease implements ClaudePersistentLease {
  private releasedValue = false;
  private releasePromise: Promise<void> | null = null;

  constructor(
    private readonly supervisor: ClaudePersistentSupervisor,
    readonly entry: TaskEntry,
  ) {}

  get configHome(): string { return this.entry.configHome; }
  get sessionId(): string { return this.entry.sessionId; }
  get generation(): number { return this.entry.generation; }

  async send(input: UserInput): Promise<NativeTurnRef> {
    return this.runtime().send(input);
  }

  async interrupt(turnId: string): Promise<void> {
    return this.runtime().interrupt(turnId);
  }

  async respond(response: ProviderRequestResponse): Promise<void> {
    return this.runtime().respond(response);
  }

  modelEvidence(): Readonly<ClaudeModelEvidenceSnapshot> {
    return this.runtime().modelEvidence();
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.releasedValue = true;
    this.releasePromise = this.supervisor.releaseLease(this);
    return this.releasePromise;
  }

  private runtime(): ClaudeSupervisorRuntime {
    if (this.releasedValue) {
      throw supervisorError("LEASE_RELEASED", "Claude supervisor lease was released");
    }
    return this.supervisor.runtimeFor(this.entry);
  }
}

export class ClaudePersistentSupervisor {
  private readonly executable: string;
  private readonly isEnabled: () => boolean;
  private readonly reconcile: ClaudeSupervisorReconcile;
  private readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  private readonly runtimeFactory: ClaudeSupervisorRuntimeFactory;
  private readonly canonicalizeHome: (home: string) => string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly maxTasks: number;
  private readonly maxLeasesPerTask: number;
  private readonly backendDiagnosticStore: ClaudeBackendDiagnosticStore;
  private readonly entries = new Map<string, TaskEntry>();
  private nextGeneration = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: ClaudePersistentSupervisorOptions) {
    if (!options || typeof options !== "object" || typeof options.executable !== "string" ||
      !path.isAbsolute(options.executable) || typeof options.isEnabled !== "function" ||
      typeof options.reconcile !== "function") {
      throw supervisorError("INVALID_CONFIGURATION", "Claude supervisor configuration is invalid");
    }
    if (options.runtimeFactory !== undefined && typeof options.runtimeFactory !== "function") {
      throw supervisorError("INVALID_CONFIGURATION", "Claude supervisor factory is invalid");
    }
    if (options.canonicalizeHome !== undefined && typeof options.canonicalizeHome !== "function") {
      throw supervisorError("INVALID_CONFIGURATION", "Claude supervisor canonicalizer is invalid");
    }
    this.executable = options.executable;
    this.isEnabled = options.isEnabled;
    this.reconcile = options.reconcile;
    const baseEnv = { ...(options.baseEnv ?? process.env) };
    // Only strip the subscription token when it isn't the env's sole auth path — a
    // programmatic method (API key, workload identity, or a cloud credential) makes it
    // dead cruft best scrubbed defensively. Under a subscription-only login, this is the
    // one credential the CLI actually needs, so it must survive to reach the child process.
    let subscriptionOnly = false;
    try { subscriptionOnly = resolveClaudeAuth(baseEnv).method === "subscription"; } catch { /* leave stripped below */ }
    if (!subscriptionOnly) delete baseEnv.CLAUDE_CODE_OAUTH_TOKEN;
    this.baseEnv = Object.freeze(baseEnv);
    this.runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;
    this.canonicalizeHome = options.canonicalizeHome ?? canonicalizeProviderHome;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.maxTasks = bounded(options.maxTasks, CLAUDE_SUPERVISOR_DEFAULT_MAX_TASKS);
    this.maxLeasesPerTask = bounded(
      options.maxLeasesPerTask,
      CLAUDE_SUPERVISOR_DEFAULT_MAX_LEASES_PER_TASK,
    );
    try {
      this.backendDiagnosticStore = new ClaudeBackendDiagnosticStore(
        options.maxBackendDiagnostics ?? CLAUDE_SUPERVISOR_DEFAULT_MAX_BACKEND_DIAGNOSTICS,
      );
    } catch {
      throw supervisorError("INVALID_CONFIGURATION", "Claude supervisor diagnostic bound is invalid");
    }
  }

  async acquire(options: ClaudeSupervisorAcquireOptions): Promise<ClaudePersistentLease> {
    if (this.shuttingDown) throw supervisorError("SHUTDOWN", "Claude supervisor is shut down");
    if (!this.enabled()) throw supervisorError("DISABLED", "Claude persistent runtime is disabled");
    this.authorized();
    if (!options || typeof options !== "object") {
      throw supervisorError("INVALID_CONFIGURATION", "Claude acquire options are invalid");
    }
    let configHome: string;
    try { configHome = this.canonicalizeHome(options.configHome); } catch {
      throw supervisorError("INVALID_CONFIGURATION", "Claude config home is invalid");
    }
    if (configHome !== options.configHome || !path.isAbsolute(configHome) ||
      typeof options.cwd !== "string" || !path.isAbsolute(options.cwd) ||
      path.normalize(options.cwd) !== options.cwd ||
      typeof options.sessionId !== "string" || !UUID.test(options.sessionId) ||
      (options.launch !== "new" && options.launch !== "resume")) {
      throw supervisorError("INVALID_CONFIGURATION", "Claude acquire options are invalid");
    }
    const requestedModel = safeModel(options.requestedModel);
    const permissionMode = safePermissionMode(options.permissionMode);
    const binding = exactHandlers(options.handlers);
    const key = createNativeTaskKey("anthropic", configHome, options.sessionId);
    const id = nativeTaskKeyId(key);
    let entry = this.entries.get(id);
    if (entry) {
      const fullyQuiescent = this.isFullyQuiescent(entry);
      const handlerMismatch = !handlersMatch(entry.handlers, binding);
      if (handlerMismatch && !fullyQuiescent) {
        throw supervisorError("HANDLER_CONFLICT", "Claude task already has another event owner");
      }
      const expectedLaunch = fullyQuiescent && entry.generation > 0
        ? "resume"
        : entry.initialLaunch;
      if (
        entry.cwd !== options.cwd ||
        (!fullyQuiescent && (
          entry.requestedModel !== requestedModel ||
          entry.permissionMode !== permissionMode
        )) ||
        expectedLaunch !== options.launch
      ) {
        throw supervisorError(
          "CONFIGURATION_CONFLICT",
          "Claude task already has another runtime configuration",
        );
      }
      if (fullyQuiescent) {
        entry.requestedModel = requestedModel;
        entry.permissionMode = permissionMode;
      }
      if (handlerMismatch) entry.handlers = binding;
      if (entry.state === "open") {
        throw supervisorError("CIRCUIT_OPEN", "Claude task restart circuit is open");
      }
      if (entry.state === "backoff" || entry.state === "stopping" || entry.state === "stopped") {
        if (entry.state !== "stopped") {
          throw supervisorError("UNAVAILABLE", "Claude task runtime is unavailable");
        }
        this.startEntry(entry, entry.generation === 0 ? entry.initialLaunch : "resume");
      }
    } else {
      this.evictDormantEntry();
      if (this.entries.size >= this.maxTasks) {
        throw supervisorError("UNAVAILABLE", "Claude supervisor task capacity is exhausted");
      }
      entry = {
        id,
        configHome,
        cwd: options.cwd,
        sessionId: options.sessionId,
        requestedModel,
        permissionMode,
        handlers: binding,
        initialLaunch: options.launch,
        state: "starting",
        generation: 0,
        token: 0,
        runtime: null,
        ready: deferred<void>(),
        users: 0,
        pendingAcquires: 0,
        leases: new Set(),
        failures: [],
        recoveryDeadline: null,
        recoveryEpoch: 0,
        timer: undefined,
        timerSet: false,
        factoryBarrier: null,
        retirement: null,
        stopPromise: null,
        stopReady: null,
        removeOnStop: false,
        dormantSince: null,
      };
      this.entries.set(id, entry);
      this.startEntry(entry, options.launch);
    }
    if (entry.users + entry.pendingAcquires >= this.maxLeasesPerTask) {
      throw supervisorError("UNAVAILABLE", "Claude task lease capacity is exhausted");
    }
    entry.pendingAcquires += 1;
    try {
      if (entry.state === "starting") await entry.ready.promise;
      if (entry.state !== "ready" || entry.runtime === null) {
        throw supervisorError(
          entry.state === "open" ? "CIRCUIT_OPEN" : "UNAVAILABLE",
          "Claude task runtime is unavailable",
        );
      }
      const lease = new PersistentLease(this, entry);
      entry.leases.add(lease);
      entry.users += 1;
      return lease;
    } finally {
      entry.pendingAcquires -= 1;
    }
  }

  runtimeFor(entry: TaskEntry): ClaudeSupervisorRuntime {
    if (this.shuttingDown) throw supervisorError("SHUTDOWN", "Claude supervisor is shut down");
    if (entry.state === "open") {
      throw supervisorError("CIRCUIT_OPEN", "Claude task restart circuit is open");
    }
    if (entry.state !== "ready" || entry.runtime === null) {
      throw supervisorError("UNAVAILABLE", "Claude task runtime is unavailable");
    }
    return entry.runtime;
  }

  releaseLease(lease: PersistentLease): Promise<void> {
    const entry = lease.entry;
    if (!entry.leases.delete(lease)) return Promise.resolve();
    entry.users -= 1;
    if (
      entry.users === 0 && entry.pendingAcquires === 0 &&
      (entry.state === "ready" || entry.state === "starting" || entry.state === "stopping")
    ) return this.stopEntry(entry, false);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = Promise.allSettled([...this.entries.values()].map((entry) =>
      this.stopEntry(entry, true))).then(() => undefined);
    return this.shutdownPromise;
  }

  async refreshEnabled(): Promise<void> {
    if (this.shuttingDown || this.enabled()) return;
    for (const entry of this.entries.values()) void this.stopEntry(entry, true);
    await Promise.resolve();
  }

  backendDiagnostics(): Readonly<ClaudeBackendDiagnosticSnapshot> {
    return this.backendDiagnosticStore.snapshot();
  }

  private startEntry(entry: TaskEntry, launch: "new" | "resume"): void {
    if (this.shuttingDown || entry.state === "stopping") return;
    entry.removeOnStop = false;
    entry.dormantSince = null;
    if (!this.invalidateRecovery(entry)) {
      this.failRecoveryClosed(entry);
      return;
    }
    entry.state = "starting";
    entry.ready = deferred<void>();
    const token = ++entry.token;
    const restarting = entry.generation > 0;
    if (this.nextGeneration >= Number.MAX_SAFE_INTEGER) {
      entry.ready.reject(supervisorError("UNAVAILABLE", "Claude generation space is exhausted"));
      this.failRecoveryClosed(entry);
      return;
    }
    const generation = ++this.nextGeneration;
    entry.generation = generation;
    const start = async (): Promise<void> => {
      try {
        if (!this.enabled()) throw supervisorError("DISABLED", "Claude runtime is disabled");
        this.authorized();
        if (launch === "resume" || restarting) {
          await this.reconcile(Object.freeze({
            configHome: entry.configHome,
            cwd: entry.cwd,
            sessionId: entry.sessionId,
            generation,
            reason: restarting ? "restart" : "resume",
          }));
        }
        if (!this.owns(entry, token) || entry.state !== "starting") return;
        const factoryBarrier = deferred<void>();
        entry.factoryBarrier = factoryBarrier;
        let boundRuntime: ClaudeSupervisorRuntime | null = null;
        const diagnosticOwnership = Object.freeze({
          taskScope: claudeBackendDiagnosticTaskScope(entry.configHome),
          sessionId: entry.sessionId,
          generation,
        });
        const emit: ProviderEventSink = (event) => {
          if (
            boundRuntime === null || !this.owns(entry, token) ||
            entry.generation !== generation || entry.runtime !== boundRuntime
          ) return;
          entry.handlers.emit(event);
        };
        const onBackendDiagnostic = (record: Readonly<ClaudeBackendDiagnosticRecord>): void => {
          if (
            boundRuntime === null || !this.owns(entry, token) ||
            entry.generation !== generation || entry.runtime !== boundRuntime
          ) return;
          this.backendDiagnosticStore.retain(record, diagnosticOwnership);
        };
        let candidate: unknown;
        try {
          candidate = this.runtimeFactory(Object.freeze({
            executable: this.executable,
            configHome: entry.configHome,
            cwd: entry.cwd,
            sessionId: entry.sessionId,
            generation,
            launch,
            ...(entry.requestedModel === null ? {} : { requestedModel: entry.requestedModel }),
            ...(entry.permissionMode === null ? {} : { permissionMode: entry.permissionMode }),
            emit,
            onBackendDiagnostic,
            baseEnv: this.baseEnv,
          }));
        } catch {
          this.settleFactoryBarrier(entry, factoryBarrier);
          throw supervisorError("UNAVAILABLE", "Claude runtime factory failed");
        }
        if (!this.validRuntime(candidate)) {
          this.settleFactoryBarrier(entry, factoryBarrier);
          throw supervisorError("UNAVAILABLE", "Claude runtime factory returned an invalid runtime");
        }
        const runtime = candidate;
        if (!this.owns(entry, token) || entry.state !== "starting" || this.shuttingDown) {
          this.beginRetirement(entry, runtime);
          this.settleFactoryBarrier(entry, factoryBarrier);
          return;
        }
        boundRuntime = runtime;
        entry.runtime = runtime;
        try {
          void runtime.terminated.then(
            () => this.onTerminal(entry, token, runtime, true),
            () => this.onTerminal(entry, token, runtime, false),
          );
        } catch {
          this.settleFactoryBarrier(entry, factoryBarrier);
          throw supervisorError("UNAVAILABLE", "Claude runtime termination channel failed");
        }
        if (!this.owns(entry, token) || entry.state !== "starting" || this.shuttingDown) {
          if (entry.runtime === runtime) entry.runtime = null;
          this.beginRetirement(entry, runtime);
          this.settleFactoryBarrier(entry, factoryBarrier);
          return;
        }
        this.settleFactoryBarrier(entry, factoryBarrier);
        await runtime.start();
        if (!this.owns(entry, token) || entry.state !== "starting" || entry.runtime !== runtime) {
          if (entry.runtime === runtime) {
            entry.runtime = null;
            this.beginRetirement(entry, runtime);
          }
          return;
        }
        entry.state = "ready";
        entry.ready.resolve(undefined);
      } catch (error) {
        if (!this.owns(entry, token) || entry.state !== "starting") return;
        const runtime = entry.runtime;
        entry.runtime = null;
        entry.ready.reject(error instanceof ClaudeSupervisorError
          ? error
          : supervisorError("UNAVAILABLE", "Claude runtime startup failed"));
        this.scheduleFailure(entry, runtime);
      }
    };
    void start();
  }

  private onTerminal(
    entry: TaskEntry,
    token: number,
    runtime: ClaudeSupervisorRuntime,
    confirmed: boolean,
  ): void {
    if (!this.owns(entry, token) || entry.runtime !== runtime) return;
    entry.runtime = null;
    if (entry.state === "stopping" || entry.state === "stopped" || this.shuttingDown) return;
    if (entry.state === "starting") {
      entry.ready.reject(supervisorError("UNAVAILABLE", "Claude runtime terminated during startup"));
    }
    this.scheduleFailure(entry, confirmed ? null : runtime);
  }

  private scheduleFailure(
    entry: TaskEntry,
    runtimeToTerminate: ClaudeSupervisorRuntime | null,
  ): void {
    if (this.shuttingDown || entry.state === "stopping" || entry.state === "stopped") return;
    if (runtimeToTerminate !== null) this.beginRetirement(entry, runtimeToTerminate);
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.failRecoveryClosed(entry);
      return;
    }
    entry.failures = entry.failures.filter((value) => now - value <
      CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS);
    entry.failures.push(now);
    const open = entry.failures.length >= CIRCUIT_FAILURES;
    entry.state = open ? "open" : "backoff";
    const base = open
      ? CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS
      : CLAUDE_SUPERVISOR_BACKOFF_MS[
          Math.min(entry.failures.length - 1, CLAUDE_SUPERVISOR_BACKOFF_MS.length - 1)
        ]!;
    const delay = open ? base : base + this.jitter();
    if (now > Number.MAX_SAFE_INTEGER - delay) {
      this.failRecoveryClosed(entry);
      return;
    }
    if (!this.clearTimer(entry)) {
      this.failRecoveryClosed(entry);
      return;
    }
    const epoch = ++entry.recoveryEpoch;
    const token = entry.token;
    entry.recoveryDeadline = now + delay;
    if (runtimeToTerminate === null) {
      this.armRecoveryTimer(entry, token, epoch);
    }
  }

  private armRecoveryTimer(entry: TaskEntry, token: number, epoch: number): void {
    if (
      !this.owns(entry, token) || entry.recoveryEpoch !== epoch ||
      (entry.state !== "backoff" && entry.state !== "open") ||
      entry.recoveryDeadline === null || entry.timerSet
    ) return;
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.failRecoveryClosed(entry, token, epoch);
      return;
    }
    const delayMs = Math.max(0, entry.recoveryDeadline - now);
    let installing = true;
    let firedSynchronously = false;
    let handle: unknown;
    try {
      handle = this.setTimeoutFn(() => {
        if (installing) {
          firedSynchronously = true;
          return;
        }
        this.onRecoveryTimer(entry, token, epoch, handle);
      }, delayMs);
      installing = false;
    } catch {
      installing = false;
      this.failRecoveryClosed(entry, token, epoch);
      return;
    }
    if (firedSynchronously) {
      try { this.clearTimeoutFn(handle); } catch { /* fail closed below */ }
      this.failRecoveryClosed(entry, token, epoch);
      return;
    }
    if (
      !this.owns(entry, token) || entry.recoveryEpoch !== epoch ||
      (entry.state !== "backoff" && entry.state !== "open") ||
      entry.recoveryDeadline === null
    ) {
      try { this.clearTimeoutFn(handle); } catch { /* The invalidated callback remains fenced. */ }
      return;
    }
    entry.timer = handle;
    entry.timerSet = true;
  }

  private onRecoveryTimer(
    entry: TaskEntry,
    token: number,
    epoch: number,
    handle: unknown,
  ): void {
    if (
      !this.owns(entry, token) || entry.recoveryEpoch !== epoch ||
      !entry.timerSet || entry.timer !== handle
    ) return;
    entry.timerSet = false;
    entry.timer = undefined;
    let now: number;
    try {
      now = this.readNow();
    } catch {
      this.failRecoveryClosed(entry, token, epoch);
      return;
    }
    const deadline = entry.recoveryDeadline;
    if (deadline === null) {
      this.failRecoveryClosed(entry, token, epoch);
      return;
    }
    if (now < deadline) {
      this.armRecoveryTimer(entry, token, epoch);
      return;
    }
    entry.recoveryDeadline = null;
    entry.recoveryEpoch += 1;
    if (entry.users === 0 && entry.pendingAcquires === 0) {
      entry.state = "stopped";
      entry.dormantSince = now;
      return;
    }
    this.startEntry(entry, "resume");
  }

  private stopEntry(entry: TaskEntry, remove: boolean): Promise<void> {
    if (remove) entry.removeOnStop = true;
    if (entry.stopPromise) return entry.stopPromise;
    if (
      !remove &&
      (entry.state === "backoff" || entry.state === "open" || entry.state === "stopped") &&
      entry.retirement === null && entry.factoryBarrier === null
    ) return Promise.resolve();
    const stopReady = deferred<void>();
    const stopPromise = stopReady.promise;
    entry.stopReady = stopReady;
    entry.stopPromise = stopPromise;
    entry.state = "stopping";
    entry.token += 1;
    entry.ready.reject(supervisorError("UNAVAILABLE", "Claude task runtime stopped"));
    this.invalidateRecovery(entry);
    const runtime = entry.runtime;
    entry.runtime = null;
    if (runtime) this.beginRetirement(entry, runtime);
    this.finishStopIfQuiescent(entry);
    return stopPromise;
  }

  private beginRetirement(entry: TaskEntry, runtime: ClaudeSupervisorRuntime): void {
    if (entry.retirement?.runtime === runtime) return;
    if (entry.retirement !== null) {
      this.failRecoveryClosed(entry);
      return;
    }
    const record: RuntimeRetirement = {
      runtime,
      confirmation: this.confirmTermination(runtime),
    };
    entry.retirement = record;
    void record.confirmation.then(
      () => this.onRetirementConfirmed(entry, record),
      () => this.onRetirementUnconfirmed(entry, record),
    );
  }

  private onRetirementConfirmed(entry: TaskEntry, record: RuntimeRetirement): void {
    if (entry.retirement !== record) return;
    entry.retirement = null;
    if (entry.state === "stopping" || entry.removeOnStop || this.shuttingDown) {
      if (entry.state !== "stopping") entry.state = "stopping";
      this.finishStopIfQuiescent(entry);
      return;
    }
    if (!this.enabled()) {
      entry.state = "stopped";
      entry.dormantSince = this.safeNow();
      return;
    }
    if (
      (entry.state === "backoff" || entry.state === "open") &&
      entry.recoveryDeadline !== null
    ) {
      this.armRecoveryTimer(entry, entry.token, entry.recoveryEpoch);
    }
  }

  private onRetirementUnconfirmed(entry: TaskEntry, record: RuntimeRetirement): void {
    if (entry.retirement !== record) return;
    this.failRecoveryClosed(entry);
  }

  private settleFactoryBarrier(entry: TaskEntry, barrier: Deferred<void>): void {
    if (entry.factoryBarrier !== barrier) return;
    entry.factoryBarrier = null;
    barrier.resolve(undefined);
    this.finishStopIfQuiescent(entry);
  }

  private finishStopIfQuiescent(entry: TaskEntry): void {
    if (
      entry.state !== "stopping" || entry.runtime !== null || entry.retirement !== null ||
      entry.factoryBarrier !== null
    ) return;
    const remove = entry.removeOnStop;
    entry.state = "stopped";
    entry.dormantSince = remove ? null : this.safeNow();
    const stopReady = entry.stopReady;
    entry.stopReady = null;
    entry.stopPromise = null;
    if (remove && this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    stopReady?.resolve(undefined);
  }

  private isFullyQuiescent(entry: TaskEntry): boolean {
    return entry.state === "stopped" && entry.users === 0 && entry.pendingAcquires === 0 &&
      entry.leases.size === 0 && entry.runtime === null && entry.retirement === null &&
      entry.factoryBarrier === null && entry.stopPromise === null && entry.stopReady === null &&
      !entry.timerSet && entry.recoveryDeadline === null;
  }

  private clearTimer(entry: TaskEntry): boolean {
    if (!entry.timerSet) return true;
    const handle = entry.timer;
    entry.timerSet = false;
    entry.timer = undefined;
    try {
      this.clearTimeoutFn(handle);
      return true;
    } catch {
      return false;
    }
  }

  private invalidateRecovery(entry: TaskEntry): boolean {
    const cleared = this.clearTimer(entry);
    entry.recoveryDeadline = null;
    entry.recoveryEpoch += 1;
    return cleared;
  }

  private failRecoveryClosed(entry: TaskEntry, token?: number, epoch?: number): void {
    if (
      token !== undefined &&
      (!this.owns(entry, token) || (epoch !== undefined && entry.recoveryEpoch !== epoch))
    ) return;
    void this.clearTimer(entry);
    entry.recoveryDeadline = null;
    entry.recoveryEpoch += 1;
    if (entry.state !== "stopping" && entry.state !== "stopped") entry.state = "open";
  }

  private confirmTermination(runtime: ClaudeSupervisorRuntime): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let rejected = 0;
      const confirm = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOne = (): void => {
        if (settled) return;
        rejected += 1;
        if (rejected === 2) {
          settled = true;
          reject(supervisorError("UNAVAILABLE", "Claude runtime termination was not confirmed"));
        }
      };
      void Promise.resolve().then(() => runtime.shutdown()).then(confirm, rejectOne);
      void runtime.terminated.then(confirm, rejectOne);
    });
  }

  private evictDormantEntry(): void {
    if (this.entries.size < this.maxTasks) return;
    const now = this.safeNow();
    if (now === null) return;
    for (const [id, entry] of this.entries) {
      entry.failures = entry.failures.filter((value) =>
        now - value < CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS);
      if (
        entry.state === "stopped" && entry.users === 0 && entry.pendingAcquires === 0 &&
        entry.runtime === null && entry.retirement === null && entry.factoryBarrier === null &&
        entry.stopPromise === null && !entry.timerSet && entry.failures.length === 0 &&
        entry.dormantSince !== null && now >= entry.dormantSince &&
        now - entry.dormantSince >= CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS
      ) {
        this.entries.delete(id);
        return;
      }
    }
  }

  private owns(entry: TaskEntry, token: number): boolean {
    return this.entries.get(entry.id) === entry && entry.token === token;
  }

  private validRuntime(value: unknown): value is ClaudeSupervisorRuntime {
    return !!value && typeof value === "object" &&
      typeof (value as ClaudeSupervisorRuntime).start === "function" &&
      typeof (value as ClaudeSupervisorRuntime).send === "function" &&
      typeof (value as ClaudeSupervisorRuntime).interrupt === "function" &&
      typeof (value as ClaudeSupervisorRuntime).respond === "function" &&
      typeof (value as ClaudeSupervisorRuntime).modelEvidence === "function" &&
      typeof (value as ClaudeSupervisorRuntime).shutdown === "function" &&
      !!(value as ClaudeSupervisorRuntime).terminated &&
      typeof (value as ClaudeSupervisorRuntime).terminated.then === "function";
  }

  private enabled(): boolean {
    try { return this.isEnabled() === true; } catch { return false; }
  }

  private authorized(): Readonly<ClaudeAuthDecision> {
    try { return resolveClaudeAuth(this.baseEnv); } catch {
      throw supervisorError(
        "UNAUTHORIZED_AUTH",
        "Claude persistent runtime requires programmatic authentication",
      );
    }
  }

  private readNow(): number {
    try {
      const value = this.now();
      if (!Number.isSafeInteger(value) || value < 0) throw new Error();
      return value;
    } catch {
      throw supervisorError("UNAVAILABLE", "Claude supervisor clock failed");
    }
  }

  private safeNow(): number | null {
    try { return this.readNow(); } catch { return null; }
  }

  private jitter(): number {
    try {
      const value = this.random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error();
      return Math.floor(value * CLAUDE_SUPERVISOR_JITTER_MS);
    } catch {
      return CLAUDE_SUPERVISOR_JITTER_MS - 1;
    }
  }
}
