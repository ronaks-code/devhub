import { describe, expect, it, vi } from "vitest";
import type {
  AgentDriver,
  RunningTurn,
  TurnHandlers,
  TurnRequest,
  TurnResult,
} from "../../src/driver/types.js";
import type { SessionMessagesPage, SessionSummary } from "../../src/types.js";
import { ProviderCapabilityError } from "../../src/providers/capabilities.js";
import { createProviderRequestIdentity } from "../../src/providers/request-identity.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import { LegacyClaudeAdapter } from "../../src/providers/claude/legacy-adapter.js";

const summary = (id: string): SessionSummary =>
  ({
    sessionId: id,
    title: `Session ${id}`,
    cwd: "/work/project",
    model: "claude-sonnet-4-5",
    firstTimestamp: "2026-07-12T20:00:00.000Z",
    lastTimestamp: "2026-07-12T21:00:00.000Z",
    archived: false,
  }) as SessionSummary;

describe("LegacyClaudeAdapter", () => {
  it("preserves the injected process-per-turn driver without advertising generic lifecycle controls", async () => {
    const result: TurnResult = {
      sessionId: "session-1",
      subtype: "success",
      isError: false,
      costUsd: 0,
      denials: [],
    };
    const running: RunningTurn = { interrupt: vi.fn(), done: Promise.resolve(result) };
    const runTurn = vi.fn((_request: TurnRequest, _handlers: TurnHandlers) => running);
    const adapter = new LegacyClaudeAdapter({
      home: "/tmp/claude-home",
      driver: { runTurn } satisfies AgentDriver,
      history: {
        listAllSessions: () => [],
        getSession: () => undefined,
        getSessionMessages: async () => undefined,
      },
    });
    const request = { cwd: "/work/project", prompt: "hello" };
    const handlers = {};

    expect(adapter.runTurn(request, handlers)).toBe(running);
    expect(runTurn).toHaveBeenCalledWith(request, handlers);
    expect(await adapter.capabilities()).toMatchObject({
      list: true,
      read: true,
      start: false,
      resume: false,
      send: false,
      interrupt: false,
      subscribe: false,
      approveCommand: false,
      approveFileChange: false,
      approvePermissions: false,
    });
    await expect(
      adapter.startTask({ home: "/tmp/claude-home", cwd: "/work/project" }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it("maps injected legacy history to provider-neutral pages and reads", async () => {
    const sessions = [summary("session-1"), summary("session-2")];
    const listAllSessions = vi.fn(() => sessions);
    const getSession = vi.fn((id: string) => sessions.find((item) => item.sessionId === id));
    const getSessionMessages = vi.fn(async (id: string): Promise<SessionMessagesPage | undefined> => ({
      session: summary(id),
      messages: [
        {
          seq: 0,
          uuid: "message-1",
          parentUuid: null,
          role: "assistant",
          type: "assistant",
          timestamp: "2026-07-12T20:00:00.000Z",
          blocks: [{ type: "text", text: "hello from history" }],
        },
      ],
      truncatedFromStart: false,
      subagents: [],
    }));
    const adapter = new LegacyClaudeAdapter({
      home: "/tmp/claude-home",
      driver: { runTurn: vi.fn() } as unknown as AgentDriver,
      history: { listAllSessions, getSession, getSessionMessages },
    });

    const page = await adapter.listTasks({ home: "/tmp/claude-home", limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("1");
    expect(page.items[0]).toMatchObject({
      key: {
        provider: "anthropic",
        home: "/tmp/claude-home",
        nativeTaskId: "session-1",
      },
      source: "legacy-history",
      title: "Session session-1",
      archived: false,
    });

    const task = await adapter.readTask(page.items[0]!.key, true);
    expect(getSessionMessages).toHaveBeenCalledWith("session-1");
    expect(task.turns[0]?.events[0]).toMatchObject({
      type: "message",
      provider: "anthropic",
      role: "assistant",
      text: "hello from history",
      itemId: "message-1",
    });
  });

  it("rejects a mismatched provider home before touching history", async () => {
    const listAllSessions = vi.fn(() => []);
    const adapter = new LegacyClaudeAdapter({
      home: "/tmp/claude-home",
      driver: { runTurn: vi.fn() } as unknown as AgentDriver,
      history: {
        listAllSessions,
        getSession: () => undefined,
        getSessionMessages: async () => undefined,
      },
    });

    await expect(adapter.listTasks({ home: "/tmp/other-home" })).rejects.toThrow(/home/i);
    expect(listAllSessions).not.toHaveBeenCalled();
  });

  it("snapshots a caller-owned key before history callbacks can mutate it", async () => {
    const callerKey = {
      provider: "anthropic" as const,
      home: "/tmp/claude-home",
      nativeTaskId: "session-1",
    };
    const getSessionMessages = vi.fn(async () => undefined);
    const adapter = new LegacyClaudeAdapter({
      home: "/tmp/claude-home",
      driver: { runTurn: vi.fn() } as unknown as AgentDriver,
      history: {
        listAllSessions: () => [],
        getSession: (id) => {
          callerKey.nativeTaskId = "session-2";
          return summary(id);
        },
        getSessionMessages,
      },
    });

    const task = await adapter.readTask(callerKey, true);

    expect(task.key.nativeTaskId).toBe("session-1");
    expect(getSessionMessages).toHaveBeenCalledWith("session-1");
  });

  it("reports non-capability operations honestly instead of blaming read or command approval", async () => {
    const adapter = new LegacyClaudeAdapter({
      home: "/tmp/claude-home",
      driver: { runTurn: vi.fn() } as unknown as AgentDriver,
      history: {
        listAllSessions: () => [summary("session-1")],
        getSession: () => summary("session-1"),
        getSessionMessages: async () => undefined,
      },
    });
    const key = (await adapter.listTasks({ home: "/tmp/claude-home" })).items[0]!.key;

    await expect(adapter.subscribe(key, vi.fn())).rejects.toMatchObject({
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      capability: "subscribe",
      provider: "anthropic",
    });
    await expect(
      adapter.respond({
        kind: "permission",
        identity: createProviderRequestIdentity({
          key,
          generation: null,
          turnId: "turn-1",
          requestId: "permission-1",
          itemId: "item-1",
          approvalId: null,
        }),
        permissions: [],
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      capability: "approvePermissions",
      provider: "anthropic",
    });
  });

  it("rejects foreign subscribe and response identities before capability dispatch", async () => {
    const adapter = new LegacyClaudeAdapter({
      home: "/tmp/claude-home",
      driver: { runTurn: vi.fn() } as unknown as AgentDriver,
      history: {
        listAllSessions: () => [],
        getSession: () => undefined,
        getSessionMessages: async () => undefined,
      },
    });
    const foreignKey = createNativeTaskKey("openai", "/tmp/codex-home", "task-1");

    await expect(adapter.subscribe(foreignKey, vi.fn())).rejects.toThrow(/belong/i);
    await expect(adapter.respond({
      kind: "permission",
      identity: createProviderRequestIdentity({
        key: foreignKey,
        generation: null,
        turnId: "turn-1",
        requestId: "request-1",
        itemId: "item-1",
        approvalId: null,
      }),
      permissions: [],
    })).rejects.toThrow(/belong/i);
  });
});
