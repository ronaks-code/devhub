import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderRequestResponse } from "../../src/providers/index.js";
import {
  ClaudeTaskRuntime,
  ClaudeTaskRuntimeError,
  type ClaudeTaskRuntimeProcess,
  type ClaudeTaskRuntimeProcessFactory,
  type ClaudeTaskRuntimeProcessOptions,
} from "../../src/providers/claude/task-runtime.js";
import type { ClaudeBackendDiagnosticRecord } from
  "../../src/providers/claude/backend-diagnostic-store.js";

const HOME = "/canonical/claude-home";
const CWD = "/canonical/project";
const SESSION = "519f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TURN_A = "719f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TURN_B = "719f5b78-18c0-7b60-8f0c-6afc120ecd7e";
const EVENT_A = "819f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const MESSAGE_A = "919f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const NOW = "2026-07-13T17:00:00.000Z";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

class FakeProcess implements ClaudeTaskRuntimeProcess {
  readonly writes: unknown[] = [];
  readonly terminal = deferred<{ readonly kind: "shutdown" | "failure" }>();
  readonly terminated = this.terminal.promise;
  startCalls = 0;
  shutdownCalls = 0;
  settleTerminalOnShutdown = true;

  constructor(readonly options: ClaudeTaskRuntimeProcessOptions) {}

  async start(): Promise<void> { this.startCalls += 1; }
  async writeEnvelope(value: unknown): Promise<void> { this.writes.push(value); }
  async shutdown() {
    this.shutdownCalls += 1;
    const result = { kind: "shutdown" as const };
    if (this.settleTerminalOnShutdown) this.terminal.resolve(result);
    return result;
  }
  async emit(value: unknown): Promise<void> { await this.options.onEnvelope(value); }
}

const flush = async (turns = 10): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const harness = (
  suppliedIds: readonly string[] = [TURN_A, TURN_B, "control-1"],
  onEmit?: (event: ProviderEvent) => void,
  runtimeOverrides: {
    readonly maxBackendDiagnostics?: number;
    readonly maxModelObservations?: number;
    readonly onBackendDiagnostic?: (record: Readonly<ClaudeBackendDiagnosticRecord>) => void;
    readonly permissionMode?: "manual" | "acceptEdits" | "auto" | "dontAsk" | "plan";
    readonly now?: () => string;
  } = {},
) => {
  const events: ProviderEvent[] = [];
  const processes: FakeProcess[] = [];
  const ids = [...suppliedIds];
  const processFactory: ClaudeTaskRuntimeProcessFactory = vi.fn((options) => {
    const process = new FakeProcess(options);
    processes.push(process);
    return process;
  });
  const runtime = new ClaudeTaskRuntime({
    executable: "/opt/bin/claude",
    configHome: HOME,
    cwd: CWD,
    sessionId: SESSION,
    generation: 3,
    launch: "new",
    requestedModel: "claude-sonnet-5",
    processFactory,
    canonicalizeHome: (home) => home,
    now: () => NOW,
    idFactory: () => ids.shift() ?? TURN_B,
    emit: (event) => {
      events.push(event);
      onEmit?.(event);
    },
    ...runtimeOverrides,
  });
  return { events, processFactory, processes, runtime };
};

describe("ClaudeTaskRuntime", () => {
  it("starts one owned process, sends an exact native user turn, and rejects overlap", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.start();
    expect(h.processes).toHaveLength(1);
    expect(h.processes[0]?.startCalls).toBe(1);
    expect(h.processFactory).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/opt/bin/claude",
      configHome: HOME,
      cwd: CWD,
      sessionId: SESSION,
      launch: "new",
      permissionPromptStdio: true,
    }));

    await expect(h.runtime.send({ text: "Inspect this safely" })).resolves.toEqual({
      taskKey: { provider: "anthropic", home: HOME, nativeTaskId: SESSION },
      turnId: TURN_A,
    });
    expect(h.processes[0]?.writes).toEqual([{
      type: "user",
      uuid: TURN_A,
      session_id: SESSION,
      message: { role: "user", content: [{ type: "text", text: "Inspect this safely" }] },
      parent_tool_use_id: null,
    }]);
    await expect(h.runtime.send({ text: "must not overlap" })).rejects.toMatchObject({
      code: "TURN_ACTIVE",
    });
  });

  it.each(["fulfilled", "rejected"] as const)(
    "publishes one owned runtime failure before retiring an active turn on %s child exit",
    async (settlement) => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.send({ text: "turn interrupted by child failure" });

    if (settlement === "fulfilled") {
      h.processes[0]!.terminal.resolve({ kind: "failure" });
    } else {
      h.processes[0]!.terminal.reject(new Error("private process failure"));
    }
    await flush();

    expect(h.events.filter((event) =>
      event.type === "status" && event.status === "runtime_failure_uncertain")).toEqual([expect.objectContaining({
      provider: "anthropic",
      key: { provider: "anthropic", home: HOME, nativeTaskId: SESSION },
      occurredAt: NOW,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: TURN_A,
    })]);
    expect(h.runtime.activeTurn).toBeNull();
    await expect(h.runtime.send({ text: "must reconcile first" })).rejects.toMatchObject({
      code: "SHUTDOWN",
    });
    },
  );

  it("treats an unexpected fulfilled shutdown terminal as uncertain while a turn is active", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.send({ text: "active when child exits" });

    h.processes[0]!.terminal.resolve({ kind: "shutdown" });
    await flush();

    expect(h.events.filter((event) =>
      event.type === "status" && event.status === "runtime_failure_uncertain"))
      .toHaveLength(1);
    expect(h.runtime.activeTurn).toBeNull();
  });

  it.each(["clock", "sink"] as const)(
    "finishes terminal cleanup even when the %s fails during crash publication",
    async (failure) => {
      let terminal = false;
      const h = harness(
        [TURN_A],
        failure === "sink" ? () => { throw new Error("hostile sink"); } : undefined,
        {
          now: () => {
            if (terminal && failure === "clock") throw new Error("hostile clock");
            return NOW;
          },
        },
      );
      await h.runtime.start();
      await h.runtime.send({ text: "active when child exits" });
      terminal = true;
      h.processes[0]!.terminal.resolve({ kind: "failure" });
      await flush();

      expect(h.runtime.activeTurn).toBeNull();
      await expect(h.runtime.send({ text: "late" })).rejects.toMatchObject({
        code: "SHUTDOWN",
      });
      await expect(h.runtime.interrupt(TURN_A)).rejects.toMatchObject({
        code: "SHUTDOWN",
      });
    },
  );

  it("does not synthesize a runtime failure after a real terminal provider event", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.send({ text: "provider completes before exit" });

    await h.processes[0]!.emit({
      type: "result",
      subtype: "success",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 2, output_tokens: 1 },
      total_cost_usd: 0.01,
    });
    h.processes[0]!.terminal.resolve({ kind: "shutdown" });
    await flush();

    expect(h.events.filter((event) =>
      event.type === "status" && event.scope === "turn")).toHaveLength(1);
    expect(h.events.some((event) =>
      event.type === "status" && event.status === "runtime_failure_uncertain")).toBe(false);
  });

  it.each(["before", "after"] as const)(
    "does not synthesize a runtime failure when intentional shutdown settles termination %s its promise",
    async (order) => {
      const h = harness();
      await h.runtime.start();
      await h.runtime.send({ text: "intentional stop" });
      h.processes[0]!.settleTerminalOnShutdown = order === "before";

      await h.runtime.shutdown();
      if (order === "after") h.processes[0]!.terminal.resolve({ kind: "shutdown" });
      await flush();

      expect(h.events.some((event) =>
        event.type === "status" && event.status === "runtime_failure_uncertain")).toBe(false);
      expect(h.runtime.activeTurn).toBeNull();
    },
  );

  it("passes an explicitly selected native permission mode to the owned process", async () => {
    const h = harness([], undefined, { permissionMode: "plan" });
    await h.runtime.start();

    expect(h.processFactory).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: "plan",
      permissionPromptStdio: true,
    }));
  });

  it("fails closed on an unknown native permission mode", () => {
    expect(() => harness([], undefined, {
      permissionMode: "bypassPermissions" as never,
    })).toThrow(ClaudeTaskRuntimeError);
  });

  it("normalizes and idempotently replays native events, records model provenance, and clears result", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.send({ text: "first" });
    const process = h.processes[0]!;
    const start = {
      type: "stream_event",
      uuid: EVENT_A,
      session_id: SESSION,
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: {
          id: MESSAGE_A,
          model: "claude-sonnet-5",
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
    };
    await process.emit(start);
    await process.emit(structuredClone(start));
    expect(h.events.filter(({ type }) => type === "usage")).toHaveLength(1);
    expect(h.runtime.modelEvidence().distinctModels).toEqual(["claude-sonnet-5"]);

    await process.emit({
      type: "result",
      subtype: "success",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 2, output_tokens: 1 },
      total_cost_usd: 0.01,
    });
    await expect(h.runtime.send({ text: "second" })).resolves.toMatchObject({ turnId: TURN_B });
  });

  it("routes interrupt and file approval through the strict control peer without browser payload leakage", async () => {
    const h = harness([TURN_A, "control-1", TURN_B]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: [],
    });
    await h.runtime.send({ text: "first" });

    const interrupting = h.runtime.interrupt(TURN_A);
    expect(process.writes.at(-1)).toEqual({
      type: "control_request",
      request_id: "control-1",
      request: { subtype: "interrupt" },
    });
    await process.emit({
      type: "control_response",
      response: { subtype: "success", request_id: "control-1" },
    });
    await expect(interrupting).resolves.toBeUndefined();

    await process.emit({
      type: "control_request",
      request_id: "permission-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/canonical/project/file.ts", content: "private body" },
        tool_use_id: "tool-1",
      },
    });
    await flush();
    const request = h.events.find((event) => event.type === "request");
    expect(request).toMatchObject({
      type: "request",
      request: { kind: "file-change-approval" },
    });
    expect(JSON.stringify(request)).not.toContain("private body");
    if (!request || request.type !== "request") throw new Error("missing request event");
    const response: ProviderRequestResponse = {
      kind: "file-change-approval",
      identity: request.request.identity,
      decision: "allow",
    };
    await h.runtime.respond(response);
    await flush();
    expect(process.writes.at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "permission-1",
        response: {
          behavior: "allow",
          updatedInput: {
            file_path: "/canonical/project/file.ts",
            content: "private body",
          },
        },
      },
    });
  });

  it("requires a strict interrupt receipt when the validated init advertises it", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"],
    });
    await h.runtime.send({ text: "first" });

    const interrupting = h.runtime.interrupt(TURN_A);
    await process.emit({
      type: "control_response",
      response: { subtype: "success", request_id: "control-1" },
    });

    await expect(interrupting).rejects.toMatchObject({ code: "PROTOCOL_FAULT" });
  });

  it("fails closed when interrupt races before init capability attestation", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    await h.runtime.send({ text: "first" });
    const interrupting = h.runtime.interrupt(TURN_A);
    await h.processes[0]!.emit({
      type: "control_response",
      response: { subtype: "success", request_id: "control-1" },
    });

    await expect(interrupting).rejects.toMatchObject({ code: "PROTOCOL_FAULT" });
  });

  it("commits validated init attestation before an initialized-status sink can reenter", async () => {
    let runtime: ClaudeTaskRuntime;
    let interrupting: Promise<void> | null = null;
    const h = harness([TURN_A, "control-1"], (event) => {
      if (event.type === "status" && event.status === "initialized") {
        interrupting = runtime.interrupt(TURN_A);
      }
    });
    runtime = h.runtime;
    await runtime.start();
    await runtime.send({ text: "first" });
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: [],
    });
    expect(interrupting).not.toBeNull();
    await process.emit({
      type: "control_response",
      response: { subtype: "success", request_id: "control-1" },
    });
    await expect(interrupting!).resolves.toBeUndefined();
  });

  it("waits for the correlated interrupt receipt when a result races ahead of it", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: ["interrupt_receipt_v1"],
    });
    await h.runtime.send({ text: "first" });
    let settled = false;
    const interrupting = h.runtime.interrupt(TURN_A).finally(() => { settled = true; });

    await process.emit({
      type: "result",
      subtype: "error_during_execution",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 0 },
      total_cost_usd: 0,
    });
    await flush();
    expect(settled).toBe(false);
    expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
      .toEqual([]);
    await process.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "control-1",
        response: { still_queued: [] },
      },
    });
    await expect(interrupting).resolves.toBeUndefined();
    expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
      .toEqual([expect.objectContaining({
        nativeId: TURN_A,
        status: "cancelled_by_user",
      })]);
    await expect(h.runtime.send({ text: "safe after cancellation" })).resolves.toMatchObject({
      turnId: TURN_B,
    });
  });

  it("maps an error result only after an earlier correlated interrupt receipt", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: ["interrupt_receipt_v1"],
    });
    await h.runtime.send({ text: "first" });
    const interrupting = h.runtime.interrupt(TURN_A);
    await process.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "control-1",
        response: { still_queued: [] },
      },
    });
    await expect(interrupting).resolves.toBeUndefined();
    expect(h.events.some((event) =>
      event.type === "status" && event.status === "cancelled_by_user")).toBe(false);

    const result = {
      type: "result",
      subtype: "error_during_execution",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 0 },
      total_cost_usd: 0,
    };
    await process.emit(result);
    await process.emit(result);
    expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
      .toEqual([expect.objectContaining({
        nativeId: TURN_A,
        status: "cancelled_by_user",
      })]);
  });

  it("flushes the original error result when the correlated interrupt receipt fails", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: ["interrupt_receipt_v1"],
    });
    await h.runtime.send({ text: "first" });
    const interrupting = h.runtime.interrupt(TURN_A);
    await process.emit({
      type: "result",
      subtype: "error_during_execution",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 0 },
      total_cost_usd: 0,
    });
    await process.emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "control-1",
        error: "interrupt rejected",
      },
    });

    await expect(interrupting).rejects.toBeDefined();
    expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
      .toEqual([expect.objectContaining({
        nativeId: TURN_A,
        status: "error_during_execution",
      })]);
    expect(h.events.some((event) =>
      event.type === "status" && event.status === "cancelled_by_user")).toBe(false);
  });

  it("clears a failed receipt correlation when no result was buffered", async () => {
    const h = harness([TURN_A, "control-1", "control-2"]);
    await h.runtime.start();
    await h.runtime.send({ text: "first" });
    const first = h.runtime.interrupt(TURN_A);
    await h.processes[0]!.emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "control-1",
        error: "interrupt rejected",
      },
    });
    await expect(first).rejects.toBeDefined();

    const retry = h.runtime.interrupt(TURN_A);
    expect(h.processes[0]!.writes.at(-1)).toMatchObject({ request_id: "control-2" });
    await h.runtime.shutdown();
    await expect(retry).rejects.toBeDefined();
  });

  it("clears a failed receipt correlation after an independently successful terminal", async () => {
    const h = harness([TURN_A, "control-1", TURN_B]);
    await h.runtime.start();
    await h.runtime.send({ text: "first" });
    const interrupting = h.runtime.interrupt(TURN_A);
    await h.processes[0]!.emit({
      type: "result",
      subtype: "success",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await h.processes[0]!.emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "control-1",
        error: "late interrupt rejected",
      },
    });
    await expect(interrupting).rejects.toBeDefined();
    await expect(h.runtime.send({ text: "next turn" })).resolves.toMatchObject({
      turnId: TURN_B,
    });
  });

  it("never relabels a successful turn merely because interrupt was acknowledged", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: ["interrupt_receipt_v1"],
    });
    await h.runtime.send({ text: "first" });
    const interrupting = h.runtime.interrupt(TURN_A);
    await process.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "control-1",
        response: { still_queued: [] },
      },
    });
    await expect(interrupting).resolves.toBeUndefined();
    await process.emit({
      type: "result",
      subtype: "success",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });

    expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
      .toEqual([expect.objectContaining({ status: "success" })]);
  });

  it.each(["result-first", "receipt-first"] as const)(
    "retries a failed mapped cancellation sink without duplicating committed usage (%s)",
    async (order) => {
      let failMappedStatus = true;
      const delivered: ProviderEvent[] = [];
      const h = harness([TURN_A, "control-1"], (event) => {
        if (
          event.type === "status" && event.status === "cancelled_by_user" &&
          failMappedStatus
        ) {
          failMappedStatus = false;
          throw new Error("mapped status sink failed");
        }
        delivered.push(event);
      });
      await h.runtime.start();
      const process = h.processes[0]!;
      await process.emit({
        type: "system",
        subtype: "init",
        uuid: EVENT_A,
        session_id: SESSION,
        capabilities: ["interrupt_receipt_v1"],
      });
      await h.runtime.send({ text: "first" });
      const interrupting = h.runtime.interrupt(TURN_A);
      const result = {
        type: "result",
        subtype: "error_during_execution",
        uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        usage: { input_tokens: 2, output_tokens: 1 },
        total_cost_usd: 0.01,
      };
      const receipt = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "control-1",
          response: { still_queued: [] },
        },
      };

      if (order === "result-first") {
        await process.emit(result);
        await process.emit(receipt);
        await expect(interrupting).rejects.toThrow("mapped status sink failed");
      } else {
        await process.emit(receipt);
        await expect(interrupting).resolves.toBeUndefined();
        await expect(process.emit(result)).rejects.toThrow("mapped status sink failed");
      }
      await expect(process.emit(result)).resolves.toBeUndefined();

      expect(delivered.filter((event) =>
        event.type === "status" && event.status === "cancelled_by_user")).toHaveLength(1);
      expect(delivered.filter((event) => event.type === "usage")).toHaveLength(1);
      expect(h.runtime.modelEvidence().bySource["result-total-usage"]).toHaveLength(1);
    },
  );

  it("does not claim user cancellation without strict receipt capability evidence", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: [],
    });
    await h.runtime.send({ text: "first" });
    const interrupting = h.runtime.interrupt(TURN_A);
    await process.emit({
      type: "control_response",
      response: { subtype: "success", request_id: "control-1" },
    });
    await expect(interrupting).resolves.toBeUndefined();
    await process.emit({
      type: "result",
      subtype: "error_during_execution",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 0 },
      total_cost_usd: 0,
    });

    expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
      .toEqual([expect.objectContaining({ status: "error_during_execution" })]);
  });

  it("does not relabel another error-class terminal as an acknowledged interrupt", async () => {
    const h = harness([TURN_A, "control-1"]);
    await h.runtime.start();
    const process = h.processes[0]!;
    await process.emit({
      type: "system",
      subtype: "init",
      uuid: EVENT_A,
      session_id: SESSION,
      capabilities: ["interrupt_receipt_v1"],
    });
    await h.runtime.send({ text: "first" });
    const interrupting = h.runtime.interrupt(TURN_A);
    await process.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "control-1",
        response: { still_queued: [] },
      },
    });
    await expect(interrupting).resolves.toBeUndefined();
    await process.emit({
      type: "result",
      subtype: "error_max_turns",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 1, output_tokens: 0 },
      total_cost_usd: 0,
    });

    expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
      .toEqual([expect.objectContaining({ status: "error_max_turns" })]);
  });

  it.each(["shutdown", "process-terminal"] as const)(
    "flushes a buffered provider error without a late cancellation on %s",
    async (termination) => {
      const h = harness([TURN_A, "control-1"]);
      await h.runtime.start();
      const process = h.processes[0]!;
      await process.emit({
        type: "system",
        subtype: "init",
        uuid: EVENT_A,
        session_id: SESSION,
        capabilities: ["interrupt_receipt_v1"],
      });
      await h.runtime.send({ text: "first" });
      const interrupting = h.runtime.interrupt(TURN_A);
      await process.emit({
        type: "result",
        subtype: "error_during_execution",
        uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        usage: { input_tokens: 1, output_tokens: 0 },
        total_cost_usd: 0,
      });

      if (termination === "shutdown") {
        await h.runtime.shutdown();
      } else {
        process.terminal.resolve({ kind: "failure" });
        await flush();
      }
      await expect(interrupting).rejects.toBeDefined();
      await process.emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "control-1",
          response: { still_queued: [] },
        },
      });

      expect(h.events.filter((event) => event.type === "status" && event.scope === "turn"))
        .toEqual([expect.objectContaining({ status: "error_during_execution" })]);
      expect(h.runtime.activeTurn).toBeNull();
    },
  );

  it("fails closed on replay collision and shutdown is idempotent", async () => {
    const h = harness();
    await h.runtime.start();
    const process = h.processes[0]!;
    const base = {
      type: "system",
      subtype: "status",
      uuid: EVENT_A,
      session_id: SESSION,
      status: "idle",
    };
    await process.emit(base);
    await expect(process.emit({ ...base, status: "busy" })).rejects.toMatchObject({
      code: "REPLAY_COLLISION",
    });
    await h.runtime.shutdown();
    await h.runtime.shutdown();
    expect(process.shutdownCalls).toBe(1);
    await expect(h.runtime.send({ text: "late" })).rejects.toBeInstanceOf(ClaudeTaskRuntimeError);
  });

  it("does not clear the active turn for a malformed or foreign result frame", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.send({ text: "first" });
    await h.processes[0]!.emit({
      type: "result",
      subtype: "success",
      uuid: "not-a-native-uuid",
      session_id: "619f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(h.events.at(-1)).toMatchObject({ type: "diagnostic" });
    expect(h.runtime.activeTurn).toBe(TURN_A);
    await expect(h.runtime.send({ text: "overlap" })).rejects.toMatchObject({
      code: "TURN_ACTIVE",
    });
  });

  it("retains one bounded backend diagnostic across a browser-sink retry", async () => {
    const secret = "sk-1234567890abcdefghijkl";
    const diagnostics: Readonly<ClaudeBackendDiagnosticRecord>[] = [];
    let failBrowserDelivery = true;
    const h = harness(
      [TURN_A],
      (event) => {
        if (event.type === "diagnostic" && failBrowserDelivery) {
          failBrowserDelivery = false;
          throw new Error("browser sink failed");
        }
      },
      { onBackendDiagnostic: (record) => diagnostics.push(record) },
    );
    await h.runtime.start();
    const unknown = {
      type: "future_private_event",
      uuid: EVENT_A,
      payload: { credential: secret, text: "bounded" },
    };

    await expect(h.processes[0]!.emit(unknown)).rejects.toThrow("browser sink failed");
    await expect(h.processes[0]!.emit(unknown)).resolves.toBeUndefined();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ sessionId: SESSION, generation: 3 });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(h.runtime.backendDiagnostics()).toMatchObject({
      accepted: 1,
      sinkFailures: 0,
    });
  });

  it("contains a hostile backend diagnostic sink without dropping the provider event", async () => {
    const h = harness([TURN_A], undefined, {
      onBackendDiagnostic: () => { throw new Error("hostile diagnostic sink"); },
    });
    await h.runtime.start();

    await expect(h.processes[0]!.emit({
      type: "future_event",
      uuid: EVENT_A,
      value: "safe",
    })).resolves.toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ type: "diagnostic" });
    expect(h.runtime.backendDiagnostics()).toMatchObject({
      accepted: 1,
      sinkFailures: 1,
    });
  });

  it("commits terminal/replay state only after sink delivery and blocks reentrant send", async () => {
    let failDelivery = true;
    let runtime: ClaudeTaskRuntime;
    const reentrant: Promise<unknown>[] = [];
    const h = harness([TURN_A, TURN_B], (event) => {
      if (event.type !== "status" || event.scope !== "turn") return;
      if (failDelivery) throw new Error("sink failure");
      reentrant.push(runtime.send({ text: "reentrant" }));
    });
    runtime = h.runtime;
    await runtime.start();
    await runtime.send({ text: "first" });
    const result = {
      type: "result",
      subtype: "success",
      uuid: "a19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 2, output_tokens: 1 },
      total_cost_usd: 0.01,
    };

    await expect(h.processes[0]!.emit(result)).rejects.toThrow("sink failure");
    expect(runtime.activeTurn).toBe(TURN_A);
    failDelivery = false;
    await expect(h.processes[0]!.emit(structuredClone(result))).resolves.toBeUndefined();
    await expect(Promise.all(reentrant)).rejects.toMatchObject({ code: "TURN_ACTIVE" });
    expect(runtime.activeTurn).toBeNull();
    await expect(runtime.send({ text: "after delivery" })).resolves.toMatchObject({
      turnId: TURN_B,
    });
  });

  it("aborts remaining delivery and uncommitted state on reentrant shutdown", async () => {
    let runtime: ClaudeTaskRuntime;
    let stopping: Promise<{ readonly kind: "shutdown" | "failure" }> | null = null;
    const h = harness([TURN_A], (event) => {
      if (event.type === "status" && event.scope === "turn" && stopping === null) {
        stopping = runtime.shutdown();
      }
    });
    runtime = h.runtime;
    await runtime.start();
    await runtime.send({ text: "first" });
    const modelBefore = runtime.modelEvidence();

    await h.processes[0]!.emit({
      type: "result",
      subtype: "success",
      uuid: "c19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 2, output_tokens: 1 },
      total_cost_usd: 0.01,
    });

    expect(stopping).not.toBeNull();
    await stopping;
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: "status", scope: "turn" });
    expect(runtime.modelEvidence()).toEqual(modelBefore);
    expect((runtime as unknown as { replay: Map<string, string> }).replay.size).toBe(0);
    expect((runtime as unknown as { deliveringReplay: Map<string, unknown> })
      .deliveringReplay.size).toBe(0);
  });

  it("does not start a process after same-tick shutdown", async () => {
    const h = harness();
    const starting = h.runtime.start();
    const stopping = h.runtime.shutdown();
    await expect(starting).rejects.toMatchObject({ code: "SHUTDOWN" });
    await stopping;
    expect(h.processes[0]?.startCalls).toBe(0);
    expect(h.processes[0]?.shutdownCalls).toBe(1);
  });

  it("resumes a failed multi-event delivery without duplicating prior events", async () => {
    let failUsage = true;
    let statusDeliveries = 0;
    const h = harness([TURN_A, TURN_B], (event) => {
      if (event.type === "status" && event.scope === "turn") statusDeliveries += 1;
      if (event.type === "usage" && failUsage) throw new Error("usage sink failure");
    });
    await h.runtime.start();
    await h.runtime.send({ text: "first" });
    const result = {
      type: "result",
      subtype: "success",
      uuid: "b19f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      usage: { input_tokens: 2, output_tokens: 1 },
      total_cost_usd: 0.01,
    };
    await expect(h.processes[0]!.emit(result)).rejects.toThrow("usage sink failure");
    expect(statusDeliveries).toBe(1);
    expect(h.runtime.activeTurn).toBe(TURN_A);
    failUsage = false;
    await h.processes[0]!.emit(structuredClone(result));
    expect(statusDeliveries).toBe(1);
    expect(h.runtime.activeTurn).toBeNull();
  });

  it("validates model-ledger capacity before any browser event escapes", async () => {
    const h = harness([TURN_A], undefined, { maxModelObservations: 1 });
    await h.runtime.start();
    await h.runtime.send({ text: "first" });
    await expect(h.processes[0]!.emit({
      type: "stream_event",
      uuid: EVENT_A,
      session_id: SESSION,
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: {
          id: MESSAGE_A,
          model: "claude-sonnet-5",
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
    })).rejects.toMatchObject({ code: "CAPACITY" });
    expect(h.events).toHaveLength(0);
    expect(h.runtime.activeTurn).toBe(TURN_A);
  });
});
