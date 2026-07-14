import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AppServerProcess,
  AppServerProcessError,
  type AppServerChild,
  type AppServerPeer,
  type AppServerPeerFactory,
  type AppServerSpawn,
} from "../../src/providers/codex/app-server-process.js";
import {
  CodexProtocolFault,
  CodexRpcPeer,
} from "../../src/providers/codex/protocol/index.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakeReadable extends EventEmitter {
  pauseCalls = 0;
  resumeCalls = 0;
  destroyCalls = 0;

  pause(): this {
    this.pauseCalls += 1;
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    return this;
  }

  destroy(): this {
    this.destroyCalls += 1;
    return this;
  }
}

class FakeWritable extends EventEmitter {
  writable = true;
  readonly writes: Buffer[] = [];
  endCalls = 0;
  writeError: Error | null = null;
  writeThrow: Error | null = null;
  writeReturn = true;
  deferWriteCallbacks = false;
  readonly writeCallbacks: Array<(error?: Error | null) => void> = [];

  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    if (this.writeThrow) throw this.writeThrow;
    if (this.writeError) {
      callback?.(this.writeError);
      return false;
    }
    this.writes.push(Buffer.from(chunk));
    if (callback) {
      if (this.deferWriteCallbacks) this.writeCallbacks.push(callback);
      else callback();
    }
    return this.writeReturn;
  }

  end(): void {
    this.endCalls += 1;
    this.writable = false;
  }
}

class FakeChild extends EventEmitter implements AppServerChild {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly signals: NodeJS.Signals[] = [];
  pid: number | undefined = 4242;
  killed = false;
  killError: Error | null = null;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.killError) throw this.killError;
    return true;
  }
}

class FakePeer implements AppServerPeer {
  readonly calls: Array<{ method: string; params: unknown; options: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly received: Array<string | Uint8Array> = [];
  readonly closeReasons: unknown[] = [];
  finishIngressCalls = 0;
  outboundIdleCalls = 0;
  callImpl: (method: string, params: unknown, options: unknown) => Promise<unknown> =
    async (method) => method === "initialize"
      ? {
          codexHome: "/canonical/home",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "codex-test",
        }
      : {};
  receiveImpl: (chunk: string | Uint8Array) => Promise<void> = async () => undefined;
  outboundIdleImpl: () => Promise<void> = async () => undefined;

  call<T>(method: string, params?: unknown, options?: unknown): Promise<T> {
    this.calls.push({ method, params, options });
    return this.callImpl(method, params, options) as Promise<T>;
  }

  notify(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
    return Promise.resolve();
  }

  receive(chunk: string | Uint8Array): Promise<void> {
    this.received.push(chunk);
    return this.receiveImpl(chunk);
  }

  async finishIngress(): Promise<void> {
    this.finishIngressCalls += 1;
  }

  async outboundIdle(): Promise<void> {
    this.outboundIdleCalls += 1;
    await this.outboundIdleImpl();
  }

  close(reason?: unknown): void {
    this.closeReasons.push(reason);
  }
}

class FakeTimers {
  readonly tasks: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];

  set = (callback: () => void, delayMs: number): object => {
    const task = { callback, delayMs, cleared: false };
    this.tasks.push(task);
    return task;
  };

  clear = (handle: unknown): void => {
    const task = handle as (typeof this.tasks)[number] | undefined;
    if (task) task.cleared = true;
  };

  fire(delayMs: number): void {
    const task = this.tasks.find((candidate) =>
      !candidate.cleared && candidate.delayMs === delayMs);
    if (!task) throw new Error(`missing active ${delayMs}ms timer`);
    task.cleared = true;
    task.callback();
  }

  fireAll(): void {
    for (const task of [...this.tasks]) {
      if (!task.cleared) {
        task.cleared = true;
        task.callback();
      }
    }
  }
}

interface HarnessOverrides {
  readonly canonicalizeHome?: (home: string) => string;
  readonly reconcile?: ConstructorParameters<typeof AppServerProcess>[0]["reconcile"];
  readonly peer?: FakePeer;
  readonly child?: FakeChild;
  readonly timers?: FakeTimers;
  readonly spawnFn?: AppServerSpawn;
  readonly peerFactory?: AppServerPeerFactory;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  readonly exitDrainTimeoutMs?: number;
  readonly sigintTimeoutMs?: number;
  readonly sigtermTimeoutMs?: number;
  readonly killConfirmationTimeoutMs?: number;
  readonly stderrMaxBytes?: number;
  readonly onNotification?: ConstructorParameters<typeof AppServerProcess>[0]["onNotification"];
}

const createHarness = (overrides: HarnessOverrides = {}) => {
  const child = overrides.child ?? new FakeChild();
  const peer = overrides.peer ?? new FakePeer();
  const timers = overrides.timers ?? new FakeTimers();
  const spawnCalls: Array<{ executable: string; args: readonly string[]; options: unknown }> = [];
  let peerOptions: Parameters<AppServerPeerFactory>[0] | undefined;
  const spawnFn: AppServerSpawn = overrides.spawnFn ?? ((executable, args, options) => {
    spawnCalls.push({ executable, args, options });
    return child;
  });
  const peerFactory: AppServerPeerFactory = overrides.peerFactory ?? ((options) => {
    peerOptions = options;
    return peer;
  });
  const process = new AppServerProcess({
    executable: "/opt/homebrew/bin/codex",
    home: "/canonical/home",
    generation: 7,
    appVersion: "1.2.3",
    baseEnv: overrides.baseEnv ?? { KEEP: "yes", CODEX_HOME: "/wrong" },
    canonicalizeHome: overrides.canonicalizeHome ?? ((home) => home),
    reconcile: overrides.reconcile ?? (async () => undefined),
    spawnFn,
    peerFactory,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    startupTimeoutMs: overrides.startupTimeoutMs ?? 10_000,
    exitDrainTimeoutMs: overrides.exitDrainTimeoutMs ?? 500,
    sigintTimeoutMs: overrides.sigintTimeoutMs ?? 2_000,
    sigtermTimeoutMs: overrides.sigtermTimeoutMs ?? 1_000,
    killConfirmationTimeoutMs: overrides.killConfirmationTimeoutMs ?? 250,
    stderrMaxBytes: overrides.stderrMaxBytes,
    onNotification: overrides.onNotification,
  });
  return {
    child,
    peer,
    timers,
    process,
    spawnCalls,
    get peerOptions() {
      return peerOptions;
    },
  };
};

const startReady = async (harness: ReturnType<typeof createHarness>): Promise<void> => {
  const starting = harness.process.start();
  harness.child.emit("spawn");
  await starting;
};

const fireTimer = async (timers: FakeTimers, delayMs: number): Promise<void> => {
  timers.fire(delayMs);
  await Promise.resolve();
  await Promise.resolve();
};

describe("AppServerProcess validation and exact startup", () => {
  it.each([
    { patch: { executable: "codex" }, message: /executable.*absolute/i },
    { patch: { home: "relative/home" }, message: /home.*absolute/i },
    { patch: { generation: 0 }, message: /generation/i },
    { patch: { generation: 1.5 }, message: /generation/i },
    { patch: { appVersion: " " }, message: /version/i },
    { patch: { startupTimeoutMs: 0 }, message: /startupTimeoutMs/i },
    { patch: { exitDrainTimeoutMs: -1 }, message: /exitDrainTimeoutMs/i },
    { patch: { sigintTimeoutMs: 0 }, message: /sigintTimeoutMs/i },
    { patch: { sigtermTimeoutMs: 0 }, message: /sigtermTimeoutMs/i },
  ])("rejects invalid immutable construction input: $patch", ({ patch, message }) => {
    expect(() => new AppServerProcess({
      executable: "/opt/homebrew/bin/codex",
      home: "/canonical/home",
      generation: 1,
      appVersion: "1.0.0",
      reconcile: async () => undefined,
      canonicalizeHome: (home) => home,
      ...patch,
    })).toThrow(message);
  });

  it("rejects a home which is absolute but not already canonical", () => {
    expect(() => new AppServerProcess({
      executable: "/opt/homebrew/bin/codex",
      home: "/canonical/../home",
      generation: 1,
      appVersion: "1.0.0",
      reconcile: async () => undefined,
      canonicalizeHome: () => "/home",
    })).toThrow(/canonical/i);
  });

  it("spawns exact argv/env and attaches every listener before handshake", async () => {
    const baseEnv = { KEEP: "original", CODEX_HOME: "/wrong" };
    const h = createHarness({ baseEnv });
    const starting = h.process.start();

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]).toEqual({
      executable: "/opt/homebrew/bin/codex",
      args: ["app-server", "--stdio"],
      options: {
        shell: false,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { KEEP: "original", CODEX_HOME: "/canonical/home" },
      },
    });
    for (const [emitter, events] of [
      [h.child, ["spawn", "error", "exit", "close"]],
      [h.child.stdin, ["error"]],
      [h.child.stdout, ["data", "error", "end"]],
      [h.child.stderr, ["data", "error"]],
    ] as const) {
      for (const event of events) expect(emitter.listenerCount(event), event).toBeGreaterThan(0);
    }
    expect(h.peer.calls).toHaveLength(0);
    baseEnv.KEEP = "mutated";

    h.child.emit("spawn");
    const ready = await starting;
    expect(h.process.phase).toBe("ready");
    expect(h.process.generation).toBe(7);
    expect(ready).toMatchObject({ home: "/canonical/home", generation: 7 });
    expect(ready.signal.aborted).toBe(false);
    expect(Object.isFrozen(ready)).toBe(true);
    expect(h.peer.calls[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "devhub", title: "DevHub", version: "1.2.3" },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      },
    });
    expect(h.peer.notifications).toEqual([{ method: "initialized", params: undefined }]);
    expect(h.peer.outboundIdleCalls).toBe(1);
    expect(baseEnv).toEqual({ KEEP: "mutated", CODEX_HOME: "/wrong" });
  });

  it("wires ingress pause/resume and stable protocol handlers into the peer", async () => {
    const onNotification = vi.fn();
    const onUnknownNotification = vi.fn();
    const onServerRequest = vi.fn();
    const child = new FakeChild();
    const peer = new FakePeer();
    let options: Parameters<AppServerPeerFactory>[0] | undefined;
    const process = new AppServerProcess({
      executable: "/opt/homebrew/bin/codex",
      home: "/canonical/home",
      generation: 1,
      appVersion: "1",
      reconcile: async () => undefined,
      canonicalizeHome: (home) => home,
      spawnFn: () => child,
      peerFactory: (value) => {
        options = value;
        return peer;
      },
      onNotification,
      onUnknownNotification,
      onServerRequest,
    });
    const starting = process.start();
    child.emit("spawn");
    await starting;

    options?.pauseIngress?.();
    options?.resumeIngress?.();
    expect(child.stdout.pauseCalls).toBe(1);
    expect(child.stdout.resumeCalls).toBe(1);
    await options?.onNotification?.({ method: "thread/archived", params: { threadId: "t" } }, {
      signal: new AbortController().signal,
    });
    await options?.onUnknownNotification?.({ method: "future" }, {
      signal: new AbortController().signal,
    });
    await options?.onServerRequest?.({ id: 1, method: "future" }, {
      signal: new AbortController().signal,
    });
    expect(onNotification.mock.calls[0]?.[1]).toMatchObject({
      home: "/canonical/home",
      generation: 1,
    });
    expect(onUnknownNotification.mock.calls[0]?.[1]).toMatchObject({
      home: "/canonical/home",
      generation: 1,
    });
    expect(onServerRequest.mock.calls[0]?.[1]).toMatchObject({
      home: "/canonical/home",
      generation: 1,
    });
  });

  it("uses callback completion for stdin backpressure and propagates write failures", async () => {
    const h = createHarness();
    const starting = h.process.start();
    h.child.stdin.writeReturn = false;
    h.child.stdin.deferWriteCallbacks = true;
    const write = h.peerOptions?.write;
    expect(write).toBeTypeOf("function");
    const pending = write!(Buffer.from("frame"));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.child.stdin.writeCallbacks.shift()?.();
    await expect(pending).resolves.toBeUndefined();

    h.child.stdin.deferWriteCallbacks = false;
    h.child.stdin.writeError = new Error("callback failure");
    await expect(write!(Buffer.from("bad"))).rejects.toThrow("callback failure");
    h.child.stdin.writeError = null;
    h.child.stdin.writeThrow = new Error("sync failure");
    await expect(write!(Buffer.from("bad"))).rejects.toThrow("sync failure");

    h.child.emit("spawn");
    await starting;
  });

  it("does not publish ready until the parameterless initialized write is flushed", async () => {
    const flush = deferred();
    const peer = new FakePeer();
    peer.outboundIdleImpl = () => flush.promise;
    const h = createHarness({ peer });
    const starting = h.process.start();
    h.child.emit("spawn");
    await vi.waitFor(() => expect(peer.calls).toHaveLength(1));
    await Promise.resolve();
    expect(h.process.phase).not.toBe("ready");
    flush.resolve();
    await starting;
    expect(h.process.phase).toBe("ready");
  });
});

describe("AppServerProcess handshake and reconciliation", () => {
  it.each([
    { result: null, code: "HANDSHAKE_FAILED" },
    { result: {}, code: "HANDSHAKE_FAILED" },
    {
      result: { codexHome: "relative", platformFamily: "unix", platformOs: "macos", userAgent: "x" },
      code: "HOME_MISMATCH",
    },
    {
      result: { codexHome: "/canonical/home", platformFamily: "", platformOs: "macos", userAgent: "x" },
      code: "HANDSHAKE_FAILED",
    },
    {
      result: { codexHome: "/canonical/home", platformFamily: "unix", platformOs: "", userAgent: "x" },
      code: "HANDSHAKE_FAILED",
    },
    {
      result: { codexHome: "/canonical/home", platformFamily: "unix", platformOs: "macos", userAgent: "" },
      code: "HANDSHAKE_FAILED",
    },
  ])("rejects malformed initialize response %#", async ({ result, code }) => {
    const peer = new FakePeer();
    peer.callImpl = async () => result;
    const h = createHarness({ peer });
    const starting = h.process.start();
    h.child.emit("spawn");
    await expect(starting).rejects.toMatchObject({ code });
    expect(h.process.phase).toBe("terminal");
  });

  it("fails closed on canonical home mismatch and never reconciles", async () => {
    const peer = new FakePeer();
    peer.callImpl = async (method) => method === "initialize"
      ? { codexHome: "/other", platformFamily: "unix", platformOs: "macos", userAgent: "x" }
      : {};
    const reconcile = vi.fn(async () => undefined);
    const h = createHarness({ peer, reconcile });
    const starting = h.process.start();
    h.child.emit("spawn");

    await expect(starting).rejects.toMatchObject({ code: "HOME_MISMATCH" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(h.process.phase).toBe("terminal");
    expect(h.peer.closeReasons).toHaveLength(1);
  });

  it("provides reconciliation only a generation-bound three-method facade", async () => {
    const peer = new FakePeer();
    const observed: string[] = [];
    let retainedRpc: Parameters<NonNullable<HarnessOverrides["reconcile"]>>[0]["rpc"] | undefined;
    const h = createHarness({
      peer,
      reconcile: async ({ rpc, generation, home, signal }) => {
        retainedRpc = rpc;
        expect(generation).toBe(7);
        expect(home).toBe("/canonical/home");
        expect(signal.aborted).toBe(false);
        await rpc.call("thread/list", {});
        await rpc.call("thread/read", { threadId: "t" });
        await rpc.call("thread/resume", { threadId: "t" });
        await expect(rpc.call("turn/start" as never, {})).rejects.toMatchObject({
          code: "RECONCILE_METHOD_DENIED",
        });
        observed.push("done");
      },
    });
    await startReady(h);

    expect(observed).toEqual(["done"]);
    expect(peer.calls.map(({ method }) => method)).toEqual([
      "initialize",
      "thread/list",
      "thread/read",
      "thread/resume",
    ]);
    await expect(retainedRpc?.call("thread/list", {})).rejects.toMatchObject({
      code: "RECONCILE_CLOSED",
    });
    expect(peer.calls.filter(({ method }) => method === "thread/list")).toHaveLength(1);
  });

  it("fences public work until ready and never retries a failed public call", async () => {
    const gate = deferred();
    const peer = new FakePeer();
    const h = createHarness({ peer, reconcile: () => gate.promise });
    const starting = h.process.start();
    await expect(h.process.call("thread/list", {})).rejects.toMatchObject({ code: "NOT_READY" });
    h.child.emit("spawn");
    await Promise.resolve();
    await expect(h.process.notify("initialized")).rejects.toMatchObject({ code: "NOT_READY" });
    gate.resolve();
    await starting;

    peer.callImpl = async () => {
      throw new Error("one failure");
    };
    await expect(h.process.call("turn/start", { input: [], threadId: "t" }))
      .rejects.toThrow("one failure");
    expect(peer.calls.filter(({ method }) => method === "turn/start")).toHaveLength(1);
  });

  it("rejects an in-flight public call immediately when the generation becomes terminal", async () => {
    const blocked = deferred<unknown>();
    const peer = new FakePeer();
    const h = createHarness({ peer });
    await startReady(h);
    peer.callImpl = () => blocked.promise;
    let rejection: unknown;
    const call = h.process.call("thread/list", {}).catch((error: unknown) => {
      rejection = error;
      throw error;
    });
    void call.catch(() => undefined);
    h.child.emit("error", new Error("terminal"));
    await vi.waitFor(() => expect(rejection).toMatchObject({ code: "CHILD_ERROR" }));
    blocked.resolve({ data: [] });
    await expect(call).rejects.toMatchObject({ code: "CHILD_ERROR" });
    expect(peer.calls.filter(({ method }) => method === "thread/list")).toHaveLength(1);
  });

  it("passes an explicit caller abort through to the transport request signal", async () => {
    const blocked = deferred<unknown>();
    const peer = new FakePeer();
    const h = createHarness({ peer });
    await startReady(h);
    peer.callImpl = () => blocked.promise;
    const caller = new AbortController();
    const call = h.process.call("thread/list", {}, { signal: caller.signal });
    const transportSignal = (peer.calls.at(-1)?.options as { signal?: AbortSignal } | undefined)
      ?.signal;

    expect(transportSignal?.aborted).toBe(false);
    caller.abort(new Error("caller cancelled"));
    expect(transportSignal?.aborted).toBe(true);
    blocked.resolve({ data: [] });
    await expect(call).resolves.toEqual({ data: [] });
  });

  it("times out a blocked startup and ignores its late handshake result", async () => {
    const init = deferred<unknown>();
    const peer = new FakePeer();
    peer.callImpl = () => init.promise;
    const h = createHarness({ peer, startupTimeoutMs: 111 });
    const starting = h.process.start();
    h.child.emit("spawn");
    await vi.waitFor(() => expect(peer.calls).toHaveLength(1));
    const signal = (peer.calls[0]?.options as { signal?: AbortSignal } | undefined)?.signal;
    h.timers.fire(111);

    await expect(starting).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
    init.resolve({ codexHome: "/canonical/home" });
    await Promise.resolve();
    expect(h.process.phase).toBe("terminal");
  });

  it("owns cleanup when a post-spawn startup timeout becomes terminal", async () => {
    const init = deferred<unknown>();
    const peer = new FakePeer();
    peer.callImpl = () => init.promise;
    const h = createHarness({ peer, startupTimeoutMs: 112 });
    const starting = h.process.start();
    h.child.emit("spawn");
    await vi.waitFor(() => expect(peer.calls).toHaveLength(1));

    h.timers.fire(112);
    await expect(starting).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });
    await vi.waitFor(() => {
      expect(h.child.stdin.endCalls).toBe(1);
      expect(h.child.signals).toEqual(["SIGINT"]);
    });
    await fireTimer(h.timers, 2_000);
    await fireTimer(h.timers, 1_000);
    await fireTimer(h.timers, 250);

    await expect(h.process.terminated).resolves.toMatchObject({
      error: { code: "STARTUP_TIMEOUT" },
      intentional: false,
      exitSeen: false,
      safeToRestart: false,
    });
  });

  it("times out before spawn and immediately cleans up a late spawn", async () => {
    const h = createHarness({ startupTimeoutMs: 333 });
    const starting = h.process.start();
    h.timers.fire(333);
    await expect(starting).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });

    h.child.emit("spawn");
    expect(h.child.stdin.endCalls).toBe(1);
    expect(h.child.signals).toEqual(["SIGINT"]);
    await fireTimer(h.timers, 2_000);
    await fireTimer(h.timers, 1_000);
    await fireTimer(h.timers, 250);
    await expect(h.process.terminated).resolves.toMatchObject({
      exitSeen: false,
      safeToRestart: false,
    });
    expect(h.process.phase).toBe("stopped");
  });

  it("times out blocked reconciliation and late resolution cannot publish ready", async () => {
    const gate = deferred();
    const entered = deferred();
    let reconcileSignal: AbortSignal | undefined;
    const h = createHarness({
      startupTimeoutMs: 222,
      reconcile: ({ signal }) => {
        reconcileSignal = signal;
        entered.resolve();
        return gate.promise;
      },
    });
    const starting = h.process.start();
    h.child.emit("spawn");
    await entered.promise;
    h.timers.fire(222);

    await expect(starting).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });
    gate.resolve();
    await Promise.resolve();
    expect(h.process.phase).toBe("terminal");
    expect(reconcileSignal?.aborted).toBe(true);
  });

  it.each(["initialize", "reconcile"] as const)(
    "shutdown during %s aborts its signal and late completion cannot publish ready",
    async (barrier) => {
      const init = deferred<unknown>();
      const reconcileGate = deferred();
      let observedSignal: AbortSignal | undefined;
      const peer = new FakePeer();
      if (barrier === "initialize") peer.callImpl = () => init.promise;
      const h = createHarness({
        peer,
        reconcile: ({ signal }) => {
          observedSignal = signal;
          return reconcileGate.promise;
        },
      });
      const starting = h.process.start();
      h.child.emit("spawn");
      if (barrier === "reconcile") {
        await vi.waitFor(() => expect(observedSignal).toBeDefined());
      } else {
        await vi.waitFor(() => expect(peer.calls).toHaveLength(1));
      }
      const initializeSignal = (peer.calls[0]?.options as { signal?: AbortSignal } | undefined)
        ?.signal;
      const shuttingDown = h.process.shutdown();
      await expect(starting).rejects.toMatchObject({ code: "SHUTDOWN" });
      if (barrier === "initialize") {
        expect(initializeSignal?.aborted).toBe(true);
        init.resolve({
          codexHome: "/canonical/home",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "x",
        });
      } else {
        expect(observedSignal?.aborted).toBe(true);
        reconcileGate.resolve();
      }
      h.child.emit("exit", 0, null);
      h.child.stdout.emit("end");
      h.child.emit("close", 0, null);
      await shuttingDown;
      expect(h.process.phase).toBe("stopped");
    },
  );
});

describe("AppServerProcess first-cause lifecycle and stdout semantics", () => {
  it.each([
    {
      name: "child error",
      emit: (child: FakeChild) => child.emit("error", new Error("private")),
      code: "CHILD_ERROR",
    },
    {
      name: "exit",
      emit: (child: FakeChild) => child.emit("exit", 9, null),
      code: "CHILD_EXIT",
    },
    {
      name: "close",
      emit: (child: FakeChild) => child.emit("close", 9, null),
      code: "CHILD_CLOSE",
    },
  ])("settles startup on pre-spawn $name", async ({ emit, code }) => {
    const h = createHarness();
    const starting = h.process.start();
    emit(h.child);

    await expect(starting).rejects.toMatchObject({ code });
    expect(h.process.phase).toBe("terminal");
    h.child.emit("spawn");
    h.child.emit("error", new Error("later"));
    expect(h.process.terminalError).toMatchObject({ code });
  });

  it("treats stdout EOF before exit as terminal and finalizes ingress once", async () => {
    const h = createHarness();
    await startReady(h);
    h.child.stdout.emit("end");
    await Promise.resolve();
    await Promise.resolve();

    expect(h.process.terminalError).toMatchObject({ code: "STDOUT_EOF" });
    expect(h.peer.finishIngressCalls).toBe(1);
    expect(h.process.exitObserved).toBe(false);
    expect(h.process.safeToRestart).toBe(false);
  });

  it("preserves child error as first cause across error, exit, and close", async () => {
    const h = createHarness();
    await startReady(h);
    h.child.emit("error", new Error("private child detail"));
    h.child.emit("exit", 1, null);
    h.child.emit("close", 1, null);
    await Promise.resolve();

    expect(h.process.terminalError).toMatchObject({ code: "CHILD_ERROR" });
    expect(h.process.terminalError?.message).not.toContain("private child detail");
    expect(h.process.exitObserved).toBe(true);
    expect(h.process.safeToRestart).toBe(true);
    const terminal = await h.process.terminated;
    expect(terminal.error).toBe(h.process.terminalError);
    expect(Object.isFrozen(terminal)).toBe(true);
    expect(terminal).toMatchObject({
      intentional: false,
      home: "/canonical/home",
      generation: 7,
      exitSeen: true,
      safeToRestart: true,
    });
  });

  it("continues ordered stdout delivery after exit until close and never signals again", async () => {
    const h = createHarness();
    await startReady(h);
    h.child.emit("exit", 7, null);
    h.child.stdout.emit("data", Buffer.from("final-a"));
    h.child.stdout.emit("data", Buffer.from("final-b"));
    const shuttingDown = h.process.shutdown();
    h.child.stdout.emit("end");
    h.child.emit("close", 7, null);
    await shuttingDown;

    expect(h.peer.received.map(String)).toEqual(["final-a", "final-b"]);
    expect(h.peer.finishIngressCalls).toBe(1);
    expect(h.child.signals).toEqual([]);
    expect(h.process.terminalError).toMatchObject({ code: "CHILD_EXIT" });
  });

  it("keeps the real RPC peer alive long enough to drain final frames after exit", async () => {
    const onNotification = vi.fn();
    const h = createHarness({
      peerFactory: (options) => new CodexRpcPeer(options),
      onNotification,
    });
    const starting = h.process.start();
    h.child.emit("spawn");
    await vi.waitFor(() => expect(h.child.stdin.writes).toHaveLength(1));
    const initialize = JSON.parse(h.child.stdin.writes[0]!.toString("utf8")) as { id: number };
    h.child.stdout.emit("data", `${JSON.stringify({
      id: initialize.id,
      result: {
        codexHome: "/canonical/home",
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "codex-test",
      },
    })}\n`);
    const ready = await starting;
    await vi.waitFor(() => expect(h.child.stdin.writes).toHaveLength(2));

    const pending = h.process.call("thread/list", {});
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(h.child.stdin.writes).toHaveLength(3));
    const request = JSON.parse(h.child.stdin.writes[2]!.toString("utf8")) as { id: number };
    h.child.emit("exit", 7, null);
    expect(ready.signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "CHILD_EXIT" });

    h.child.stdout.emit("data",
      `${JSON.stringify({ id: request.id, result: { data: [] } })}\n` +
      `${JSON.stringify({
        method: "thread/archived",
        params: { threadId: "thread-1" },
      })}\n`);
    h.child.stdout.emit("end");
    h.child.emit("close", 7, null);
    await h.process.terminated;

    expect(onNotification).toHaveBeenCalledOnce();
    expect(h.process.terminalError).toMatchObject({ code: "CHILD_EXIT" });
    expect(h.child.signals).toEqual([]);
  });

  it("bounds exit-without-close drain, preserving final data before destroying streams", async () => {
    const h = createHarness({ exitDrainTimeoutMs: 444 });
    await startReady(h);
    h.child.emit("exit", 3, null);
    h.child.stdout.emit("data", Buffer.from("last-frame"));
    await Promise.resolve();
    h.timers.fire(444);
    const terminal = await h.process.terminated;

    expect(h.peer.received.map(String)).toEqual(["last-frame"]);
    expect(h.peer.finishIngressCalls).toBe(1);
    expect(h.child.stdout.destroyCalls).toBe(1);
    expect(h.child.stderr.destroyCalls).toBe(1);
    expect(h.child.signals).toEqual([]);
    expect(terminal).toMatchObject({ exitSeen: true, safeToRestart: true });
  });

  it("serializes stdout receives and faults once on a receive failure", async () => {
    const first = deferred();
    const peer = new FakePeer();
    let receives = 0;
    peer.receiveImpl = async () => {
      receives += 1;
      if (receives === 1) await first.promise;
      else throw new Error("decoder secret");
    };
    const h = createHarness({ peer });
    await startReady(h);
    h.child.stdout.emit("data", Buffer.from("one"));
    h.child.stdout.emit("data", Buffer.from("two"));
    await Promise.resolve();
    expect(peer.received).toHaveLength(1);
    first.resolve();
    await vi.waitFor(() => expect(peer.received).toHaveLength(2));
    expect(h.process.terminalError).toMatchObject({ code: "PROTOCOL_FAULT" });
  });

  it("queues EOF behind every in-flight receive and finalizes ingress exactly once", async () => {
    const first = deferred();
    const peer = new FakePeer();
    let index = 0;
    peer.receiveImpl = async () => {
      index += 1;
      if (index === 1) await first.promise;
    };
    const h = createHarness({ peer });
    await startReady(h);
    h.child.stdout.emit("data", Buffer.from("one"));
    h.child.stdout.emit("data", Buffer.from("two"));
    h.child.stdout.emit("end");
    await vi.waitFor(() => expect(peer.received).toHaveLength(1));
    expect(peer.finishIngressCalls).toBe(0);
    first.resolve();
    await vi.waitFor(() => expect(peer.finishIngressCalls).toBe(1));
    expect(peer.received.map(String)).toEqual(["one", "two"]);
    h.child.emit("exit", 0, null);
    h.child.emit("close", 0, null);
    await h.process.terminated;
    expect(peer.finishIngressCalls).toBe(1);
  });

  it("turns stdin, stdout, and peer faults into sanitized terminal causes", async () => {
    for (const [emitFault, code] of [
      [(h: ReturnType<typeof createHarness>) => h.child.stdin.emit("error", new Error("secret")), "STDIN_ERROR"],
      [(h: ReturnType<typeof createHarness>) => h.child.stdout.emit("error", new Error("secret")), "STDOUT_ERROR"],
      [(h: ReturnType<typeof createHarness>) => h.peerOptions?.onProtocolFault?.(
        new CodexProtocolFault("INVALID_ENVELOPE", "secret"),
      ), "PEER_FAULT"],
    ] as const) {
      const h = createHarness();
      await startReady(h);
      emitFault(h);
      expect(h.process.terminalError).toMatchObject({ code });
      expect(h.process.terminalError?.message).not.toContain("secret");
    }
  });

  it("treats stderr stream failure as a sanitized terminal cause", async () => {
    const h = createHarness();
    await startReady(h);
    h.child.stderr.emit("error", new Error("stderr secret"));
    expect(h.process.terminalError).toMatchObject({ code: "STDERR_ERROR" });
    expect(h.process.terminalError?.message).not.toContain("stderr secret");
  });

  it("aborts the immutable ready signal on fault and rejects later public work", async () => {
    const h = createHarness();
    const starting = h.process.start();
    h.child.emit("spawn");
    const ready = await starting;
    expect(ready.signal.aborted).toBe(false);
    await expect(h.process.start()).rejects.toMatchObject({ code: "ALREADY_STARTED" });
    expect(h.spawnCalls).toHaveLength(1);
    h.child.emit("error", new Error("stop"));
    expect(ready.signal.aborted).toBe(true);
    await expect(h.process.call("thread/list", {})).rejects.toMatchObject({ code: "TERMINAL" });
    await expect(h.process.notify("initialized")).rejects.toMatchObject({ code: "TERMINAL" });
  });

  it("reports synchronous spawn throw without leaking its cause", async () => {
    const process = new AppServerProcess({
      executable: "/opt/homebrew/bin/codex",
      home: "/canonical/home",
      generation: 1,
      appVersion: "1",
      reconcile: async () => undefined,
      canonicalizeHome: (home) => home,
      spawnFn: () => {
        throw new Error("spawn secret");
      },
    });
    await expect(process.start()).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(process.terminalError?.message).not.toContain("spawn secret");
    await expect(process.terminated).resolves.toMatchObject({
      error: { code: "SPAWN_FAILED" },
      exitSeen: false,
      safeToRestart: true,
    });
    expect(process.safeToRestart).toBe(true);
  });

  it("tears down a live child when peer construction throws synchronously", async () => {
    const h = createHarness({
      peerFactory: () => {
        throw new Error("peer factory secret");
      },
    });
    const starting = h.process.start();
    h.child.emit("spawn");

    await expect(starting).rejects.toMatchObject({ code: "HANDSHAKE_FAILED" });
    await vi.waitFor(() => {
      expect(h.child.stdin.endCalls).toBe(1);
      expect(h.child.signals).toEqual(["SIGINT"]);
    });
    await fireTimer(h.timers, 2_000);
    await fireTimer(h.timers, 1_000);
    await fireTimer(h.timers, 250);
    await expect(h.process.terminated).resolves.toMatchObject({
      error: { code: "HANDSHAKE_FAILED" },
      safeToRestart: false,
    });
  });
});

describe("AppServerProcess shutdown and diagnostics", () => {
  it("treats shutdown from idle as a confirmed no-child terminal", async () => {
    const h = createHarness();
    const terminal = await h.process.shutdown();

    expect(h.spawnCalls).toHaveLength(0);
    expect(terminal).toMatchObject({
      intentional: true,
      exitSeen: false,
      safeToRestart: true,
    });
    expect(h.process.safeToRestart).toBe(true);
    expect(h.process.phase).toBe("stopped");
    await expect(h.process.start()).rejects.toMatchObject({ code: "ALREADY_STARTED" });
  });

  it("still terminates a child that spawns after pre-spawn shutdown already settled", async () => {
    const h = createHarness();
    const starting = h.process.start();
    const shuttingDown = h.process.shutdown();
    await expect(starting).rejects.toMatchObject({ code: "SHUTDOWN" });

    let settled = false;
    void shuttingDown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await fireTimer(h.timers, 250);
    await expect(shuttingDown).resolves.toMatchObject({
      exitSeen: false,
      safeToRestart: false,
    });

    h.child.emit("spawn");
    await vi.waitFor(() => expect(h.child.signals).toEqual(["SIGINT"]));
    await fireTimer(h.timers, 2_000);
    await fireTimer(h.timers, 1_000);
    await fireTimer(h.timers, 250);
    expect(h.child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(h.child.stdin.endCalls).toBe(1);
  });

  it("automatically tears down and settles after a runtime stream fault", async () => {
    const h = createHarness();
    await startReady(h);
    h.child.stderr.emit("error", new Error("private stream detail"));

    await vi.waitFor(() => {
      expect(h.child.stdin.endCalls).toBe(1);
      expect(h.child.signals).toEqual(["SIGINT"]);
    });
    await fireTimer(h.timers, 2_000);
    await fireTimer(h.timers, 1_000);
    await fireTimer(h.timers, 250);
    await expect(h.process.terminated).resolves.toMatchObject({
      error: { code: "STDERR_ERROR" },
      intentional: false,
      safeToRestart: false,
    });
  });

  it("escalates SIGINT to TERM to KILL, ignores child.killed, and reports unconfirmed exit", async () => {
    const h = createHarness();
    await startReady(h);
    h.child.killed = true;
    const first = h.process.shutdown();
    const second = h.process.shutdown();
    expect(second).toBe(first);
    expect(h.child.stdin.endCalls).toBe(1);
    expect(h.child.signals).toEqual(["SIGINT"]);
    await fireTimer(h.timers, 2_000);
    expect(h.child.signals).toEqual(["SIGINT", "SIGTERM"]);
    await fireTimer(h.timers, 1_000);
    expect(h.child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    await fireTimer(h.timers, 250);

    await expect(first).resolves.toMatchObject({
      intentional: true,
      exitSeen: false,
      safeToRestart: false,
      home: "/canonical/home",
      generation: 7,
    });
    await expect(h.process.terminated).resolves.toMatchObject({
      intentional: true,
      exitSeen: false,
      safeToRestart: false,
    });
    expect(h.process.phase).toBe("stopped");
  });

  it("exit immediately cancels every signal timer even while stdio remains open", async () => {
    const h = createHarness();
    await startReady(h);
    const shuttingDown = h.process.shutdown();
    expect(h.child.signals).toEqual(["SIGINT"]);
    h.child.emit("exit", 0, null);
    h.timers.fireAll();
    h.child.stdout.emit("end");
    h.child.emit("close", 0, null);

    await expect(shuttingDown).resolves.toMatchObject({
      intentional: true,
      exitSeen: true,
      safeToRestart: true,
    });
    expect(h.child.signals).toEqual(["SIGINT"]);
  });

  it("close without exit never claims restart safety", async () => {
    const h = createHarness();
    await startReady(h);
    h.child.emit("close", 0, null);
    const shuttingDown = h.process.shutdown();
    expect(h.child.signals).toEqual(["SIGINT"]);
    await fireTimer(h.timers, 2_000);
    await fireTimer(h.timers, 1_000);
    await fireTimer(h.timers, 250);
    const result = await shuttingDown;
    expect(h.child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({
      intentional: false,
      exitSeen: false,
      safeToRestart: false,
    });
  });

  it("swallows signal exceptions and keeps diagnostics sanitized and bounded", async () => {
    const h = createHarness({ stderrMaxBytes: 64 });
    await startReady(h);
    h.child.stderr.emit("data", Buffer.from("Authorization: Bearer secret-value\n"));
    h.child.stderr.emit("data", Buffer.from("x".repeat(200)));
    h.child.killError = new Error("kill secret");
    const shuttingDown = h.process.shutdown();
    await fireTimer(h.timers, 2_000);
    await fireTimer(h.timers, 1_000);
    await fireTimer(h.timers, 250);
    await shuttingDown;

    expect(Buffer.byteLength(h.process.stderrDiagnostics)).toBeLessThanOrEqual(64);
    expect(h.process.stderrDiagnostics).not.toContain("secret-value");
    expect(h.process.terminalError?.message).not.toContain("kill secret");
  });
});
