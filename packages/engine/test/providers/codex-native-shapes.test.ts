import { describe, expect, it } from "vitest";
import {
  CodexNativeShapeError,
  parseCodexThreadForkResult,
  parseCodexThreadListResult,
  parseCodexThreadReadResult,
  parseCodexThreadResumeResult,
  parseCodexThreadStartResult,
  parseCodexTurnStartResult,
} from "../../src/providers/codex/native-shapes.js";

const OPENAI_KEY = "sk-proj-0123456789abcdefghijklmnop";
const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz012345";

function nativeTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "turn-1",
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1_700_000_010,
    completedAt: null,
    durationMs: null,
    items: [
      {
        type: "agentMessage",
        id: "item-message",
        text: `visible response ${OPENAI_KEY}`,
        phase: null,
        memoryCitation: null,
      },
      {
        type: "reasoning",
        id: "item-reasoning",
        summary: [`private reasoning ${BEARER}`],
        content: ["hidden chain-of-thought"],
      },
      {
        type: "commandExecution",
        id: "item-command",
        command: `curl -H '${BEARER}' https://example.test`,
        cwd: "/tmp/project",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: OPENAI_KEY,
        exitCode: null,
        durationMs: null,
      },
      {
        type: "mcpToolCall",
        id: "item-mcp",
        server: "safe-server",
        tool: "safe-tool",
        status: "completed",
        arguments: { token: OPENAI_KEY },
        appContext: null,
        pluginId: null,
        result: null,
        error: null,
        durationMs: 4,
      },
    ],
    ...overrides,
  };
}

function nativeThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: `password=${OPENAI_KEY}`,
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_020,
    recencyAt: 1_700_000_021,
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
    path: "/private/provider/rollout.jsonl",
    cwd: "/tmp/project",
    cliVersion: "0.144.1",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: `Task ${OPENAI_KEY}`,
    turns: [nativeTurn()],
    ...overrides,
  };
}

function configuredThreadResult(thread: Record<string, unknown>): Record<string, unknown> {
  return {
    thread,
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp/project",
    instructionSources: ["/tmp/project/AGENTS.md"],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: ["/tmp/project"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    reasoningEffort: "high",
  };
}

describe("Codex native response shapes", () => {
  it("parses an active list response into redacted, content-free metadata", () => {
    const result = parseCodexThreadListResult(
      {
        data: [nativeThread()],
        nextCursor: "provider-next",
        backwardsCursor: "provider-back",
      },
      { archived: false },
    );

    expect(result.nextCursor).toBe("provider-next");
    expect(result.backwardsCursor).toBe("provider-back");
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      id: "thread-1",
      sessionId: "session-1",
      archived: false,
      sourceKind: "vscode",
      status: "active",
      activeFlags: ["waitingOnApproval"],
    });
    expect(result.threads[0]?.name).toContain("[REDACTED]");
    expect(result.threads[0]?.preview).toContain("[REDACTED]");
    expect(result.threads[0]?.turns[0]?.items).toEqual([
      { id: "item-message", type: "agentMessage", status: null },
      { id: "item-reasoning", type: "reasoning", status: null },
      { id: "item-command", type: "commandExecution", status: "inProgress" },
      { id: "item-mcp", type: "mcpToolCall", status: "completed" },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(OPENAI_KEY);
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain("hidden chain-of-thought");
    expect(serialized).not.toContain("aggregatedOutput");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("rollout.jsonl");
  });

  it("uses the list lane as the only archive authority", () => {
    const archived = parseCodexThreadListResult(
      { data: [nativeThread({ source: "appServer" })], nextCursor: null },
      { archived: true },
    );
    const read = parseCodexThreadReadResult({ thread: nativeThread() });

    expect(archived.threads[0]?.archived).toBe(true);
    expect(archived.threads[0]?.sourceKind).toBe("appServer");
    expect(read.thread.archived).toBeNull();
  });

  it("sanitizes schema-supported custom sources without retaining their value", () => {
    const result = parseCodexThreadReadResult({
      thread: nativeThread({ source: { custom: `integration-${OPENAI_KEY}` } }),
    });

    expect(result.thread.sourceKind).toBe("custom");
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it.each([
    "review",
    "compact",
    "memory_consolidation",
    { thread_spawn: { parent_thread_id: "parent-1", depth: 1 } },
    { other: `future-${OPENAI_KEY}` },
  ])("accepts and sanitizes the installed subAgent source variant", (subAgent) => {
    const result = parseCodexThreadReadResult({
      thread: nativeThread({ source: { subAgent } }),
    });

    expect(result.thread.sourceKind).toBe("subAgent");
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it("rejects properties outside the installed closed source union", () => {
    expect(() =>
      parseCodexThreadReadResult({
        thread: nativeThread({ source: { custom: "safe", credential: OPENAI_KEY } }),
      })
    ).toThrow(CodexNativeShapeError);
  });

  it("does not retain fallback errors that contain provider-controlled property names", () => {
    let thrown: unknown;
    try {
      parseCodexThreadStartResult({
        ...configuredThreadResult(nativeThread({ turns: [] })),
        sandbox: { type: "dangerFullAccess", [OPENAI_KEY]: false },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CodexNativeShapeError);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(OPENAI_KEY);
  });

  it.each([
    ["start", parseCodexThreadStartResult],
    ["resume", parseCodexThreadResumeResult],
    ["fork", parseCodexThreadForkResult],
  ] as const)("parses the configured thread/%s result without exposing policy internals", (_name, parse) => {
    const result = parse(configuredThreadResult(nativeThread({ turns: [] })));

    expect(result).toMatchObject({
      model: "gpt-5.4",
      modelProvider: "openai",
      cwd: "/tmp/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxType: "workspaceWrite",
      reasoningEffort: "high",
    });
    expect(result.thread.archived).toBeNull();
    expect(result).not.toHaveProperty("sandbox");
    expect(result).not.toHaveProperty("instructionSources");
  });

  it("parses turn/start into metadata only", () => {
    const result = parseCodexTurnStartResult({ turn: nativeTurn() });

    expect(result.turn.id).toBe("turn-1");
    expect(result.turn.items[0]).toEqual({
      id: "item-message",
      type: "agentMessage",
      status: null,
    });
    expect(JSON.stringify(result)).not.toContain("visible response");
  });

  it("redacts arbitrary schema status text and rejects credential-shaped native ids", () => {
    const statusResult = parseCodexTurnStartResult({
      turn: nativeTurn({
        items: [
          {
            id: "image-item",
            type: "imageGeneration",
            result: "completed",
            status: BEARER,
          },
        ],
      }),
    });

    expect(statusResult.turn.items[0]?.status).toBe("Bearer [REDACTED]");
    expect(JSON.stringify(statusResult)).not.toContain(BEARER);
    expect(() =>
      parseCodexThreadReadResult({ thread: nativeThread({ id: OPENAI_KEY }) })
    ).toThrow(CodexNativeShapeError);
  });

  it.each([
    ["unknown thread status", { thread: nativeThread({ status: { type: "future" } }) }],
    [
      "unknown item type",
      { thread: nativeThread({ turns: [nativeTurn({ items: [{ id: "x", type: "future" }] })] }) },
    ],
    [
      "missing required item field",
      {
        thread: nativeThread({
          turns: [nativeTurn({ items: [{ id: "x", type: "agentMessage" }] })],
        }),
      },
    ],
    ["unsafe timestamp", { thread: nativeThread({ updatedAt: Number.MAX_SAFE_INTEGER + 1 }) }],
  ])("fails closed for %s with value-free diagnostics", (_label, payload) => {
    let thrown: unknown;
    try {
      parseCodexThreadReadResult(payload);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CodexNativeShapeError);
    expect((thrown as CodexNativeShapeError).code).toBe("INVALID_NATIVE_SHAPE");
    expect((thrown as Error).message).not.toContain("future");
    expect((thrown as Error).message).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
  });

  it("rejects arrays beyond the bounded list response budget", () => {
    expect(() =>
      parseCodexThreadListResult(
        { data: Array.from({ length: 257 }, () => nativeThread({ turns: [] })) },
        { archived: false },
      )
    ).toThrow(CodexNativeShapeError);
  });
});
