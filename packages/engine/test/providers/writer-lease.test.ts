import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import {
  NATIVE_TASK_WRITER_DEFAULT_MAX_ACTIVE,
  NATIVE_TASK_WRITER_EXPIRY_MS,
  NATIVE_TASK_WRITER_HEARTBEAT_MS,
  NativeTaskWriterLeaseError,
  NativeTaskWriterLeaseStore,
  type NativeTaskWriterLeaseStoreOptions,
} from "../../src/providers/writer-lease.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SESSION_A = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const SESSION_B = "129f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const CHILD_TIMEOUT_MS = 10_000;
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "../../../..");
const WRITER_LEASE_MODULE_URL = pathToFileURL(
  path.resolve(TEST_DIRECTORY, "../../src/providers/writer-lease.ts"),
).href;
const CHILD_PAYLOAD_ENV = "DEVHUB_WRITER_LEASE_CHILD_PAYLOAD";

interface LeaseChildPayload {
  readonly dbPath: string;
  readonly key: ReturnType<typeof createNativeTaskKey>;
  readonly now: number;
  readonly ownerToken: string;
}

type LeaseChildMessage =
  | { readonly kind: "ready" }
  | {
    readonly kind: "result";
    readonly acquired: boolean;
    readonly rereadRequired: boolean;
    readonly usableBeforeReread: boolean;
    readonly confirmed: boolean;
    readonly epoch: number | null;
  }
  | { readonly kind: "error"; readonly code: string };

interface LeaseChild {
  readonly process: ChildProcess;
  readonly stderr: () => string;
}

const LEASE_CHILD_SOURCE = `
import { NativeTaskWriterLeaseStore } from ${JSON.stringify(WRITER_LEASE_MODULE_URL)};

const finish = (message, exitCode = 0) => {
  if (typeof process.send !== "function") process.exit(70);
  process.send(message, () => process.exit(exitCode));
};
const errorCode = (error) =>
  error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "CHILD_FAILURE";

try {
  const payload = JSON.parse(process.env.${CHILD_PAYLOAD_ENV} ?? "null");
  const store = new NativeTaskWriterLeaseStore({
    dbPath: payload.dbPath,
    now: () => payload.now,
    ownerTokenFactory: () => payload.ownerToken,
    setTimeoutFn: () => Object.freeze({ kind: "manual-heartbeat" }),
    clearTimeoutFn: () => undefined,
  });
  process.once("message", (message) => {
    if (message !== "acquire") return finish({ kind: "error", code: "BAD_COMMAND" }, 71);
    try {
      const lease = store.acquire(payload.key);
      const result = {
        kind: "result",
        acquired: lease !== null,
        rereadRequired: lease?.rereadRequired ?? false,
        usableBeforeReread: lease?.usable ?? false,
        epoch: lease?.fence.epoch ?? null,
        confirmed: lease?.confirmReread() ?? false,
      };
      finish(result);
    } catch (error) {
      finish({ kind: "error", code: errorCode(error) }, 72);
    }
  });
  if (typeof process.send !== "function") process.exit(70);
  process.send({ kind: "ready" });
} catch (error) {
  finish({ kind: "error", code: errorCode(error) }, 73);
}
`;

interface TimerTask {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
  fired: boolean;
}

class ManualTimers {
  readonly tasks: TimerTask[] = [];

  set = (callback: () => void, delayMs: number): TimerTask => {
    const task = { callback, delayMs, cleared: false, fired: false };
    this.tasks.push(task);
    return task;
  };

  clear = (handle: unknown): void => {
    const task = handle as TimerTask;
    task.cleared = true;
  };

  get activeCount(): number {
    return this.tasks.filter((task) => !task.cleared && !task.fired).length;
  }

  fireNext(): void {
    const task = this.tasks.find((candidate) => !candidate.cleared && !candidate.fired);
    if (!task) throw new Error("missing active lease timer");
    task.fired = true;
    task.callback();
  }
}

const roots: string[] = [];
const stores: NativeTaskWriterLeaseStore[] = [];
const childProcesses = new Set<ChildProcess>();

const terminateChild = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, CHILD_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGKILL");
  });
};

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) store.close();
  await Promise.all([...childProcesses].map(terminateChild));
  childProcesses.clear();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

const spawnLeaseChild = (payload: LeaseChildPayload): LeaseChild => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", LEASE_CHILD_SOURCE],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, [CHILD_PAYLOAD_ENV]: JSON.stringify(payload) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  childProcesses.add(child);
  child.once("exit", () => childProcesses.delete(child));
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  return { process: child, stderr: () => stderr };
};

const waitForChildMessage = <Kind extends LeaseChildMessage["kind"]>(
  child: LeaseChild,
  kind: Kind,
): Promise<Extract<LeaseChildMessage, { kind: Kind }>> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.process.kill("SIGKILL");
    reject(new Error(`lease child timed out waiting for ${kind}`));
  }, CHILD_TIMEOUT_MS);
  const cleanup = (): void => {
    clearTimeout(timeout);
    child.process.off("message", onMessage);
    child.process.off("exit", onExit);
  };
  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object" || !("kind" in message)) return;
    const candidate = message as LeaseChildMessage;
    if (candidate.kind === "error") {
      cleanup();
      reject(new Error(`lease child failed with ${candidate.code}: ${child.stderr()}`));
      return;
    }
    if (candidate.kind !== kind) return;
    cleanup();
    resolve(candidate as Extract<LeaseChildMessage, { kind: Kind }>);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    cleanup();
    reject(new Error(
      `lease child exited before ${kind} (code=${String(code)}, signal=${String(signal)}): ${child.stderr()}`,
    ));
  };
  child.process.on("message", onMessage);
  child.process.once("exit", onExit);
});

const waitForChildExit = (child: LeaseChild): Promise<void> => {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.process.kill("SIGKILL");
      reject(new Error("lease child timed out while exiting"));
    }, CHILD_TIMEOUT_MS);
    child.process.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `lease child exit failed (code=${String(code)}, signal=${String(signal)}): ${child.stderr()}`,
      ));
    });
  });
};

const startChildAcquisition = (child: LeaseChild): Promise<Extract<LeaseChildMessage, {
  kind: "result";
}>> => {
  const result = waitForChildMessage(child, "result");
  if (typeof child.process.send !== "function") throw new Error("lease child IPC is unavailable");
  child.process.send("acquire");
  return result;
};

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-writer-lease-"));
  roots.push(root);
  const home = path.join(root, "provider-home");
  mkdirSync(home);
  return {
    dbPath: path.join(root, "leases.sqlite"),
    keyA: createNativeTaskKey("anthropic", home, SESSION_A),
    keyB: createNativeTaskKey("anthropic", home, SESSION_B),
  };
};

const openStore = (
  dbPath: string,
  options: Omit<NativeTaskWriterLeaseStoreOptions, "dbPath">,
): NativeTaskWriterLeaseStore => {
  const store = new NativeTaskWriterLeaseStore({ dbPath, ...options });
  stores.push(store);
  return store;
};

describe("NativeTaskWriterLeaseStore", () => {
  it("exposes the fixed lease timings and requires a native reread before use", () => {
    expect(NATIVE_TASK_WRITER_HEARTBEAT_MS).toBe(5_000);
    expect(NATIVE_TASK_WRITER_EXPIRY_MS).toBe(15_000);
    expect(NATIVE_TASK_WRITER_DEFAULT_MAX_ACTIVE).toBeGreaterThan(0);

    const { dbPath, keyA } = fixture();
    const timers = new ManualTimers();
    const store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
    });

    const lease = store.acquire(keyA);
    expect(lease).not.toBeNull();
    expect(lease?.rereadRequired).toBe(true);
    expect(lease?.usable).toBe(false);
    expect(lease?.lost).toBe(false);
    expect(lease?.confirmReread()).toBe(true);
    expect(lease?.rereadRequired).toBe(false);
    expect(lease?.usable).toBe(true);
    expect(store.activeLeaseCount).toBe(1);
    expect(timers.activeCount).toBe(1);
    expect(timers.tasks[0]?.delayMs).toBe(NATIVE_TASK_WRITER_HEARTBEAT_MS);
  });

  it("uses the shared SQLite file for atomic contention and recurring heartbeat", () => {
    const { dbPath, keyA } = fixture();
    const timersA = new ManualTimers();
    const timersB = new ManualTimers();
    let now = 1_000;
    const first = openStore(dbPath, {
      now: () => now,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timersA.set,
      clearTimeoutFn: timersA.clear,
    });
    const second = openStore(dbPath, {
      now: () => now,
      ownerTokenFactory: () => "owner-b",
      setTimeoutFn: timersB.set,
      clearTimeoutFn: timersB.clear,
    });

    const lease = first.acquire(keyA);
    expect(lease?.confirmReread()).toBe(true);
    expect(second.acquire(keyA)).toBeNull();

    now += NATIVE_TASK_WRITER_HEARTBEAT_MS;
    timersA.fireNext();
    expect(lease?.lost).toBe(false);
    expect(timersA.activeCount).toBe(1);
    now = 20_999;
    expect(second.acquire(keyA)).toBeNull();
  });

  it("ignores duplicate stale heartbeat callbacks without creating parallel timers", () => {
    const { dbPath, keyA } = fixture();
    const timers = new ManualTimers();
    let now = 1_000;
    const store = openStore(dbPath, {
      now: () => now,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
    });
    const lease = store.acquire(keyA)!;
    expect(lease.confirmReread()).toBe(true);
    const firstTimer = timers.tasks[0]!;

    now += NATIVE_TASK_WRITER_HEARTBEAT_MS;
    timers.fireNext();
    expect(timers.tasks).toHaveLength(2);
    expect(timers.activeCount).toBe(1);
    const expiresAfterFirst = lease.expiresAtMs;

    firstTimer.callback();

    expect(lease.expiresAtMs).toBe(expiresAfterFirst);
    expect(timers.tasks).toHaveLength(2);
    expect(timers.activeCount).toBe(1);
    expect(store.activeLeaseCount).toBe(1);
  });

  it("grants exactly one lease across barriered simultaneous Node processes", async () => {
    const { dbPath, keyA } = fixture();
    const first = spawnLeaseChild({ dbPath, key: keyA, now: 1_000, ownerToken: "child-a" });
    const second = spawnLeaseChild({ dbPath, key: keyA, now: 1_000, ownerToken: "child-b" });

    await Promise.all([
      waitForChildMessage(first, "ready"),
      waitForChildMessage(second, "ready"),
    ]);
    const [firstResult, secondResult] = await Promise.all([
      startChildAcquisition(first),
      startChildAcquisition(second),
    ]);
    await Promise.all([waitForChildExit(first), waitForChildExit(second)]);

    const owners = [firstResult, secondResult].filter((result) => result.acquired);
    const contenders = [firstResult, secondResult].filter((result) => !result.acquired);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      rereadRequired: true,
      usableBeforeReread: false,
      confirmed: true,
      epoch: 1,
    });
    expect(contenders).toHaveLength(1);
    expect(contenders[0]).toMatchObject({
      rereadRequired: false,
      usableBeforeReread: false,
      confirmed: false,
      epoch: null,
    });
  });

  it("takes over at deterministic expiry after a child exits without release", async () => {
    const { dbPath, keyA } = fixture();
    const crashedOwner = spawnLeaseChild({
      dbPath,
      key: keyA,
      now: 0,
      ownerToken: "crashed-child",
    });
    await waitForChildMessage(crashedOwner, "ready");
    const crashedResult = await startChildAcquisition(crashedOwner);
    await waitForChildExit(crashedOwner);
    expect(crashedResult).toMatchObject({
      acquired: true,
      rereadRequired: true,
      usableBeforeReread: false,
      confirmed: true,
      epoch: 1,
    });

    const raw = new DatabaseSync(dbPath);
    try {
      const abandoned = raw.prepare(`
        SELECT lease_epoch AS leaseEpoch, expires_at_ms AS expiresAtMs
        FROM native_task_writer_leases
        WHERE provider = ? AND home = ? AND native_task_id = ?;
      `).get(keyA.provider, keyA.home, keyA.nativeTaskId) as {
        leaseEpoch: number;
        expiresAtMs: number;
      };
      expect(abandoned).toEqual({
        leaseEpoch: 1,
        expiresAtMs: NATIVE_TASK_WRITER_EXPIRY_MS,
      });
    } finally {
      raw.close();
    }

    const successor = spawnLeaseChild({
      dbPath,
      key: keyA,
      now: NATIVE_TASK_WRITER_EXPIRY_MS,
      ownerToken: "successor-child",
    });
    await waitForChildMessage(successor, "ready");
    const successorResult = await startChildAcquisition(successor);
    await waitForChildExit(successor);
    expect(successorResult).toMatchObject({
      acquired: true,
      rereadRequired: true,
      usableBeforeReread: false,
      confirmed: true,
      epoch: 2,
    });
  });

  it("replaces an expired owner and fences a stale handle even when tokens collide", () => {
    const { dbPath, keyA } = fixture();
    const timersA = new ManualTimers();
    const timersB = new ManualTimers();
    let now = 0;
    const first = openStore(dbPath, {
      now: () => now,
      ownerTokenFactory: () => "same-owner-token",
      setTimeoutFn: timersA.set,
      clearTimeoutFn: timersA.clear,
    });
    const second = openStore(dbPath, {
      now: () => now,
      ownerTokenFactory: () => "same-owner-token",
      setTimeoutFn: timersB.set,
      clearTimeoutFn: timersB.clear,
    });

    const stale = first.acquire(keyA);
    expect(stale?.confirmReread()).toBe(true);
    now = NATIVE_TASK_WRITER_EXPIRY_MS;
    const successor = second.acquire(keyA);
    expect(successor).not.toBeNull();
    expect(successor?.rereadRequired).toBe(true);
    expect(stale?.release()).toBe(false);
    expect(stale?.lost).toBe(true);
    expect(stale?.heartbeat()).toBe(false);
    expect(successor?.confirmReread()).toBe(true);
    expect(successor?.usable).toBe(true);
    expect(first.acquire(keyA)).toBeNull();
  });

  it("keeps epoch fences monotonic across clean release when owner tokens collide", () => {
    const { dbPath, keyA } = fixture();
    const timersA = new ManualTimers();
    const timersB = new ManualTimers();
    const first = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "same-owner-token",
      setTimeoutFn: timersA.set,
      clearTimeoutFn: timersA.clear,
    });
    const second = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "same-owner-token",
      setTimeoutFn: timersB.set,
      clearTimeoutFn: timersB.clear,
    });

    const released = first.acquire(keyA)!;
    expect(released.fence.epoch).toBe(1);
    expect(released.confirmReread()).toBe(true);
    expect(released.release()).toBe(true);

    const successor = second.acquire(keyA)!;
    expect(successor.fence.epoch).toBe(2);
    expect(successor.rereadRequired).toBe(true);
    expect(successor.usable).toBe(false);
    expect(released.runFencedWrite(() => "stale-mutation")).toEqual({ started: false });
  });

  it("conditionally releases ownership and closes idempotently", () => {
    const { dbPath, keyA } = fixture();
    const timersA = new ManualTimers();
    const timersB = new ManualTimers();
    const first = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timersA.set,
      clearTimeoutFn: timersA.clear,
    });
    const second = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-b",
      setTimeoutFn: timersB.set,
      clearTimeoutFn: timersB.clear,
    });

    const released = first.acquire(keyA)!;
    expect(released.release()).toBe(true);
    expect(released.released).toBe(true);
    expect(released.release()).toBe(false);
    const active = second.acquire(keyA);
    expect(active).not.toBeNull();
    second.close();
    second.close();
    expect(active?.usable).toBe(false);
    expect(first.acquire(keyA)).not.toBeNull();
    expect(() => second.acquire(keyA)).toThrowError(expect.objectContaining({ code: "CLOSED" }));
  });

  it("closes before timer cleanup can reenter and create a usable lease", () => {
    const { dbPath, keyA, keyB } = fixture();
    let store: NativeTaskWriterLeaseStore;
    let activeLease: ReturnType<NativeTaskWriterLeaseStore["acquire"]>;
    let reentrantLease: ReturnType<NativeTaskWriterLeaseStore["acquire"]>;
    let reentrantAcquireError: unknown;
    let reentrantConfirmed = false;
    let reentrantUsable = false;
    const timerHandle = Object.freeze({ kind: "lease-heartbeat" });

    store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: (() => {
        const tokens = ["owner-a", "owner-b"];
        return () => tokens.shift() ?? "owner-fallback";
      })(),
      setTimeoutFn: () => timerHandle,
      clearTimeoutFn: () => {
        try {
          reentrantLease = store.acquire(keyB);
          reentrantConfirmed = reentrantLease?.confirmReread() ?? false;
          reentrantUsable = reentrantLease?.usable ?? false;
        } catch (error) {
          reentrantAcquireError = error;
        }
        expect(activeLease?.confirmReread()).toBe(false);
        expect(activeLease?.usable).toBe(false);
      },
    });
    activeLease = store.acquire(keyA);
    expect(activeLease?.confirmReread()).toBe(true);

    store.close();

    expect(reentrantAcquireError).toMatchObject({ code: "CLOSED" });
    expect(reentrantLease).toBeUndefined();
    expect(reentrantConfirmed).toBe(false);
    expect(reentrantUsable).toBe(false);
    expect(store.activeLeaseCount).toBe(0);
    expect(activeLease?.usable).toBe(false);
    expect(activeLease?.runFencedWrite(() => "must-not-start")).toEqual({ started: false });
  });

  it("fails the usable check closed when the injected clock closes the store", () => {
    const { dbPath, keyA } = fixture();
    const timers = new ManualTimers();
    let store: NativeTaskWriterLeaseStore;
    let closeOnRead = false;
    store = openStore(dbPath, {
      now: () => {
        if (closeOnRead) {
          closeOnRead = false;
          store.close();
        }
        return 1_000;
      },
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
    });
    const lease = store.acquire(keyA)!;
    expect(lease.confirmReread()).toBe(true);

    closeOnRead = true;
    expect(lease.usable).toBe(false);
    expect(store.closed).toBe(true);
    expect(lease.released).toBe(true);
  });

  it("does not dispatch a heartbeat after the injected clock closes the store", () => {
    const { dbPath, keyA } = fixture();
    const timers = new ManualTimers();
    let store: NativeTaskWriterLeaseStore;
    let closeOnRead = false;
    store = openStore(dbPath, {
      now: () => {
        if (closeOnRead) {
          closeOnRead = false;
          store.close();
        }
        return 1_000;
      },
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
    });
    const lease = store.acquire(keyA)!;
    expect(lease.confirmReread()).toBe(true);
    let heartbeatDispatches = 0;
    const internal = store as unknown as {
      heartbeatStatement: { get: (...args: unknown[]) => Record<string, unknown> | undefined };
    };
    internal.heartbeatStatement = {
      get: () => {
        heartbeatDispatches += 1;
        throw new Error("heartbeat must not dispatch");
      },
    };

    closeOnRead = true;
    expect(lease.heartbeat()).toBe(false);

    expect(store.closed).toBe(true);
    expect(lease.released).toBe(true);
    expect(heartbeatDispatches).toBe(0);
    expect(timers.activeCount).toBe(0);
  });

  it("clears a newly returned timer when timer setup reentrantly closes the store", () => {
    const { dbPath, keyA } = fixture();
    let store: NativeTaskWriterLeaseStore;
    let timerCallback: (() => void) | undefined;
    let clearCount = 0;
    const timerHandle = Object.freeze({ kind: "lease-heartbeat" });
    store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: (callback) => {
        timerCallback = callback;
        store.close();
        return timerHandle;
      },
      clearTimeoutFn: (handle) => {
        expect(handle).toBe(timerHandle);
        clearCount += 1;
      },
    });

    const lease = store.acquire(keyA)!;

    expect(store.closed).toBe(true);
    expect(lease.released).toBe(true);
    expect(store.activeLeaseCount).toBe(0);
    expect(clearCount).toBe(1);
    expect(() => timerCallback?.()).not.toThrow();
  });

  it("exposes an immutable epoch fence and synchronously revalidates before dispatch", () => {
    const { dbPath, keyA } = fixture();
    const timers = new ManualTimers();
    let now = 1_000;
    const store = openStore(dbPath, {
      now: () => now,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
    });
    const lease = store.acquire(keyA)!;
    const dispatches: number[] = [];

    expect(lease.fence).toEqual({ key: keyA, epoch: 1 });
    expect(Object.isFrozen(lease.fence)).toBe(true);
    expect(lease.runFencedWrite(() => {
      dispatches.push(0);
      return "must-not-start";
    })).toEqual({ started: false });
    expect(dispatches).toEqual([]);

    expect(lease.confirmReread()).toBe(true);
    now = 2_000;
    const raw = new DatabaseSync(dbPath);
    try {
      const started = lease.runFencedWrite((fence) => {
        dispatches.push(fence.epoch);
        const row = raw.prepare(`
          SELECT expires_at_ms AS expiresAtMs
          FROM native_task_writer_leases
          WHERE provider = ? AND home = ? AND native_task_id = ?;
        `).get(keyA.provider, keyA.home, keyA.nativeTaskId) as { expiresAtMs: number };
        expect(row.expiresAtMs).toBe(now + NATIVE_TASK_WRITER_EXPIRY_MS);
        return "mutation-started";
      });
      expect(started).toEqual({ started: true, value: "mutation-started" });

      raw.prepare(`
        UPDATE native_task_writer_leases
        SET owner_token = ?, lease_epoch = lease_epoch + 1
        WHERE provider = ? AND home = ? AND native_task_id = ?;
      `).run("successor", keyA.provider, keyA.home, keyA.nativeTaskId);

      expect(lease.runFencedWrite(() => {
        dispatches.push(99);
        return "stale-mutation";
      })).toEqual({ started: false });
    } finally {
      raw.close();
    }

    expect(dispatches).toEqual([1]);
    expect(lease.lost).toBe(true);
    expect(lease.lossReason).toBe("ownership");
  });

  it("bounds active handles and their timers", () => {
    const { dbPath, keyA, keyB } = fixture();
    const timers = new ManualTimers();
    const store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: (() => {
        const tokens = ["owner-a", "owner-b"];
        return () => tokens.shift() ?? "owner-fallback";
      })(),
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      maxActiveLeases: 1,
    });

    const first = store.acquire(keyA)!;
    expect(store.acquire(keyB)).toBeNull();
    expect(store.activeLeaseCount).toBe(1);
    expect(timers.activeCount).toBe(1);
    expect(first.release()).toBe(true);
    expect(store.activeLeaseCount).toBe(0);
    expect(timers.activeCount).toBe(0);
    expect(store.acquire(keyB)).not.toBeNull();
  });

  it("reserves capacity before an injected clock can reenter acquisition", () => {
    const { dbPath, keyA, keyB } = fixture();
    const timers = new ManualTimers();
    let store: NativeTaskWriterLeaseStore;
    let nested: ReturnType<NativeTaskWriterLeaseStore["acquire"]> | undefined;
    let clockCalls = 0;
    store = openStore(dbPath, {
      now: () => {
        clockCalls += 1;
        if (clockCalls === 1) nested = store.acquire(keyB);
        return 1_000;
      },
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      maxActiveLeases: 1,
    });

    const outer = store.acquire(keyA);

    expect(outer).not.toBeNull();
    expect(nested).toBeNull();
    expect(clockCalls).toBe(1);
    expect(store.activeLeaseCount).toBe(1);
    expect(timers.activeCount).toBe(1);
  });

  it("reserves capacity before an owner token factory can reenter acquisition", () => {
    const { dbPath, keyA, keyB } = fixture();
    const timers = new ManualTimers();
    let store: NativeTaskWriterLeaseStore;
    let nested: ReturnType<NativeTaskWriterLeaseStore["acquire"]> | undefined;
    let tokenCalls = 0;
    store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => {
        tokenCalls += 1;
        if (tokenCalls === 1) nested = store.acquire(keyB);
        return tokenCalls === 1 ? "owner-a" : "owner-b";
      },
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      maxActiveLeases: 1,
    });

    const outer = store.acquire(keyA);

    expect(outer).not.toBeNull();
    expect(nested).toBeNull();
    expect(tokenCalls).toBe(1);
    expect(store.activeLeaseCount).toBe(1);
    expect(timers.activeCount).toBe(1);
  });

  it("does not dispatch SQLite acquisition after a hostile callback closes the store", () => {
    const { dbPath, keyA } = fixture();
    let clockStore: NativeTaskWriterLeaseStore;
    let clockTokenCalls = 0;
    clockStore = openStore(dbPath, {
      now: () => {
        clockStore.close();
        return 1_000;
      },
      ownerTokenFactory: () => {
        clockTokenCalls += 1;
        return "owner-a";
      },
    });

    expect(() => clockStore.acquire(keyA)).toThrowError(expect.objectContaining({ code: "CLOSED" }));
    expect(clockTokenCalls).toBe(0);
    expect(clockStore.activeLeaseCount).toBe(0);

    const secondDb = path.join(path.dirname(dbPath), "owner-close.sqlite");
    let tokenStore: NativeTaskWriterLeaseStore;
    tokenStore = openStore(secondDb, {
      now: () => 1_000,
      ownerTokenFactory: () => {
        tokenStore.close();
        return "owner-b";
      },
    });

    expect(() => tokenStore.acquire(keyA)).toThrowError(expect.objectContaining({ code: "CLOSED" }));
    expect(tokenStore.activeLeaseCount).toBe(0);
  });

  it("releases acquisition capacity after null, clock, token, and database exits", () => {
    const { dbPath, keyA, keyB } = fixture();
    const owner = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-a",
    });
    expect(owner.acquire(keyA)).not.toBeNull();

    const contender = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-b",
      maxActiveLeases: 1,
    });
    expect(contender.acquire(keyA)).toBeNull();
    expect(contender.acquire(keyB)).not.toBeNull();

    const clockDb = path.join(path.dirname(dbPath), "recover-clock.sqlite");
    let failClock = true;
    const clockStore = openStore(clockDb, {
      now: () => {
        if (failClock) throw new Error("clock-failure");
        return 1_000;
      },
      ownerTokenFactory: () => "clock-owner",
      maxActiveLeases: 1,
    });
    expect(() => clockStore.acquire(keyA)).toThrowError(expect.objectContaining({ code: "CLOCK_FAILURE" }));
    failClock = false;
    expect(clockStore.acquire(keyA)).not.toBeNull();

    const tokenDb = path.join(path.dirname(dbPath), "recover-token.sqlite");
    let failToken = true;
    const tokenStore = openStore(tokenDb, {
      now: () => 1_000,
      ownerTokenFactory: () => {
        if (failToken) throw new Error("token-failure");
        return "token-owner";
      },
      maxActiveLeases: 1,
    });
    expect(() => tokenStore.acquire(keyA)).toThrowError(expect.objectContaining({ code: "TOKEN_FAILURE" }));
    failToken = false;
    expect(tokenStore.acquire(keyA)).not.toBeNull();

    const databaseDb = path.join(path.dirname(dbPath), "recover-database.sqlite");
    const databaseStore = openStore(databaseDb, {
      now: () => 1_000,
      ownerTokenFactory: () => "database-owner",
      maxActiveLeases: 1,
    });
    const internal = databaseStore as unknown as {
      acquireStatement: { get: (...args: unknown[]) => Record<string, unknown> | undefined };
    };
    const originalStatement = internal.acquireStatement;
    internal.acquireStatement = { get: () => { throw new Error("database-failure"); } };
    expect(() => databaseStore.acquire(keyA)).toThrowError(expect.objectContaining({
      code: "DATABASE_FAILURE",
    }));
    internal.acquireStatement = originalStatement;
    expect(databaseStore.acquire(keyA)).not.toBeNull();
  });

  it("rejects a normalization alias instead of changing native task identity", () => {
    const { dbPath, keyA } = fixture();
    const store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-a",
    });
    const alias = { ...keyA, nativeTaskId: ` ${keyA.nativeTaskId} ` };

    expect(() => store.acquire(alias)).toThrowError(expect.objectContaining({ code: "INVALID_KEY" }));
    expect(store.acquire(keyA)).not.toBeNull();
  });

  it("fails closed and marks the acquired handle lost when timer setup fails", () => {
    const { dbPath, keyA } = fixture();
    const store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: () => {
        throw new Error("timer-secret");
      },
      clearTimeoutFn: () => undefined,
    });

    const lease = store.acquire(keyA);
    expect(lease).not.toBeNull();
    expect(lease?.lost).toBe(true);
    expect(lease?.lossReason).toBe("timer");
    expect(lease?.usable).toBe(false);
    expect(lease?.confirmReread()).toBe(false);
    expect(store.activeLeaseCount).toBe(0);
  });

  it("marks ownership lost when a heartbeat database operation fails", () => {
    const { dbPath, keyA } = fixture();
    const timers = new ManualTimers();
    const store = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => "owner-a",
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
    });
    const lease = store.acquire(keyA)!;
    expect(lease.confirmReread()).toBe(true);
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("DROP TABLE native_task_writer_leases;");
    } finally {
      raw.close();
    }

    expect(lease.heartbeat()).toBe(false);
    expect(lease.lost).toBe(true);
    expect(lease.lossReason).toBe("database");
    expect(lease.usable).toBe(false);
    expect(store.activeLeaseCount).toBe(0);
  });

  it("sanitizes hostile clock and token factories", () => {
    const { dbPath, keyA } = fixture();
    const secret = "factory-secret";
    const badToken = openStore(dbPath, {
      now: () => 1_000,
      ownerTokenFactory: () => {
        throw new Error(secret);
      },
    });
    try {
      badToken.acquire(keyA);
      throw new Error("expected token factory failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeTaskWriterLeaseError);
      expect(error).toMatchObject({ code: "TOKEN_FAILURE" });
      expect(String(error)).not.toContain(secret);
    }

    const secondDb = path.join(path.dirname(dbPath), "clock.sqlite");
    const badClock = openStore(secondDb, {
      now: () => {
        throw new Error(secret);
      },
      ownerTokenFactory: () => "owner-a",
    });
    expect(() => badClock.acquire(keyA)).toThrowError(expect.objectContaining({
      code: "CLOCK_FAILURE",
    }));
  });
});
