import { describe, expect, it, vi } from "vitest";
import { defineProviderCapabilities } from "../../src/providers/capabilities.js";
import { ProviderCapabilityError } from "../../src/providers/capabilities.js";
import type { ProviderEvent } from "../../src/providers/events.js";
import { ProviderOperationError } from "../../src/providers/operation-error.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type {
  ProviderRequestResponse,
  StartTaskInput,
  TaskOverrides,
} from "../../src/providers/types.js";
import { ClaudeNativeAdapter } from "../../src/providers/claude/native-adapter.js";

const HOME = "/canonical/claude-home";
const CWD = "/canonical/project";
const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const FORK = "119f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TURN_A = "219f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const ITEM_A = "319f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const ITEM_B = "419f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const THIRD = "519f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const CREATED = "2026-07-13T17:00:00.000Z";
const UPDATED = "2026-07-13T17:01:00.000Z";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const nextMicrotasks = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

const key = (nativeTaskId = SESSION) => ({
  provider: "anthropic" as const,
  home: HOME,
  nativeTaskId,
});

const summary = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  title: "Inspect the runtime",
  summary: "Inspect the runtime",
  cwd: CWD,
  createdAt: CREATED,
  updatedAt: UPDATED,
  fileSize: 1_024,
  ...overrides,
});

const messages = () => ({
  messages: [
    { id: ITEM_A, role: "user" as const, text: "inspect" },
    { id: ITEM_B, role: "assistant" as const, text: "done" },
  ],
  limit: 200,
  offset: 0,
  rawCount: 2,
});

type TestTaskKey = ReturnType<typeof key>;

interface FakeWriterOptions {
  readonly leaseKey?: TestTaskKey;
  readonly fenceKey?: TestTaskKey;
  readonly callbackFenceKey?: TestTaskKey;
  readonly epoch?: number;
  readonly callbackEpoch?: number;
  readonly started?: boolean;
}

class FakeRuntimeLease {
  readonly configHome = HOME;
  readonly generation = 1;
  readonly sends: unknown[] = [];
  readonly interrupts: string[] = [];
  readonly responses: ProviderRequestResponse[] = [];
  releaseCalls = 0;

  constructor(
    readonly sessionId: string,
    private readonly persistOnSend: (() => void) | null = null,
  ) {}

  async send(input: unknown) {
    this.sends.push(input);
    this.persistOnSend?.();
    return { taskKey: key(this.sessionId), turnId: TURN_A };
  }
  async interrupt(turnId: string): Promise<void> { this.interrupts.push(turnId); }
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
  async release(): Promise<void> { this.releaseCalls += 1; }
}

const harness = (enabled = true, maxTrackedRevisions?: number) => {
  let featureEnabled = enabled;
  const sessionRows = [summary()];
  const helpers = {
    listSessions: vi.fn(async ({ limit, offset }: { limit: number; offset: number }) =>
      sessionRows.slice(offset, offset + limit)),
    getSessionInfo: vi.fn(async (id: string) =>
      sessionRows.find((row) => row.sessionId === id) ?? null),
    getSessionMessages: vi.fn(async () => messages()),
    renameSession: vi.fn(async (id: string, title: string) => {
      const row = sessionRows.find((candidate) => candidate.sessionId === id);
      if (row) row.title = title;
    }),
    forkSession: vi.fn(async () => FORK),
  };
  const runtimeLeases: FakeRuntimeLease[] = [];
  let emit: ((event: ProviderEvent) => void) | null = null;
  const supervisor = {
    acquire: vi.fn(async (options: {
      sessionId: string;
      handlers: { emit: (event: ProviderEvent) => void };
    }) => {
      emit = options.handlers.emit;
      const lease = new FakeRuntimeLease(options.sessionId, () => {
        if (!sessionRows.some((row) => row.sessionId === options.sessionId)) {
          sessionRows.push(summary({ sessionId: options.sessionId }));
        }
      });
      runtimeLeases.push(lease);
      return lease;
    }),
  };
  const writerHandles: Array<{
    readonly key: TestTaskKey;
    readonly fence: { readonly key: TestTaskKey; readonly epoch: number };
    confirmReread: ReturnType<typeof vi.fn>;
    runFencedWrite: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  const createWriterHandle = (
    acquiredKey: TestTaskKey,
    overrides: FakeWriterOptions = {},
  ) => {
    let confirmed = false;
    let released = false;
    let lost = false;
    const leaseKey = overrides.leaseKey ?? acquiredKey;
    const fenceKey = overrides.fenceKey ?? acquiredKey;
    const epoch = overrides.epoch ?? writerHandles.length + 1;
    const handle = {
      key: leaseKey,
      fence: { key: fenceKey, epoch },
      get rereadRequired() { return !confirmed && !released; },
      get usable() { return confirmed && !released && !lost; },
      get lost() { return lost; },
      get released() { return released; },
      get lossReason() { return lost ? "ownership" as const : null; },
      expiresAtMs: 15_000,
      confirmReread: vi.fn(() => {
        if (released || lost) return false;
        confirmed = true;
        return true;
      }),
      heartbeat: vi.fn(() => confirmed && !released && !lost),
      runFencedWrite: vi.fn((start: (fence: unknown) => unknown) => {
        if (overrides.started === false || released || lost) {
          lost = true;
          return { started: false as const };
        }
        return {
          started: true as const,
          value: start({
            key: overrides.callbackFenceKey ?? fenceKey,
            epoch: overrides.callbackEpoch ?? epoch,
          }),
        };
      }),
      release: vi.fn(() => {
        if (released) return false;
        released = true;
        return true;
      }),
    };
    writerHandles.push(handle);
    return handle;
  };
  const writerLeases = {
    acquire: vi.fn((acquiredKey: TestTaskKey) => createWriterHandle(acquiredKey)),
  };
  const adapter = new ClaudeNativeAdapter({
    home: HOME,
    helpers,
    supervisor,
    writerLeases,
    isEnabled: () => featureEnabled,
    idFactory: () => FORK,
    canonicalizeHome: (home: string) => home,
    ...(maxTrackedRevisions === undefined ? {} : { maxTrackedRevisions }),
  });
  return {
    adapter,
    createWriterHandle,
    emit: (event: ProviderEvent) => emit?.(event),
    helpers,
    runtimeLeases,
    sessionRows,
    supervisor,
    setEnabled: (value: boolean) => { featureEnabled = value; },
    writerHandles,
    writerLeases,
  };
};

const resumeWithPlan = (
  h: ReturnType<typeof harness>,
  taskKey = key(),
  overrides: TaskOverrides = {},
) => h.adapter.resumeTask(taskKey, { permissionMode: "plan", ...overrides });

const startWithPlan = (
  h: ReturnType<typeof harness>,
  input: StartTaskInput,
) => h.adapter.startTask({ permissionMode: "plan", ...input });

describe("ClaudeNativeAdapter", () => {
  it("advertises only implemented persistent-native operations and closes all gates when disabled", async () => {
    const off = harness(false);
    await expect(off.adapter.capabilities()).resolves.toEqual(defineProviderCapabilities());

    const on = harness();
    await expect(on.adapter.capabilities()).resolves.toEqual(defineProviderCapabilities({
      list: true,
      read: true,
      start: true,
      resume: true,
      fork: true,
      send: true,
      interrupt: true,
      subscribe: true,
      rename: true,
    }));
  });

  it("lists all-project official-helper history with bounded cursor pagination", async () => {
    const h = harness();
    h.sessionRows.push(summary({ sessionId: FORK, updatedAt: CREATED }));
    const first = await h.adapter.listTasks({ home: HOME, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      key: key(),
      archived: null,
      source: "native",
      status: "complete",
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await h.adapter.listTasks({
      home: HOME,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items[0]?.key.nativeTaskId).toBe(FORK);
    expect(h.helpers.listSessions).toHaveBeenNthCalledWith(1, { limit: 2, offset: 0 });
    expect(h.helpers.listSessions).toHaveBeenNthCalledWith(2, { limit: 2, offset: 1 });
  });

  it("probes one bounded row to avoid a false cursor at the helper page ceiling", async () => {
    const h = harness();
    h.sessionRows.splice(0, h.sessionRows.length, ...Array.from({ length: 200 }, (_, index) =>
      summary({
        sessionId: `${index.toString(16).padStart(8, "0")}-18c0-7b60-8f0c-6afc120ecd7d`,
      })));

    const page = await h.adapter.listTasks({ home: HOME, limit: 200 });
    expect(page.items).toHaveLength(200);
    expect(page.nextCursor).toBeNull();
    expect(h.helpers.listSessions).toHaveBeenNthCalledWith(1, { limit: 200, offset: 0 });
    expect(h.helpers.listSessions).toHaveBeenNthCalledWith(2, { limit: 1, offset: 200 });
  });

  it("accepts the maximum representable cursor when the terminal page is empty", async () => {
    const h = harness();
    const cursor = Buffer.from(JSON.stringify({ v: 1, offset: 1_000_000 }), "utf8")
      .toString("base64url");

    await expect(h.adapter.listTasks({ home: HOME, limit: 1, cursor })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(h.helpers.listSessions).toHaveBeenCalledWith({ limit: 2, offset: 1_000_000 });
  });

  it("reads safe text history as native turns and attaches a content-free revision", async () => {
    const h = harness();
    const task = await h.adapter.readTask(key(), true);
    expect(task.turns).toHaveLength(1);
    expect(task.turns[0]).toMatchObject({
      id: ITEM_A,
      status: "complete",
      events: [
        { type: "message", role: "user", itemId: ITEM_A, turnId: ITEM_A, text: "inspect" },
        { type: "message", role: "assistant", itemId: ITEM_B, turnId: ITEM_A, text: "done" },
      ],
    });
    expect(task.revision).toMatchObject({
      status: "complete",
      lastTurnId: ITEM_A,
      lastItemId: ITEM_B,
      fingerprint: expect.stringMatching(/^claude:v1:/u),
    });
    expect(JSON.stringify(task.revision)).not.toContain("inspect");
  });

  it("starts one generated native session and routes the first user envelope through its owned runtime", async () => {
    const h = harness();
    const task = await startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "start safely" },
    });
    expect(task.key).toEqual(key(FORK));
    expect(h.supervisor.acquire).toHaveBeenCalledWith(expect.objectContaining({
      configHome: HOME,
      cwd: CWD,
      sessionId: FORK,
      launch: "new",
    }));
    expect(h.runtimeLeases[0]?.sends).toEqual([{ text: "start safely" }]);
    expect(h.writerHandles[0]?.confirmReread).toHaveBeenCalledTimes(1);
  });

  it.each(["manual", "acceptEdits", "auto", "dontAsk", "plan"] as const)(
    "propagates the allowlisted %s permission mode to the owned runtime",
    async (permissionMode) => {
      const h = harness();
      await h.adapter.startTask({
        home: HOME,
        cwd: CWD,
        permissionMode,
        input: { text: "start safely" },
      });

      expect(h.supervisor.acquire).toHaveBeenCalledWith(expect.objectContaining({
        permissionMode,
      }));
    },
  );

  it("requires a non-empty first message before acquiring a new Claude runtime", async () => {
    const missing = harness();
    await expect(missing.adapter.startTask({
      home: HOME,
      cwd: CWD,
      permissionMode: "plan",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(missing.supervisor.acquire).not.toHaveBeenCalled();

    const empty = harness();
    await expect(empty.adapter.startTask({
      home: HOME,
      cwd: CWD,
      permissionMode: "plan",
      input: { text: "" },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(empty.supervisor.acquire).not.toHaveBeenCalled();
  });

  it("returns a frozen partial start when the dispatched task is not helper-visible", async () => {
    const h = harness();
    const invisible = new FakeRuntimeLease(FORK);
    h.supervisor.acquire.mockResolvedValueOnce(invisible);

    const starting = startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "dispatch before helper visibility" },
    });

    await expect(starting).rejects.toMatchObject({
      code: "PARTIAL_START",
      task: { key: key(FORK), turns: [{ id: TURN_A, status: "active" }] },
    });
    await expect(h.adapter.rename(key(FORK), "must reconcile first"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });

  it("rejects generic mode and unknown Claude permission modes before acquisition", async () => {
    const generic = harness();
    await expect(generic.adapter.startTask({
      home: HOME,
      cwd: CWD,
      mode: "plan",
    })).rejects.toMatchObject({ code: "UNSAFE_OVERRIDE" });
    expect(generic.supervisor.acquire).not.toHaveBeenCalled();

    const unknown = harness();
    await expect(unknown.adapter.startTask({
      home: HOME,
      cwd: CWD,
      permissionMode: "unknown",
    })).rejects.toMatchObject({ code: "UNSAFE_OVERRIDE" });
    expect(unknown.supervisor.acquire).not.toHaveBeenCalled();
  });

  it("requires an explicit attested policy for start, unknown resume, and historical send", async () => {
    const starting = harness();
    await expect(starting.adapter.startTask({ home: HOME, cwd: CWD }))
      .rejects.toMatchObject({ code: "POLICY_MISMATCH" });
    expect(starting.supervisor.acquire).not.toHaveBeenCalled();

    const resuming = harness();
    await expect(resuming.adapter.resumeTask(key()))
      .rejects.toMatchObject({ code: "POLICY_MISMATCH" });
    await expect(resuming.adapter.send(key(), { text: "must verify policy first" }))
      .rejects.toMatchObject({ code: "POLICY_MISMATCH" });
    expect(resuming.supervisor.acquire).not.toHaveBeenCalled();
    expect(resuming.writerLeases.acquire).not.toHaveBeenCalled();
  });

  it.each(["manual", "acceptEdits", "plan"] as const)(
    "preserves the attested %s policy across idle RuntimeState eviction and auto-resume",
    async (permissionMode) => {
      const h = harness();
      await h.adapter.resumeTask(key(), { permissionMode });
      await h.adapter.send(key(), { text: "first" });
      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "status",
        scope: "turn",
        status: "success",
        nativeId: TURN_A,
      });
      await nextTurn();

      await expect(h.adapter.send(key(), { text: "reuse exact attested policy" }))
        .resolves.toMatchObject({ taskKey: key() });
      expect(h.supervisor.acquire).toHaveBeenNthCalledWith(2, expect.objectContaining({
        permissionMode,
        launch: "resume",
      }));
    },
  );

  it("preserves the attested model with policy across idle RuntimeState eviction", async () => {
    const h = harness();
    await h.adapter.resumeTask(key(), {
      permissionMode: "plan",
      model: "claude-sonnet-4-5",
    });
    await h.adapter.send(key(), { text: "first" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    await nextTurn();

    await expect(h.adapter.send(key(), { text: "reuse exact attested runtime" }))
      .resolves.toMatchObject({ taskKey: key() });
    expect(h.supervisor.acquire).toHaveBeenNthCalledWith(2, expect.objectContaining({
      permissionMode: "plan",
      requestedModel: "claude-sonnet-4-5",
      launch: "resume",
    }));
  });

  it("retires ownership when drift lands after runtime acquisition but before policy attestation", async () => {
    const h = harness();
    await h.adapter.readTask(key(), true);
    const pendingLease = deferred<FakeRuntimeLease>();
    const lease = new FakeRuntimeLease(SESSION);
    h.runtimeLeases.push(lease);
    h.supervisor.acquire.mockImplementationOnce(async () => pendingLease.promise);
    const resume = h.adapter.resumeTask(key(), { permissionMode: "plan" });
    await vi.waitFor(() => expect(h.supervisor.acquire).toHaveBeenCalledTimes(1));

    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    await h.adapter.readTask(key(), true);
    pendingLease.resolve(lease);

    await expect(resume).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(lease.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("safely rebinds an idle subscribed task from invalidated policy to explicit Plan", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await h.adapter.resumeTask(key(), { permissionMode: "acceptEdits" });
    await h.adapter.send(key(), { text: "first" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    await nextTurn();
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;

    await expect(h.adapter.send(key(), { text: "must review external drift" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const reviewed = await h.adapter.readTask(key(), true);
    await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);
    await expect(h.adapter.resumeTask(key(), { permissionMode: "plan" }))
      .resolves.toMatchObject({ key: key() });

    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.supervisor.acquire).toHaveBeenNthCalledWith(2, expect.objectContaining({
      permissionMode: "plan",
      launch: "resume",
    }));
    await unsubscribe();
  });

  it("resumes and sends on the same native id only after writer reread", async () => {
    const h = harness();
    const resumed = await resumeWithPlan(h);
    expect(resumed.key).toEqual(key());
    expect(h.supervisor.acquire).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      launch: "resume",
    }));
    await expect(h.adapter.send(key(), { text: "continue" })).resolves.toMatchObject({
      taskKey: key(),
      turnId: TURN_A,
    });
    expect(h.runtimeLeases).toHaveLength(1);
  });

  it.each(["unknown-error", "malformed-ref"] as const)(
    "latches a potentially dispatched send with an %s outcome until exact review",
    async (outcome) => {
      const h = harness();
      await resumeWithPlan(h);
      const send = vi.spyOn(h.runtimeLeases[0]!, "send");
      if (outcome === "unknown-error") {
        send.mockRejectedValueOnce(new Error("private transport failure"));
      } else {
        send.mockResolvedValueOnce({ taskKey: key("wrong-task"), turnId: TURN_A });
      }

      await expect(h.adapter.send(key(), { text: "possibly dispatched" }))
        .rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
      await expect(h.adapter.rename(key(), "must review first"))
        .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
      expect(h.helpers.renameSession).not.toHaveBeenCalled();

      const reviewed = await h.adapter.readTask(key(), true);
      await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);
      await expect(h.adapter.send(key(), { text: "safe after review" }))
        .resolves.toMatchObject({ taskKey: key() });
    },
  );

  it("latches an uncertain rename dispatch before any other client can mutate", async () => {
    const h = harness();
    h.helpers.renameSession.mockRejectedValueOnce(new Error("response lost"));

    await expect(h.adapter.rename(key(), "possibly applied"))
      .rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
    await expect(h.adapter.rename(key(), "must not replay"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).toHaveBeenCalledTimes(1);
  });

  it("keeps a partial first-input start state-frozen until native review", async () => {
    const h = harness();
    const lease = new FakeRuntimeLease(FORK);
    const sendGate = deferred<ReturnType<FakeRuntimeLease["send"]> extends Promise<infer T> ? T : never>();
    vi.spyOn(lease, "send").mockImplementationOnce(async () => sendGate.promise);
    h.supervisor.acquire.mockResolvedValueOnce(lease);
    const starting = startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "possibly dispatched first turn" },
    });
    await vi.waitFor(() => expect(lease.send).toHaveBeenCalledTimes(1));
    h.sessionRows.push(summary({ sessionId: FORK }));
    sendGate.reject(new Error("response lost"));

    await expect(starting).rejects.toMatchObject({ code: "PARTIAL_START" });
    await expect(h.adapter.resumeTask(key(FORK), { permissionMode: "plan" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(lease.sends).toHaveLength(0);
    const reviewed = await h.adapter.readTask(key(FORK), true);
    await h.adapter.acknowledgeReconciliation(key(FORK), reviewed.revision!.fingerprint);
    await expect(h.adapter.send(key(FORK), { text: "policy still needs repair" }))
      .rejects.toMatchObject({ code: "POLICY_MISMATCH" });
    await expect(h.adapter.resumeTask(key(FORK), { permissionMode: "plan" }))
      .resolves.toMatchObject({ key: key(FORK) });
  });

  it("latches external revision drift until the reviewed revision is acknowledged", async () => {
    const h = harness();
    await h.adapter.readTask(key(), false);
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    await expect(h.adapter.rename(key(), "Renamed"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
    await expect(h.adapter.rename(key(), "Renamed"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();

    const reviewed = await h.adapter.readTask(key(), true);
    await expect(h.adapter.rename(key(), "Renamed"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);
    await expect(h.adapter.rename(key(), "Renamed")).resolves.toBeUndefined();
    expect(h.helpers.renameSession).toHaveBeenCalledWith(SESSION, "Renamed");
  });

  it("does not let automatic subscribe/read absorb idle external drift or reuse its old policy", async () => {
    const h = harness();
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "first" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    await nextTurn();
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;

    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await expect(h.adapter.send(key(), { text: "must review drift" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.supervisor.acquire).toHaveBeenCalledTimes(1);
    const reviewed = await h.adapter.readTask(key(), true);
    await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);
    await expect(h.adapter.send(key(), { text: "old policy stays invalid" }))
      .rejects.toMatchObject({ code: "POLICY_MISMATCH" });
    await expect(h.adapter.resumeTask(key(), { permissionMode: "plan" }))
      .resolves.toMatchObject({ key: key() });
    await unsubscribe();
  });

  it("never evicts reconciliation latches when the bounded revision ledger fills", async () => {
    const h = harness(true, 2);
    h.sessionRows.push(
      summary({ sessionId: FORK }),
      summary({ sessionId: THIRD }),
    );
    await h.adapter.readTask(key(), true);
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    await expect(h.adapter.rename(key(), "latch first"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    await h.adapter.readTask(key(FORK), true);
    h.sessionRows[1]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[1]!.fileSize = 1_025;
    await expect(h.adapter.rename(key(FORK), "latch second"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    await expect(h.adapter.readTask(key(THIRD), true))
      .rejects.toMatchObject({ code: "SUBSCRIPTION_CAPACITY" });
    await expect(h.adapter.rename(key(), "must remain blocked"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
  });

  it("pins an in-flight mutation revision so its uncertain outcome can always latch", async () => {
    const h = harness(true, 2);
    h.sessionRows.push(
      summary({ sessionId: FORK }),
      summary({ sessionId: THIRD }),
    );
    await h.adapter.readTask(key(), true);
    const renameGate = deferred<void>();
    h.helpers.renameSession.mockImplementation(async (id: string) => {
      if (id === SESSION) await renameGate.promise;
    });
    const inFlight = h.adapter.rename(key(), "possibly dispatched");
    await vi.waitFor(() => expect(h.helpers.renameSession).toHaveBeenCalledTimes(1));

    await h.adapter.readTask(key(FORK), true);
    h.sessionRows[1]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[1]!.fileSize = 1_025;
    await expect(h.adapter.rename(key(FORK), "latch second"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    let thirdWasTracked = false;
    try {
      await h.adapter.readTask(key(THIRD), true);
      thirdWasTracked = true;
    } catch (error) {
      expect(error).toMatchObject({ code: "SUBSCRIPTION_CAPACITY" });
    }
    if (thirdWasTracked) {
      h.sessionRows[2]!.updatedAt = "2026-07-13T17:02:00.000Z";
      h.sessionRows[2]!.fileSize = 1_025;
      await expect(h.adapter.rename(key(THIRD), "latch third"))
        .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    }

    renameGate.reject(new Error("response lost"));
    await expect(inFlight).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
    await expect(h.adapter.rename(key(), "must remain frozen"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(thirdWasTracked).toBe(false);
  });

  it("forks at the exact user-message boundary without mutating the source identity", async () => {
    const h = harness();
    h.sessionRows.push(summary({ sessionId: FORK, title: "Fork" }));
    const forked = await h.adapter.forkTask(key(), ITEM_A);
    expect(h.helpers.forkSession).toHaveBeenCalledWith(SESSION, { upToMessageId: ITEM_A });
    expect(forked.key).toEqual(key(FORK));
    expect(forked.key).not.toEqual(key());
  });

  it("latches the source when post-fork source verification cannot complete", async () => {
    const h = harness();
    h.sessionRows.push(summary({ sessionId: FORK, title: "Fork" }));
    let sourceVerificationFails = false;
    h.helpers.forkSession.mockImplementationOnce(async () => {
      sourceVerificationFails = true;
      return FORK;
    });
    h.helpers.getSessionInfo.mockImplementation(async (id: string) => {
      if (id === SESSION && sourceVerificationFails) throw new Error("source reread failed");
      return h.sessionRows.find((row) => row.sessionId === id) ?? null;
    });

    await expect(h.adapter.forkTask(key(), ITEM_A))
      .rejects.toMatchObject({ code: "PARTIAL_FORK", task: { key: key(FORK) } });
    sourceVerificationFails = false;
    await expect(h.adapter.rename(key(), "source must remain frozen"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });

  it("rejects an assistant item as a fork boundary before dispatching the helper mutation", async () => {
    const h = harness();

    await expect(h.adapter.forkTask(key(), ITEM_B)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(h.helpers.forkSession).not.toHaveBeenCalled();
  });

  it("publishes only owned runtime events and routes interrupt and correlated responses", async () => {
    const h = harness();
    const events: ProviderEvent[] = [];
    const unsubscribe = await h.adapter.subscribe(key(), (event) => events.push(event));
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "continue" });
    const event = {
      provider: "anthropic" as const,
      key: key(),
      occurredAt: UPDATED,
      type: "status" as const,
      scope: "turn" as const,
      status: "success",
      nativeId: TURN_A,
    };
    h.emit(event);
    expect(events).toEqual([event]);
    await h.adapter.interrupt(key(), TURN_A);
    expect(h.runtimeLeases[0]?.interrupts).toEqual([TURN_A]);
    const response = {
      kind: "file-change-approval" as const,
      identity: {
        key: key(), generation: 1, turnId: TURN_A, requestId: "request-1",
        itemId: "item-1", approvalId: "approval-1",
      },
      decision: "deny" as const,
    };
    await h.adapter.respond(response);
    expect(h.runtimeLeases[0]?.responses).toEqual([response]);
    await unsubscribe();
  });

  it.each([
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
    "failure",
    "success",
  ] as const)(
    "retires the active public projection for the terminal %s runtime status",
    async (status) => {
      const h = harness();
      const events: ProviderEvent[] = [];
      const unsubscribe = await h.adapter.subscribe(key(), (event) => events.push(event));
      await resumeWithPlan(h);
      await h.adapter.send(key(), { text: "continue" });

      expect((await h.adapter.readTask(key(), true)).status).toBe("active");
      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "status",
        scope: "turn",
        status,
        nativeId: TURN_A,
      });

      expect((await h.adapter.readTask(key(), true)).status).toBe("complete");
      expect(events.at(-1)).toMatchObject({ status, nativeId: TURN_A });
      await unsubscribe();
    },
  );

  it("latches an active-turn runtime crash until the exact reviewed revision is acknowledged", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "uncertain turn" });

    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: TURN_A,
    });

    await expect(h.adapter.send(key(), { text: "must not race recovery" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const reviewed = await h.adapter.readTask(key(), true);
    await expect(h.adapter.send(key(), { text: "a read alone cannot clear uncertainty" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.acknowledgeReconciliation(
      key(),
      reviewed.revision!.fingerprint,
    )).resolves.toBeUndefined();
    await expect(h.adapter.send(key(), { text: "after authoritative read" }))
      .resolves.toMatchObject({ taskKey: key() });
    await unsubscribe();
  });

  it("invalidates preserved policy when provider history drifts after a crash latch", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await h.adapter.resumeTask(key(), { permissionMode: "acceptEdits" });
    await h.adapter.send(key(), { text: "uncertain turn" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: TURN_A,
    });
    await nextTurn();

    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    const reviewed = await h.adapter.readTask(key(), true);
    await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);

    await expect(h.adapter.send(key(), { text: "old policy must not survive drift" }))
      .rejects.toMatchObject({ code: "POLICY_MISMATCH" });
    await unsubscribe();
  });

  it("does not let supervised restart clear a crash latch before explicit revision review", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "uncertain turn" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: TURN_A,
    });

    const context = {
      configHome: HOME,
      cwd: CWD,
      sessionId: SESSION,
      generation: 2,
      reason: "restart" as const,
    };
    await expect(h.adapter.reconcile(context))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const reviewed = await h.adapter.readTask(key(), true);
    await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);
    await expect(h.adapter.reconcile(context)).resolves.toBeUndefined();
    expect(h.writerHandles[0]?.confirmReread).toHaveBeenCalledTimes(1);
    await expect(h.adapter.send(key(), { text: "after fenced restart" }))
      .resolves.toMatchObject({ taskKey: key() });
    await unsubscribe();
  });

  it("rejects stale and missing revision acknowledgements without clearing the crash latch", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "uncertain turn" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: TURN_A,
    });
    const stale = (await h.adapter.readTask(key(), true)).revision!.fingerprint;
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:03:00.000Z";
    h.sessionRows[0]!.fileSize = 2_048;

    await expect(h.adapter.acknowledgeReconciliation(key(), stale))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.send(key(), { text: "still blocked" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const current = (await h.adapter.readTask(key(), true)).revision!.fingerprint;
    h.sessionRows.splice(0, 1);
    await expect(h.adapter.acknowledgeReconciliation(key(), current))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await unsubscribe();
  });

  it("does not let an older acknowledgement clear drift observed while its reread is pending", async () => {
    const h = harness();
    await h.adapter.readTask(key(), true);
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    await expect(h.adapter.rename(key(), "must first latch"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const reviewed = await h.adapter.readTask(key(), true);

    const pendingInfo = deferred<(typeof h.sessionRows)[number] | null>();
    const callsBeforeAck = h.helpers.getSessionInfo.mock.calls.length;
    h.helpers.getSessionInfo.mockImplementationOnce(async () => pendingInfo.promise);
    const acknowledgement = h.adapter.acknowledgeReconciliation(
      key(),
      reviewed.revision!.fingerprint,
    );
    await vi.waitFor(() => {
      expect(h.helpers.getSessionInfo).toHaveBeenCalledTimes(callsBeforeAck + 1);
    });

    h.sessionRows[0]!.updatedAt = "2026-07-13T17:03:00.000Z";
    h.sessionRows[0]!.fileSize = 1_026;
    await h.adapter.readTask(key(), true);
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    await h.adapter.readTask(key(), true);
    pendingInfo.resolve(h.sessionRows[0]!);

    await expect(acknowledgement)
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.rename(key(), "still blocked"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
  });

  it("stops a mutation when an automatic read latches drift during writer validation", async () => {
    const h = harness();
    await h.adapter.readTask(key(), true);
    const pendingInfo = deferred<(typeof h.sessionRows)[number] | null>();
    const callsBeforeRename = h.helpers.getSessionInfo.mock.calls.length;
    h.helpers.getSessionInfo.mockImplementationOnce(async () => pendingInfo.promise);
    const rename = h.adapter.rename(key(), "must not dispatch");
    await vi.waitFor(() => {
      expect(h.helpers.getSessionInfo).toHaveBeenCalledTimes(callsBeforeRename + 1);
    });

    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    await h.adapter.readTask(key(), true);
    pendingInfo.resolve(h.sessionRows[0]!);

    await expect(rename).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });

  it("accepts an unchanged exact acknowledgement retry but rejects it after later drift", async () => {
    const h = harness();
    await h.adapter.readTask(key(), true);
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;
    await expect(h.adapter.rename(key(), "latch"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const reviewed = await h.adapter.readTask(key(), true);

    await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);
    await expect(h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint))
      .resolves.toBeUndefined();

    h.sessionRows[0]!.updatedAt = "2026-07-13T17:03:00.000Z";
    h.sessionRows[0]!.fileSize = 1_026;
    await expect(h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
  });

  it("publishes crash diagnostics before detaching the dead generation despite a live subscriber", async () => {
    const h = harness();
    const events: ProviderEvent[] = [];
    const unsubscribe = await h.adapter.subscribe(key(), (event) => events.push(event));
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "uncertain turn" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: TURN_A,
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "status", status: "runtime_failure_uncertain" }),
      expect.objectContaining({
        type: "diagnostic",
        level: "error",
        code: "CLAUDE_RUNTIME_MUTATION_UNCERTAIN",
      }),
    ]);
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(0);
    await nextTurn();
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
    expect(h.supervisor.acquire).toHaveBeenCalledTimes(1);
    await unsubscribe();
  });

  it("blocks reentrant owned control after a crash latch before terminal detachment", async () => {
    const h = harness();
    let reentrant: Promise<void> | null = null;
    const response: ProviderRequestResponse = {
      kind: "file-change-approval",
      identity: {
        key: key(),
        generation: 1,
        turnId: TURN_A,
        requestId: "request-1",
        itemId: "item-1",
        approvalId: "approval-1",
      },
      decision: "deny",
    };
    const unsubscribe = await h.adapter.subscribe(key(), (event) => {
      if (
        event.type === "status" &&
        event.status === "runtime_failure_uncertain" &&
        reentrant === null
      ) {
        reentrant = h.adapter.respond(response);
      }
    });
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "uncertain turn" });

    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: TURN_A,
    });

    expect(reentrant).not.toBeNull();
    await expect(reentrant!).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.runtimeLeases[0]?.responses).toEqual([]);
    await unsubscribe();
  });

  it("keeps unsupported native archive, steering, and unadvertised approval capabilities honest", async () => {
    const h = harness();
    await expect(h.adapter.archive(key())).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(h.adapter.steer(key(), TURN_A, { text: "late" }))
      .rejects.toBeInstanceOf(ProviderCapabilityError);
    expect((await h.adapter.capabilities()).approveFileChange).toBe(false);
  });

  it("fences resume against a revision cached before an external mutation", async () => {
    const h = harness();
    await h.adapter.readTask(key(), false);
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;

    await expect(resumeWithPlan(h)).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
    });
    expect(h.supervisor.acquire).not.toHaveBeenCalled();
    await expect(resumeWithPlan(h)).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
    });
    const reviewed = await h.adapter.readTask(key(), true);
    await expect(resumeWithPlan(h)).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
    });
    await h.adapter.acknowledgeReconciliation(key(), reviewed.revision!.fingerprint);
    await expect(resumeWithPlan(h)).resolves.toMatchObject({ key: key() });
  });

  it("rejects a conflicting concurrent runtime configuration while coalescing acquisition", async () => {
    const h = harness();
    const first = resumeWithPlan(h, key(), { model: "claude-a" });
    const conflicting = resumeWithPlan(h, key(), { model: "claude-b" });

    await expect(first).resolves.toMatchObject({ key: key() });
    await expect(conflicting).rejects.toMatchObject({ code: "OWNERSHIP" });
    expect(h.supervisor.acquire).toHaveBeenCalledTimes(1);
    expect(h.supervisor.acquire).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: "claude-a",
    }));
  });

  it("does not adopt an already-existing generated native id", async () => {
    const h = harness();
    h.sessionRows.push(summary({ sessionId: FORK }));

    await expect(startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "must not collide" },
    })).rejects.toMatchObject({ code: "OWNERSHIP" });
    expect(h.supervisor.acquire).not.toHaveBeenCalled();
  });

  it("recognizes its own session creation before dispatching the first envelope", async () => {
    const h = harness();
    const acquire = h.supervisor.acquire.getMockImplementation()!;
    h.supervisor.acquire.mockImplementationOnce(async (options) => {
      h.sessionRows.push(summary({ sessionId: FORK }));
      return acquire(options);
    });

    await expect(startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "start after creation" },
    })).resolves.toMatchObject({ key: key(FORK) });
    expect(h.runtimeLeases[0]?.sends).toEqual([{ text: "start after creation" }]);
  });

  it("buffers an owned startup event until the supervisor lease generation is verified", async () => {
    const h = harness();
    const events: ProviderEvent[] = [];
    await h.adapter.subscribe(key(), (event) => events.push(event));
    const acquire = h.supervisor.acquire.getMockImplementation()!;
    const startupEvent = {
      provider: "anthropic" as const,
      key: key(),
      occurredAt: UPDATED,
      type: "status" as const,
      scope: "task" as const,
      status: "starting",
      nativeId: SESSION,
    };
    h.supervisor.acquire.mockImplementationOnce(async (options) => {
      options.handlers.emit(startupEvent);
      return acquire(options);
    });

    await resumeWithPlan(h);
    expect(events).toEqual([startupEvent]);
  });

  it("drops foreign runtime events and releases runtime and writer leases when disabled", async () => {
    const h = harness();
    const events: ProviderEvent[] = [];
    await h.adapter.subscribe(key(), (event) => events.push(event));
    await resumeWithPlan(h);
    h.emit({
      provider: "anthropic",
      key: key(FORK),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    expect(events).toEqual([]);

    h.setEnabled(false);
    await h.adapter.refreshEnabled();
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
    await expect(h.adapter.capabilities()).resolves.toEqual(defineProviderCapabilities());
  });

  it("releases both ownership layers when post-acquire revision refresh fails", async () => {
    const h = harness();
    h.helpers.getSessionInfo
      .mockResolvedValueOnce(summary())
      .mockResolvedValueOnce(summary())
      .mockRejectedValueOnce(new Error("sensitive provider failure"));

    await expect(resumeWithPlan(h)).rejects.toMatchObject({ code: "OWNERSHIP" });
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("reconciles a supervised resume through a live writer fence", async () => {
    const h = harness();

    await h.adapter.reconcile({
      configHome: HOME,
      cwd: CWD,
      sessionId: SESSION,
      generation: 1,
      reason: "resume",
    });

    expect(h.writerHandles[0]?.confirmReread).toHaveBeenCalledTimes(1);
    expect(h.writerHandles[0]?.runFencedWrite).toHaveBeenCalledTimes(1);
  });

  it("does not mistake owned in-turn transcript growth for an external control conflict", async () => {
    const h = harness();
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "continue" });
    h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    h.sessionRows[0]!.fileSize = 1_025;

    await expect(h.adapter.interrupt(key(), TURN_A)).resolves.toBeUndefined();
    expect(h.runtimeLeases[0]?.interrupts).toEqual([TURN_A]);
    expect(h.writerHandles[0]?.runFencedWrite).toHaveBeenCalled();
  });

  it("keeps a requested model unclaimed until actual model evidence exists", async () => {
    const h = harness();

    const task = await startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      model: "requested-only",
      input: { text: "start with requested model" },
    });
    expect(task.model).toBeNull();
  });

  it("surfaces model divergence once as a value-free terminal diagnostic", async () => {
    const h = harness();
    const events: ProviderEvent[] = [];
    await h.adapter.subscribe(key(), (event) => events.push(event));
    await resumeWithPlan(h);
    vi.spyOn(h.runtimeLeases[0]!, "modelEvidence").mockReturnValue({
      observations: Object.freeze([]),
      bySource: Object.freeze({
        requested: Object.freeze([]),
        "system-init": Object.freeze([]),
        "stream-message-start": Object.freeze([]),
        "assistant-message": Object.freeze([]),
        "result-model-usage": Object.freeze([]),
        "result-total-usage": Object.freeze([]),
      }),
      distinctModels: Object.freeze(["sensitive-requested-model", "sensitive-billed-model"]),
      hasDivergence: true,
    });
    const terminal = {
      provider: "anthropic" as const,
      key: key(),
      occurredAt: UPDATED,
      type: "status" as const,
      scope: "turn" as const,
      status: "success",
      nativeId: TURN_A,
    };

    h.emit(terminal);
    h.emit(terminal);
    await nextTurn();

    expect(events[0]).toEqual(terminal);
    expect(events.filter((event) =>
      event.type === "diagnostic" && event.code === "CLAUDE_MODEL_DIVERGENCE"))
      .toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("sensitive-requested-model");
    expect(JSON.stringify(events)).not.toContain("sensitive-billed-model");
  });

  it("coalesces terminal refreshes, drains dirty work, and avoids self-latching owned revision", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await resumeWithPlan(h);
    const firstRefresh = deferred<ReturnType<typeof summary> | null>();
    const advanced = summary({
      updatedAt: "2026-07-13T17:02:00.000Z",
      fileSize: 1_025,
    });
    let refreshCalls = 0;
    h.helpers.getSessionInfo.mockClear();
    h.helpers.getSessionInfo.mockImplementation(async () => {
      refreshCalls += 1;
      return refreshCalls === 1 ? firstRefresh.promise : advanced;
    });
    const terminal: ProviderEvent = {
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    };

    h.emit(terminal);
    h.emit(terminal);
    await nextTurn();
    expect(h.helpers.getSessionInfo).toHaveBeenCalledTimes(1);

    h.sessionRows[0]!.updatedAt = advanced.updatedAt;
    h.sessionRows[0]!.fileSize = advanced.fileSize;
    const renameOutcome = h.adapter.rename(key(), "Owned refresh is current").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await nextTurn();
    expect(h.helpers.getSessionInfo).toHaveBeenCalledTimes(1);

    firstRefresh.resolve(summary());
    await nextTurn();
    await nextTurn();
    await nextTurn();
    expect(h.helpers.getSessionInfo.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await renameOutcome).toEqual({ ok: true });
    await unsubscribe();
  });

  it("does not lose a dirty refresh in the promise-finalization microtask window", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await resumeWithPlan(h);
    const firstRefresh = deferred<ReturnType<typeof summary> | null>();
    let refreshCalls = 0;
    h.helpers.getSessionInfo.mockClear();
    h.helpers.getSessionInfo.mockImplementation(async () => {
      refreshCalls += 1;
      return refreshCalls === 1 ? firstRefresh.promise : summary();
    });
    const terminal: ProviderEvent = {
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    };

    h.emit(terminal);
    firstRefresh.resolve(summary());
    await nextMicrotasks(6);
    h.emit(terminal);
    await nextTurn();
    await nextTurn();

    expect(h.helpers.getSessionInfo).toHaveBeenCalledTimes(2);
    await unsubscribe();
  });

  it("preserves public operation codes and a verified partial start through ProviderRegistry", async () => {
    const h = harness();
    const acquire = h.supervisor.acquire.getMockImplementation()!;
    h.supervisor.acquire.mockImplementationOnce(async (options) => {
      const lease = await acquire(options);
      vi.spyOn(lease, "send").mockRejectedValueOnce(
        new Error("Bearer sensitive-provider-failure"),
      );
      return lease;
    });
    const registry = new ProviderRegistry();
    registry.register(HOME, h.adapter);

    const error = await registry.startTask("anthropic", {
      home: HOME,
      cwd: CWD,
      permissionMode: "plan",
      input: { text: "create once" },
    }).catch((reason: unknown) => reason) as ProviderOperationError;

    expect(error).toBeInstanceOf(ProviderOperationError);
    expect(error).toMatchObject({
      code: "PARTIAL_START",
      task: { key: key(FORK), model: null },
    });
    expect(JSON.stringify(error)).not.toContain("sensitive-provider-failure");
  });

  it("preserves invalid, stale-policy, and uncertain-mutation semantics through ProviderRegistry", async () => {
    const invalid = harness();
    const invalidRegistry = new ProviderRegistry();
    invalidRegistry.register(HOME, invalid.adapter);
    await expect(invalidRegistry.startTask("anthropic", {
      home: HOME,
      cwd: "relative",
      permissionMode: "plan",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const stale = harness();
    const staleRegistry = new ProviderRegistry();
    staleRegistry.register(HOME, stale.adapter);
    await staleRegistry.readTask(key(), false);
    stale.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
    stale.sessionRows[0]!.fileSize = 1_025;
    await expect(staleRegistry.rename(key(), "Renamed"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });

    const uncertain = harness();
    uncertain.helpers.renameSession.mockRejectedValueOnce(
      new Error("Bearer sensitive-mutation-error"),
    );
    const uncertainRegistry = new ProviderRegistry();
    uncertainRegistry.register(HOME, uncertain.adapter);
    const error = await uncertainRegistry.rename(key(), "Renamed")
      .catch((reason: unknown) => reason) as ProviderOperationError;
    expect(error).toMatchObject({
      code: "MUTATION_UNCERTAIN",
      message: "Provider mutation outcome is uncertain; do not retry automatically",
    });
    expect(JSON.stringify(error)).not.toContain("sensitive-mutation-error");
  });

  it("does not label a start as partial before an initialized native id is known", async () => {
    const h = harness();
    h.supervisor.acquire.mockRejectedValueOnce(new Error("pre-init failure"));
    const registry = new ProviderRegistry();
    registry.register(HOME, h.adapter);

    const error = await registry.startTask("anthropic", {
      home: HOME,
      cwd: CWD,
      permissionMode: "plan",
      input: { text: "not initialized" },
    }).catch((reason: unknown) => reason) as ProviderOperationError;

    expect(error).toBeInstanceOf(ProviderOperationError);
    expect(error.code).toBe("OWNERSHIP");
    expect(error.task).toBeUndefined();
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("fully evicts failed pre-init starts so repeated failures cannot consume task capacity", async () => {
    const h = harness();
    h.supervisor.acquire.mockRejectedValue(new Error("pre-init failure"));

    for (let attempt = 0; attempt < 257; attempt += 1) {
      await expect(startWithPlan(h, {
        home: HOME,
        cwd: CWD,
        input: { text: "fail before init" },
      })).rejects.toMatchObject({ code: "OWNERSHIP" });
    }

    expect(h.supervisor.acquire).toHaveBeenCalledTimes(257);
    expect(h.writerHandles).toHaveLength(257);
    for (const writer of h.writerHandles) {
      expect(writer.release).toHaveBeenCalledTimes(1);
    }
  });

  it("projects a distinct verified id when fork creation succeeds but reread is partial", async () => {
    const h = harness();
    const registry = new ProviderRegistry();
    registry.register(HOME, h.adapter);

    const error = await registry.forkTask(key(), ITEM_A)
      .catch((reason: unknown) => reason) as ProviderOperationError;

    expect(error).toBeInstanceOf(ProviderOperationError);
    expect(error).toMatchObject({
      code: "PARTIAL_FORK",
      task: { key: key(FORK), model: null },
    });
    await expect(h.adapter.rename(key(), "source remains frozen"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.rename(key(FORK), "target remains frozen"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });

  it("rejects a fork before dispatch when source and target cannot both be tracked", async () => {
    const h = harness(true, 1);
    h.sessionRows.push(summary({ sessionId: FORK, title: "Capacity fork" }));

    await expect(h.adapter.forkTask(key(), ITEM_A))
      .rejects.toMatchObject({ code: "SUBSCRIPTION_CAPACITY" });
    expect(h.helpers.forkSession).not.toHaveBeenCalled();
  });

  it("pins the inserted fork target until source verification completes", async () => {
    const h = harness(true, 2);
    h.sessionRows.push(summary({ sessionId: FORK, title: "Pinned fork" }));
    const sourceVerification = deferred<void>();
    const sourceVerificationStarted = deferred<void>();
    let forkDispatched = false;
    h.helpers.forkSession.mockImplementationOnce(async () => {
      forkDispatched = true;
      return FORK;
    });
    h.helpers.getSessionInfo.mockImplementation(async (id: string) => {
      if (id === SESSION && forkDispatched) {
        sourceVerificationStarted.resolve();
        await sourceVerification.promise;
      }
      return h.sessionRows.find((row) => row.sessionId === id) ?? null;
    });

    const forking = h.adapter.forkTask(key(), ITEM_A);
    await sourceVerificationStarted.promise;
    h.sessionRows.push(summary({ sessionId: THIRD, title: "Competing read" }));
    await expect(h.adapter.readTask(key(THIRD), true))
      .rejects.toMatchObject({ code: "SUBSCRIPTION_CAPACITY" });
    sourceVerification.resolve();
    await expect(forking).resolves.toMatchObject({ key: key(FORK) });
  });

  it("freezes both tasks when the fork helper returns a locally tracked target id", async () => {
    const h = harness();
    h.sessionRows.push(summary({ sessionId: FORK, title: "Existing target" }));
    await h.adapter.readTask(key(FORK), false);

    await expect(h.adapter.forkTask(key(), ITEM_A)).rejects.toMatchObject({
      code: "PARTIAL_FORK",
      task: { key: key(FORK) },
    });
    await expect(h.adapter.rename(key(), "source collision review"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.rename(key(FORK), "target collision review"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.forkSession).toHaveBeenCalledTimes(1);
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });

  it("does not let either concurrent source claim a shared fork target", async () => {
    const h = harness();
    h.sessionRows.push(
      summary({ sessionId: THIRD, title: "Second source" }),
      summary({ sessionId: FORK, title: "Shared target" }),
    );
    const firstSourceVerification = deferred<void>();
    const firstSourceVerificationStarted = deferred<void>();
    let firstForkDispatched = false;
    h.helpers.forkSession.mockImplementation(async (sourceId: string) => {
      if (sourceId === SESSION) firstForkDispatched = true;
      return FORK;
    });
    h.helpers.getSessionInfo.mockImplementation(async (id: string) => {
      if (id === SESSION && firstForkDispatched) {
        firstSourceVerificationStarted.resolve();
        await firstSourceVerification.promise;
      }
      return h.sessionRows.find((row) => row.sessionId === id) ?? null;
    });

    const first = h.adapter.forkTask(key(), ITEM_A);
    await firstSourceVerificationStarted.promise;
    const second = h.adapter.forkTask(key(THIRD), ITEM_A);
    await expect(second).rejects.toMatchObject({
      code: "PARTIAL_FORK",
      task: { key: key(FORK) },
    });
    firstSourceVerification.resolve();
    await expect(first).rejects.toMatchObject({
      code: "PARTIAL_FORK",
      task: { key: key(FORK) },
    });
    expect(h.helpers.forkSession).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly 4096 helper messages and rejects a hidden 4097th row", async () => {
    const allMessages = Array.from({ length: 4_097 }, (_, index) => ({
      id: `${index.toString(16).padStart(8, "0")}-18c0-7b60-8f0c-6afc120ecd7d`,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message ${index}`,
    }));
    const installHistory = (
      h: ReturnType<typeof harness>,
      count: number,
    ) => h.helpers.getSessionMessages.mockImplementation(async (
      _id: string,
      options: { limit?: number; offset?: number } = {},
    ) => {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return {
        messages: allMessages.slice(0, count).slice(offset, offset + limit),
        limit,
        offset,
        rawCount: allMessages.slice(0, count).slice(offset, offset + limit).length,
      };
    });

    const exact = harness();
    installHistory(exact, 4_096);
    await expect(exact.adapter.readTask(key(), false)).resolves.toMatchObject({ key: key() });
    expect(exact.helpers.getSessionMessages).toHaveBeenLastCalledWith(
      SESSION,
      { limit: 1, offset: 4_096 },
    );

    const overflow = harness();
    installHistory(overflow, 4_097);
    await expect(overflow.adapter.readTask(key(), false)).rejects.toMatchObject({
      code: "OWNERSHIP",
    });
    expect(overflow.helpers.getSessionMessages).toHaveBeenLastCalledWith(
      SESSION,
      { limit: 1, offset: 4_096 },
    );
  });

  it("advances history pages by raw rows even when valid non-text rows are skipped", async () => {
    const h = harness();
    h.helpers.getSessionMessages.mockImplementation(async (
      _id: string,
      options: { limit?: number; offset?: number } = {},
    ) => {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      if (offset === 0) {
        return {
          messages: [{ id: ITEM_A, role: "user" as const, text: "first text row" }],
          limit,
          offset,
          rawCount: 200,
        };
      }
      if (offset === 200) {
        return {
          messages: [{ id: ITEM_B, role: "assistant" as const, text: "later text row" }],
          limit,
          offset,
          rawCount: 1,
        };
      }
      throw new Error("unexpected raw offset");
    });

    const task = await h.adapter.readTask(key(), true);
    expect(task.turns[0]?.events).toMatchObject([
      { itemId: ITEM_A, text: "first text row" },
      { itemId: ITEM_B, text: "later text row" },
    ]);
    expect(h.helpers.getSessionMessages).toHaveBeenNthCalledWith(
      2,
      SESSION,
      { limit: 200, offset: 200 },
    );
  });

  it("rejects a non-text raw row beyond the 4096-row history boundary", async () => {
    const h = harness();
    h.helpers.getSessionMessages.mockImplementation(async (
      _id: string,
      options: { limit?: number; offset?: number } = {},
    ) => {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return {
        messages: [],
        limit,
        offset,
        rawCount: offset === 4_096 ? 1 : limit,
      };
    });

    await expect(h.adapter.readTask(key(), false)).rejects.toMatchObject({ code: "OWNERSHIP" });
    expect(h.helpers.getSessionMessages).toHaveBeenLastCalledWith(
      SESSION,
      { limit: 1, offset: 4_096 },
    );
  });

  it.each([
    ["lease key", { leaseKey: key(FORK) }],
    ["fence key", { fenceKey: key(FORK) }],
    ["unsafe epoch", { epoch: 0 }],
    ["callback fence", { callbackFenceKey: key(FORK) }],
    ["callback epoch", { callbackEpoch: 2 }],
  ] as const)("rejects a writer with an invalid %s before native dispatch", async (_label, overrides) => {
    const h = harness();
    h.writerLeases.acquire.mockImplementationOnce((acquiredKey) =>
      h.createWriterHandle(acquiredKey, overrides));

    await expect(h.adapter.rename(key(), "Renamed")).rejects.toMatchObject({
      code: "OWNERSHIP",
    });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("releases a lost writer and reacquires a strictly newer fence", async () => {
    const h = harness();
    h.writerLeases.acquire
      .mockImplementationOnce((acquiredKey) =>
        h.createWriterHandle(acquiredKey, { epoch: 2, started: false }))
      .mockImplementationOnce((acquiredKey) =>
        h.createWriterHandle(acquiredKey, { epoch: 3 }));

    await expect(h.adapter.rename(key(), "First")).rejects.toMatchObject({ code: "OWNERSHIP" });
    await expect(h.adapter.rename(key(), "Second")).resolves.toBeUndefined();

    expect(h.writerLeases.acquire).toHaveBeenCalledTimes(2);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
    expect(h.helpers.renameSession).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused writer epoch after loss and accepts only a newer retry", async () => {
    const h = harness();
    h.writerLeases.acquire
      .mockImplementationOnce((acquiredKey) =>
        h.createWriterHandle(acquiredKey, { epoch: 7, started: false }))
      .mockImplementationOnce((acquiredKey) =>
        h.createWriterHandle(acquiredKey, { epoch: 7 }))
      .mockImplementationOnce((acquiredKey) =>
        h.createWriterHandle(acquiredKey, { epoch: 8 }));

    await expect(h.adapter.rename(key(), "First")).rejects.toMatchObject({ code: "OWNERSHIP" });
    await expect(h.adapter.rename(key(), "Second")).rejects.toMatchObject({ code: "OWNERSHIP" });
    await expect(h.adapter.rename(key(), "Third")).resolves.toBeUndefined();

    expect(h.writerLeases.acquire).toHaveBeenCalledTimes(3);
    expect(h.helpers.renameSession).toHaveBeenCalledTimes(1);
  });

  it("checks availability again after async preflight before dispatching a disabled mutation", async () => {
    const h = harness();
    const entered = deferred<void>();
    const reread = deferred<ReturnType<typeof summary> | null>();
    h.helpers.getSessionInfo.mockImplementationOnce(async () => {
      entered.resolve();
      return reread.promise;
    });

    const mutation = h.adapter.rename(key(), "Must not dispatch");
    await entered.promise;
    h.setEnabled(false);
    reread.resolve(summary());

    await expect(mutation).rejects.toMatchObject({ code: "DISABLED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });

  it("checks availability again after async preflight before dispatching a disposed mutation", async () => {
    const h = harness();
    const entered = deferred<void>();
    const reread = deferred<ReturnType<typeof summary> | null>();
    h.helpers.getSessionInfo.mockImplementationOnce(async () => {
      entered.resolve();
      return reread.promise;
    });

    const mutation = h.adapter.rename(key(), "Must not dispatch");
    await entered.promise;
    const disposed = h.adapter.dispose();
    reread.resolve(summary());

    await expect(mutation).rejects.toMatchObject({ code: "DISPOSED" });
    await disposed;
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });

  it("serializes same-task asynchronous mutations before native dispatch", async () => {
    const h = harness();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const dispatches: string[] = [];
    h.helpers.renameSession.mockImplementation(async (_id, title) => {
      dispatches.push(title);
      if (title === "First") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      h.sessionRows[0]!.title = title;
    });

    const first = h.adapter.rename(key(), "First");
    await firstStarted.promise;
    const second = h.adapter.rename(key(), "Second");
    await nextTurn();
    expect(dispatches).toEqual(["First"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(dispatches).toEqual(["First", "Second"]);
  });

  it("releases and evicts writer-only mutation states instead of exhausting active-task capacity", async () => {
    const h = harness();
    const ids = Array.from({ length: 257 }, (_, index) =>
      `${index.toString(16).padStart(8, "0")}-18c0-7b60-8f0c-6afc120ecd7d`);
    h.sessionRows.splice(0, h.sessionRows.length, ...ids.map((sessionId) =>
      summary({ sessionId })));

    for (const [index, sessionId] of ids.entries()) {
      await expect(h.adapter.rename(key(sessionId), `Rename ${index}`)).resolves.toBeUndefined();
    }

    expect(h.writerHandles).toHaveLength(257);
    for (const writer of h.writerHandles) {
      expect(writer.release).toHaveBeenCalledTimes(1);
    }
  });

  it("releases idle runtime ownership when the last subscriber leaves", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await resumeWithPlan(h);

    await unsubscribe();
    await nextTurn();

    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "inProgress", "in_progress", "active"])(
    "retains turn control for the active %s status until an exact terminal status arrives",
    async (status) => {
      const h = harness();
      await resumeWithPlan(h);
      await h.adapter.send(key(), { text: "continue" });

      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "status",
        scope: "turn",
        status,
        nativeId: TURN_A,
      });
      await nextTurn();
      expect(h.runtimeLeases[0]?.releaseCalls).toBe(0);
      await expect(h.adapter.interrupt(key(), TURN_A)).resolves.toBeUndefined();

      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "status",
        scope: "turn",
        status: "success",
        nativeId: TURN_A,
      });
      await nextTurn();
      expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
      expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
    },
  );

  it("defers terminal release until the provider event batch has unwound", async () => {
    const h = harness();
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "continue" });

    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });

    expect(h.runtimeLeases[0]?.releaseCalls).toBe(0);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(0);
    await nextTurn();
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("checks terminal model divergence only after the provider batch commits evidence", async () => {
    const h = harness();
    const events: ProviderEvent[] = [];
    const unsubscribe = await h.adapter.subscribe(key(), (event) => events.push(event));
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "continue" });
    let diverged = false;
    vi.spyOn(h.runtimeLeases[0]!, "modelEvidence").mockImplementation(() => ({
      observations: Object.freeze([]),
      bySource: Object.freeze({
        requested: Object.freeze([]),
        "system-init": Object.freeze([]),
        "stream-message-start": Object.freeze([]),
        "assistant-message": Object.freeze([]),
        "result-model-usage": Object.freeze([]),
        "result-total-usage": Object.freeze([]),
      }),
      distinctModels: Object.freeze(["claude-a", "claude-b"]),
      hasDivergence: diverged,
    }));

    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    diverged = true;
    expect(events.some((event) => event.type === "diagnostic" &&
      event.code === "CLAUDE_MODEL_DIVERGENCE")).toBe(false);
    await nextTurn();
    expect(events.filter((event) => event.type === "diagnostic" &&
      event.code === "CLAUDE_MODEL_DIVERGENCE")).toHaveLength(1);
    await unsubscribe();
  });

  it("remembers a synchronous terminal send event and releases after mutation bookkeeping drains", async () => {
    const h = harness();
    await resumeWithPlan(h);
    vi.spyOn(h.runtimeLeases[0]!, "send").mockImplementationOnce(async (input) => {
      h.runtimeLeases[0]!.sends.push(input);
      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "status",
        scope: "turn",
        status: "success",
        nativeId: TURN_A,
      });
      return { taskKey: key(), turnId: TURN_A };
    });

    await h.adapter.send(key(), { text: "complete synchronously" });
    await nextTurn();

    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("overlays public readTask history with the current active helper-turn identity", async () => {
    const h = harness();
    await resumeWithPlan(h);
    vi.spyOn(h.runtimeLeases[0]!, "send").mockResolvedValueOnce({
      taskKey: key(),
      turnId: ITEM_A,
    });
    await h.adapter.send(key(), { text: "continue existing turn" });

    const projected = await h.adapter.readTask(key(), true);
    expect(projected.status).toBe("active");
    expect(projected.turns).toHaveLength(1);
    expect(projected.turns[0]).toMatchObject({ id: ITEM_A, status: "active" });
    expect(projected.turns[0]?.events).toHaveLength(2);
  });

  it("retains active and background work until every native activity is terminal", async () => {
    const h = harness();
    const unsubscribe = await h.adapter.subscribe(key(), () => undefined);
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "continue" });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "activity",
      turnId: TURN_A,
      itemId: ITEM_A,
      activity: "background-agent",
      status: "running",
      message: null,
    });

    await unsubscribe();
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    await nextTurn();
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(0);

    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "activity",
      turnId: TURN_A,
      itemId: ITEM_A,
      activity: "background-agent",
      status: "completed",
      message: null,
    });
    await nextTurn();
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);
    expect(h.writerHandles[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("releases a terminal task without subscribers and reacquires it as resume", async () => {
    const h = harness();
    const acquire = h.supervisor.acquire.getMockImplementation()!;
    h.supervisor.acquire.mockImplementationOnce(async (options) => {
      h.sessionRows.push(summary({ sessionId: FORK }));
      return acquire(options);
    });
    await startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "first" },
    });
    h.emit({
      provider: "anthropic",
      key: key(FORK),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    await nextTurn();
    expect(h.runtimeLeases[0]?.releaseCalls).toBe(1);

    await h.adapter.send(key(FORK), { text: "second" });
    expect(h.supervisor.acquire).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: FORK,
      launch: "resume",
    }));
  });

  it("gives each subscriber its own bounded first-turn replay snapshot", async () => {
    const h = harness();
    const acquire = h.supervisor.acquire.getMockImplementation()!;
    const firstMessage: ProviderEvent = {
      provider: "anthropic",
      key: key(FORK),
      occurredAt: UPDATED,
      type: "message",
      role: "assistant",
      text: "first event",
      turnId: TURN_A,
      itemId: ITEM_A,
    };
    const firstRequest: ProviderEvent = {
      provider: "anthropic",
      key: key(FORK),
      occurredAt: UPDATED,
      type: "request",
      request: {
        kind: "file-change-approval",
        identity: {
          key: key(FORK),
          generation: 1,
          turnId: TURN_A,
          requestId: "request-1",
          itemId: ITEM_B,
          approvalId: "approval-1",
        },
      },
    };
    h.supervisor.acquire.mockImplementationOnce(async (options) => {
      const lease = await acquire(options);
      vi.spyOn(lease, "send").mockImplementationOnce(async (input) => {
        lease.sends.push(input);
        h.sessionRows.push(summary({ sessionId: FORK }));
        options.handlers.emit(firstMessage);
        options.handlers.emit(firstRequest);
        return { taskKey: key(FORK), turnId: TURN_A };
      });
      return lease;
    });

    const started = await startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "start" },
    });
    const activeTurn = started.turns.find((turn) => turn.id === TURN_A);
    expect(activeTurn).toMatchObject({ id: TURN_A, status: "active" });

    const replayed: ProviderEvent[] = [];
    const unsubscribe = await h.adapter.subscribe(key(FORK), (event) => replayed.push(event));
    expect(replayed).toEqual([firstMessage, firstRequest]);
    await h.adapter.interrupt(key(FORK), activeTurn!.id);
    expect(h.runtimeLeases[0]?.interrupts).toEqual([TURN_A]);
    await unsubscribe();

    const secondReplay: ProviderEvent[] = [];
    await h.adapter.subscribe(key(FORK), (event) => secondReplay.push(event));
    expect(secondReplay).toEqual([firstMessage, firstRequest]);
    expect(Object.isFrozen(secondReplay[1])).toBe(true);
  });

  it("installs a quarantined subscriber before async validation and flushes in order", async () => {
    const h = harness();
    await resumeWithPlan(h);
    const entered = deferred<void>();
    const validation = deferred<ReturnType<typeof summary> | null>();
    h.helpers.getSessionInfo.mockImplementationOnce(async () => {
      entered.resolve();
      return validation.promise;
    });
    const events: ProviderEvent[] = [];
    const subscribing = h.adapter.subscribe(key(), (event) => events.push(event));
    await entered.promise;
    const duringValidation: ProviderEvent = {
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "message",
      role: "assistant",
      text: "during validation",
      turnId: null,
      itemId: ITEM_A,
    };
    h.emit(duringValidation);
    validation.resolve(summary());

    await subscribing;
    expect(events).toEqual([duringValidation]);
  });

  it("rolls back failed subscription validation and permits a later valid retry", async () => {
    const h = harness();
    await expect(h.adapter.subscribe(key(FORK), () => undefined)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    h.sessionRows.push(summary({ sessionId: FORK }));

    const unsubscribe = await h.adapter.subscribe(key(FORK), () => undefined);
    await expect(unsubscribe()).resolves.toBeUndefined();
  });

  it("fails a quarantined subscription rather than silently truncating its event buffer", async () => {
    const h = harness();
    await resumeWithPlan(h);
    const entered = deferred<void>();
    const validation = deferred<ReturnType<typeof summary> | null>();
    h.helpers.getSessionInfo.mockImplementationOnce(async () => {
      entered.resolve();
      return validation.promise;
    });
    const events: ProviderEvent[] = [];
    const subscribing = h.adapter.subscribe(key(), (event) => events.push(event));
    await entered.promise;
    for (let index = 0; index < 257; index += 1) {
      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "message",
        role: "assistant",
        text: `event ${index}`,
        turnId: null,
        itemId: `item-${index}`,
      });
    }
    validation.resolve(summary());

    await expect(subscribing).rejects.toMatchObject({ code: "SUBSCRIPTION_CAPACITY" });
    expect(events).toEqual([]);
  });

  it("latches replay overflow when event 257 arrives before any subscriber", async () => {
    const h = harness();
    await resumeWithPlan(h);
    for (let index = 0; index < 257; index += 1) {
      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "message",
        role: "assistant",
        text: `replay ${index}`,
        turnId: TURN_A,
        itemId: `item-${index}`,
      });
    }

    const events: ProviderEvent[] = [];
    await expect(h.adapter.subscribe(key(), (event) => events.push(event)))
      .rejects.toMatchObject({ code: "SUBSCRIPTION_CAPACITY" });
    expect(events).toEqual([]);
  });

  it("retires resolved approval replay before a later subscriber validates", async () => {
    const h = harness();
    await resumeWithPlan(h);
    const identity = {
      key: key(),
      generation: 1,
      turnId: TURN_A,
      requestId: "request-1",
      itemId: ITEM_A,
      approvalId: "approval-1",
    } as const;
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "request",
      request: { kind: "file-change-approval", identity },
    });
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "request-resolved",
      identity,
    });

    const replayed: ProviderEvent[] = [];
    await h.adapter.subscribe(key(), (event) => replayed.push(event));
    expect(replayed).toEqual([]);
  });

  it("clears replay overflow at an exact terminal turn boundary", async () => {
    const h = harness();
    await resumeWithPlan(h);
    await h.adapter.send(key(), { text: "run" });
    for (let index = 0; index < 257; index += 1) {
      h.emit({
        provider: "anthropic",
        key: key(),
        occurredAt: UPDATED,
        type: "message",
        role: "assistant",
        text: `replay ${index}`,
        turnId: TURN_A,
        itemId: `item-${index}`,
      });
    }
    h.emit({
      provider: "anthropic",
      key: key(),
      occurredAt: UPDATED,
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: TURN_A,
    });
    await nextTurn();

    const replayed: ProviderEvent[] = [];
    await expect(h.adapter.subscribe(key(), (event) => replayed.push(event))).resolves.toEqual(
      expect.any(Function),
    );
    expect(replayed).toEqual([]);
  });

  it("never permits missing native state after a new task was observed persisted", async () => {
    const h = harness();
    const acquire = h.supervisor.acquire.getMockImplementation()!;
    h.supervisor.acquire.mockImplementationOnce(async (options) => {
      h.sessionRows.push(summary({ sessionId: FORK }));
      return acquire(options);
    });
    await startWithPlan(h, {
      home: HOME,
      cwd: CWD,
      input: { text: "persist me" },
    });
    h.sessionRows.splice(h.sessionRows.findIndex((row) => row.sessionId === FORK), 1);

    await expect(h.adapter.send(key(FORK), { text: "after delete" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.send(key(FORK), { text: "retry after delete" }))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.reconcile({
      configHome: HOME,
      cwd: CWD,
      sessionId: FORK,
      generation: 2,
      reason: "restart",
    })).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.runtimeLeases[0]?.sends).toHaveLength(1);
  });

  it("returns PARTIAL_START with the known task when final projection fails", async () => {
    const h = harness();
    let generatedReads = 0;
    h.helpers.getSessionInfo.mockImplementation(async (id) => {
      if (id === FORK) {
        generatedReads += 1;
        if (generatedReads === 5) throw new Error("post-dispatch projection failure");
      }
      return h.sessionRows.find((row) => row.sessionId === id) ?? null;
    });
    const registry = new ProviderRegistry();
    registry.register(HOME, h.adapter);

    const error = await registry.startTask("anthropic", {
      home: HOME,
      cwd: CWD,
      permissionMode: "plan",
      input: { text: "dispatch once" },
    }).catch((reason: unknown) => reason) as ProviderOperationError;
    expect(error).toMatchObject({
      code: "PARTIAL_START",
      task: { key: key(FORK) },
    });
    expect(error.task?.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: TURN_A }),
    ]));
  });

  it("treats a malformed post-send turn reference as mutation uncertainty", async () => {
    const h = harness();
    await resumeWithPlan(h);
    vi.spyOn(h.runtimeLeases[0]!, "send").mockResolvedValueOnce({
      taskKey: key(FORK),
      turnId: TURN_A,
    });

    await expect(h.adapter.send(key(), { text: "dispatch" })).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
    });
  });

  it("treats rename verification failure after dispatch as mutation uncertainty", async () => {
    const h = harness();
    h.helpers.getSessionInfo
      .mockResolvedValueOnce(summary())
      .mockRejectedValueOnce(new Error("post-write verification failed"));

    await expect(h.adapter.rename(key(), "Renamed")).rejects.toMatchObject({
      code: "MUTATION_UNCERTAIN",
    });
    expect(h.helpers.renameSession).toHaveBeenCalledTimes(1);
  });

  it("preserves known pre-dispatch turn failures without retry ambiguity", async () => {
    const h = harness();
    await resumeWithPlan(h);
    vi.spyOn(h.runtimeLeases[0]!, "send").mockRejectedValueOnce(
      Object.assign(new Error("safe"), { code: "TURN_ACTIVE" }),
    );
    await expect(h.adapter.send(key(), { text: "blocked" })).rejects.toMatchObject({
      code: "UNSUPPORTED_INTERACTION",
    });

    vi.spyOn(h.runtimeLeases[0]!, "interrupt").mockRejectedValueOnce(
      Object.assign(new Error("safe"), { code: "TURN_MISMATCH" }),
    );
    await expect(h.adapter.interrupt(key(), TURN_A)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("maps malformed provider summaries to ownership failure", async () => {
    const malformedId = harness();
    malformedId.helpers.getSessionInfo.mockResolvedValueOnce(summary({ sessionId: "malformed" }));
    await expect(malformedId.adapter.readTask(key(), false)).rejects.toMatchObject({
      code: "OWNERSHIP",
    });

    const malformedTitle = harness();
    malformedTitle.helpers.getSessionInfo.mockResolvedValueOnce(summary({ title: "bad\u0000title" }));
    await expect(malformedTitle.adapter.readTask(key(), false)).rejects.toMatchObject({
      code: "OWNERSHIP",
    });
  });

  it("returns a partial fork and latches source drift detected after creation", async () => {
    const h = harness();
    h.helpers.forkSession.mockImplementationOnce(async () => {
      h.sessionRows[0]!.updatedAt = "2026-07-13T17:02:00.000Z";
      h.sessionRows[0]!.fileSize = 1_025;
      h.sessionRows.push(summary({ sessionId: FORK, title: "Fork" }));
      return FORK;
    });
    const registry = new ProviderRegistry();
    registry.register(HOME, h.adapter);

    const error = await registry.forkTask(key(), ITEM_A)
      .catch((reason: unknown) => reason) as ProviderOperationError;
    expect(error).toMatchObject({
      code: "PARTIAL_FORK",
      task: { key: key(FORK) },
    });
    await expect(h.adapter.rename(key(), "Blocked source"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await expect(h.adapter.rename(key(FORK), "Blocked target"))
      .rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(h.helpers.renameSession).not.toHaveBeenCalled();
  });
});
