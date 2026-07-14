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

class FakeProcess implements CodexSupervisorProcess {
  readonly home: string;
  readonly generation: number;
  readonly terminated: Promise<CodexAppServerTerminal>;
  readonly terminalGate = deferred<CodexAppServerTerminal>();
  startError: Error | null = null;

  constructor(readonly options: CodexSupervisorProcessOptions) {
    this.home = options.home;
    this.generation = options.generation;
    this.terminated = this.terminalGate.promise;
  }

  start(): Promise<CodexAppServerReady> {
    if (this.startError) return Promise.reject(this.startError);
    return Promise.resolve(Object.freeze({
      home: this.home,
      generation: this.generation,
      signal: new AbortController().signal,
    }));
  }

  call<T>(): Promise<T> {
    return Promise.resolve({} as T);
  }

  shutdown(): Promise<CodexAppServerTerminal> {
    const result = terminal(this.home, this.generation);
    this.terminalGate.resolve(result);
    return Promise.resolve(result);
  }

  crash(): void {
    this.terminalGate.resolve(terminal(this.home, this.generation, {
      intentional: false,
      error: Object.assign(new Error("crashed"), { code: "CHILD_EXIT" }) as never,
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
  readonly configureProcess?: (process: FakeProcess, index: number) => void;
  readonly clock?: FakeClock;
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
    isEnabled: () => true,
    reconcile: async () => undefined,
    processFactory,
    canonicalizeHome: (home) => home,
    now: options.clock?.now,
    random: () => 0,
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

const generationContext = (home: string, generation: number) => ({
  home,
  generation,
  signal: new AbortController().signal,
});

describe("CodexAppServerSupervisor adversarial hardening", () => {
  it("persists the initial failure retry deadline and makes reacquire wait for backoff", async () => {
    const clock = new FakeClock();
    const h = createHarness({
      clock,
      configureProcess: (process, index) => {
        if (index === 0) process.startError = new Error("initial startup failed");
      },
    });

    await expect(acquire(h.supervisor, createHandlers(Symbol("first"))))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(h.processes).toHaveLength(1);

    const reacquiring = acquire(h.supervisor, createHandlers(Symbol("second")));
    let settled = false;
    void reacquiring.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(h.processes).toHaveLength(1);
    expect(clock.activeDelays()).toContain(250);

    clock.fire(250);
    const lease = await reacquiring;
    expect(h.processes).toHaveLength(2);
    expect(lease.generation).toBe(2);
    await lease.release();
  });

  it("snapshots handlers so caller mutation cannot replace the bound owner callbacks", async () => {
    const h = createHarness();
    const originalNotification = vi.fn();
    const originalUnknown = vi.fn();
    const originalRequest = vi.fn(async () => ({ source: "original" }));
    const replacementNotification = vi.fn();
    const replacementUnknown = vi.fn();
    const replacementRequest = vi.fn(async () => ({ source: "replacement" }));
    const handlers = {
      owner: Symbol("mutable-owner"),
      onNotification: originalNotification,
      onUnknownNotification: originalUnknown,
      onServerRequest: originalRequest,
    };
    const lease = await acquire(h.supervisor, handlers);
    const processOptions = h.processes[0]!.options;

    handlers.onNotification = replacementNotification;
    handlers.onUnknownNotification = replacementUnknown;
    handlers.onServerRequest = replacementRequest;

    const context = generationContext("/canonical/home", 1);
    await processOptions.onNotification(
      { method: "thread/archived", params: { threadId: "t-1" } },
      context,
    );
    await processOptions.onUnknownNotification(
      { method: "future/event", params: {} },
      context,
    );
    await expect(processOptions.onServerRequest(
      { id: 1, method: "item/commandExecution/requestApproval", params: {} },
      context,
    )).resolves.toEqual({ source: "original" });

    expect(originalNotification).toHaveBeenCalledOnce();
    expect(originalUnknown).toHaveBeenCalledOnce();
    expect(originalRequest).toHaveBeenCalledOnce();
    expect(replacementNotification).not.toHaveBeenCalled();
    expect(replacementUnknown).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
    await lease.release();
  });

  it("rejects generation callbacks while the home is in backoff", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock });
    const handlers = createHandlers();
    const lease = await acquire(h.supervisor, handlers);
    const processOptions = h.processes[0]!.options;
    h.processes[0]!.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(250));

    const context = generationContext("/canonical/home", 1);
    await processOptions.onNotification(
      { method: "thread/archived", params: { threadId: "late" } },
      context,
    );
    await expect(processOptions.onServerRequest(
      { id: 1, method: "item/commandExecution/requestApproval", params: {} },
      context,
    )).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(handlers.onNotification).not.toHaveBeenCalled();
    expect(handlers.onServerRequest).not.toHaveBeenCalled();
    await lease.release();
  });

  it("rejects generation callbacks while the circuit is open", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock });
    const handlers = createHandlers();
    const lease = await acquire(h.supervisor, handlers);

    for (const [index, delay] of [250, 1_000, 2_000, 4_000].entries()) {
      h.processes[index]!.crash();
      await vi.waitFor(() => expect(clock.activeDelays()).toContain(delay));
      clock.fire(delay);
      await vi.waitFor(() => expect(h.processes).toHaveLength(index + 2));
    }
    const processOptions = h.processes[4]!.options;
    h.processes[4]!.crash();
    await vi.waitFor(() => expect(clock.activeDelays()).toContain(60_000));

    const context = generationContext("/canonical/home", 5);
    await processOptions.onNotification(
      { method: "thread/archived", params: { threadId: "late" } },
      context,
    );
    await expect(processOptions.onServerRequest(
      { id: "open", method: "item/commandExecution/requestApproval", params: {} },
      context,
    )).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(handlers.onNotification).not.toHaveBeenCalled();
    expect(handlers.onServerRequest).not.toHaveBeenCalled();
    await lease.release();
  });

  it("evicts the oldest safe idle history instead of retaining unbounded homes", async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock });

    for (let index = 0; index < 257; index += 1) {
      const lease = await acquire(
        h.supervisor,
        createHandlers(Symbol(`owner-${index}`)),
        `/homes/${index}`,
      );
      await lease.release();
    }

    const internals = h.supervisor as unknown as {
      circuits: Map<string, unknown>;
    };
    expect(internals.circuits.size).toBeLessThanOrEqual(256);
    expect(internals.circuits.has("/homes/0")).toBe(false);
    expect(internals.circuits.has("/homes/256")).toBe(true);
  });

  it("rejects a pre-aborted acquire before factory or home admission", async () => {
    const h = createHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(h.supervisor.acquire({
      home: "/cancelled/home",
      handlers: createHandlers(),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    expect(h.processFactory).not.toHaveBeenCalled();
    const internals = h.supervisor as unknown as {
      entries: Map<string, unknown>;
      circuits: Map<string, unknown>;
    };
    expect(internals.entries.size).toBe(0);
    expect(internals.circuits.size).toBe(0);
  });
});
