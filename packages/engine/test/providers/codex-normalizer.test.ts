import { describe, expect, it } from "vitest";
import {
  CODEX_MAX_ACTIVITY_BODY_JSON_BYTES,
  CodexNormalizationError,
  normalizeCodexNotification,
  normalizeCodexServerRequest,
} from "../../src/providers/codex/normalizer.js";

const context = Object.freeze({
  home: "/tmp/devhub-codex-normalizer-home",
  generation: 7,
  occurredAt: "2026-07-13T10:00:00.000Z",
});

const notification = (method: string, params: unknown) => ({ method, params });

describe("Codex native notification normalization", () => {
  it("maps task and turn lifecycle to stable status events", () => {
    expect(normalizeCodexNotification(notification("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    }), context)).toMatchObject([{
      type: "status",
      scope: "task",
      status: "active",
      nativeId: "thread-1",
    }]);

    expect(normalizeCodexNotification(notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    }), context)).toMatchObject([{
      type: "status",
      scope: "turn",
      status: "completed",
      nativeId: "turn-1",
    }]);
  });

  it("extracts only text from a user item and preserves task, turn, and item identity", () => {
    const events = normalizeCodexNotification(notification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
      item: {
        id: "item-user",
        type: "userMessage",
        content: [
          { type: "text", text: "hello" },
          { type: "image", url: "https://secret.example/image?token=raw-secret" },
          { type: "mention", name: "private", path: "/secret/path" },
        ],
      },
    }), context);

    expect(events).toMatchObject([
      { type: "status", scope: "item", status: "started", nativeId: "item-user" },
      {
        type: "message",
        role: "user",
        text: "hello",
        turnId: "turn-1",
        itemId: "item-user",
        key: { provider: "openai", nativeTaskId: "thread-1" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("raw-secret");
    expect(JSON.stringify(events)).not.toContain("/secret/path");
  });

  it("maps completed assistant text without copying citation or phase payloads", () => {
    const events = normalizeCodexNotification(notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2,
      item: {
        id: "item-assistant",
        type: "agentMessage",
        text: "safe answer",
        phase: "final_answer",
        memoryCitation: { raw: "citation-secret" },
      },
    }), context);

    expect(events).toMatchObject([
      { type: "status", scope: "item", status: "completed", nativeId: "item-assistant" },
      {
        type: "message",
        role: "assistant",
        text: "safe answer",
        turnId: "turn-1",
        itemId: "item-assistant",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("citation-secret");
  });

  it("suppresses reasoning content and maps tool output to redacted activity bodies", () => {
    const reasoning = normalizeCodexNotification(notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2,
      item: {
        id: "reasoning-1",
        type: "reasoning",
        summary: ["hidden-summary"],
        content: ["hidden-thought"],
      },
    }), context);
    expect(reasoning).toMatchObject([
      { type: "status", scope: "item", status: "completed", nativeId: "reasoning-1" },
    ]);
    expect(JSON.stringify(reasoning)).not.toContain("hidden");

    const activity = normalizeCodexNotification(notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2,
      item: {
        id: "command-1",
        type: "commandExecution",
        status: "failed",
        command: "echo command-secret",
        cwd: "/secret/cwd",
        commandActions: [],
        aggregatedOutput: "tests passed\nsk-proj-0123456789abcdefghijklmnop",
      },
    }), context);
    expect(activity).toMatchObject([
      { type: "status", scope: "item", status: "failed", nativeId: "command-1" },
      {
        type: "activity",
        turnId: "turn-1",
        itemId: "command-1",
        activity: "commandExecution",
        status: "failed",
        message: "tests passed\n[REDACTED]",
      },
    ]);
    expect(JSON.stringify(activity)).not.toContain("command-secret");
    expect(JSON.stringify(activity)).not.toContain("sk-proj-");
    expect(JSON.stringify(activity)).not.toContain("/secret/cwd");
  });

  it("preserves bounded subagent labels and output metadata in activity events", () => {
    const events = normalizeCodexNotification(notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2,
      item: {
        id: "agent-call-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        prompt: "Inspect event flow",
        senderThreadId: "thread-1",
        receiverThreadIds: ["agent-thread-1"],
        agentsStates: {
          "agent-thread-1": { status: "completed", message: "Found the SSE path" },
        },
        status: "completed",
      },
    }), context);

    expect(events).toMatchObject([
      { type: "status", scope: "item", status: "completed", nativeId: "agent-call-1" },
      {
        type: "activity",
        activity: "collabAgentToolCall",
        status: "completed",
        itemId: "agent-call-1",
      },
    ]);
    const activity = events.find((event) => event.type === "activity");
    expect(activity?.type === "activity" ? activity.message : null).toContain("Inspect event flow");
    expect(activity?.type === "activity" ? activity.message : null).toContain("Found the SSE path");
  });

  it("redacts a credential before truncating a bounded activity body", () => {
    const prefix = "x".repeat(CODEX_MAX_ACTIVITY_BODY_JSON_BYTES - 10);
    const events = normalizeCodexNotification(notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2,
      item: {
        id: "command-1",
        type: "commandExecution",
        status: "completed",
        command: "run",
        cwd: "/tmp/work",
        commandActions: [],
        aggregatedOutput: `${prefix} sk-proj-0123456789abcdefghijklmnop trailing`,
      },
    }), context);
    expect(JSON.stringify(events)).not.toContain("sk-proj-");
  });

  it("maps assistant and plan deltas without losing item identity", () => {
    expect(normalizeCodexNotification(notification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "answer chunk",
    }), context)).toMatchObject([{
      type: "message-delta",
      role: "assistant",
      delta: "answer chunk",
      turnId: "turn-1",
      itemId: "item-1",
    }]);

    expect(normalizeCodexNotification(notification("item/plan/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "plan-1",
      delta: "plan chunk",
    }), context)).toMatchObject([{
      type: "plan",
      text: "plan chunk",
      status: "streaming",
      turnId: "turn-1",
      itemId: "plan-1",
      stepIndex: null,
    }]);
  });

  it("maps plan steps and thread-total token usage", () => {
    expect(normalizeCodexNotification(notification("turn/plan/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "private explanation is not copied",
      plan: [
        { step: "First", status: "completed" },
        { step: "Second", status: "inProgress" },
      ],
    }), context)).toMatchObject([
      { type: "plan", text: "First", status: "completed", itemId: null, stepIndex: 0 },
      { type: "plan", text: "Second", status: "inProgress", itemId: null, stepIndex: 1 },
    ]);

    expect(normalizeCodexNotification(notification("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 3,
          reasoningOutputTokens: 4,
          totalTokens: 10,
        },
        total: {
          inputTokens: 11,
          outputTokens: 12,
          cachedInputTokens: 13,
          reasoningOutputTokens: 14,
          totalTokens: 50,
        },
      },
    }), context)).toMatchObject([{
      type: "usage",
      turnId: "turn-1",
      inputTokens: 11,
      outputTokens: 12,
      cachedInputTokens: 13,
      totalTokens: 50,
    }]);
  });

  it("summarizes unified diffs and preserves their bodies", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-old-secret",
      "+new-secret",
      "+second-line",
      "diff --git a/b.txt b/b.txt",
      "--- /dev/null",
      "+++ b/b.txt",
      "+third-line",
    ].join("\n");
    const turnEvents = normalizeCodexNotification(notification("turn/diff/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      diff,
    }), context);
    expect(turnEvents).toMatchObject([
      {
        type: "diff-summary",
        changedFiles: 2,
        additions: 3,
        deletions: 1,
      },
      {
        type: "activity",
        activity: "fileChange",
        status: "updated",
        message: diff,
      },
    ]);

    const patchEvents = normalizeCodexNotification(notification("item/fileChange/patchUpdated", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-1",
      changes: [
        { path: "/secret/a.txt", kind: { type: "update" }, diff },
        { path: "/secret/b.txt", kind: { type: "delete" }, diff: "-gone-secret" },
      ],
    }), context);
    expect(patchEvents).toMatchObject([
      {
        type: "diff-summary",
        changedFiles: 2,
        additions: 3,
        deletions: 2,
      },
      {
        type: "activity",
        itemId: "patch-1",
        activity: "fileChange",
        status: "updated",
        message: `${diff}\n-gone-secret`,
      },
    ]);
  });

  it("withholds raw output deltas until the authoritative completed item", () => {
    for (const method of [
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ]) {
      const events = normalizeCodexNotification(notification(method, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "must-never-render",
      }), context);
      expect(events).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("must-never-render");
    }
  });

  it("turns unknown or invalid notifications into bounded metadata-only diagnostics", () => {
    const params = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      `field-${String(index).padStart(2, "0")}`,
      `raw-secret-${index}`,
    ]));
    const [unknown] = normalizeCodexNotification(notification("future/raw-secret-method", params), context);
    expect(unknown).toMatchObject({
      type: "diagnostic",
      code: "UNKNOWN_CODEX_NOTIFICATION",
      method: "future/raw-secret-method",
    });
    expect(unknown?.type === "diagnostic" && unknown.shapeKeys.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(unknown)).not.toContain("raw-secret-0");

    const [invalid] = normalizeCodexNotification(notification("turn/started", {
      threadId: "thread-1",
      turn: { id: "", status: "inProgress", items: [], raw: "invalid-secret" },
    }), context);
    expect(invalid).toMatchObject({
      type: "diagnostic",
      code: "INVALID_CODEX_NOTIFICATION",
      method: "turn/started",
    });
    expect(JSON.stringify(invalid)).not.toContain("invalid-secret");
  });

  it("keeps malformed unknown ownership metadata inside a safe diagnostic boundary", () => {
    const events = normalizeCodexNotification(notification("future\u0000method", {
      threadId: "unsafe\u0000thread",
      raw: "raw-diagnostic-secret",
    }), context);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "diagnostic",
      code: "UNKNOWN_CODEX_NOTIFICATION",
      key: { nativeTaskId: "unknown" },
    });
    expect(JSON.stringify(events)).not.toContain("raw-diagnostic-secret");
    expect(JSON.stringify(events)).not.toContain("\u0000");
  });

  it("contains oversized or credential-shaped live ownership ids", () => {
    for (const threadId of [
      "x".repeat(513),
      "sk-proj-0123456789abcdefghijklmnop",
    ]) {
      const events = normalizeCodexNotification(notification("thread/archived", { threadId }), context);
      expect(events).toMatchObject([{
        type: "diagnostic",
        code: "INVALID_CODEX_NOTIFICATION",
        key: { nativeTaskId: "unknown" },
      }]);
      expect(JSON.stringify(events)).not.toContain(threadId);
    }
  });
});

describe("Codex native server-request normalization", () => {
  it("rejects a non-canonical wire request id before correlation", () => {
    expect(() => normalizeCodexServerRequest({
      id: " request-1 ",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        approvalId: null,
        startedAtMs: 1,
      },
    }, context)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it.each([
    ["item/commandExecution/requestApproval", "command-approval"],
    ["item/fileChange/requestApproval", "file-change-approval"],
    ["item/permissions/requestApproval", "permission"],
  ] as const)("maps %s to %s with generation-aware identity", (method, kind) => {
    const normalized = normalizeCodexServerRequest({
      id: 1,
      method,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        approvalId: "approval-1",
        cwd: "/tmp/work",
        permissions: {},
      },
    }, context);

    expect(normalized.event).toMatchObject({
      type: "request",
      request: {
        kind,
        identity: {
          generation: 7,
          turnId: "turn-1",
          requestId: 1,
          itemId: "item-1",
          approvalId: method === "item/commandExecution/requestApproval" ? "approval-1" : null,
          key: { nativeTaskId: "thread-1" },
        },
      },
    });
    expect(normalized.request).toEqual(normalized.event.type === "request"
      ? normalized.event.request
      : undefined);
  });

  it("projects a redacted command beside its exact approval request", () => {
    const normalized = normalizeCodexServerRequest({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        approvalId: null,
        startedAtMs: 1,
        command: "echo sk-proj-0123456789abcdefghijklmnop",
        cwd: "/tmp/work",
      },
    }, context);

    expect(normalized.detailEvents).toMatchObject([{
      type: "activity",
      turnId: "turn-1",
      itemId: "item-1",
      activity: "commandApproval",
      status: "waitingOnApproval",
      message: "echo [REDACTED]",
    }]);
  });

  it("preserves numeric and string RPC ids as distinct identities", () => {
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1,
    };
    const numeric = normalizeCodexServerRequest({
      id: 1,
      method: "item/fileChange/requestApproval",
      params,
    }, context);
    const string = normalizeCodexServerRequest({
      id: "1",
      method: "item/fileChange/requestApproval",
      params,
    }, context);
    expect(numeric.request.identity.requestId).toBe(1);
    expect(string.request.identity.requestId).toBe("1");
  });

  it("maps bounded user input and stable MCP elicitation modes without copying prompts", () => {
    const input = normalizeCodexServerRequest({
      id: "input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        autoResolutionMs: 60_000,
        questions: [{ id: "q1", header: "H", question: "question-secret" }],
      },
    }, context);
    expect(input.request).toMatchObject({ kind: "user-input", autoResolutionMs: 60_000 });
    expect(input.questionIds).toEqual(["q1"]);
    expect(JSON.stringify(input.event)).not.toContain("question-secret");

    const mcp = normalizeCodexServerRequest({
      id: "mcp-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: null,
        mode: "url",
        elicitationId: "elicitation-1",
        message: "mcp-secret",
        url: "https://secret.example",
        serverName: "safe-server",
      },
    }, context);
    expect(mcp.request).toMatchObject({
      kind: "mcp-elicitation",
      identity: {
        generation: 7,
        approvalId: "elicitation-1",
        itemId: null,
      },
    });
    expect(JSON.stringify(mcp.event)).not.toContain("mcp-secret");
    expect(JSON.stringify(mcp.event)).not.toContain("secret.example");
  });

  it("fails closed on unsupported or malformed request shapes", () => {
    expect(() => normalizeCodexServerRequest({
      id: 1,
      method: "future/unsafeRequest",
      params: { threadId: "thread-1", secret: "do-not-copy" },
    }, context)).toThrowError(CodexNormalizationError);

    expect(() => normalizeCodexServerRequest({
      id: 1,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        mode: "future-mode",
        message: "secret",
        serverName: "server",
      },
    }, context)).toThrow(/invalid/i);
  });
});
