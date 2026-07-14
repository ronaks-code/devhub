import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  NativeTask,
  ProviderApiClient,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequestResponse,
} from "../lib/provider-api.js";
import {
  CodexNativePane,
  CodexNativeTimeline,
  MAX_CONNECT_BUFFER_EVENTS,
  appendCodexTimelineEvent,
  activeTurnAfterSendResponse,
  buildCodexTimeline,
  capabilityAllowsRequest,
  connectNativeTask,
  codexComposerPlaceholder,
  connectionAfterSnapshot,
  connectionMessage,
  createdTaskHandoff,
  descriptorSupportsNativeHistory,
  latestActiveTurn,
  nativeMutationsArePaused,
  nativeTaskIdentity,
  providerCreateOverrides,
  providerDefaultPermission,
  providerRequiresFirstMessage,
  providerResumeOverrides,
  providerEventAnnouncement,
  providerHomeReviewSource,
  projectReconciliationForTaskStatus,
  projectBufferedTurnReconciliation,
  projectReconciliationForTurnStatus,
  reconciliationReviewReady,
  reconciliationForPartialTask,
  reviewedTaskFingerprint,
  projectTaskStatus,
  projectTaskStatusFromTurnEvent,
  reconciliationKindForError,
  runNativeFork,
  runNativeCreate,
  shouldRetainArchivedSnapshotForReview,
  taskSelectionAfterList,
  taskIndexForKey,
  taskMatchesSelection,
  nativeTaskKeysEqual,
  type CodexTimelineState,
} from "./CodexNativePane.js";

const key = {
  provider: "openai" as const,
  home: "/Users/test/.codex",
  nativeTaskId: "thread-1",
};

const capabilities: ProviderCapabilities = {
  list: true,
  read: true,
  start: true,
  resume: true,
  fork: true,
  send: true,
  steer: false,
  interrupt: true,
  subscribe: true,
  approveCommand: false,
  approveFileChange: false,
  approvePermissions: false,
  requestUserInput: false,
  mcpElicitation: false,
  archive: true,
  rename: true,
  skills: false,
  plugins: false,
  hooks: false,
  mcp: false,
  backgroundWork: false,
};

const base = {
  provider: "openai" as const,
  key,
  occurredAt: "2026-07-13T10:00:00.000Z",
};

function task(id = "thread-1"): NativeTask {
  return {
    key: { ...key, nativeTaskId: id },
    title: `Task ${id}`,
    cwd: "/workspace",
    model: "gpt-5.4",
    status: "idle",
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:00:00.000Z",
    archived: false,
    source: "native",
    turns: [],
  };
}

function requestEvent(
  kind: "command-approval" | "file-change-approval" | "permission" | "user-input" | "mcp-elicitation",
): ProviderEvent {
  return {
    ...base,
    type: "request",
    request: {
      kind,
      identity: {
        key,
        generation: 7,
        turnId: "turn-1",
        requestId: `request-${kind}`,
        itemId: "item-request",
        approvalId: null,
      },
      ...(kind === "user-input" ? { autoResolutionMs: null } : {}),
    },
  } as ProviderEvent;
}

describe("CodexNativePane timeline", () => {
  it("keeps an existing task with no events as an unadorned transcript canvas", () => {
    const html = renderToStaticMarkup(
      createElement(CodexNativeTimeline, {
        timeline: buildCodexTimeline([]),
        capabilities,
        onRespond: vi.fn<(response: ProviderRequestResponse) => void>(),
      }),
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Codex task transcript"');
    expect(html).not.toContain("Ready for a native Codex turn");
    expect(html).not.toContain("Continue this task below");
    expect(html).not.toContain("<svg");
  });

  it("renders acknowledged user cancellation as exact transcript copy", () => {
    const html = renderToStaticMarkup(
      createElement(CodexNativeTimeline, {
        timeline: buildCodexTimeline([{
          ...base,
          type: "status",
          scope: "turn",
          status: "cancelled_by_user",
          nativeId: "turn-1",
        }]),
        capabilities,
        onRespond: vi.fn<(response: ProviderRequestResponse) => void>(),
      }),
    );

    expect(html).toContain("Cancelled by you");
    expect(html).not.toContain("cancelled_by_user");
  });

  it("coalesces deltas and authoritative completions by native turn/item identity", () => {
    const events: ProviderEvent[] = [
      {
        ...base,
        type: "message-delta",
        role: "assistant",
        delta: "Hel",
        turnId: "turn-1",
        itemId: "item-1",
      },
      {
        ...base,
        type: "message-delta",
        role: "assistant",
        delta: "lo",
        turnId: "turn-1",
        itemId: "item-1",
      },
      {
        ...base,
        type: "message",
        role: "assistant",
        text: "Hello, complete.",
        turnId: "turn-1",
        itemId: "item-1",
      },
    ];

    const timeline = buildCodexTimeline(events);
    expect(timeline.order).toEqual(["message:turn-1:item-1:assistant"]);
    expect(timeline.entries[timeline.order[0]!]).toMatchObject({
      kind: "message",
      text: "Hello, complete.",
      streaming: false,
    });
  });

  it("does not let a late replayed delta corrupt an authoritative completed item", () => {
    const completed = appendCodexTimelineEvent(buildCodexTimeline([]), {
      ...base,
      type: "message",
      role: "assistant",
      text: "Authoritative text",
      turnId: "turn-1",
      itemId: "item-1",
    });
    const afterReplay = appendCodexTimelineEvent(completed, {
      ...base,
      type: "message-delta",
      role: "assistant",
      delta: " duplicate",
      turnId: "turn-1",
      itemId: "item-1",
    });

    expect(afterReplay).toBe(completed);
    expect(afterReplay.entries["message:turn-1:item-1:assistant"]).toMatchObject({
      text: "Authoritative text",
      streaming: false,
    });
  });

  it("updates plan, activity, status, diff, and usage in place without dropping native IDs", () => {
    const events: ProviderEvent[] = [
      { ...base, type: "plan", turnId: "turn-1", itemId: "plan-1", stepIndex: null, text: "1. Test", status: "inProgress" },
      { ...base, type: "plan", turnId: "turn-1", itemId: "plan-1", stepIndex: null, text: "1. Test", status: "completed" },
      { ...base, type: "activity", turnId: "turn-1", itemId: "tool-1", activity: "shell", status: "running", message: "Running tests" },
      { ...base, type: "status", scope: "turn", status: "inProgress", nativeId: "turn-1" },
      { ...base, type: "diff-summary", turnId: "turn-1", changedFiles: 2, additions: 14, deletions: 3 },
      { ...base, type: "usage", turnId: "turn-1", inputTokens: 10, outputTokens: 20, cachedInputTokens: 5, totalTokens: 30 },
    ];

    const timeline = buildCodexTimeline(events);
    expect(timeline.order).toHaveLength(5);
    expect(timeline.entries["plan:turn-1:plan-1"]).toMatchObject({ status: "completed" });
    expect(timeline.entries["activity:turn-1:tool-1"]).toMatchObject({ nativeId: "tool-1" });
    expect(timeline.entries["status:turn:turn-1"]).toMatchObject({ nativeId: "turn-1" });
    expect(timeline.entries["diff:turn-1"]).toMatchObject({ additions: 14, deletions: 3 });
    expect(timeline.entries["usage:turn-1"]).toMatchObject({ totalTokens: 30 });
  });

  it("concatenates item plan deltas until the authoritative completion", () => {
    const timeline = buildCodexTimeline([
      { ...base, type: "plan", turnId: "turn-1", itemId: "plan-1", stepIndex: null, text: "1. ", status: "streaming" },
      { ...base, type: "plan", turnId: "turn-1", itemId: "plan-1", stepIndex: null, text: "Test", status: "streaming" },
      { ...base, type: "plan", turnId: "turn-1", itemId: "plan-1", stepIndex: null, text: "1. Test completely", status: "completed" },
    ]);

    expect(timeline.entries["plan:turn-1:plan-1"]).toMatchObject({
      text: "1. Test completely",
      status: "completed",
    });
  });

  it("keeps provider plan snapshot steps distinct without inventing native ids", () => {
    const timeline = buildCodexTimeline([
      { ...base, type: "plan", turnId: "turn-1", itemId: null, stepIndex: 0, text: "First", status: "completed" },
      { ...base, type: "plan", turnId: "turn-1", itemId: null, stepIndex: 1, text: "Second", status: "inProgress" },
    ]);

    expect(timeline.order).toEqual(["plan:turn-1:step:0", "plan:turn-1:step:1"]);
    expect(timeline.entries["plan:turn-1:step:0"]).toMatchObject({ text: "First", nativeId: null });
    expect(timeline.entries["plan:turn-1:step:1"]).toMatchObject({ text: "Second", nativeId: null });
  });

  it("removes the exact pending intervention after request resolution", () => {
    const request = requestEvent("command-approval");
    const withRequest = appendCodexTimelineEvent(buildCodexTimeline([]), request);
    const identity = request.type === "request" ? request.request.identity : null;
    const resolved = appendCodexTimelineEvent(withRequest, {
      ...base,
      type: "request-resolved",
      identity: identity!,
    });

    expect(withRequest.order).toHaveLength(1);
    expect(resolved.order).toHaveLength(0);
  });

  it("treats a growing non-tail item as a new timeline revision", () => {
    const before = buildCodexTimeline([
      { ...base, type: "message-delta", role: "assistant", delta: "First", turnId: "turn-1", itemId: "item-1" },
      { ...base, type: "status", scope: "turn", status: "inProgress", nativeId: "turn-1" },
    ]);
    const tail = before.order.at(-1);
    const after = appendCodexTimelineEvent(before, {
      ...base,
      type: "message-delta",
      role: "assistant",
      delta: " response",
      turnId: "turn-1",
      itemId: "item-1",
    });

    expect(after).not.toBe(before);
    expect(after.order.at(-1)).toBe(tail);
    expect(after.entries["message:turn-1:item-1:assistant"]).toMatchObject({ text: "First response" });
  });

  it("announces bounded lifecycle changes without announcing token deltas", () => {
    expect(providerEventAnnouncement({
      ...base,
      type: "message-delta",
      role: "assistant",
      delta: "secret streaming text",
      turnId: "turn-1",
      itemId: "item-1",
    })).toBeNull();
    expect(providerEventAnnouncement({
      ...base,
      type: "status",
      scope: "turn",
      status: "completed",
      nativeId: "turn-1",
    })).toBe("Codex turn status: completed.");
    expect(providerEventAnnouncement({
      ...base,
      type: "message",
      role: "assistant",
      text: "sensitive response body",
      turnId: "turn-1",
      itemId: "item-1",
    })).toBe("Codex response completed.");
  });
});

describe("CodexNativePane mutation ordering", () => {
  it("keeps every mutation paused until the authoritative home list settles", () => {
    expect(nativeMutationsArePaused("connected", false, null)).toBe(false);
    expect(nativeMutationsArePaused("connected", true, null)).toBe(true);
    expect(nativeMutationsArePaused("connecting", false, null)).toBe(true);
  });

  it("never invents a task read for uncertain create reconciliation", () => {
    const createScope = {
      kind: "provider-home" as const,
      home: key.home,
      reason: "mutation-uncertain" as const,
      phase: "refresh-home" as const,
      operation: "create" as const,
    };
    const forkScope = {
      ...createScope,
      operation: "fork" as const,
      sourceKey: key,
    };

    expect(providerHomeReviewSource(createScope)).toBeUndefined();
    expect(providerHomeReviewSource(forkScope)).toEqual(key);
    expect(taskSelectionAfterList(null, [task("newly-listed")], "preserve")).toBeNull();
    expect(taskSelectionAfterList("existing", [task("existing"), task("newly-listed")], "preserve"))
      .toBe("existing");
  });

  it("retains an archived snapshot until uncertain archive review is acknowledged", () => {
    expect(shouldRetainArchivedSnapshotForReview({
      kind: "task",
      key,
      phase: "refresh",
      operation: "archive",
    }, key)).toBe(true);
    expect(shouldRetainArchivedSnapshotForReview({
      kind: "task",
      key,
      phase: "review",
      operation: "archive",
    }, key)).toBe(true);
    expect(shouldRetainArchivedSnapshotForReview(null, key)).toBe(false);
  });

  it("records a lagging archived status while uncertain archive review is open", () => {
    const reviewing = {
      kind: "task" as const,
      key,
      phase: "review" as const,
      operation: "archive" as const,
    };

    expect(projectReconciliationForTaskStatus(reviewing, key, "archived")).toEqual({
      ...reviewing,
      observedArchived: true,
    });
    expect(projectReconciliationForTaskStatus(reviewing, key, "idle")).toBe(reviewing);
  });

  it("allows an authoritative reconciliation review independently of task stream state", () => {
    expect(reconciliationReviewReady({
      kind: "provider-home",
      home: key.home,
      reason: "mutation-uncertain",
      phase: "review",
      operation: "create",
    })).toBe(true);
    expect(reconciliationReviewReady({
      kind: "provider-home",
      home: key.home,
      reason: "mutation-uncertain",
      phase: "refresh-home",
      operation: "create",
    })).toBe(false);
  });
});

describe("CodexNativePane capability truth", () => {
  it("requires verified list and read before entering the native history shell", () => {
    const available = {
      provider: "openai" as const,
      home: key.home,
      status: "available" as const,
      capabilities,
    };
    expect(descriptorSupportsNativeHistory(available)).toBe(true);
    expect(descriptorSupportsNativeHistory({
      ...available,
      capabilities: { ...capabilities, list: false },
    })).toBe(false);
    expect(descriptorSupportsNativeHistory({
      ...available,
      capabilities: { ...capabilities, read: false },
    })).toBe(false);
  });

  it("maps every request kind only to its matching verified capability", () => {
    expect(capabilityAllowsRequest(capabilities, "command-approval")).toBe(false);
    expect(capabilityAllowsRequest({ ...capabilities, approveCommand: true }, "command-approval")).toBe(true);
    expect(capabilityAllowsRequest({ ...capabilities, approveCommand: true }, "file-change-approval")).toBe(false);
    expect(capabilityAllowsRequest({ ...capabilities, approveFileChange: true }, "file-change-approval")).toBe(true);
    expect(capabilityAllowsRequest({ ...capabilities, approvePermissions: true }, "permission")).toBe(true);
    expect(capabilityAllowsRequest({ ...capabilities, requestUserInput: true }, "user-input")).toBe(true);
    expect(capabilityAllowsRequest({ ...capabilities, mcpElicitation: true }, "mcp-elicitation")).toBe(true);
  });

  it("never renders actionable intervention controls for capability-gated requests", () => {
    const timeline = buildCodexTimeline([
      requestEvent("command-approval"),
      requestEvent("file-change-approval"),
      requestEvent("permission"),
      requestEvent("user-input"),
      requestEvent("mcp-elicitation"),
    ]);
    const html = renderToStaticMarkup(
      createElement(CodexNativeTimeline, {
        timeline,
        capabilities,
        onRespond: vi.fn<(response: ProviderRequestResponse) => void>(),
      }),
    );

    expect(html).not.toContain("Approve command");
    expect(html).not.toContain("Approve file change");
    expect(html).not.toContain("Submit permission response");
    expect(html).not.toContain("Submit requested input");
    expect(html).not.toContain("Approve MCP request");
    expect(html).toContain("This provider interaction is not enabled");
  });

  it("renders accessible approval actions only after the precise capability is verified", () => {
    const html = renderToStaticMarkup(
      createElement(CodexNativeTimeline, {
        timeline: buildCodexTimeline([requestEvent("command-approval")]),
        capabilities: { ...capabilities, approveCommand: true },
        onRespond: vi.fn<(response: ProviderRequestResponse) => void>(),
      }),
    );

    expect(html).toContain("aria-label=\"Approve command\"");
    expect(html).toContain("aria-label=\"Deny command\"");
    expect(html).toContain("role=\"status\"");
  });
});

describe("CodexNativePane keyboard and lifecycle ordering", () => {
  it("uses the approved existing-task composer copy at rest", () => {
    expect(codexComposerPlaceholder(false, false, false)).toBe("Ask for follow-up changes");
    expect(codexComposerPlaceholder(true, false, false)).toBe("Reconnect to send. Your draft is saved.");
    expect(codexComposerPlaceholder(false, true, false)).toBe("Wait for this turn or interrupt it");
  });

  it("implements bounded roving task-list navigation", () => {
    expect(taskIndexForKey("ArrowDown", 0, 3)).toBe(1);
    expect(taskIndexForKey("j", 2, 3)).toBe(0);
    expect(taskIndexForKey("ArrowUp", 0, 3)).toBe(2);
    expect(taskIndexForKey("k", 1, 3)).toBe(0);
    expect(taskIndexForKey("Home", 2, 3)).toBe(0);
    expect(taskIndexForKey("End", 0, 3)).toBe(2);
    expect(taskIndexForKey("x", 1, 3)).toBeNull();
    expect(taskIndexForKey("ArrowDown", 0, 0)).toBeNull();
  });

  it("rejects mutations from a stale task snapshot after selection changes", () => {
    expect(taskMatchesSelection(task(), key.home, key.nativeTaskId)).toBe(true);
    expect(taskMatchesSelection(task(), key.home, "thread-2")).toBe(false);
    expect(taskMatchesSelection(task(), "/another/home", key.nativeTaskId)).toBe(false);
    expect(taskMatchesSelection(null, key.home, key.nativeTaskId)).toBe(false);
  });

  it("never dispatches a provider request response through a different selected task", () => {
    expect(nativeTaskKeysEqual(key, { ...key })).toBe(true);
    expect(nativeTaskKeysEqual(key, { ...key, nativeTaskId: "thread-2" })).toBe(false);
    expect(nativeTaskKeysEqual(key, { ...key, home: "/another/home" })).toBe(false);
  });

  it("acknowledges only the exact fingerprint displayed for the selected native task", () => {
    const reviewed = {
      ...task(),
      revision: {
        updatedAt: 1,
        status: "idle",
        lastTurnId: null,
        lastTurnStatus: null,
        lastItemId: null,
        fingerprint: "reviewed-fingerprint",
      },
    };
    expect(reviewedTaskFingerprint(reviewed, reviewed.key)).toBe("reviewed-fingerprint");
    expect(reviewedTaskFingerprint(reviewed, { ...reviewed.key, nativeTaskId: "other" }))
      .toBeNull();
    expect(reviewedTaskFingerprint({ ...reviewed, revision: undefined }, reviewed.key))
      .toBeNull();
  });

  it("uses provider, home, and native task id for every internal task identity", () => {
    const identity = nativeTaskIdentity(key);
    expect(identity).toContain("openai");
    expect(identity).toContain(key.home);
    expect(identity).toContain(key.nativeTaskId);
    expect(nativeTaskIdentity({ ...key, provider: "anthropic" }))
      .not.toBe(identity);
  });

  it("drops hidden cross-provider model and permission state at serialization", () => {
    expect(providerCreateOverrides(
      "anthropic",
      "gpt-5.4",
      "workspace-write",
    )).toEqual({ permissionMode: "plan" });
    expect(providerCreateOverrides("anthropic", "", "plan"))
      .toEqual({ permissionMode: "plan" });
    expect(providerCreateOverrides("openai", "gpt-5.4", "manual"))
      .toEqual({ model: "gpt-5.4", permissionMode: "read-only" });
    expect(providerDefaultPermission("anthropic")).toBe("plan");
    expect(providerDefaultPermission("openai")).toBe("read-only");
    expect(providerRequiresFirstMessage("anthropic")).toBe(true);
    expect(providerRequiresFirstMessage("openai")).toBe(false);
  });

  it("preserves known Claude policy on normal resume and uses Plan only for explicit repair", () => {
    expect(providerResumeOverrides("anthropic", null, false)).toEqual({});
    expect(providerResumeOverrides("anthropic", null, true))
      .toEqual({ permissionMode: "plan" });
    expect(providerResumeOverrides("openai", "gpt-5.4", false))
      .toEqual({ model: "gpt-5.4", permissionMode: "read-only" });
  });

  it("does not reactivate a turn whose terminal notification beat its send response", () => {
    expect(activeTurnAfterSendResponse("turn-2", "completed")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "interrupted")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "aborted")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "complete")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "error_during_execution")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "error_max_turns")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "error_max_budget_usd")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "error_max_structured_output_retries")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "failure")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "runtime_failure_uncertain")).toBeNull();
    expect(activeTurnAfterSendResponse("turn-2", "inProgress")).toBe("turn-2");
    expect(activeTurnAfterSendResponse("turn-2", undefined)).toBe("turn-2");
  });

  it("never promotes a dead or unreconciled stream to connected after its read resolves", () => {
    expect(connectionAfterSnapshot(true, false)).toBe("disconnected");
    expect(connectionAfterSnapshot(false, true)).toBe("disconnected");
    expect(connectionAfterSnapshot(false, false)).toBe("connected");
  });

  it("projects only task-scoped status onto the task row", () => {
    const original = task();
    const lateOldTurn: ProviderEvent = {
      ...base,
      type: "status",
      scope: "turn",
      status: "completed",
      nativeId: "turn-1",
    };
    const currentTask: ProviderEvent = {
      ...base,
      type: "status",
      scope: "task",
      status: "running",
      nativeId: original.key.nativeTaskId,
    };

    expect(projectTaskStatus(original, lateOldTurn)).toBe(original);
    expect(projectTaskStatus(original, currentTask)).toMatchObject({ status: "running" });
    expect(projectTaskStatus(original, { ...currentTask, status: "archived" })).toMatchObject({
      status: "archived",
      archived: true,
    });
  });

  it("returns an active task row to idle when its final active turn completes", () => {
    const activeTask = { ...task(), status: "active" };
    const completed: ProviderEvent = {
      ...base,
      type: "status",
      scope: "turn",
      status: "completed",
      nativeId: "turn-1",
    };

    expect(projectTaskStatusFromTurnEvent(activeTask, completed, false))
      .toMatchObject({ status: "idle" });
    expect(projectTaskStatusFromTurnEvent(activeTask, completed, true))
      .toBe(activeTask);
  });

  it.each(["compacting", "initialized", "pending", "queued", "requesting"] as const)(
    "keeps the real Claude %s task status active until its terminal turn settles",
    (status) => {
      const activeTask = { ...task(), status: "active" };
      const projected = projectTaskStatus(activeTask, {
        ...base,
        type: "status",
        scope: "task",
        status,
        nativeId: activeTask.key.nativeTaskId,
      });
      expect(projectTaskStatusFromTurnEvent(projected, {
        ...base,
        type: "status",
        scope: "turn",
        status: "success",
        nativeId: "turn-1",
      }, false)).toMatchObject({ status: "idle" });
    },
  );

  it("settles the row for every provider terminal alias, including Claude interrupt results", () => {
    const activeTask = { ...task(), status: "active" };
    for (const status of [
      "aborted",
      "complete",
      "cancelled_by_user",
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
      "failure",
      "runtime_failure_uncertain",
      "success",
    ]) {
      const terminal: ProviderEvent = {
        ...base,
        type: "status",
        scope: "turn",
        status,
        nativeId: "turn-1",
      };
      expect(projectTaskStatusFromTurnEvent(activeTask, terminal, false), status)
        .toMatchObject({ status: "idle" });
    }
  });

  it("enters task reconciliation immediately for an uncertain runtime terminal", () => {
    expect(projectReconciliationForTurnStatus(null, key, "runtime_failure_uncertain"))
      .toEqual({
        kind: "task",
        key,
        phase: "refresh",
        operation: "send",
      });
    const reviewing = {
      kind: "task" as const,
      key,
      phase: "review" as const,
      operation: "rename" as const,
    };
    expect(projectReconciliationForTurnStatus(reviewing, key, "runtime_failure_uncertain"))
      .toBe(reviewing);
    expect(projectReconciliationForTurnStatus(null, key, "error_during_execution"))
      .toBeNull();
  });

  it("keeps a buffered runtime crash disconnected when it beats the initial snapshot", () => {
    const crash: ProviderEvent = {
      ...base,
      type: "status",
      scope: "turn",
      status: "runtime_failure_uncertain",
      nativeId: "turn-1",
    };
    expect(projectBufferedTurnReconciliation(null, key, [crash])).toEqual({
      scope: {
        kind: "task",
        key,
        phase: "refresh",
        operation: "send",
      },
      disconnect: true,
    });
  });
});

describe("CodexNativePane operation recovery", () => {
  it("preserves an active first turn returned by native task creation", () => {
    const created = {
      ...task("new-active-task"),
      turns: [
        {
          id: "first-native-turn",
          status: "inProgress",
          startedAt: null,
          completedAt: null,
          events: [],
        },
      ],
    };
    expect(latestActiveTurn(created)).toBe("first-native-turn");
    expect(latestActiveTurn({
      ...created,
      turns: [{ ...created.turns[0]!, status: "completed" }],
    })).toBeNull();
  });

  it("hands the authoritative created task directly into connected view state", () => {
    const created = {
      ...task("new-active-task"),
      turns: [{
        id: "first-native-turn",
        status: "inProgress",
        startedAt: null,
        completedAt: null,
        events: [{
          ...base,
          key: { ...key, nativeTaskId: "new-active-task" },
          type: "status" as const,
          scope: "turn" as const,
          status: "inProgress",
          nativeId: "first-native-turn",
        }],
      }],
    };
    const handoff = createdTaskHandoff(created);
    expect(handoff.selectedTask).toBe(created);
    expect(handoff.identity).toContain("openai");
    expect(handoff.activeTurnId).toBe("first-native-turn");
    expect(handoff.turnStatuses.get("first-native-turn")).toBe("inProgress");
    expect(handoff.timeline.order).toContain("status:turn:first-native-turn");
  });

  it("directly selects a preferred native session even when it is not on the first list page", () => {
    const select = taskSelectionAfterList as unknown as (
      current: string | null,
      tasks: readonly NativeTask[],
      mode: "first" | "preserve",
      preferredTaskId?: string,
    ) => string | null;
    expect(select(null, [task("first-page-task")], "first", "continued-session"))
      .toBe("continued-session");
  });

  it("renders an accessible bounded loading state before provider discovery", () => {
    const providers = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CodexNativePane, {
        client: { providers } as unknown as ProviderApiClient,
      }),
    );

    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("Checking native Codex runtime");
    expect(html).not.toContain("Create task");
    // Effects do not run during static rendering, which keeps this proof hermetic.
    expect(providers).not.toHaveBeenCalled();
  });

  it("opens a partially-created native task and never blindly retries start", async () => {
    const recovered = task("created-despite-turn-failure");
    const start = vi.fn().mockResolvedValue({
      outcome: "partial",
      code: "PARTIAL_START",
      provider: "openai",
      task: recovered,
    });

    const result = await runNativeCreate(
      { start } as never,
      "openai",
      { home: key.home, cwd: "/workspace", permissionMode: "read-only" },
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(result.task.key.nativeTaskId).toBe(recovered.key.nativeTaskId);
    expect(result.partial).toBe(true);
    expect(result.retry).toBe(false);
    expect(result.reconciliationOperation).toBe("send");
    expect(reconciliationForPartialTask(result.task.key, result.reconciliationOperation!))
      .toEqual({
        kind: "task",
        key: result.task.key,
        phase: "refresh",
        operation: "send",
        afterReview: "task-policy",
      });
    expect(result.notice).toMatch(/status is unknown/i);
    expect(result.notice).toContain(recovered.key.nativeTaskId);
  });

  it("freezes the correct scope for uncertain and policy-mismatch mutations", () => {
    expect(reconciliationKindForError({ code: "MUTATION_UNCERTAIN" }, "provider-home"))
      .toBe("provider-home");
    expect(reconciliationKindForError({ code: "RECONCILIATION_REQUIRED" }, "task"))
      .toBe("task");
    expect(reconciliationKindForError({ code: "POLICY_MISMATCH" }, "task"))
      .toBe("task-policy");
    expect(reconciliationKindForError(new Error("ordinary failure"), "task")).toBeNull();
  });

  it("subscribes before the authoritative read and replays buffered events", async () => {
    const calls: string[] = [];
    let emit!: (event: ProviderEvent) => void;
    let resolveRead!: (value: NativeTask) => void;
    const client = {
      subscribe: vi.fn(async (_key, sink) => {
        calls.push("subscribe");
        emit = sink;
        return {
          signal: new AbortController().signal,
          closed: new Promise<void>(() => undefined),
          unsubscribe: vi.fn(async () => undefined),
        };
      }),
      read: vi.fn(async () => {
        calls.push("read");
        return await new Promise<NativeTask>((resolve) => { resolveRead = resolve; });
      }),
    } as unknown as Pick<ProviderApiClient, "subscribe" | "read">;
    const ready = vi.fn();
    const live = vi.fn();
    const pending = connectNativeTask(
      client,
      key,
      new AbortController().signal,
      live,
      vi.fn(),
      ready,
    );
    await vi.waitFor(() => expect(calls).toEqual(["subscribe", "read"]));
    const buffered = {
      ...base,
      type: "status" as const,
      scope: "turn" as const,
      status: "inProgress",
      nativeId: "turn-2",
    };
    emit(buffered);
    resolveRead(task());
    await pending;

    expect(ready).toHaveBeenCalledWith(task(), [buffered]);
    expect(live).not.toHaveBeenCalled();
  });

  it("bounds pre-snapshot events and tears down immediately on overflow", async () => {
    let emit!: (event: ProviderEvent) => void;
    const unsubscribe = vi.fn(async () => undefined);
    const client = {
      subscribe: vi.fn(async (_key, sink) => {
        emit = sink;
        return {
          signal: new AbortController().signal,
          closed: new Promise<void>(() => undefined),
          unsubscribe,
        };
      }),
      read: vi.fn(() => new Promise<NativeTask>(() => undefined)),
    } as unknown as Pick<ProviderApiClient, "subscribe" | "read">;
    const streamError = vi.fn();
    const pending = connectNativeTask(
      client,
      key,
      new AbortController().signal,
      vi.fn(),
      streamError,
      vi.fn(),
    );
    await vi.waitFor(() => expect(client.read).toHaveBeenCalledTimes(1));
    const event: ProviderEvent = {
      ...base,
      type: "status",
      scope: "turn",
      status: "inProgress",
      nativeId: "turn-overflow",
    };
    for (let index = 0; index <= MAX_CONNECT_BUFFER_EVENTS; index += 1) emit(event);

    await expect(pending).rejects.toMatchObject({ code: "SSE_BUFFER_LIMIT" });
    expect(streamError).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes immediately when navigation aborts a hung snapshot read", async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const controller = new AbortController();
    const client = {
      subscribe: vi.fn(async () => ({
        signal: new AbortController().signal,
        closed: new Promise<void>(() => undefined),
        unsubscribe,
      })),
      read: vi.fn(() => new Promise<NativeTask>(() => undefined)),
    } as unknown as Pick<ProviderApiClient, "subscribe" | "read">;
    const pending = connectNativeTask(
      client,
      key,
      controller.signal,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(() => expect(client.read).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects a snapshot attempt whose stream closes cleanly before read completes", async () => {
    let close!: () => void;
    const unsubscribe = vi.fn(async () => undefined);
    const client = {
      subscribe: vi.fn(async () => ({
        signal: new AbortController().signal,
        closed: new Promise<void>((resolve) => { close = resolve; }),
        unsubscribe,
      })),
      read: vi.fn(() => new Promise<NativeTask>(() => undefined)),
    } as unknown as Pick<ProviderApiClient, "subscribe" | "read">;
    const streamError = vi.fn();
    const pending = connectNativeTask(
      client,
      key,
      new AbortController().signal,
      vi.fn(),
      streamError,
      vi.fn(),
    );
    await vi.waitFor(() => expect(client.read).toHaveBeenCalledTimes(1));
    close();

    await expect(pending).rejects.toMatchObject({ code: "SSE_READ_FAILED" });
    expect(streamError).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rereads before choosing the native fork point", async () => {
    const current = {
      ...task(),
      turns: [
        { id: "turn-1", status: "completed", startedAt: null, completedAt: null, events: [] },
        { id: "turn-2", status: "completed", startedAt: null, completedAt: null, events: [] },
      ],
    };
    const forked = task("fork-1");
    const client = {
      read: vi.fn().mockResolvedValue(current),
      fork: vi.fn().mockResolvedValue({ outcome: "created", task: forked }),
    } as unknown as Pick<ProviderApiClient, "read" | "fork">;

    const result = await runNativeFork(client, key);

    expect(client.read).toHaveBeenCalledWith(key, true);
    expect(client.fork).toHaveBeenCalledWith(key, "turn-2");
    expect(result.task).toBe(forked);
  });

  it("distinguishes reconnecting from disconnected mutation freeze copy", () => {
    expect(connectionMessage("reconnecting")).toMatch(/Reconnecting/);
    expect(connectionMessage("disconnected")).toBe(
      "Connection lost — task status must be checked before continuing.",
    );
    expect(connectionMessage("connected")).toBeNull();
  });
});

// Compile-time guard: the timeline state stays serializable and event-owned.
const _timelineState: CodexTimelineState = { order: [], entries: {} };
void _timelineState;
