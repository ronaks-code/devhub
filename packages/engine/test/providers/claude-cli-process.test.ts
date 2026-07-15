import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CLI_INITIALIZE_REQUEST_ID,
  ClaudeCliProcess,
  ClaudeCliProcessError,
  type ClaudeCliChild,
  type ClaudeCliSpawn,
} from "../../src/providers/claude/cli-process.js";

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
  destroyCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;

  destroy(): this {
    this.destroyCalls += 1;
    return this;
  }

  pause(): this {
    this.pauseCalls += 1;
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    return this;
  }
}

class FakeWritable extends EventEmitter {
  writable = true;
  readonly writes: Buffer[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  readonly returns: boolean[] = [];
  deferCallbacks = false;
  endCalls = 0;

  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(chunk));
    if (callback) {
      if (this.deferCallbacks) this.callbacks.push(callback);
      else callback();
    }
    return this.returns.shift() ?? true;
  }

  end(): void {
    this.endCalls += 1;
    this.writable = false;
  }
}

class FakeChild extends EventEmitter implements ClaudeCliChild {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
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
}

interface HarnessOptions {
  readonly child?: FakeChild;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly maxFrameBytes?: number;
  readonly stderrMaxBytes?: number;
  readonly ingressLimits?: {
    readonly maxItems: number;
    readonly maxBytes: number;
    readonly pauseItems: number;
    readonly pauseBytes: number;
    readonly resumeItems: number;
    readonly resumeBytes: number;
  };
  readonly outboundLimits?: {
    readonly maxItems: number;
    readonly maxBytes: number;
    readonly maxFrameBytes: number;
  };
  readonly setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly envelopeHandlerTimeoutMs?: number;
  readonly spawnOutcomeTimeoutMs?: number;
  readonly onEnvelope?: (value: Readonly<Record<string, unknown>>) => void | Promise<void>;
  readonly launch?:
    | { readonly kind: "new"; readonly sessionId: string }
    | { readonly kind: "resume"; readonly sessionId: string };
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly permissionMode?: "manual" | "acceptEdits" | "auto" | "dontAsk" | "plan";
  readonly permissionPromptStdio?: boolean;
}

const createHarness = (options: HarnessOptions = {}) => {
  const child = options.child ?? new FakeChild();
  const timers = new FakeTimers();
  const spawnCalls: Array<{
    executable: string;
    args: readonly string[];
    options: Parameters<ClaudeCliSpawn>[2];
  }> = [];
  const spawnFn: ClaudeCliSpawn = (executable, args, spawnOptions) => {
    spawnCalls.push({ executable, args, options: spawnOptions });
    return child;
  };
  const process = new ClaudeCliProcess({
    executable: "/opt/claude/bin/claude",
    configHome: "/canonical/claude-home",
    cwd: "/workspace/project",
    baseEnv: options.baseEnv ?? { KEEP: "yes" },
    canonicalizeHome: (home) => home,
    spawnFn,
    setTimeoutFn: options.setTimeoutFn ?? timers.set,
    clearTimeoutFn: options.clearTimeoutFn ?? timers.clear,
    gracefulTimeoutMs: 10,
    sigintTimeoutMs: 20,
    sigtermTimeoutMs: 30,
    sigkillTimeoutMs: 40,
    exitDrainTimeoutMs: 50,
    envelopeHandlerTimeoutMs: options.envelopeHandlerTimeoutMs,
    spawnOutcomeTimeoutMs: options.spawnOutcomeTimeoutMs,
    maxFrameBytes: options.maxFrameBytes,
    stderrMaxBytes: options.stderrMaxBytes,
    ingressLimits: options.ingressLimits,
    outboundLimits: options.outboundLimits,
    onEnvelope: options.onEnvelope,
    launch: options.launch,
    model: options.model,
    effort: options.effort,
    permissionMode: options.permissionMode,
    permissionPromptStdio: options.permissionPromptStdio,
  });
  return {
    child,
    process,
    spawnCalls,
    timers,
    expectedSessionId: options.launch?.sessionId ?? null,
  };
};

/** The SDK control_response that acknowledges the `initialize` control_request every
 * ClaudeCliProcess sends immediately after spawn. This — not a pre-turn `system/init` —
 * is what start() now waits for. */
const emitInitializeSuccess = (harness: ReturnType<typeof createHarness>): void => {
  harness.child.stdout.emit("data", Buffer.from(`${JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: CLAUDE_CLI_INITIALIZE_REQUEST_ID },
  })}\n`));
};

const startReady = async (harness: ReturnType<typeof createHarness>): Promise<void> => {
  // The initialize control_request/response handshake writes to the same fake stdin
  // tests configure (deferCallbacks/returns) for their own post-ready assertions. Run
  // the handshake write against neutral stdin behavior, then erase its footprint and
  // restore whatever the harness had configured before handing control to the test.
  const stdin = harness.child.stdin;
  const priorDeferCallbacks = stdin.deferCallbacks;
  const priorReturns = stdin.returns.splice(0);
  stdin.deferCallbacks = false;

  const starting = harness.process.start();
  harness.child.emit("spawn");
  emitInitializeSuccess(harness);
  await starting;

  stdin.writes.splice(0);
  stdin.callbacks.splice(0);
  stdin.deferCallbacks = priorDeferCallbacks;
  stdin.returns.push(...priorReturns);
};

const closeFailedChild = async (
  harness: ReturnType<typeof createHarness>,
): Promise<void> => {
  harness.child.stdout.emit("end");
  harness.child.emit("exit", 1, null);
  harness.child.emit("close", 1, null);
  await harness.process.terminated;
};

describe("ClaudeCliProcess", () => {
  it("requires absolute installed paths and an already-canonical config home", () => {
    const child = new FakeChild();
    const base = {
      executable: "/opt/claude/bin/claude",
      configHome: "/canonical/home",
      cwd: "/workspace/project",
      canonicalizeHome: (home: string) => home,
      spawnFn: (() => child) as ClaudeCliSpawn,
    };

    expect(() => new ClaudeCliProcess({ ...base, executable: "claude" }))
      .toThrow(/executable.*absolute/i);
    expect(() => new ClaudeCliProcess({ ...base, configHome: "relative/home" }))
      .toThrow(/config home.*absolute/i);
    expect(() => new ClaudeCliProcess({
      ...base,
      configHome: "/home/../canonical/home",
      canonicalizeHome: () => "/canonical/home",
    })).toThrow(/config home.*canonical/i);
    expect(() => new ClaudeCliProcess(base)).not.toThrow();
  });

  it("spawns one persistent child with the exact installed-CLI contract", async () => {
    const baseEnv: NodeJS.ProcessEnv = {
      KEEP: "before",
      CLAUDE_CONFIG_DIR: "/wrong",
      CLAUDE_UI_CLAUDE_BIN: "/ambient/claude",
    };
    const harness = createHarness({ baseEnv });
    baseEnv.KEEP = "after";

    const firstStart = harness.process.start();
    const secondStart = harness.process.start();

    expect(secondStart).toBe(firstStart);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]).toEqual({
      executable: "/opt/claude/bin/claude",
      args: [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--include-hook-events",
        "--replay-user-messages",
        "--setting-sources", "user,project,local",
      ],
      options: {
        cwd: "/workspace/project",
        shell: false,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          KEEP: "before",
          CLAUDE_CONFIG_DIR: "/canonical/claude-home",
        },
      },
    });
    expect(Object.isFrozen(harness.spawnCalls[0]!.options.env)).toBe(true);

    for (const [emitter, events] of [
      [harness.child, ["spawn", "error", "exit", "close"]],
      [harness.child.stdin, ["error", "close"]],
      [harness.child.stdout, ["data", "error", "end", "close"]],
      [harness.child.stderr, ["data", "error", "end", "close"]],
    ] as const) {
      for (const event of events) expect(emitter.listenerCount(event)).toBeGreaterThan(0);
    }

    harness.child.emit("spawn");
    expect(harness.child.stdin.writes.map(String)).toEqual([
      `${JSON.stringify({
        type: "control_request",
        request_id: CLAUDE_CLI_INITIALIZE_REQUEST_ID,
        request: { subtype: "initialize" },
      })}\n`,
    ]);
    expect(harness.process.phase).toBe("starting");
    emitInitializeSuccess(harness);
    await firstStart;
    expect(harness.process.phase).toBe("ready");
  });

  it("appends only the exact allowlisted native launch profile", async () => {
    const sessionId = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
    const fresh = createHarness({
      launch: { kind: "new", sessionId },
      model: "claude-sonnet-5",
      effort: "high",
      permissionMode: "manual",
      permissionPromptStdio: true,
    });
    await startReady(fresh);
    expect(fresh.spawnCalls[0]?.args.slice(-10)).toEqual([
      "--effort", "high",
      "--model", "claude-sonnet-5",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", "manual",
      "--session-id", sessionId,
    ]);

    const resumed = createHarness({ launch: { kind: "resume", sessionId } });
    await startReady(resumed);
    expect(resumed.spawnCalls[0]?.args.slice(-2)).toEqual(["--resume", sessionId]);
    expect(Object.isFrozen(resumed.spawnCalls[0]?.args)).toBe(true);
  });

  it("rejects hostile launch values and dangerous permission bypass before spawning", () => {
    const sessionId = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
    const base = {
      executable: "/opt/claude/bin/claude",
      configHome: "/canonical/home",
      cwd: "/workspace/project",
      canonicalizeHome: (home: string) => home,
      spawnFn: (() => new FakeChild()) as ClaudeCliSpawn,
    };
    expect(() => new ClaudeCliProcess({
      ...base,
      launch: { kind: "resume", sessionId: "not-a-uuid" },
    })).toThrow(/launch/i);
    expect(() => new ClaudeCliProcess({ ...base, model: "sonnet\n--danger" }))
      .toThrow(/model/i);
    expect(() => new ClaudeCliProcess({ ...base, effort: "infinite" as never }))
      .toThrow(/effort/i);
    expect(() => new ClaudeCliProcess({
      ...base,
      permissionMode: "bypassPermissions" as never,
    })).toThrow(/permission mode/i);
    expect(() => new ClaudeCliProcess({
      ...base,
      permissionPromptStdio: "yes" as never,
    })).toThrow(/permission prompt/i);
    expect(() => new ClaudeCliProcess({
      ...base,
      launch: { kind: "new", sessionId, extra: true } as never,
    })).toThrow(/launch/i);
  });

  it("faults turn 1 (not startup) when its system/init reports a session mismatch", async () => {
    const expected = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
    const actual = "129f5b78-18c0-7b60-8f0c-6afc120ecd7d";
    const harness = createHarness({ launch: { kind: "resume", sessionId: expected } });
    await startReady(harness);
    expect(harness.process.phase).toBe("ready");

    harness.child.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: actual,
    })}\n`));
    await vi.waitFor(() => expect(harness.process.terminalError).toMatchObject({
      code: "MALFORMED_FRAME",
    }));
    expect(harness.process.sessionId).toBeNull();
    await closeFailedChild(harness);
  });

  it("stays non-ready until the SDK initialize control_response arrives", async () => {
    const harness = createHarness({ launch: { kind: "resume", sessionId: "019f5b78-18c0-7b60-8f0c-6afc120ecd7d" } });
    const starting = harness.process.start();
    let settled = false;
    void starting.then(() => { settled = true; });

    harness.child.emit("spawn");
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(harness.process.phase).toBe("starting");
    await expect(harness.process.writeEnvelope({ type: "user" })).rejects.toMatchObject({
      code: "NOT_READY",
    });
    expect(harness.process.sessionId).toBeNull();

    emitInitializeSuccess(harness);
    await expect(starting).resolves.toBeUndefined();
    expect(harness.process.phase).toBe("ready");
    expect(harness.process.sessionId).toBeNull();
  });

  it("bounds the initialize handshake deadline after spawn", async () => {
    const harness = createHarness({ spawnOutcomeTimeoutMs: 70 });
    const starting = harness.process.start();
    harness.child.emit("spawn");

    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 70)).toBe(true));
    harness.timers.fire(70);

    await expect(starting).rejects.toMatchObject({ code: "INIT_TIMEOUT" });
    expect(harness.child.signals).toEqual([]);
  });

  it("fails closed when the CLI rejects the initialize handshake", async () => {
    const harness = createHarness();
    const starting = harness.process.start();
    harness.child.emit("spawn");
    harness.child.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: CLAUDE_CLI_INITIALIZE_REQUEST_ID,
        error: "unsupported",
      },
    })}\n`));

    await expect(starting).rejects.toMatchObject({ code: "INIT_FAILED" });
    expect(harness.process.terminalError).toMatchObject({ code: "INIT_FAILED" });
    expect(harness.process.phase).toBe("terminal");
  });

  it("ignores control_response frames that don't correlate to the initialize handshake", async () => {
    const received: unknown[] = [];
    const harness = createHarness({ onEnvelope: (value) => { received.push(value); } });
    const starting = harness.process.start();
    harness.child.emit("spawn");
    const strayResponse = {
      type: "control_response",
      response: { subtype: "success", request_id: "some-other-request" },
    };
    harness.child.stdout.emit("data", Buffer.from(`${JSON.stringify(strayResponse)}\n`));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.process.phase).toBe("starting");
    expect(received).toEqual([strayResponse]);

    emitInitializeSuccess(harness);
    await starting;
  });

  it("delivers raw JSON objects in wire order and captures only a valid init UUID", async () => {
    const gate = deferred();
    const received: Array<Readonly<Record<string, unknown>>> = [];
    const harness = createHarness({
      onEnvelope: async (value) => {
        received.push(value);
        if (received.length === 1) await gate.promise;
      },
    });
    await startReady(harness);

    const validId = "df6288da-e4f7-48b1-a7ab-323c1e4c92fe";
    const values = [
      { type: "system", subtype: "init", session_id: "not-a-uuid", extra: { kept: true } },
      { type: "future_event", nested: [1, { untouched: "yes" }] },
      { type: "system", subtype: "init", session_id: validId, capabilities: ["future"] },
    ];
    harness.child.stdout.emit("data", Buffer.from(`${values.map(JSON.stringify).join("\n")}\n`));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(harness.process.sessionId).toBeNull();
    gate.resolve();
    await vi.waitFor(() => expect(received).toHaveLength(3));

    expect(received).toEqual(values);
    expect(harness.process.sessionId).toBe(validId);
  });

  it("retains active stdout bytes and applies ingress pause/resume watermarks", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const harness = createHarness({
      ingressLimits: {
        maxItems: 4,
        maxBytes: 1_024,
        pauseItems: 2,
        pauseBytes: 1_024,
        resumeItems: 1,
        resumeBytes: 1_024,
      },
      onEnvelope: async (value) => {
        seen.push(String(value.type));
        if (value.type === "first") await gate.promise;
      },
    });
    await startReady(harness);

    harness.child.stdout.emit("data", Buffer.from('{"type":"first"}\n'));
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    harness.child.stdout.emit("data", Buffer.from('{"type":"second"}\n'));

    expect(harness.child.stdout.pauseCalls).toBe(1);
    expect(harness.child.stdout.resumeCalls).toBe(0);
    gate.resolve();
    await vi.waitFor(() => expect(seen).toEqual(["first", "second"]));
    expect(harness.child.stdout.resumeCalls).toBe(1);
  });

  it("fails before ingress overflow and drops every frame queued after the fault", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const harness = createHarness({
      ingressLimits: {
        maxItems: 2,
        maxBytes: 1_024,
        pauseItems: 2,
        pauseBytes: 1_024,
        resumeItems: 1,
        resumeBytes: 512,
      },
      onEnvelope: async (value) => {
        seen.push(String(value.type));
        if (value.type === "first") await gate.promise;
      },
    });
    await startReady(harness);

    harness.child.stdout.emit(
      "data",
      Buffer.from('{"type":"first"}\n{"type":"same-chunk-after-fault"}\n'),
    );
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    harness.child.stdout.emit("data", Buffer.from('{"type":"queued"}\n'));
    harness.child.stdout.emit("data", Buffer.from('{"type":"overflow"}\n'));

    await vi.waitFor(() => expect(harness.process.terminalError).toMatchObject({
      code: "INGRESS_OVERFLOW",
    }));
    gate.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["first"]);
    await closeFailedChild(harness);
  });

  it.each([
    {
      label: "malformed JSON",
      maxFrameBytes: 1024,
      chunk: "{bad}\n{\"type\":\"ignored\"}\n",
      code: "MALFORMED_FRAME",
    },
    {
      label: "an oversized pending frame",
      // Must comfortably fit the fixed initialize control_response frame that
      // startReady() sends (97 bytes) while still being small enough for `chunk`
      // to trivially exceed it.
      maxFrameBytes: 128,
      chunk: "x".repeat(129),
      code: "FRAME_TOO_LARGE",
    },
  ])("fails closed on $label", async ({ maxFrameBytes, chunk, code }) => {
    const onEnvelope = vi.fn();
    const harness = createHarness({ maxFrameBytes, onEnvelope });
    await startReady(harness);

    harness.child.stdout.emit("data", Buffer.from(chunk));
    await vi.waitFor(() => expect(harness.process.terminalError).toMatchObject({ code }));
    expect(onEnvelope).not.toHaveBeenCalled();

    await closeFailedChild(harness);
    await expect(harness.process.terminated).resolves.toMatchObject({
      kind: "failure",
      intentional: false,
      error: { code },
    });
  });

  it("treats trailing incomplete JSON at EOF as a terminal protocol fault", async () => {
    const harness = createHarness();
    await startReady(harness);
    harness.child.stdout.emit("data", Buffer.from('{"type":"result"'));
    harness.child.stdout.emit("end");

    await vi.waitFor(() => expect(harness.process.terminalError).toMatchObject({
      code: "TRUNCATED_FRAME",
    }));
    harness.child.emit("exit", 1, null);
    harness.child.emit("close", 1, null);

    await expect(harness.process.terminated).resolves.toMatchObject({
      kind: "failure",
      error: { code: "TRUNCATED_FRAME" },
    });
  });

  it("serializes one-line writes and waits for both callback completion and drain", async () => {
    const harness = createHarness();
    harness.child.stdin.deferCallbacks = true;
    harness.child.stdin.returns.push(false, true);
    await startReady(harness);

    const first = harness.process.writeEnvelope({ type: "user", message: "first\nline" });
    const second = harness.process.writeEnvelope({ type: "user", message: "second" });
    expect(harness.child.stdin.writes.map(String)).toEqual([
      '{"type":"user","message":"first\\nline"}\n',
    ]);

    harness.child.stdin.callbacks.shift()?.();
    await Promise.resolve();
    expect(harness.child.stdin.writes).toHaveLength(1);

    harness.child.stdin.emit("drain");
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.child.stdin.writes).toHaveLength(2));
    expect(String(harness.child.stdin.writes[1])).toBe('{"type":"user","message":"second"}\n');
    harness.child.stdin.callbacks.shift()?.();
    await expect(second).resolves.toBeUndefined();
  });

  it.each([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "an array", value: [1, 2] },
    { label: "a primitive", value: "text" },
    { label: "an object encoded as a primitive", value: { toJSON: () => "text" } },
    { label: "a nested undefined value", value: { type: "user", bad: undefined } },
    { label: "a non-finite number", value: { type: "user", bad: Number.NaN } },
  ])("rejects $label instead of normalizing a non-JSON envelope", async ({ value }) => {
    const harness = createHarness();
    await startReady(harness);

    await expect(harness.process.writeEnvelope(value)).rejects.toThrow(/JSON object/i);
    expect(harness.child.stdin.writes).toHaveLength(0);
  });

  it("rejects outbound item overflow without displacing accepted writes", async () => {
    const harness = createHarness({
      outboundLimits: { maxItems: 2, maxBytes: 1_024, maxFrameBytes: 512 },
    });
    harness.child.stdin.deferCallbacks = true;
    await startReady(harness);

    const first = harness.process.writeEnvelope({ type: "user", sequence: 1 });
    const second = harness.process.writeEnvelope({ type: "user", sequence: 2 });
    const overflow = harness.process.writeEnvelope({ type: "user", sequence: 3 });
    let overflowError: unknown;
    void overflow.catch((error: unknown) => { overflowError = error; });
    await Promise.resolve();

    expect(overflowError).toMatchObject({ code: "OUTBOUND_OVERFLOW" });
    expect(harness.child.stdin.writes.map(String)).toEqual([
      '{"type":"user","sequence":1}\n',
    ]);
    harness.child.stdin.callbacks.shift()?.();
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.child.stdin.writes).toHaveLength(2));
    harness.child.stdin.callbacks.shift()?.();
    await expect(second).resolves.toBeUndefined();
    expect(harness.child.stdin.writes).toHaveLength(2);
  });

  it("rejects outbound byte and frame overflow before retaining either frame", async () => {
    const byteHarness = createHarness({
      outboundLimits: { maxItems: 4, maxBytes: 32, maxFrameBytes: 128 },
    });
    byteHarness.child.stdin.deferCallbacks = true;
    await startReady(byteHarness);
    const accepted = byteHarness.process.writeEnvelope({ type: "ok" });
    const byteOverflow = byteHarness.process.writeEnvelope({ type: "too-many-bytes" });
    let byteOverflowError: unknown;
    void byteOverflow.catch((error: unknown) => { byteOverflowError = error; });
    await Promise.resolve();
    expect(byteOverflowError).toMatchObject({ code: "OUTBOUND_OVERFLOW" });
    expect(byteHarness.child.stdin.writes).toHaveLength(1);
    byteHarness.child.stdin.callbacks.shift()?.();
    await accepted;

    const frameHarness = createHarness({
      outboundLimits: { maxItems: 4, maxBytes: 1_024, maxFrameBytes: 16 },
    });
    await startReady(frameHarness);
    await expect(frameHarness.process.writeEnvelope({ type: "frame-too-large" }))
      .rejects.toMatchObject({ code: "OUTBOUND_FRAME_TOO_LARGE" });
    expect(frameHarness.child.stdin.writes).toHaveLength(0);
  });

  it("terminally fails an uncertain callback write without replaying it", async () => {
    const harness = createHarness();
    harness.child.stdin.deferCallbacks = true;
    await startReady(harness);

    const writing = harness.process.writeEnvelope({ type: "user", message: "once" });
    harness.child.stdin.callbacks.shift()?.(new Error("uncertain write"));

    await expect(writing).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(harness.child.stdin.writes).toHaveLength(1);
    expect(harness.process.terminalError).toMatchObject({ code: "WRITE_FAILED" });
    await closeFailedChild(harness);
  });

  it("terminally fails an active write when stdin errors", async () => {
    const harness = createHarness();
    harness.child.stdin.deferCallbacks = true;
    await startReady(harness);

    const writing = harness.process.writeEnvelope({ type: "user", message: "uncertain" });
    harness.child.stdin.emit("error", new Error("broken pipe"));

    await expect(writing).rejects.toMatchObject({ code: "STDIN_ERROR" });
    expect(harness.child.stdin.writes).toHaveLength(1);
    harness.child.stdin.callbacks.shift()?.();
    await closeFailedChild(harness);
  });

  it("bounds and redacts stderr diagnostics", async () => {
    const harness = createHarness({ stderrMaxBytes: 64 });
    await startReady(harness);

    harness.child.stderr.emit("data", Buffer.from("ANTHROPIC_API_KEY=super-secret-value\n"));
    expect(harness.process.stderrDiagnostics).toContain("[REDACTED]");
    expect(harness.process.stderrDiagnostics).not.toContain("super-secret-value");

    harness.child.stderr.emit("data", Buffer.from(`${"x".repeat(200)}\nlatest\n`));
    expect(Buffer.byteLength(harness.process.stderrDiagnostics)).toBeLessThanOrEqual(64);
    expect(harness.process.stderrDiagnostics).toContain("latest");
  });

  it("omits a complete oversized stderr line without decoding the oversized buffer", async () => {
    const harness = createHarness({ stderrMaxBytes: 64 });
    await startReady(harness);
    const oversized = Buffer.alloc(1024 * 1024, 0x78);
    const input = Buffer.concat([oversized, Buffer.from("\ntail")]);
    const decodedSizes: number[] = [];
    const originalWrite = StringDecoder.prototype.write;
    const write = vi.spyOn(StringDecoder.prototype, "write").mockImplementation(function (
      this: StringDecoder,
      buffer: Buffer,
    ): string {
      decodedSizes.push(buffer.byteLength);
      return originalWrite.call(this, buffer);
    });
    let diagnostics = "";

    try {
      harness.child.stderr.emit("data", input);
      diagnostics = harness.process.stderrDiagnostics;
    } finally {
      write.mockRestore();
    }

    expect(Math.max(0, ...decodedSizes)).toBeLessThanOrEqual(64);
    expect(diagnostics).toContain("stderr line omitted");
    expect(diagnostics).toContain("tail");
  });

  it("preserves split stderr UTF-8 and redacts secrets split across chunks", async () => {
    const harness = createHarness({ stderrMaxBytes: 256 });
    await startReady(harness);
    const emoji = Buffer.from("🔥 ready\n", "utf8");

    harness.child.stderr.emit("data", emoji.subarray(0, 2));
    expect(harness.process.stderrDiagnostics).toBe("");
    harness.child.stderr.emit("data", emoji.subarray(2));
    harness.child.stderr.emit("data", Buffer.from("ANTHROPIC_API_"));
    harness.child.stderr.emit("data", Buffer.from("KEY=split-secret-value\n"));

    expect(harness.process.stderrDiagnostics).toContain("🔥 ready\n");
    expect(harness.process.stderrDiagnostics).toContain("ANTHROPIC_API_KEY=[REDACTED]");
    expect(harness.process.stderrDiagnostics).not.toContain("split-secret-value");
    expect(harness.process.stderrDiagnostics).not.toContain("�");
  });

  it("preserves split string surrogate pairs with bounded forward progress", async () => {
    const harness = createHarness({ stderrMaxBytes: 64 });
    await startReady(harness);

    harness.child.stderr.emit("data", "\ud83d");
    expect(harness.process.stderrDiagnostics).toBe("");
    harness.child.stderr.emit("data", "\udd25 ready\n");

    expect(harness.process.stderrDiagnostics).toContain("🔥 ready\n");
    expect(harness.process.stderrDiagnostics).not.toContain("�");
    expect(Buffer.byteLength(harness.process.stderrDiagnostics)).toBeLessThanOrEqual(64);
    expect(harness.process.stderrRetention.ownedBytes).toBeLessThanOrEqual(64);
  });

  it("coalesces one-byte stderr chunks into fixed bounded storage", async () => {
    const harness = createHarness({ stderrMaxBytes: 256 });
    await startReady(harness);

    for (let index = 0; index < 256; index += 1) {
      harness.child.stderr.emit("data", Buffer.from("x"));
    }

    expect(harness.process.stderrRetention).toMatchObject({
      pendingBytes: 256,
      segmentCount: 1,
    });
    expect(harness.process.stderrRetention.ownedBytes).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(harness.process.stderrDiagnostics)).toBe(256);
  });

  it("drains queued stdout handling before resolving an unexpected close", async () => {
    const gate = deferred();
    const seen: unknown[] = [];
    const harness = createHarness({
      onEnvelope: async (value) => {
        seen.push(value);
        await gate.promise;
      },
    });
    await startReady(harness);
    harness.child.stdout.emit("data", Buffer.from('{"type":"result","kept":true}\n'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    let settled = false;
    void harness.process.terminated.then(() => { settled = true; });
    harness.child.emit("exit", 1, null);
    harness.child.emit("close", 1, null);
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(harness.process.terminated).resolves.toMatchObject({
      kind: "failure",
      intentional: false,
      exitSeen: true,
    });
    expect(seen).toEqual([{ type: "result", kept: true }]);
  });

  it.each([
    {
      label: "stdout error",
      code: "STDOUT_ERROR",
      emit: (child: FakeChild) => child.stdout.emit("error", new Error("stdout failed")),
    },
    {
      label: "stdin error",
      code: "STDIN_ERROR",
      emit: (child: FakeChild) => child.stdin.emit("error", new Error("stdin failed")),
    },
    {
      label: "child error",
      code: "CHILD_ERROR",
      emit: (child: FakeChild) => child.emit("error", new Error("child failed")),
    },
  ])("drops queued envelopes after a terminal $label", async ({ code, emit }) => {
    const gate = deferred();
    const seen: string[] = [];
    const harness = createHarness({
      onEnvelope: async (value) => {
        seen.push(String(value.type));
        if (value.type === "first") await gate.promise;
      },
    });
    await startReady(harness);
    harness.child.stdout.emit("data", Buffer.from('{"type":"first"}\n'));
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    harness.child.stdout.emit("data", Buffer.from('{"type":"queued-after-fault"}\n'));

    emit(harness.child);
    await vi.waitFor(() => expect(harness.process.terminalError).toMatchObject({ code }));
    harness.child.stdout.emit("end");
    harness.child.emit("exit", 1, null);
    harness.child.emit("close", 1, null);
    gate.resolve();

    await harness.process.terminated;
    expect(seen).toEqual(["first"]);
  });

  it("preserves accepted stdout from child exit through stdio drain", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const harness = createHarness({
      onEnvelope: async (value) => {
        seen.push(String(value.type));
        if (value.type === "first") await gate.promise;
      },
    });
    await startReady(harness);
    harness.child.stdout.emit("data", Buffer.from('{"type":"first"}\n'));
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    harness.child.stdout.emit("data", Buffer.from('{"type":"second"}\n'));

    harness.child.emit("exit", 1, null);
    harness.child.stdout.emit("data", Buffer.from('{"type":"final-after-exit"}\n'));
    harness.child.stdout.emit("end");
    harness.child.emit("close", 1, null);
    let settled = false;
    void harness.process.terminated.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(harness.process.terminated).resolves.toMatchObject({
      kind: "failure",
      error: { code: "CHILD_EXIT" },
    });
    expect(seen).toEqual(["first", "second", "final-after-exit"]);
  });

  it("purges preserved exit ingress when a later stdout error occurs", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const harness = createHarness({
      onEnvelope: async (value) => {
        seen.push(String(value.type));
        if (value.type === "first") await gate.promise;
      },
    });
    await startReady(harness);
    harness.child.stdout.emit("data", Buffer.from('{"type":"first"}\n'));
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    harness.child.stdout.emit("data", Buffer.from('{"type":"queued"}\n'));
    harness.child.emit("exit", 1, null);
    harness.child.stdout.emit("error", new Error("late stdout failure"));
    harness.child.stdout.emit("end");
    harness.child.emit("close", 1, null);
    gate.resolve();

    await expect(harness.process.terminated).resolves.toMatchObject({
      error: { code: "CHILD_EXIT" },
    });
    expect(seen).toEqual(["first"]);
  });

  it("fails and settles when an envelope handler never resolves", async () => {
    const entered = deferred();
    const harness = createHarness({
      envelopeHandlerTimeoutMs: 60,
      onEnvelope: () => {
        entered.resolve();
        return new Promise<void>(() => undefined);
      },
    });
    await startReady(harness);
    harness.child.stdout.emit("data", Buffer.from('{"type":"result"}\n'));
    await entered.promise;

    const shuttingDown = harness.process.shutdown();
    let settled = false;
    void shuttingDown.then(() => { settled = true; });
    harness.child.emit("exit", 0, null);
    harness.child.emit("close", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 60)).toBe(true));
    harness.timers.fire(60);

    await expect(shuttingDown).resolves.toMatchObject({
      kind: "failure",
      intentional: false,
      error: { code: "ENVELOPE_HANDLER_TIMEOUT" },
    });
    await expect(harness.process.terminated).resolves.toMatchObject({
      error: { code: "ENVELOPE_HANDLER_TIMEOUT" },
    });
  });

  it("shuts down idempotently and bounds escalation through SIGKILL", async () => {
    const harness = createHarness();
    await startReady(harness);

    const first = harness.process.shutdown();
    const second = harness.process.shutdown();
    expect(second).toBe(first);
    expect(harness.child.stdin.endCalls).toBe(1);
    expect(harness.child.signals).toEqual([]);

    harness.timers.fire(10);
    await vi.waitFor(() => expect(harness.child.signals).toEqual(["SIGINT"]));
    harness.timers.fire(20);
    await vi.waitFor(() => expect(harness.child.signals).toEqual(["SIGINT", "SIGTERM"]));
    harness.timers.fire(30);
    await vi.waitFor(() => expect(harness.child.signals).toEqual([
      "SIGINT", "SIGTERM", "SIGKILL",
    ]));
    harness.timers.fire(40);
    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 50)).toBe(true));
    harness.timers.fire(50);

    await expect(first).resolves.toEqual({
      kind: "shutdown",
      intentional: true,
      exitSeen: false,
      closeSeen: false,
      error: null,
    });
    expect(harness.child.stdout.destroyCalls).toBe(1);
    expect(harness.child.stderr.destroyCalls).toBe(1);
    expect(harness.process.shutdown()).toBe(first);
  });

  it("waits for a pre-spawn shutdown outcome and terminates a late child", async () => {
    const harness = createHarness();
    const starting = harness.process.start();
    const shuttingDown = harness.process.shutdown();
    await expect(starting).rejects.toMatchObject({ code: "SHUTDOWN" });

    let settled = false;
    void shuttingDown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(harness.child.signals).toEqual([]);

    harness.child.emit("spawn");
    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 10)).toBe(true));
    harness.timers.fire(10);
    await vi.waitFor(() => expect(harness.child.signals).toEqual(["SIGINT"]));
    harness.timers.fire(20);
    await vi.waitFor(() => expect(harness.child.signals).toEqual(["SIGINT", "SIGTERM"]));
    harness.timers.fire(30);
    await vi.waitFor(() => expect(harness.child.signals).toEqual([
      "SIGINT", "SIGTERM", "SIGKILL",
    ]));
    harness.timers.fire(40);
    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 50)).toBe(true));
    harness.timers.fire(50);

    await expect(shuttingDown).resolves.toMatchObject({
      kind: "shutdown",
      intentional: true,
    });
  });

  it("bounds a missing spawn outcome and kills a child that spawns after timeout", async () => {
    const harness = createHarness({ spawnOutcomeTimeoutMs: 70 });
    const starting = harness.process.start();
    const shuttingDown = harness.process.shutdown();
    await expect(starting).rejects.toMatchObject({ code: "SHUTDOWN" });

    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 70)).toBe(true));
    harness.timers.fire(70);
    await vi.waitFor(() => expect(harness.child.signals).toEqual(["SIGKILL"]));
    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 50)).toBe(true));
    harness.timers.fire(50);

    await expect(shuttingDown).resolves.toMatchObject({
      kind: "failure",
      intentional: false,
      error: { code: "SPAWN_OUTCOME_TIMEOUT" },
    });
    await expect(harness.process.terminated).resolves.toMatchObject({
      error: { code: "SPAWN_OUTCOME_TIMEOUT" },
    });

    harness.child.emit("spawn");
    expect(harness.child.signals).toEqual(["SIGKILL", "SIGKILL"]);
  });

  it("arms the spawn-outcome deadline during start without requiring shutdown", async () => {
    const harness = createHarness({ spawnOutcomeTimeoutMs: 70 });
    const starting = harness.process.start();

    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 70)).toBe(true));
    harness.timers.fire(70);

    await expect(starting).rejects.toMatchObject({ code: "SPAWN_OUTCOME_TIMEOUT" });
    expect(harness.child.signals).toEqual(["SIGKILL"]);
    await vi.waitFor(() => expect(harness.timers.tasks.some((task) =>
      !task.cleared && task.delayMs === 50)).toBe(true));
    harness.timers.fire(50);
    await expect(harness.process.terminated).resolves.toMatchObject({
      kind: "failure",
      error: { code: "SPAWN_OUTCOME_TIMEOUT" },
    });
  });

  it("treats exit before spawn as a definitive failed spawn outcome", async () => {
    const harness = createHarness();
    const starting = harness.process.start();
    harness.child.emit("exit", 1, null);
    harness.child.stdout.emit("end");

    await expect(starting).rejects.toMatchObject({ code: "CHILD_EXIT" });
    let terminal: unknown;
    void harness.process.terminated.then((value) => { terminal = value; });
    await vi.waitFor(() => expect(terminal).toMatchObject({
      kind: "failure",
      error: { code: "CHILD_EXIT" },
    }), { timeout: 250, interval: 10 });
  });

  it("settles termination when teardown timer scheduling throws", async () => {
    const scheduled = new FakeTimers();
    let throwOnSet = false;
    const harness = createHarness({
      setTimeoutFn: (callback, delayMs) => {
        if (throwOnSet) throw new Error("private timer detail");
        return scheduled.set(callback, delayMs);
      },
      clearTimeoutFn: scheduled.clear,
    });
    await startReady(harness);
    throwOnSet = true;

    const shuttingDown = harness.process.shutdown();

    await expect(shuttingDown).resolves.toMatchObject({
      kind: "failure",
      error: { code: "TIMER_ERROR" },
    });
    await expect(harness.process.terminated).resolves.toMatchObject({
      error: { code: "TIMER_ERROR" },
    });
    expect(harness.child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.child.stdout.destroyCalls).toBe(1);
  });

  it("contains timer clear failures and still settles termination", async () => {
    const scheduled = new FakeTimers();
    let throwOnClear = false;
    const harness = createHarness({
      setTimeoutFn: scheduled.set,
      clearTimeoutFn: (handle) => {
        if (throwOnClear) throw new Error("private clear detail");
        scheduled.clear(handle);
      },
    });
    await startReady(harness);
    throwOnClear = true;
    const shuttingDown = harness.process.shutdown();

    expect(() => harness.child.emit("exit", 0, null)).not.toThrow();
    harness.child.stdout.emit("end");
    harness.child.emit("close", 0, null);

    await expect(shuttingDown).resolves.toMatchObject({
      kind: "failure",
      error: { code: "TIMER_ERROR" },
    });
    await expect(harness.process.terminated).resolves.toMatchObject({
      error: { code: "TIMER_ERROR" },
    });
  });

  it("handles synchronous timer callbacks without clearing undefined or faulting", async () => {
    let synchronous = false;
    const cleared: unknown[] = [];
    const synchronousHandles: object[] = [];
    const harness = createHarness({
      setTimeoutFn: (callback, delayMs) => {
        const handle = { delayMs };
        if (synchronous) {
          synchronousHandles.push(handle);
          callback();
        }
        return handle;
      },
      clearTimeoutFn: (handle) => {
        cleared.push(handle);
        if (handle === undefined) throw new Error("undefined timer handle");
      },
    });
    await startReady(harness);
    cleared.length = 0;
    synchronous = true;

    const terminal = await harness.process.shutdown();

    expect(terminal).toEqual({
      kind: "shutdown",
      intentional: true,
      exitSeen: false,
      closeSeen: false,
      error: null,
    });
    expect(cleared).not.toContain(undefined);
    expect(cleared).toEqual(synchronousHandles);
    expect(() => harness.child.emit("exit", 0, null)).not.toThrow();
  });

  it("surfaces spawn failures without creating a child", async () => {
    const process = new ClaudeCliProcess({
      executable: "/opt/claude/bin/claude",
      configHome: "/canonical/home",
      cwd: "/workspace/project",
      canonicalizeHome: (home) => home,
      spawnFn: () => { throw new Error("spawn failed"); },
    });

    await expect(process.start()).rejects.toBeInstanceOf(ClaudeCliProcessError);
    await expect(process.start()).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    await expect(process.terminated).resolves.toMatchObject({
      kind: "failure",
      error: { code: "SPAWN_FAILED" },
    });
  });
});
