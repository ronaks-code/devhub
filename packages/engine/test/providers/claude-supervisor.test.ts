import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderRequestResponse, UserInput } from "../../src/providers/index.js";
import {
  CLAUDE_SUPERVISOR_BACKOFF_MS,
  CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS,
  CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS,
  ClaudePersistentSupervisor,
  type ClaudePersistentLease,
  type ClaudeSupervisorHandlers,
  type ClaudeSupervisorReconcile,
  type ClaudeSupervisorRuntime,
  type ClaudeSupervisorRuntimeFactory,
  type ClaudeSupervisorRuntimeOptions,
} from "../../src/providers/claude/supervisor.js";
import { claudeBackendDiagnosticTaskScope } from
  "../../src/providers/claude/backend-diagnostic-store.js";

const HOME = "/canonical/claude-home";
const CWD = "/canonical/project";
const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TURN = "119f5b78-18c0-7b60-8f0c-6afc120ecd7d";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakeRuntime implements ClaudeSupervisorRuntime {
  readonly terminal = deferred<{ readonly kind: "shutdown" | "failure" }>();
  readonly terminated = this.terminal.promise;
  readonly sends: UserInput[] = [];
  startCalls = 0;
  shutdownCalls = 0;
  interruptCalls: string[] = [];
  responses: ProviderRequestResponse[] = [];
  startError: Error | null = null;
  shutdownHangs = false;
  shutdownGate: ReturnType<typeof deferred<void>> | null = null;
  shutdownError: Error | null = null;
  startEvent: ProviderEvent | null = null;

  constructor(readonly options: ClaudeSupervisorRuntimeOptions) {}

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    if (this.startEvent) this.options.emit(this.startEvent);
  }
  async send(input: UserInput) {
    this.sends.push(input);
    return { taskKey: {
      provider: "anthropic" as const,
      home: this.options.configHome,
      nativeTaskId: this.options.sessionId,
    }, turnId: TURN };
  }
  async interrupt(turnId: string): Promise<void> { this.interruptCalls.push(turnId); }
  async respond(response: ProviderRequestResponse): Promise<void> { this.responses.push(response); }
  modelEvidence() {
    return Object.freeze({
      observations: Object.freeze([]),
      bySource: Object.freeze({
        requested: Object.freeze([]),
        "system-init": Object.freeze([]),
        "stream-message-start": Object.freeze([]),
        "assistant-message": Object.freeze([]),
        "result-model-usage": Object.freeze([]),
        "result-total-usage": Object.freeze([]),
      }),
      distinctModels: Object.freeze([]),
      hasDivergence: false,
    });
  }
  async shutdown() {
    this.shutdownCalls += 1;
    if (this.shutdownHangs) return new Promise<never>(() => undefined);
    if (this.shutdownGate) await this.shutdownGate.promise;
    if (this.shutdownError) throw this.shutdownError;
    const result = { kind: "shutdown" as const };
    this.terminal.resolve(result);
    return result;
  }
  crash(): void { this.terminal.resolve({ kind: "failure" }); }
  rejectTerminal(): void { this.terminal.reject(new Error("terminal channel rejected")); }
}

class ManualTimers {
  nowMs = 1_000;
  onSet: (() => void) | null = null;
  readonly tasks: Array<{
    callback: () => void;
    delayMs: number;
    cleared: boolean;
  }> = [];

  now = (): number => this.nowMs;
  set = (callback: () => void, delayMs: number): object => {
    const task = { callback, delayMs, cleared: false };
    this.tasks.push(task);
    this.onSet?.();
    return task;
  };
  clear = (handle: unknown): void => {
    const task = handle as (typeof this.tasks)[number];
    if (task) task.cleared = true;
  };
  fire(delayMs: number): void {
    const task = this.tasks.find((candidate) => !candidate.cleared && candidate.delayMs === delayMs);
    if (!task) throw new Error(`missing ${delayMs}ms timer`);
    task.cleared = true;
    this.nowMs += delayMs;
    task.callback();
  }
  fireEarly(delayMs: number, advanceMs: number): void {
    const task = this.tasks.find((candidate) => !candidate.cleared && candidate.delayMs === delayMs);
    if (!task) throw new Error(`missing ${delayMs}ms timer`);
    task.cleared = true;
    this.nowMs += advanceMs;
    task.callback();
  }
  activeDelays(): number[] {
    return this.tasks.filter(({ cleared }) => !cleared).map(({ delayMs }) => delayMs);
  }
}

const flush = async (turns = 20): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const handlers = (owner = Symbol("owner")): ClaudeSupervisorHandlers => ({
  owner,
  emit: vi.fn((_event: ProviderEvent) => undefined),
});

const statusEvent = (status = "running"): ProviderEvent => ({
  provider: "anthropic",
  key: { provider: "anthropic", home: HOME, nativeTaskId: SESSION },
  occurredAt: "2026-07-13T17:00:00.000Z",
  type: "status",
  scope: "turn",
  status,
  nativeId: TURN,
});

const harness = (overrides: {
  readonly enabled?: () => boolean;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly reconcile?: ClaudeSupervisorReconcile;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly maxTasks?: number;
  readonly maxBackendDiagnostics?: number;
  readonly onTimerSet?: (supervisor: ClaudePersistentSupervisor) => void;
  readonly onRuntimeFactory?: (
    supervisor: ClaudePersistentSupervisor,
    runtime: FakeRuntime,
    index: number,
  ) => void;
  readonly configureRuntime?: (runtime: FakeRuntime, index: number) => void;
} = {}) => {
  const timers = new ManualTimers();
  const runtimes: FakeRuntime[] = [];
  const order: string[] = [];
  let supervisor!: ClaudePersistentSupervisor;
  const runtimeFactory: ClaudeSupervisorRuntimeFactory = vi.fn((options) => {
    order.push(`factory:${options.generation}`);
    const runtime = new FakeRuntime(options);
    const index = runtimes.length;
    overrides.configureRuntime?.(runtime, index);
    runtimes.push(runtime);
    overrides.onRuntimeFactory?.(supervisor, runtime, index);
    return runtime;
  });
  const reconcile = overrides.reconcile ?? (async (context) => {
    order.push(`reconcile:${context.generation}`);
  });
  supervisor = new ClaudePersistentSupervisor({
    executable: "/opt/bin/claude",
    isEnabled: overrides.enabled ?? (() => true),
    baseEnv: overrides.env ?? { ANTHROPIC_API_KEY: "secret" },
    runtimeFactory,
    reconcile,
    canonicalizeHome: (home) => home,
    now: overrides.now ?? timers.now,
    random: overrides.random ?? (() => 0),
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    ...(overrides.maxTasks === undefined ? {} : { maxTasks: overrides.maxTasks }),
    ...(overrides.maxBackendDiagnostics === undefined
      ? {}
      : { maxBackendDiagnostics: overrides.maxBackendDiagnostics }),
  });
  timers.onSet = overrides.onTimerSet === undefined
    ? null
    : () => overrides.onTimerSet!(supervisor);
  return { order, reconcile, runtimeFactory, runtimes, supervisor, timers };
};

const acquire = (
  supervisor: ClaudePersistentSupervisor,
  owner = handlers(),
  launch: "new" | "resume" = "new",
  permissionMode?: "manual" | "acceptEdits" | "auto" | "dontAsk" | "plan",
): Promise<ClaudePersistentLease> => supervisor.acquire({
  configHome: HOME,
  cwd: CWD,
  sessionId: SESSION,
  launch,
  requestedModel: "claude-sonnet-5",
  ...(permissionMode === undefined ? {} : { permissionMode }),
  handlers: owner,
});

describe("ClaudePersistentSupervisor", () => {
  it("fails before runtime creation when disabled", async () => {
    const disabled = harness({ enabled: () => false });
    await expect(acquire(disabled.supervisor)).rejects.toMatchObject({ code: "DISABLED" });
    expect(disabled.runtimeFactory).not.toHaveBeenCalled();
  });

  it("accepts a subscription-only login (no programmatic credential) and keeps the OAuth token", async () => {
    const secret = "oauth-secret";
    const subscriptionOnly = harness({ env: { CLAUDE_CODE_OAUTH_TOKEN: secret } });
    await acquire(subscriptionOnly.supervisor);
    expect(subscriptionOnly.runtimeFactory).toHaveBeenCalledTimes(1);
    expect(subscriptionOnly.runtimes[0]?.options.baseEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(secret);
  });

  it("still fails closed before runtime creation on ambiguous programmatic auth", async () => {
    const ambiguous = harness({
      env: { ANTHROPIC_API_KEY: "api-secret", ANTHROPIC_AUTH_TOKEN: "workload-secret" },
    });
    await expect(acquire(ambiguous.supervisor)).rejects.toMatchObject({
      code: "UNAUTHORIZED_AUTH",
      message: expect.not.stringContaining("api-secret"),
    });
    expect(ambiguous.runtimeFactory).not.toHaveBeenCalled();
  });

  it("coalesces concurrent ownership into one generation and shuts down on last release", async () => {
    const h = harness();
    const binding = handlers();
    const leases = await Promise.all(Array.from({ length: 32 }, () =>
      acquire(h.supervisor, binding)));
    expect(h.runtimes).toHaveLength(1);
    expect(h.runtimes[0]?.startCalls).toBe(1);
    expect(h.runtimes[0]?.options).toMatchObject({
      configHome: HOME,
      cwd: CWD,
      sessionId: SESSION,
      generation: 1,
      launch: "new",
      requestedModel: "claude-sonnet-5",
    });
    expect(new Set(leases.map(({ generation }) => generation))).toEqual(new Set([1]));
    await leases[0]!.send({ text: "hello" });
    expect(h.runtimes[0]?.sends).toEqual([{ text: "hello" }]);

    await Promise.all(leases.slice(0, -1).map((lease) => lease.release()));
    expect(h.runtimes[0]?.shutdownCalls).toBe(0);
    await leases.at(-1)!.release();
    expect(h.runtimes[0]?.shutdownCalls).toBe(1);
    await leases.at(-1)!.release();
    expect(h.runtimes[0]?.shutdownCalls).toBe(1);
  });

  it("quarantines factory-time events but accepts events emitted synchronously from start", async () => {
    const binding = handlers();
    const event = statusEvent();
    const h = harness({
      onRuntimeFactory: (_supervisor, runtime) => runtime.options.emit(event),
      configureRuntime: (runtime) => { runtime.startEvent = event; },
    });

    const lease = await acquire(h.supervisor, binding);
    expect(binding.emit).toHaveBeenCalledTimes(1);
    expect(binding.emit).toHaveBeenCalledWith(event);
    await lease.release();
  });

  it("retains only current-generation backend diagnostics with bounded loss counters", async () => {
    const diagnostic = {
      taskScope: claudeBackendDiagnosticTaskScope(HOME),
      sessionId: SESSION,
      generation: 1,
      eventId: "diagnostic:event:1",
      raw: "safe diagnostic",
      truncated: false,
    } as const;
    const h = harness({
      maxBackendDiagnostics: 2,
      onRuntimeFactory: (_supervisor, runtime) => {
        runtime.options.onBackendDiagnostic(diagnostic);
      },
    });
    const lease = await acquire(h.supervisor);
    const firstSink = h.runtimes[0]!.options.onBackendDiagnostic;

    firstSink(diagnostic);
    firstSink(diagnostic);
    firstSink({ ...diagnostic, raw: "collision" });
    (firstSink as (value: unknown) => void)({ raw: "malformed" });
    firstSink({ ...diagnostic, taskScope: claudeBackendDiagnosticTaskScope("/other-home") });
    firstSink({ ...diagnostic, sessionId: TURN });
    firstSink({ ...diagnostic, generation: 2 });
    expect(h.supervisor.backendDiagnostics()).toMatchObject({
      accepted: 1,
      collisions: 1,
      dropped: 5,
      duplicates: 1,
      evicted: 0,
    });

    h.runtimes[0]!.crash();
    await flush();
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();
    firstSink({ ...diagnostic, eventId: "stale-generation" });
    h.runtimes[1]!.options.onBackendDiagnostic({ ...diagnostic, generation: 2 });

    const snapshot = h.supervisor.backendDiagnostics();
    expect(snapshot.accepted).toBe(1);
    expect(snapshot.duplicates).toBe(2);
    expect(snapshot.records).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("configHome");
    expect(JSON.stringify(snapshot)).not.toContain("cwd");
    await lease.release();
  });

  it("drops every stale-generation event after restart and forwards only the current wrapper", async () => {
    const binding = handlers();
    const h = harness();
    const lease = await acquire(h.supervisor, binding);
    const firstEmit = h.runtimes[0]!.options.emit;
    h.runtimes[0]!.crash();
    await flush();
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();
    expect(h.runtimes).toHaveLength(2);

    firstEmit(statusEvent("stale"));
    h.runtimes[1]!.options.emit(statusEvent("current"));
    expect(binding.emit).toHaveBeenCalledTimes(1);
    expect(binding.emit).toHaveBeenCalledWith(expect.objectContaining({ status: "current" }));
    await lease.release();
  });

  it("allows a new handler owner to rebind only after the retained entry is fully quiescent", async () => {
    const h = harness();
    const firstBinding = handlers(Symbol("first"));
    const first = await acquire(h.supervisor, firstBinding, "new", "plan");
    const firstGeneration = first.generation;
    const staleEmit = h.runtimes[0]!.options.emit;
    await first.release();
    await flush();

    const secondBinding = handlers(Symbol("second"));
    const second = await acquire(h.supervisor, secondBinding, "resume", "plan");
    staleEmit(statusEvent("stale"));
    h.runtimes[1]!.options.emit(statusEvent("current"));
    expect(firstBinding.emit).not.toHaveBeenCalled();
    expect(secondBinding.emit).toHaveBeenCalledTimes(1);
    expect(second.generation).toBeGreaterThan(firstGeneration);
    await second.release();
  });

  it("allows model and permission policy to rebind only after full quiescence", async () => {
    const h = harness();
    const first = await acquire(h.supervisor, handlers(Symbol("first")), "new", "acceptEdits");
    await first.release();
    await flush();

    const secondBinding = handlers(Symbol("second"));
    const second = await h.supervisor.acquire({
      configHome: HOME,
      cwd: CWD,
      sessionId: SESSION,
      launch: "resume",
      requestedModel: "claude-sonnet-4-5",
      permissionMode: "plan",
      handlers: secondBinding,
    });

    expect(h.runtimes[1]?.options).toMatchObject({
      requestedModel: "claude-sonnet-4-5",
      permissionMode: "plan",
      launch: "resume",
    });
    await second.release();
  });

  it("does not poison a quiescent owner binding when replacement configuration is invalid", async () => {
    const h = harness();
    const original = handlers(Symbol("original"));
    const first = await acquire(h.supervisor, original, "new", "plan");
    await first.release();
    await flush();
    const rejected = handlers(Symbol("rejected"));

    await expect(h.supervisor.acquire({
      configHome: HOME,
      cwd: "/different/project",
      sessionId: SESSION,
      launch: "resume",
      requestedModel: "claude-sonnet-5",
      permissionMode: "plan",
      handlers: rejected,
    })).rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });

    const resumed = await acquire(h.supervisor, original, "resume", "plan");
    h.runtimes[1]!.options.emit(statusEvent("current"));
    expect(original.emit).toHaveBeenCalledTimes(1);
    expect(rejected.emit).not.toHaveBeenCalled();
    await resumed.release();
  });

  it("rejects handler/config conflicts without replacing the live runtime", async () => {
    const h = harness();
    const binding = handlers();
    const lease = await acquire(h.supervisor, binding);
    await expect(acquire(h.supervisor, handlers(Symbol("other"))))
      .rejects.toMatchObject({ code: "HANDLER_CONFLICT" });
    await expect(h.supervisor.acquire({
      configHome: HOME,
      cwd: "/other/project",
      sessionId: SESSION,
      launch: "new",
      handlers: binding,
    })).rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });
    await expect(acquire(h.supervisor, binding, "resume"))
      .rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });
    await expect(h.supervisor.acquire({
      configHome: HOME,
      cwd: CWD,
      sessionId: SESSION,
      launch: "new",
      requestedModel: "claude-opus-5",
      handlers: binding,
    })).rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });
    expect(h.runtimes).toHaveLength(1);
    await lease.release();

    const resumed = await acquire(h.supervisor, binding, "resume");
    expect(h.runtimes).toHaveLength(2);
    await resumed.release();
  });

  it("validates, propagates, and conflict-checks provider-native permission modes", async () => {
    const h = harness();
    const binding = handlers();
    const lease = await acquire(h.supervisor, binding, "new", "plan");
    expect(h.runtimes[0]?.options.permissionMode).toBe("plan");

    await expect(acquire(h.supervisor, binding, "new", "acceptEdits"))
      .rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });
    await expect(acquire(
      h.supervisor,
      binding,
      "new",
      "bypassPermissions" as never,
    )).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await lease.release();
  });

  it("never retries an uncertain send and reconciles before a resumed generation", async () => {
    const h = harness();
    const lease = await acquire(h.supervisor);
    h.runtimes[0]!.crash();
    await flush();
    expect(h.timers.activeDelays()).toEqual([CLAUDE_SUPERVISOR_BACKOFF_MS[0]]);
    await expect(lease.send({ text: "uncertain" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(h.runtimes[0]?.sends).toHaveLength(0);

    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();
    expect(h.order.slice(-2)).toEqual(["reconcile:2", "factory:2"]);
    expect(h.runtimes[1]?.options.launch).toBe("resume");
    expect(lease.generation).toBe(2);
    await lease.send({ text: "after reconcile" });
    expect(h.runtimes[1]?.sends).toEqual([{ text: "after reconcile" }]);
    await lease.release();
  });

  it("quarantines a runtime whose terminal channel rejects before retrying", async () => {
    const termination = deferred<void>();
    const h = harness({
      configureRuntime: (runtime, index) => {
        if (index === 0) runtime.shutdownGate = termination;
      },
    });
    const lease = await acquire(h.supervisor);
    h.runtimes[0]!.rejectTerminal();
    await flush();

    expect(h.runtimes[0]?.shutdownCalls).toBe(1);
    expect(h.timers.activeDelays()).toEqual([]);
    expect(h.runtimes).toHaveLength(1);

    termination.resolve();
    await flush();
    expect(h.timers.activeDelays()).toEqual([CLAUDE_SUPERVISOR_BACKOFF_MS[0]]);
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();
    expect(h.runtimes).toHaveLength(2);
    await lease.release();
  });

  it("opens a sixty-second circuit after repeated failed generations", async () => {
    const h = harness();
    const lease = await acquire(h.supervisor);
    for (let failure = 0; failure < 5; failure += 1) {
      h.runtimes.at(-1)!.crash();
      await flush();
      if (failure < 4) {
        const delay = CLAUDE_SUPERVISOR_BACKOFF_MS[failure]!;
        expect(h.timers.activeDelays()).toContain(delay);
        h.timers.fire(delay);
        await flush();
      }
    }
    expect(h.timers.activeDelays()).toContain(CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS);
    await expect(lease.send({ text: "blocked" })).rejects.toMatchObject({
      code: "CIRCUIT_OPEN",
    });
    await lease.release();
  });

  it("shuts every generation down idempotently and invalidates retained leases", async () => {
    const h = harness();
    const first = await acquire(h.supervisor, handlers(Symbol("first")));
    const second = await h.supervisor.acquire({
      configHome: HOME,
      cwd: CWD,
      sessionId: "129f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      launch: "new",
      handlers: handlers(Symbol("second")),
    });
    await h.supervisor.shutdown();
    await h.supervisor.shutdown();
    expect(h.runtimes.map(({ shutdownCalls }) => shutdownCalls)).toEqual([1, 1]);
    await expect(first.send({ text: "late" })).rejects.toMatchObject({ code: "SHUTDOWN" });
    await expect(second.send({ text: "late" })).rejects.toMatchObject({ code: "SHUTDOWN" });
  });

  it("does not schedule another generation until failed-start cleanup confirms termination", async () => {
    const cleanup = deferred<void>();
    const h = harness({
      configureRuntime: (runtime, index) => {
        if (index === 1) {
          runtime.startError = new Error("start failed");
          runtime.shutdownGate = cleanup;
        }
      },
    });
    const lease = await acquire(h.supervisor);
    h.runtimes[0]!.crash();
    await flush();
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();
    expect(h.runtimes[1]?.shutdownCalls).toBe(1);
    expect(h.timers.activeDelays()).toEqual([]);
    await expect(lease.send({ text: "closed while cleanup is pending" }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });

    h.timers.nowMs += CLAUDE_SUPERVISOR_BACKOFF_MS[1];
    cleanup.resolve();
    await flush();
    expect(h.timers.activeDelays()).toEqual([0]);
    h.timers.fire(0);
    await flush();
    expect(h.runtimes).toHaveLength(3);
    await lease.release();
  });

  it("fails closed without blocking callers when failed-start cleanup never settles", async () => {
    const h = harness({
      configureRuntime: (runtime, index) => {
        if (index === 1) {
          runtime.startError = new Error("start failed");
          runtime.shutdownHangs = true;
        }
      },
    });
    const lease = await acquire(h.supervisor);
    h.runtimes[0]!.crash();
    await flush();
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();

    expect(h.runtimes[1]?.shutdownCalls).toBe(1);
    expect(h.timers.activeDelays()).toEqual([]);
    await expect(lease.send({ text: "closed" }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("retains a failed-start retirement tombstone across disable and re-enable", async () => {
    let enabled = true;
    const cleanup = deferred<void>();
    const h = harness({
      enabled: () => enabled,
      configureRuntime: (runtime, index) => {
        if (index === 1) {
          runtime.startError = new Error("start failed");
          runtime.shutdownGate = cleanup;
        }
      },
    });
    const binding = handlers();
    const lease = await acquire(h.supervisor, binding);
    h.runtimes[0]!.crash();
    await flush();
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();
    expect(h.runtimes[1]?.shutdownCalls).toBe(1);

    enabled = false;
    await h.supervisor.refreshEnabled();
    enabled = true;
    await expect(acquire(h.supervisor, binding))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(h.runtimes).toHaveLength(2);

    cleanup.resolve();
    await flush();
    const replacement = await acquire(h.supervisor, binding, "resume");
    expect(replacement.generation).toBeGreaterThan(lease.generation);
    expect(h.runtimes).toHaveLength(3);
    await replacement.release();
    await lease.release();
  });

  it("quarantines an ordinary release until rejected shutdown receives terminal evidence", async () => {
    const h = harness({
      configureRuntime: (runtime, index) => {
        if (index === 0) runtime.shutdownError = new Error("shutdown rejected");
      },
    });
    const binding = handlers();
    const lease = await acquire(h.supervisor, binding);
    const firstGeneration = lease.generation;
    let releaseSettled = false;
    const release = lease.release().then(() => { releaseSettled = true; });
    await flush();
    expect(h.runtimes[0]?.shutdownCalls).toBe(1);
    expect(releaseSettled).toBe(false);
    await expect(acquire(h.supervisor, binding))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(h.runtimes).toHaveLength(1);

    h.runtimes[0]!.crash();
    await flush();
    await release;
    expect(releaseSettled).toBe(true);
    const replacement = await acquire(h.supervisor, binding, "resume");
    expect(replacement.generation).toBeGreaterThan(firstGeneration);
    expect(h.runtimes).toHaveLength(2);
    await replacement.release();
  });

  it("uses absolute backoff deadlines and ignores early, stale, and duplicate callbacks", async () => {
    const h = harness();
    const lease = await acquire(h.supervisor);
    h.runtimes[0]!.crash();
    await flush();
    const delay = CLAUDE_SUPERVISOR_BACKOFF_MS[0];
    const staleCallback = h.timers.tasks.find((task) => !task.cleared && task.delayMs === delay)!
      .callback;

    h.timers.fireEarly(delay, delay - 1);
    await flush();
    expect(h.runtimes).toHaveLength(1);
    expect(h.timers.activeDelays()).toEqual([1]);

    staleCallback();
    await flush();
    expect(h.runtimes).toHaveLength(1);
    expect(h.timers.activeDelays()).toEqual([1]);

    h.timers.fire(1);
    await flush();
    expect(h.runtimes).toHaveLength(2);
    staleCallback();
    await flush();
    expect(h.runtimes).toHaveLength(2);
    await lease.release();
  });

  it("invalidates and clears a timer whose installation races reentrant shutdown", async () => {
    const h = harness({
      onTimerSet: (supervisor) => { void supervisor.shutdown(); },
    });
    const lease = await acquire(h.supervisor);
    h.runtimes[0]!.crash();
    await flush();

    expect(h.timers.activeDelays()).toEqual([]);
    await expect(lease.send({ text: "late" }))
      .rejects.toMatchObject({ code: "SHUTDOWN" });
  });

  it("quarantines a factory candidate when shutdown is called reentrantly", async () => {
    const termination = deferred<void>();
    let shutdownPromise: Promise<void> | null = null;
    const h = harness({
      configureRuntime: (runtime, index) => {
        if (index === 0) runtime.shutdownGate = termination;
      },
      onRuntimeFactory: (supervisor, _runtime, index) => {
        if (index === 0) shutdownPromise = supervisor.shutdown();
      },
    });

    await expect(acquire(h.supervisor)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await flush();
    expect(h.runtimes[0]?.startCalls).toBe(0);
    expect(h.runtimes[0]?.shutdownCalls).toBe(1);
    let shutdownSettled = false;
    void shutdownPromise!.then(() => { shutdownSettled = true; });
    await flush();
    expect(shutdownSettled).toBe(false);

    termination.resolve();
    await shutdownPromise!;
    expect(shutdownSettled).toBe(true);
  });

  it("does not close an open circuit before its absolute deadline", async () => {
    const h = harness();
    const lease = await acquire(h.supervisor);
    for (let failure = 0; failure < 5; failure += 1) {
      h.runtimes.at(-1)!.crash();
      await flush();
      if (failure < 4) {
        h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[failure]!);
        await flush();
      }
    }
    const staleCallback = h.timers.tasks.find((task) =>
      !task.cleared && task.delayMs === CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS)!.callback;
    h.timers.fireEarly(
      CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS,
      CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS - 1,
    );
    await flush();
    expect(h.runtimes).toHaveLength(5);
    await expect(lease.send({ text: "still blocked" }))
      .rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(h.timers.activeDelays()).toEqual([1]);
    staleCallback();
    await flush();
    expect(h.runtimes).toHaveLength(5);
    h.timers.fire(1);
    await flush();
    expect(h.runtimes).toHaveLength(6);
    await lease.release();
  });

  it("retains generation, backoff, and circuit history across lease churn", async () => {
    const h = harness();
    const binding = handlers();
    let lease = await acquire(h.supervisor, binding);

    for (let failure = 0; failure < 5; failure += 1) {
      expect(lease.generation).toBe(failure + 1);
      h.runtimes.at(-1)!.crash();
      await flush();
      await lease.release();
      if (failure < 4) {
        const delay = CLAUDE_SUPERVISOR_BACKOFF_MS[failure]!;
        expect(h.timers.activeDelays()).toContain(delay);
        h.timers.fire(delay);
        await flush();
        lease = await acquire(h.supervisor, binding, "resume");
        expect(h.runtimes.at(-1)?.options.launch).toBe("resume");
      }
    }

    expect(h.timers.activeDelays()).toContain(CLAUDE_SUPERVISOR_CIRCUIT_OPEN_MS);
    await expect(acquire(h.supervisor, binding))
      .rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
  });

  it("evicts only expired failure-free dormant state and keeps generations monotonic", async () => {
    const h = harness({ maxTasks: 1 });
    const first = await acquire(h.supervisor);
    const firstGeneration = first.generation;
    await first.release();
    await flush();

    const acquireSecond = () => h.supervisor.acquire({
      configHome: HOME,
      cwd: CWD,
      sessionId: "129f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      launch: "new",
      requestedModel: "claude-sonnet-5",
      handlers: handlers(),
    });
    await expect(acquireSecond()).rejects.toMatchObject({ code: "UNAVAILABLE" });

    h.timers.nowMs += CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS;
    const second = await acquireSecond();
    expect(second.generation).toBeGreaterThan(firstGeneration);
    expect(h.runtimes).toHaveLength(2);
    await second.release();
    await flush();

    h.timers.nowMs += CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS;
    const firstAgain = await acquire(h.supervisor);
    expect(firstAgain.generation).toBeGreaterThan(firstGeneration);
    expect(h.runtimes).toHaveLength(3);
    await firstAgain.release();
  });

  it("does not evict dormant state while failure or dormancy windows remain live", async () => {
    const h = harness({ maxTasks: 1 });
    const first = await acquire(h.supervisor);
    h.runtimes[0]!.crash();
    await flush();
    await first.release();
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    await flush();

    const acquireOther = () => h.supervisor.acquire({
      configHome: HOME,
      cwd: CWD,
      sessionId: "129f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      launch: "new",
      requestedModel: "claude-sonnet-5",
      handlers: handlers(),
    });
    await expect(acquireOther()).rejects.toMatchObject({ code: "UNAVAILABLE" });

    h.timers.nowMs += CLAUDE_SUPERVISOR_FAILURE_WINDOW_MS -
      CLAUDE_SUPERVISOR_BACKOFF_MS[0] - 1;
    await expect(acquireOther()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    h.timers.nowMs += 1;
    await expect(acquireOther()).rejects.toMatchObject({ code: "UNAVAILABLE" });

    h.timers.nowMs += CLAUDE_SUPERVISOR_BACKOFF_MS[0];
    const other = await acquireOther();
    expect(other.generation).toBeGreaterThan(first.generation);
    await other.release();
  });

  it("contains clock failure during crash handling and fails the lease closed", async () => {
    let failClock = false;
    const h = harness({ now: () => failClock ? Number.NaN : 1_000 });
    const lease = await acquire(h.supervisor);
    failClock = true;
    h.runtimes[0]!.crash();
    await flush();
    await expect(lease.send({ text: "late" })).rejects.toMatchObject({
      code: expect.stringMatching(/^(CIRCUIT_OPEN|UNAVAILABLE)$/u),
    });
    await lease.release();
  });

  it("still shuts a failed-start runtime down when recovery clock setup fails", async () => {
    let failClock = false;
    let clock = 1_000;
    const h = harness({
      now: () => failClock ? Number.NaN : clock,
      configureRuntime: (runtime, index) => {
        if (index === 1) runtime.startError = new Error("start failed");
      },
    });
    const lease = await acquire(h.supervisor);
    h.runtimes[0]!.crash();
    await flush();
    clock += CLAUDE_SUPERVISOR_BACKOFF_MS[0];
    h.timers.fire(CLAUDE_SUPERVISOR_BACKOFF_MS[0]);
    failClock = true;
    await flush();

    expect(h.runtimes[1]?.shutdownCalls).toBe(1);
    expect(h.timers.activeDelays()).toEqual([]);
    await expect(lease.send({ text: "closed" }))
      .rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    await lease.release();
  });

  it("drains live runtimes when disabled and strips subscription OAuth from child env", async () => {
    let enabled = true;
    const h = harness({
      enabled: () => enabled,
      env: {
        ANTHROPIC_API_KEY: "api-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-secret",
        KEEP: "yes",
      },
    });
    const lease = await acquire(h.supervisor);
    expect(h.runtimes[0]?.options.baseEnv).toMatchObject({
      ANTHROPIC_API_KEY: "api-secret",
      KEEP: "yes",
    });
    expect(h.runtimes[0]?.options.baseEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    enabled = false;
    await h.supervisor.refreshEnabled();
    expect(h.runtimes[0]?.shutdownCalls).toBe(1);
    await expect(lease.send({ text: "late" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(acquire(h.supervisor)).rejects.toMatchObject({ code: "DISABLED" });
  });
});
