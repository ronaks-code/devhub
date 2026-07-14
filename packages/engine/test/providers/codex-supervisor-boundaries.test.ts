import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerSupervisor,
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

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const terminal = (
  home: string,
  generation: number,
  overrides: Partial<CodexAppServerTerminal> = {},
): CodexAppServerTerminal => Object.freeze({
  home,
  generation,
  intentional: true,
  exitSeen: true,
  safeToRestart: true,
  error: Object.assign(new Error("stopped"), { code: "SHUTDOWN" }) as never,
  ...overrides,
});

class BoundaryProcess implements CodexSupervisorProcess {
  readonly home: string;
  readonly generation: number;
  readonly terminalGate = deferred<CodexAppServerTerminal>();
  readonly terminated = this.terminalGate.promise;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly callGates: Array<ReturnType<typeof deferred<unknown>>> = [];
  shutdownResult: CodexAppServerTerminal;
  startError: Error | null = null;
  startCalls = 0;
  shutdownCalls = 0;

  constructor(readonly options: CodexSupervisorProcessOptions) {
    this.home = options.home;
    this.generation = options.generation;
    this.shutdownResult = terminal(this.home, this.generation);
  }

  async start(): Promise<CodexAppServerReady> {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    return Object.freeze({
      home: this.home,
      generation: this.generation,
      signal: new AbortController().signal,
    });
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const gate = deferred<unknown>();
    this.callGates.push(gate);
    return gate.promise as Promise<T>;
  }

  shutdown(): Promise<CodexAppServerTerminal> {
    this.shutdownCalls += 1;
    this.terminalGate.resolve(this.shutdownResult);
    return this.terminalGate.promise;
  }

  crash(): void {
    for (const gate of this.callGates) gate.reject(new Error("generation crashed"));
    this.terminalGate.resolve(terminal(this.home, this.generation, {
      intentional: false,
      error: Object.assign(new Error("crashed"), { code: "CHILD_EXIT" }) as never,
    }));
  }

  rejectTermination(): void {
    this.terminalGate.reject(new Error("private terminal rejection"));
  }
}

interface ClockTask {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
}

class ManualClock {
  nowMs = 0;
  readonly tasks: ClockTask[] = [];
  readonly synchronousDelays = new Set<number>();
  clearThrows = false;

  now = (): number => this.nowMs;

  set = (callback: () => void, delayMs: number): ClockTask => {
    const task = { callback, delayMs, cleared: false };
    this.tasks.push(task);
    if (this.synchronousDelays.has(delayMs)) callback();
    return task;
  };

  clear = (handle: unknown): void => {
    if (this.clearThrows) throw new Error("private clear failure");
    const task = handle as ClockTask | undefined;
    if (task) task.cleared = true;
  };

  activeDelay(delayMs: number): ClockTask | undefined {
    return this.tasks.find((task) => !task.cleared && task.delayMs === delayMs);
  }

  latest(delayMs: number): ClockTask | undefined {
    return [...this.tasks].reverse().find((task) => task.delayMs === delayMs);
  }

  fire(delayMs: number): void {
    const task = this.activeDelay(delayMs);
    if (!task) throw new Error(`missing active ${delayMs}ms timer`);
    task.cleared = true;
    this.nowMs += delayMs;
    task.callback();
  }
}

interface HarnessOptions {
  readonly maxTrackedHomes?: number;
  readonly clock?: ManualClock;
  readonly random?: () => number;
  readonly configureProcess?: (process: BoundaryProcess, index: number) => void;
}

const createHarness = (options: HarnessOptions = {}) => {
  const processes: BoundaryProcess[] = [];
  const processFactory: CodexSupervisorProcessFactory = vi.fn((processOptions) => {
    const process = new BoundaryProcess(processOptions);
    options.configureProcess?.(process, processes.length);
    processes.push(process);
    return process;
  });
  const supervisor = new CodexAppServerSupervisor({
    executable: "/opt/homebrew/bin/codex",
    clientVersion: "boundary-tests",
    isEnabled: () => true,
    reconcile: async () => undefined,
    processFactory,
    canonicalizeHome: (home) => home,
    now: options.clock?.now,
    random: options.random,
    setTimeoutFn: options.clock?.set,
    clearTimeoutFn: options.clock?.clear,
    maxTrackedHomes: options.maxTrackedHomes,
  });
  return { processFactory, processes, supervisor };
};

const handlers = (owner = Symbol("owner")): CodexSupervisorHandlers => ({
  owner,
  onNotification: vi.fn(),
  onUnknownNotification: vi.fn(),
  onServerRequest: vi.fn(async () => ({ decision: "cancel" })),
});

const acquire = (
  supervisor: CodexAppServerSupervisor,
  home: string,
  owner = Symbol(home),
  signal?: AbortSignal,
): Promise<CodexAppServerLease> => supervisor.acquire({
  home,
  handlers: handlers(owner),
  signal,
});

const internals = (supervisor: CodexAppServerSupervisor) => supervisor as unknown as {
  readonly circuits: Map<string, unknown>;
  readonly entries: Map<string, unknown>;
};

describe("CodexAppServerSupervisor cooldown boundaries", () => {
  it("waits only the remaining absolute retryAt after a halfway reacquire without resampling", async () => {
    const clock = new ManualClock();
    const random = vi.fn(() => 0);
    const h = createHarness({ clock, random });
    const first = await acquire(h.supervisor, "/home/a", Symbol("first"));

    h.processes[0]!.crash();
    await vi.waitFor(() => expect(clock.activeDelay(250)).toBeDefined());
    expect(random).toHaveBeenCalledOnce();
    await first.release();

    clock.nowMs = 125;
    const reacquiring = acquire(h.supervisor, "/home/a", Symbol("second"));
    await vi.waitFor(() => expect(clock.activeDelay(125)).toBeDefined());
    expect(random).toHaveBeenCalledOnce();
    expect(h.processes).toHaveLength(1);

    clock.fire(125);
    const second = await reacquiring;
    expect(second.generation).toBe(2);
    expect(h.processes).toHaveLength(2);
    await second.release();
  });

  it("preserves the cooldown deadline and releases handler ownership when reacquire is cancelled", async () => {
    const clock = new ManualClock();
    const random = vi.fn(() => 0);
    const h = createHarness({ clock, random });
    const first = await acquire(h.supervisor, "/home/a", Symbol("first"));

    h.processes[0]!.crash();
    await vi.waitFor(() => expect(clock.activeDelay(250)).toBeDefined());
    await first.release();

    clock.nowMs = 100;
    const controller = new AbortController();
    const cancelled = acquire(
      h.supervisor,
      "/home/a",
      Symbol("cancelled"),
      controller.signal,
    );
    await vi.waitFor(() => expect(clock.activeDelay(150)).toBeDefined());
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "UNAVAILABLE" });

    clock.nowMs = 200;
    const finalAcquire = acquire(h.supervisor, "/home/a", Symbol("final"));
    await vi.waitFor(() => expect(clock.activeDelay(50)).toBeDefined());
    expect(random).toHaveBeenCalledOnce();
    clock.fire(50);
    const lease = await finalAcquire;
    expect(lease.generation).toBe(2);
    await lease.release();
  });
});

describe("CodexAppServerSupervisor tracked-home boundaries", () => {
  it("touches a safely idle circuit on reacquire so LRU eviction removes the true oldest home", async () => {
    const clock = new ManualClock();
    const h = createHarness({ clock, maxTrackedHomes: 3 });

    for (const home of ["/home/a", "/home/b", "/home/c"]) {
      const lease = await acquire(h.supervisor, home);
      await lease.release();
    }
    const touched = await acquire(h.supervisor, "/home/a", Symbol("touch-a"));
    await touched.release();

    const newest = await acquire(h.supervisor, "/home/d", Symbol("new-d"));
    expect([...internals(h.supervisor).circuits.keys()].sort()).toEqual([
      "/home/a",
      "/home/c",
      "/home/d",
    ]);
    await newest.release();
  });

  it("rejects a new home at full capacity before factory or map mutation when nothing is evictable", async () => {
    const clock = new ManualClock();
    const h = createHarness({ clock, maxTrackedHomes: 2, random: () => 0 });
    const active = await acquire(h.supervisor, "/home/active");
    const cooling = await acquire(h.supervisor, "/home/cooling");
    h.processes[1]!.crash();
    await vi.waitFor(() => expect(clock.activeDelay(250)).toBeDefined());
    await cooling.release();

    const beforeCircuits = [...internals(h.supervisor).circuits.keys()];
    const beforeEntries = [...internals(h.supervisor).entries.keys()];
    const beforeFactoryCalls = vi.mocked(h.processFactory).mock.calls.length;
    await expect(acquire(h.supervisor, "/home/rejected"))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });

    expect(vi.mocked(h.processFactory).mock.calls).toHaveLength(beforeFactoryCalls);
    expect([...internals(h.supervisor).circuits.keys()]).toEqual(beforeCircuits);
    expect([...internals(h.supervisor).entries.keys()]).toEqual(beforeEntries);
    expect(internals(h.supervisor).circuits.has("/home/rejected")).toBe(false);
    expect(internals(h.supervisor).entries.has("/home/rejected")).toBe(false);
    await active.release();
  });

  it("expires inactive startup-failure history so it cannot exhaust home admission forever", async () => {
    const clock = new ManualClock();
    const h = createHarness({
      clock,
      maxTrackedHomes: 1,
      random: () => 0,
      configureProcess: (process, index) => {
        if (index === 0) process.startError = new Error("private startup failure");
      },
    });

    await expect(acquire(h.supervisor, "/home/expired"))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect([...internals(h.supervisor).circuits.keys()]).toEqual(["/home/expired"]);

    clock.nowMs = 60_001;
    const admitted = await acquire(h.supervisor, "/home/new", Symbol("new"));
    expect([...internals(h.supervisor).circuits.keys()]).toEqual(["/home/new"]);
    expect(h.processes).toHaveLength(2);
    await admitted.release();
  });

  it("assigns a globally higher generation when an evicted home is later recreated", async () => {
    const h = createHarness({ clock: new ManualClock(), maxTrackedHomes: 1 });
    const first = await acquire(h.supervisor, "/home/a");
    const firstGeneration = first.generation;
    await first.release();

    const other = await acquire(h.supervisor, "/home/b");
    await other.release();
    const recreated = await acquire(h.supervisor, "/home/a", Symbol("recreated"));

    expect(recreated.generation).toBeGreaterThan(firstGeneration);
    expect(h.processes.map((process) => process.generation)).toEqual([1, 2, 3]);
    await recreated.release();
  });

  it("ignores a stale healthy callback after circuit eviction and home recreation", async () => {
    const clock = new ManualClock();
    const h = createHarness({ clock, maxTrackedHomes: 1 });
    const first = await acquire(h.supervisor, "/home/a");
    const stale = clock.latest(60_000)!;
    await first.release();
    expect(stale.cleared).toBe(true);

    const other = await acquire(h.supervisor, "/home/b");
    await other.release();
    const recreated = await acquire(h.supervisor, "/home/a", Symbol("recreated"));
    expect(recreated.generation).toBe(3);

    stale.callback();
    await Promise.resolve();
    expect(h.processes).toHaveLength(3);
    expect(recreated.generation).toBe(3);
    const call = recreated.call<{ data: unknown[] }>("thread/list", {});
    await vi.waitFor(() => expect(h.processes[2]!.calls).toHaveLength(1));
    h.processes[2]!.callGates[0]!.resolve({ data: [] });
    await expect(call).resolves.toEqual({ data: [] });
    await recreated.release();
  });
});

describe("CodexAppServerSupervisor unsafe terminal boundaries", () => {
  it("never replaces a malformed factory child while its quarantine shutdown is pending", async () => {
    const cleanup = deferred<CodexAppServerTerminal>();
    const processes: BoundaryProcess[] = [];
    let factoryCalls = 0;
    let cleanupCalls = 0;
    const supervisor = new CodexAppServerSupervisor({
      executable: "/opt/homebrew/bin/codex",
      clientVersion: "boundary-tests",
      isEnabled: () => true,
      reconcile: async () => undefined,
      canonicalizeHome: (home) => home,
      processFactory: ((options: CodexSupervisorProcessOptions) => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          return {
            shutdown: () => {
              cleanupCalls += 1;
              return cleanup.promise;
            },
          };
        }
        const process = new BoundaryProcess(options);
        processes.push(process);
        return process;
      }) as CodexSupervisorProcessFactory,
    });
    const controller = new AbortController();
    const first = acquire(supervisor, "/home/quarantine", Symbol("first"), controller.signal);
    await vi.waitFor(() => expect(cleanupCalls).toBe(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const replacement = acquire(supervisor, "/home/quarantine", Symbol("replacement"));
    let settled = false;
    void replacement.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(factoryCalls).toBe(1);

    cleanup.resolve(terminal("/home/quarantine", 1));
    const lease = await replacement;
    expect(factoryCalls).toBe(2);
    expect(processes).toHaveLength(1);
    await lease.release();
  });

  it("memoizes valid-process shutdown so cancellation cannot bypass the first pending stop", async () => {
    const firstShutdown = deferred<CodexAppServerTerminal>();
    const neverTerminates = deferred<CodexAppServerTerminal>();
    const processes: BoundaryProcess[] = [];
    let factoryCalls = 0;
    let shutdownCalls = 0;
    const supervisor = new CodexAppServerSupervisor({
      executable: "/opt/homebrew/bin/codex",
      clientVersion: "boundary-tests",
      isEnabled: () => true,
      reconcile: async () => undefined,
      canonicalizeHome: (home) => home,
      processFactory: (options) => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          return {
            home: options.home,
            generation: options.generation,
            terminated: neverTerminates.promise,
            start: () => Promise.reject(new Error("private startup failure")),
            call: async <T>() => ({} as T),
            shutdown: () => {
              shutdownCalls += 1;
              return shutdownCalls === 1
                ? firstShutdown.promise
                : Promise.resolve(terminal(options.home, options.generation));
            },
          };
        }
        const process = new BoundaryProcess(options);
        processes.push(process);
        return process;
      },
    });
    const controller = new AbortController();
    const first = acquire(supervisor, "/home/memoized", Symbol("first"), controller.signal);
    const firstOutcome = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(shutdownCalls).toBe(1));
    controller.abort();
    await vi.waitFor(() => {
      const entry = internals(supervisor).entries.get("/home/memoized") as {
        readonly state?: string;
      } | undefined;
      expect(entry?.state).toBe("stopping");
    });

    const replacement = acquire(supervisor, "/home/memoized", Symbol("replacement"));
    let settled = false;
    void replacement.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(factoryCalls).toBe(1);
    expect(shutdownCalls).toBe(1);

    firstShutdown.resolve(terminal("/home/memoized", 1));
    await expect(firstOutcome).resolves.toMatchObject({ code: "UNAVAILABLE" });
    const lease = await replacement;
    expect(factoryCalls).toBe(2);
    expect(processes).toHaveLength(1);
    await lease.release();
  });

  it("hard-blocks replacement after malformed or mismatched shutdown terminals", async () => {
    const variants: Array<{
      readonly name: string;
      readonly result: (process: BoundaryProcess) => CodexAppServerTerminal;
    }> = [
      {
        name: "home mismatch",
        result: (process) => terminal("/home/other", process.generation),
      },
      {
        name: "generation mismatch",
        result: (process) => terminal(process.home, process.generation + 1),
      },
      {
        name: "malformed terminal",
        result: (process) => Object.freeze({
          home: process.home,
          generation: process.generation,
          intentional: true,
          exitSeen: true,
          safeToRestart: true,
        }) as CodexAppServerTerminal,
      },
    ];

    for (const variant of variants) {
      const h = createHarness({
        configureProcess: (process) => {
          process.shutdownResult = variant.result(process);
        },
      });
      const first = await acquire(h.supervisor, `/home/${variant.name}`, Symbol("first"));
      await first.release();
      await expect(acquire(
        h.supervisor,
        `/home/${variant.name}`,
        Symbol("replacement"),
      )).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(h.processes, variant.name).toHaveLength(1);
    }
  });

  it("hard-blocks replacement when the process terminated promise rejects", async () => {
    const h = createHarness();
    const first = await acquire(h.supervisor, "/home/rejected-terminal", Symbol("first"));
    h.processes[0]!.rejectTermination();

    await vi.waitFor(() => {
      const entry = internals(h.supervisor).entries.get("/home/rejected-terminal") as {
        readonly state?: string;
      } | undefined;
      expect(entry?.state).toBe("unavailable");
    });
    await expect(first.call("thread/list", {})).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await first.release();
    await expect(acquire(
      h.supervisor,
      "/home/rejected-terminal",
      Symbol("replacement"),
    )).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(h.processes).toHaveLength(1);
  });
});

describe("CodexAppServerSupervisor timer-host boundaries", () => {
  it("sanitizes a first-acquire clock failure without admitting a home or process", async () => {
    const h = createHarness();
    const supervisor = new CodexAppServerSupervisor({
      executable: "/opt/homebrew/bin/codex",
      clientVersion: "boundary-tests",
      isEnabled: () => true,
      reconcile: async () => undefined,
      processFactory: h.processFactory,
      canonicalizeHome: (home) => home,
      now: () => { throw new Error("private clock detail"); },
    });

    await expect(acquire(supervisor, "/home/clock"))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(internals(supervisor).circuits.size).toBe(0);
    expect(internals(supervisor).entries.size).toBe(0);
    expect(h.processFactory).not.toHaveBeenCalled();
  });

  it("fails closed and wakes a queued acquire when a restart callback fires synchronously", async () => {
    const clock = new ManualClock();
    clock.synchronousDelays.add(250);
    const h = createHarness({ clock, random: () => 0 });
    const owner = Symbol("shared");
    const sharedHandlers = handlers(owner);
    const first = await h.supervisor.acquire({ home: "/home/a", handlers: sharedHandlers });

    h.processes[0]!.crash();
    const queued = h.supervisor.acquire({ home: "/home/a", handlers: sharedHandlers });
    await expect(queued).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(first.call("thread/list", {})).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(h.processes).toHaveLength(1);
    await first.release();
  });

  it("contains clearTimeout throws so release completes and stale callbacks cannot resurrect", async () => {
    const clock = new ManualClock();
    clock.clearThrows = true;
    const h = createHarness({ clock, random: () => 0 });
    const first = await acquire(h.supervisor, "/home/a", Symbol("first"));
    h.processes[0]!.crash();
    await vi.waitFor(() => expect(clock.latest(250)).toBeDefined());
    const stale = clock.latest(250)!;

    await expect(first.release()).resolves.toBeUndefined();
    stale.callback();
    await Promise.resolve();
    expect(h.processes).toHaveLength(1);

    clock.nowMs = 250;
    const recreated = await acquire(h.supervisor, "/home/a", Symbol("recreated"));
    expect(recreated.generation).toBe(2);
    stale.callback();
    await Promise.resolve();
    expect(h.processes).toHaveLength(2);
    await expect(recreated.release()).resolves.toBeUndefined();
  });
});
