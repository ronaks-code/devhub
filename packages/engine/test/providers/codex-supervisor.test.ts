import { describe, expect, it, vi } from "vitest";
import {
  CODEX_SUPERVISOR_BACKOFF_MS,
  CodexAppServerSupervisor,
  CodexSupervisorError,
  codexSupervisorBackoffDelay,
  type CodexAppServerLease,
  type CodexSupervisorHandlers,
  type CodexSupervisorProcess,
  type CodexSupervisorProcessFactory,
  type CodexSupervisorProcessOptions,
} from "../../src/providers/codex/supervisor.js";
import type {
  CodexAppServerReady,
  CodexAppServerTerminal,
} from "../../src/providers/codex/app-server-process.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const terminal = (
  generation: number,
  overrides: Partial<CodexAppServerTerminal> = {},
): CodexAppServerTerminal => Object.freeze({
  home: "/canonical/home",
  generation,
  intentional: true,
  exitSeen: true,
  safeToRestart: true,
  error: Object.assign(new Error("stopped"), { code: "SHUTDOWN" }) as never,
  ...overrides,
});

class FakeProcess implements CodexSupervisorProcess {
  readonly home: string;
  readonly generation: number;
  readonly terminated: Promise<CodexAppServerTerminal>;
  readonly startGate = deferred<CodexAppServerReady>();
  readonly terminalGate = deferred<CodexAppServerTerminal>();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly callGates: Array<ReturnType<typeof deferred<unknown>>> = [];
  startCalls = 0;
  shutdownCalls = 0;
  autoStart = true;
  autoShutdown = true;
  startError: Error | null = null;
  shutdownError: Error | null = null;
  shutdownResult: CodexAppServerTerminal;

  constructor(readonly options: CodexSupervisorProcessOptions) {
    this.home = options.home;
    this.generation = options.generation;
    this.terminated = this.terminalGate.promise;
    this.shutdownResult = terminal(this.generation);
  }

  start(): Promise<CodexAppServerReady> {
    this.startCalls += 1;
    if (this.startError) return Promise.reject(this.startError);
    if (this.autoStart) {
      this.startGate.resolve(Object.freeze({
        home: this.home,
        generation: this.generation,
        signal: new AbortController().signal,
      }));
    }
    return this.startGate.promise;
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const gate = deferred<unknown>();
    this.callGates.push(gate);
    return gate.promise as Promise<T>;
  }

  shutdown(): Promise<CodexAppServerTerminal> {
    this.shutdownCalls += 1;
    if (this.shutdownError) return Promise.reject(this.shutdownError);
    if (this.autoShutdown) {
      this.terminalGate.resolve(this.shutdownResult);
    }
    return this.terminalGate.promise;
  }

  crash(overrides: Partial<CodexAppServerTerminal> = {}): void {
    for (const gate of this.callGates) gate.reject(new Error("generation crashed"));
    this.terminalGate.resolve(terminal(this.generation, {
      intentional: false,
      error: Object.assign(new Error("crashed"), { code: "CHILD_EXIT" }) as never,
      ...overrides,
    }));
  }
}

class FakeClock {
  nowMs = 0;
  readonly tasks: Array<{
    callback: () => void;
    delayMs: number;
    cleared: boolean;
  }> = [];

  now = (): number => this.nowMs;

  set = (callback: () => void, delayMs: number): object => {
    const task = { callback, delayMs, cleared: false };
    this.tasks.push(task);
    return task;
  };

  clear = (handle: unknown): void => {
    const task = handle as (typeof this.tasks)[number] | undefined;
    if (task) task.cleared = true;
  };

  activeDelays(): number[] {
    return this.tasks.filter(({ cleared }) => !cleared).map(({ delayMs }) => delayMs);
  }

  fire(delayMs: number): void {
    const task = this.tasks.find((candidate) =>
      !candidate.cleared && candidate.delayMs === delayMs);
    if (!task) throw new Error(`missing active ${delayMs}ms timer`);
    task.cleared = true;
    this.nowMs += delayMs;
    task.callback();
  }
}

interface HarnessOptions {
  readonly enabled?: () => boolean;
  readonly canonicalizeHome?: (home: string) => string;
  readonly configureProcess?: (process: FakeProcess, index: number) => void;
  readonly clock?: FakeClock;
  readonly random?: () => number;
}

const createHarness = (options: HarnessOptions = {}) => {
  const processes: FakeProcess[] = [];
  const processFactory: CodexSupervisorProcessFactory = vi.fn((processOptions) => {
    const process = new FakeProcess(processOptions);
    options.configureProcess?.(process, processes.length);
    processes.push(process);
    return process;
  });
  const supervisor = new CodexAppServerSupervisor({
    executable: "/opt/homebrew/bin/codex",
    clientVersion: "1.2.3",
    isEnabled: options.enabled ?? (() => true),
    reconcile: async () => undefined,
    processFactory,
    canonicalizeHome: options.canonicalizeHome ?? ((home) =>
      home === "/alias/home" ? "/canonical/home" : home),
    now: options.clock?.now,
    random: options.random,
    setTimeoutFn: options.clock?.set,
    clearTimeoutFn: options.clock?.clear,
  });
  return { processFactory, processes, supervisor };
};

const createHandlers = (owner = Symbol("owner")): CodexSupervisorHandlers => ({
  owner,
  onNotification: vi.fn(),
  onUnknownNotification: vi.fn(),
  onServerRequest: vi.fn(async () => ({ decision: "cancel" })),
});

const acquire = (
  supervisor: CodexAppServerSupervisor,
  handlers: CodexSupervisorHandlers,
  home = "/canonical/home",
): Promise<CodexAppServerLease> => supervisor.acquire({ home, handlers });

describe("CodexAppServerSupervisor ownership and lease core", () => {
  it("rejects invalid immutable construction inputs", () => {
    const base = {
      executable: "/opt/homebrew/bin/codex",
      clientVersion: "1",
      isEnabled: () => true,
      reconcile: async () => undefined,
    };
    expect(() => new CodexAppServerSupervisor({ ...base, executable: "codex" }))
      .toThrow(/absolute/i);
    expect(() => new CodexAppServerSupervisor({ ...base, maxTrackedHomes: 257 }))
      .toThrow(/at most 256/i);
    expect(() => new CodexAppServerSupervisor({ ...base, maxDemandPerHome: 257 }))
      .toThrow(/at most 256/i);
    expect(() => new CodexAppServerSupervisor({ ...base, maxPendingRequestsPerHome: 257 }))
      .toThrow(/at most 256/i);
    expect(() => new CodexAppServerSupervisor({ ...base, clientVersion: " " }))
      .toThrow(/version/i);
    expect(() => new CodexAppServerSupervisor({ ...base, isEnabled: null as never }))
      .toThrow(/isEnabled/i);
  });

  it("performs zero process work when native Codex is disabled", async () => {
    const h = createHarness({ enabled: () => false });
    await expect(acquire(h.supervisor, createHandlers())).rejects.toMatchObject({
      code: "DISABLED",
    });
    expect(h.processFactory).not.toHaveBeenCalled();
  });

  it("shares one canonical-home process across one hundred concurrent alias acquires", async () => {
    const h = createHarness();
    const handlers = createHandlers();
    const leases = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      acquire(h.supervisor, handlers, index % 2 === 0 ? "/alias/home" : "/canonical/home")));

    expect(h.processes).toHaveLength(1);
    expect(h.processes[0]?.startCalls).toBe(1);
    expect(new Set(leases.map(({ home }) => home))).toEqual(new Set(["/canonical/home"]));
    expect(new Set(leases.map(({ generation }) => generation))).toEqual(new Set([1]));

    await Promise.all(leases.map((lease) => lease.release()));
    expect(h.processes[0]?.shutdownCalls).toBe(1);
  });

  it("allows identical same-owner handlers and rejects owner or function conflicts without mutation", async () => {
    const h = createHarness();
    const handlers = createHandlers();
    const first = await acquire(h.supervisor, handlers);
    const second = await acquire(h.supervisor, handlers);

    await expect(acquire(h.supervisor, createHandlers(Symbol("other"))))
      .rejects.toMatchObject({ code: "HANDLER_CONFLICT" });
    await expect(acquire(h.supervisor, { ...handlers, onNotification: vi.fn() }))
      .rejects.toMatchObject({ code: "HANDLER_CONFLICT" });
    expect(h.processes).toHaveLength(1);

    await first.release();
    expect(h.processes[0]?.shutdownCalls).toBe(0);
    await second.release();
    expect(h.processes[0]?.shutdownCalls).toBe(1);
  });

  it("fences lease methods as soon as idempotent release begins", async () => {
    const h = createHarness({
      configureProcess: (process) => { process.autoShutdown = false; },
    });
    const lease = await acquire(h.supervisor, createHandlers());
    const first = lease.release();
    const second = lease.release();
    expect(second).toBe(first);
    await expect(lease.call("thread/list", {})).rejects.toMatchObject({
      code: "LEASE_RELEASED",
    });
    expect(h.processes[0]?.shutdownCalls).toBe(1);

    h.processes[0]?.terminalGate.resolve(terminal(1));
    await first;
  });

  it("pins an in-flight call to one generation, invokes it once, and delays last release", async () => {
    const h = createHarness();
    const lease = await acquire(h.supervisor, createHandlers());
    const call = lease.call<{ data: unknown[] }>("thread/list", {});
    await vi.waitFor(() => expect(h.processes[0]?.calls).toHaveLength(1));
    const releasing = lease.release();
    await Promise.resolve();
    expect(h.processes[0]?.shutdownCalls).toBe(0);

    h.processes[0]?.callGates[0]?.resolve({ data: [] });
    await expect(call).resolves.toEqual({ data: [] });
    await releasing;
    expect(h.processes[0]?.calls).toHaveLength(1);
    expect(h.processes[0]?.shutdownCalls).toBe(1);
  });

  it("queues a new owner during stopping and never overlaps home processes", async () => {
    const h = createHarness({
      configureProcess: (process, index) => {
        if (index === 0) process.autoShutdown = false;
      },
    });
    const first = await acquire(h.supervisor, createHandlers(Symbol("first")));
    const releasing = first.release();
    const acquiring = acquire(h.supervisor, createHandlers(Symbol("second")));
    await Promise.resolve();
    expect(h.processes).toHaveLength(1);

    h.processes[0]?.terminalGate.resolve(terminal(1));
    await releasing;
    const second = await acquiring;
    expect(h.processes).toHaveLength(2);
    expect(h.processes[1]?.generation).toBe(2);
    await second.release();
  });

  it("hard-blocks replacement when the old process never confirms restart safety", async () => {
    const h = createHarness({
      configureProcess: (process) => {
        process.shutdownResult = terminal(process.generation, {
          exitSeen: false,
          safeToRestart: false,
        });
      },
    });
    const first = await acquire(h.supervisor, createHandlers(Symbol("first")));
    await first.release();

    await expect(acquire(h.supervisor, createHandlers(Symbol("second"))))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(h.processes).toHaveLength(1);
  });

  it("treats a shutdown rejection as unsafe and never starts a replacement", async () => {
    const h = createHarness({
      configureProcess: (process) => { process.shutdownError = new Error("private shutdown"); },
    });
    const lease = await acquire(h.supervisor, createHandlers(Symbol("first")));
    await lease.release();
    await expect(acquire(h.supervisor, createHandlers(Symbol("second"))))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(h.processes).toHaveLength(1);
  });

  it("rolls back handler ownership when startup fails or acquire is cancelled", async () => {
    let configured = 0;
    const clock = new FakeClock();
    const h = createHarness({
      clock,
      random: () => 0,
      configureProcess: (process) => {
        configured += 1;
        if (configured === 1) process.startError = new Error("private startup detail");
        if (configured === 2) process.autoStart = false;
      },
    });
    const firstOwner = createHandlers(Symbol("first"));
    await expect(acquire(h.supervisor, firstOwner)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    const controller = new AbortController();
    const cancelled = h.supervisor.acquire({
      home: "/canonical/home",
      handlers: createHandlers(Symbol("second")),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    clock.fire(250);
    await vi.waitFor(() => expect(h.processes).toHaveLength(2));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const third = await acquire(h.supervisor, createHandlers(Symbol("third")));
    expect(h.processes).toHaveLength(3);
    await third.release();
  });

  it("dispatches only the current generation and isolates stale notifications", async () => {
    const h = createHarness();
    const firstHandlers = createHandlers(Symbol("first"));
    const first = await acquire(h.supervisor, firstHandlers);
    const firstOptions = h.processes[0]!.options;
    const signal = new AbortController().signal;
    await firstOptions.onNotification(
      { method: "thread/archived", params: { threadId: "t-1" } },
      { home: "/canonical/home", generation: 1, signal },
    );
    expect(firstHandlers.onNotification).toHaveBeenCalledOnce();
    await first.release();

    const secondHandlers = createHandlers(Symbol("second"));
    const second = await acquire(h.supervisor, secondHandlers);
    await firstOptions.onNotification(
      { method: "thread/archived", params: { threadId: "stale" } },
      { home: "/canonical/home", generation: 1, signal },
    );
    expect(firstHandlers.onNotification).toHaveBeenCalledOnce();
    expect(secondHandlers.onNotification).not.toHaveBeenCalled();
    await second.release();
  });

  it("keeps numeric and string request ids distinct, rejects duplicates, and aborts late owner work", async () => {
    const h = createHarness();
    const numeric = deferred<unknown>();
    const string = deferred<unknown>();
    const observedSignals: AbortSignal[] = [];
    const baseHandlers = createHandlers();
    const handlers: CodexSupervisorHandlers = {
      ...baseHandlers,
      onServerRequest: vi.fn((request, { signal }) => {
        observedSignals.push(signal);
        return request.id === 1 ? numeric.promise : string.promise;
      }),
    };
    const lease = await acquire(h.supervisor, handlers);
    const options = h.processes[0]!.options;
    const context = {
      home: "/canonical/home",
      generation: 1,
      signal: new AbortController().signal,
    };
    const first = options.onServerRequest({ id: 1, method: "request" }, context);
    const second = options.onServerRequest({ id: "1", method: "request" }, context);
    await vi.waitFor(() => expect(handlers.onServerRequest).toHaveBeenCalledTimes(2));
    await expect(options.onServerRequest({ id: 1, method: "request" }, context))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });

    const releasing = lease.release();
    await expect(first).rejects.toMatchObject({ code: "LEASE_RELEASED" });
    await expect(second).rejects.toMatchObject({ code: "LEASE_RELEASED" });
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    numeric.resolve({ decision: "accept" });
    string.resolve({ decision: "accept" });
    await releasing;
  });

  it("exposes stable typed supervisor errors", () => {
    const error = new CodexSupervisorError("UNAVAILABLE", "unavailable");
    expect(error).toMatchObject({ name: "CodexSupervisorError", code: "UNAVAILABLE" });
  });
});

describe("CodexAppServerSupervisor restart and circuit policy", () => {
  it("publishes the exact capped backoff bases with additive bounded jitter", () => {
    expect(CODEX_SUPERVISOR_BACKOFF_MS).toEqual([
      250,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
    ]);
    expect(CODEX_SUPERVISOR_BACKOFF_MS.map((_, index) =>
      codexSupervisorBackoffDelay(index, () => 0))).toEqual(CODEX_SUPERVISOR_BACKOFF_MS);
    expect(codexSupervisorBackoffDelay(99, () => 0.9999)).toBe(30_249);
  });

  it("restarts a demanded safe generation without replaying an uncertain turn", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock, random: () => 0 });
    const handlers = createHandlers();
    const lease = await acquire(h.supervisor, handlers);
    const uncertain = lease.call("turn/start", { threadId: "t", input: [] });
    await vi.waitFor(() => expect(h.processes[0]?.calls).toHaveLength(1));
    h.processes[0]?.crash();
    await expect(uncertain).rejects.toThrow();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    await expect(lease.call("thread/list", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });

    clock.fire(250);
    await vi.waitFor(() => expect(h.processes).toHaveLength(2));
    expect(lease.generation).toBe(2);
    expect(h.processes[0]?.calls).toHaveLength(1);
    expect(h.processes[1]?.calls).toHaveLength(0);
    await lease.release();
  });

  it("does not hand out a stale lease when terminal settlement races acquire", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock, random: () => 0 });
    const handlers = createHandlers();
    const keeper = await acquire(h.supervisor, handlers);
    h.processes[0]?.crash();
    const racing = acquire(h.supervisor, handlers);
    let settled = false;
    void racing.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    clock.fire(250);
    const lease = await racing;
    expect(lease.generation).toBe(2);
    await lease.release();
    await keeper.release();
  });

  it("opens on the fifth failure in sixty seconds and permits one half-open probe", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock, random: () => 0 });
    const handlers = createHandlers();
    const keeper = await acquire(h.supervisor, handlers);

    for (const [index, delay] of [250, 1_000, 2_000, 4_000].entries()) {
      h.processes[index]?.crash();
      await vi.waitFor(() => expect(h.processes).toHaveLength(index + 1));
      await vi.waitFor(() => expect(clock.activeDelays()).toContain(delay));
      clock.fire(delay);
      await vi.waitFor(() => expect(h.processes).toHaveLength(index + 2));
    }
    await vi.waitFor(() => expect(h.processes).toHaveLength(5));
    h.processes[4]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(60_000));

    await expect(acquire(h.supervisor, handlers)).rejects.toMatchObject({
      code: "CIRCUIT_OPEN",
    });
    clock.nowMs += 60_000;
    const halfOpen = await Promise.all(Array.from({ length: 20 }, () =>
      acquire(h.supervisor, handlers)));
    expect(h.processes).toHaveLength(6);
    expect(new Set(halfOpen.map(({ generation }) => generation))).toEqual(new Set([6]));
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(60_000));
    clock.fire(60_000);
    h.processes[5]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    await Promise.all(halfOpen.map((lease) => lease.release()));
    await keeper.release();
  });

  it("reopens for sixty seconds when the sole half-open generation fails", async () => {
    const clock = new FakeClock();
    const h = createHarness({
      clock,
      random: () => 0,
      configureProcess: (process, index) => {
        if (index === 5) process.startError = new Error("half-open failed");
      },
    });
    const handlers = createHandlers();
    const keeper = await acquire(h.supervisor, handlers);
    for (const [index, delay] of [250, 1_000, 2_000, 4_000].entries()) {
      h.processes[index]?.crash();
      await vi.waitFor(() => expect(clock.activeDelays()).toContain(delay));
      clock.fire(delay);
      await vi.waitFor(() => expect(h.processes).toHaveLength(index + 2));
    }
    h.processes[4]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(60_000));
    clock.fire(60_000);
    await vi.waitFor(() => expect(h.processes).toHaveLength(6));
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(60_000));
    await expect(acquire(h.supervisor, handlers)).rejects.toMatchObject({
      code: "CIRCUIT_OPEN",
    });
    await keeper.release();
  });

  it("prunes failures older than sixty seconds instead of opening the circuit", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock, random: () => 0 });
    const keeper = await acquire(h.supervisor, createHandlers());
    for (const [index, delay] of [250, 1_000, 2_000, 4_000].entries()) {
      h.processes[index]?.crash();
      await vi.waitFor(() => expect(clock.activeDelays()).toContain(delay));
      clock.fire(delay);
      await vi.waitFor(() => expect(h.processes).toHaveLength(index + 2));
    }
    clock.nowMs = 60_001;
    await vi.waitFor(() => expect(h.processes).toHaveLength(5));
    h.processes[4]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(8_000));
    await keeper.release();
  });

  it("preserves failure history after an idle entry is removed", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock, random: () => 0 });
    const first = await acquire(h.supervisor, createHandlers(Symbol("first")));
    h.processes[0]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    await first.release();

    const reacquiring = acquire(h.supervisor, createHandlers(Symbol("second")));
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    expect(h.processes).toHaveLength(1);
    clock.fire(250);
    const second = await reacquiring;
    h.processes[1]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(1_000));
    await second.release();
  });

  it("fences stale restart timers after an idle entry is replaced", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock, random: () => 0 });
    const first = await acquire(h.supervisor, createHandlers(Symbol("first")));
    h.processes[0]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    const stale = clock.tasks.find(({ delayMs, cleared }) => delayMs === 250 && !cleared)!;
    await first.release();
    expect(stale.cleared).toBe(true);
    const reacquiring = acquire(h.supervisor, createHandlers(Symbol("second")));
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    clock.fire(250);
    const second = await reacquiring;
    const generation = second.generation;
    stale.callback();
    await Promise.resolve();
    expect(h.processes).toHaveLength(2);
    expect(second.generation).toBe(generation);
    await second.release();
  });

  it("cannot launch an overlapping generation from a stale same-entry timer callback", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock, random: () => 0 });
    const lease = await acquire(h.supervisor, createHandlers());
    h.processes[0]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    const stale = clock.tasks.find(({ delayMs, cleared }) => delayMs === 250 && !cleared)!;
    clock.fire(250);
    await vi.waitFor(() => expect(h.processes).toHaveLength(2));
    stale.callback();
    await Promise.resolve();
    expect(h.processes).toHaveLength(2);
    await lease.release();
  });

  it("sanitizes a synchronous factory throw and rolls ownership back", async () => {
    let calls = 0;
    const processes: FakeProcess[] = [];
    const supervisor = new CodexAppServerSupervisor({
      executable: "/opt/homebrew/bin/codex",
      clientVersion: "1",
      isEnabled: () => true,
      reconcile: async () => undefined,
      canonicalizeHome: (home) => home,
      processFactory: (options) => {
        calls += 1;
        if (calls === 1) throw new Error("private factory detail");
        const process = new FakeProcess(options);
        processes.push(process);
        return process;
      },
    });
    await expect(acquire(supervisor, createHandlers(Symbol("first"))))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    const second = await acquire(supervisor, createHandlers(Symbol("second")));
    expect(second.generation).toBe(2);
    expect(processes).toHaveLength(1);
    await second.release();
  });

  it("contains an invalid factory return and releases the reserved owner", async () => {
    let calls = 0;
    const processes: FakeProcess[] = [];
    const supervisor = new CodexAppServerSupervisor({
      executable: "/opt/homebrew/bin/codex",
      clientVersion: "1",
      isEnabled: () => true,
      reconcile: async () => undefined,
      canonicalizeHome: (home) => home,
      processFactory: ((options: CodexSupervisorProcessOptions) => {
        calls += 1;
        if (calls === 1) return null;
        const process = new FakeProcess(options);
        processes.push(process);
        return process;
      }) as CodexSupervisorProcessFactory,
    });
    await expect(acquire(supervisor, createHandlers(Symbol("first"))))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    const second = await acquire(supervisor, createHandlers(Symbol("second")));
    expect(second.generation).toBe(2);
    expect(processes).toHaveLength(1);
    await second.release();
  });

  it("fails closed when restart randomness or timer scheduling throws", async () => {
    for (const mode of ["random", "timer"] as const) {
      const processOptions: FakeProcess[] = [];
      const supervisor = new CodexAppServerSupervisor({
        executable: "/opt/homebrew/bin/codex",
        clientVersion: "1",
        isEnabled: () => true,
        reconcile: async () => undefined,
        canonicalizeHome: (home) => home,
        random: () => {
          if (mode === "random") throw new Error("private random");
          return 0;
        },
        setTimeoutFn: () => {
          if (mode === "timer") throw new Error("private timer");
          return {};
        },
        processFactory: (options) => {
          const process = new FakeProcess(options);
          processOptions.push(process);
          return process;
        },
      });
      const handlers = createHandlers(Symbol(mode));
      const lease = await acquire(supervisor, handlers);
      processOptions[0]?.crash();
      await Promise.resolve();
      await Promise.resolve();
      await expect(lease.call("thread/list", {})).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      await expect(acquire(supervisor, handlers)).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      await lease.release();
    }
  });

  it("hard-blocks replacement after an unsafe unexpected runtime terminal", async () => {
    const h = createHarness();
    const handlers = createHandlers();
    const lease = await acquire(h.supervisor, handlers);
    h.processes[0]?.crash({ exitSeen: false, safeToRestart: false });
    await Promise.resolve();
    await Promise.resolve();
    await expect(lease.call("thread/list", {})).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(acquire(h.supervisor, handlers)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await lease.release();
    await expect(acquire(h.supervisor, createHandlers(Symbol("new"))))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(h.processes).toHaveLength(1);
  });
});

describe("CodexAppServerSupervisor dynamic disable and shutdown", () => {
  it("disables during startup, cancels the waiter, and shuts down the child", async () => {
    let enabled = true;
    const h = createHarness({
      enabled: () => enabled,
      configureProcess: (process) => { process.autoStart = false; },
    });
    const pending = acquire(h.supervisor, createHandlers());
    await vi.waitFor(() => expect(h.processes).toHaveLength(1));
    enabled = false;
    const disabling = h.supervisor.refreshEnabled();
    await expect(pending).rejects.toMatchObject({ code: "DISABLED" });
    await disabling;
    expect(h.processes[0]?.shutdownCalls).toBe(1);
  });

  it("does not let a late start overwrite stopping while disable awaits terminal", async () => {
    let enabled = true;
    const h = createHarness({
      enabled: () => enabled,
      configureProcess: (process) => {
        process.autoStart = false;
        process.autoShutdown = false;
      },
    });
    const pending = acquire(h.supervisor, createHandlers());
    await vi.waitFor(() => expect(h.processes).toHaveLength(1));
    enabled = false;
    const disabling = h.supervisor.refreshEnabled();
    h.processes[0]?.startGate.resolve(Object.freeze({
      home: "/canonical/home",
      generation: 1,
      signal: new AbortController().signal,
    }));
    await expect(pending).rejects.toMatchObject({ code: "DISABLED" });
    h.processes[0]?.terminalGate.resolve(terminal(1));
    await disabling;
    expect(h.processes).toHaveLength(1);
  });

  it("checks the flag again before a scheduled restart and resurrects no lease", async () => {
    let enabled = true;
    const clock = new FakeClock();
    const h = createHarness({ clock, enabled: () => enabled, random: () => 0 });
    const lease = await acquire(h.supervisor, createHandlers());
    h.processes[0]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    enabled = false;
    clock.fire(250);
    await vi.waitFor(() => expect(h.processes).toHaveLength(1));
    await expect(lease.call("thread/list", {})).rejects.toMatchObject({ code: "DISABLED" });
    expect(h.processes).toHaveLength(1);
  });

  it("cancels backoff and open timers when disabled", async () => {
    let enabled = true;
    const clock = new FakeClock();
    const h = createHarness({ clock, enabled: () => enabled, random: () => 0 });
    const lease = await acquire(h.supervisor, createHandlers());
    h.processes[0]?.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));
    enabled = false;
    await h.supervisor.refreshEnabled();
    expect(clock.activeDelays()).not.toContain(250);
    await expect(lease.call("thread/list", {})).rejects.toMatchObject({ code: "DISABLED" });
  });

  it("waits for an in-progress stop, then rejects the queued acquire as disabled", async () => {
    let enabled = true;
    const h = createHarness({
      enabled: () => enabled,
      configureProcess: (process) => { process.autoShutdown = false; },
    });
    const first = await acquire(h.supervisor, createHandlers(Symbol("first")));
    const releasing = first.release();
    const queued = acquire(h.supervisor, createHandlers(Symbol("second")));
    enabled = false;
    const disabling = h.supervisor.refreshEnabled();
    await Promise.resolve();
    expect(h.processes).toHaveLength(1);
    h.processes[0]?.terminalGate.resolve(terminal(1));
    await releasing;
    await disabling;
    await expect(queued).rejects.toMatchObject({ code: "DISABLED" });
  });

  it("makes concurrent shutdown idempotent and rejects every later acquire", async () => {
    const h = createHarness();
    const lease = await acquire(h.supervisor, createHandlers());
    const first = h.supervisor.shutdown();
    const second = h.supervisor.shutdown();
    expect(second).toBe(first);
    await first;
    await expect(acquire(h.supervisor, createHandlers(Symbol("later"))))
      .rejects.toMatchObject({ code: "SHUTDOWN" });
    await expect(lease.call("thread/list", {})).rejects.toMatchObject({ code: "SHUTDOWN" });
    expect(h.processes[0]?.shutdownCalls).toBe(1);
  });
});
