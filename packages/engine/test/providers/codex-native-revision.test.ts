import { describe, expect, it } from "vitest";
import {
  parseCodexThreadListResult,
  parseCodexThreadReadResult,
} from "../../src/providers/codex/native-shapes.js";
import { buildCodexNativeRevision } from "../../src/providers/codex/revision.js";

function thread(itemStatus = "inProgress", message = "first"): Record<string, unknown> {
  return {
    id: "thread-sensitive-id",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: message,
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 120,
    recencyAt: 121,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp/project",
    cliVersion: "0.144.1",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [
      {
        id: "turn-sensitive-id",
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 101,
        completedAt: 119,
        durationMs: 18_000,
        items: [
          {
            id: "item-sensitive-id",
            type: "commandExecution",
            command: message,
            cwd: "/tmp/project",
            processId: null,
            source: "agent",
            status: itemStatus,
            commandActions: [],
            aggregatedOutput: message,
            exitCode: null,
            durationMs: null,
          },
        ],
      },
    ],
  };
}

describe("Codex native revision", () => {
  it("derives public revision fields and a stable bounded fingerprint from metadata", () => {
    const parsed = parseCodexThreadReadResult({ thread: thread() }).thread;
    const first = buildCodexNativeRevision(parsed);
    const second = buildCodexNativeRevision(parsed);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      updatedAt: 120,
      status: "idle",
      lastTurnId: "turn-sensitive-id",
      lastTurnStatus: "completed",
      lastItemId: "item-sensitive-id",
    });
    expect(first.fingerprint).toMatch(/^codex:v1:[A-Za-z0-9_-]{43}$/);
    expect(first.fingerprint.length).toBeLessThanOrEqual(64);
    expect(first.fingerprint).not.toContain("sensitive");
  });

  it("changes for provider-native item status and timestamp changes", () => {
    const base = parseCodexThreadReadResult({ thread: thread("inProgress") }).thread;
    const statusChanged = parseCodexThreadReadResult({ thread: thread("completed") }).thread;
    const timestampChanged = parseCodexThreadReadResult({
      thread: { ...thread("inProgress"), updatedAt: 122 },
    }).thread;

    expect(buildCodexNativeRevision(statusChanged).fingerprint).not.toBe(
      buildCodexNativeRevision(base).fingerprint,
    );
    expect(buildCodexNativeRevision(timestampChanged).fingerprint).not.toBe(
      buildCodexNativeRevision(base).fingerprint,
    );
  });

  it("does not fingerprint command output, reasoning, or other raw content", () => {
    const first = parseCodexThreadReadResult({ thread: thread("completed", "secret-one") }).thread;
    const second = parseCodexThreadReadResult({ thread: thread("completed", "secret-two") }).thread;

    expect(buildCodexNativeRevision(first).fingerprint).toBe(
      buildCodexNativeRevision(second).fingerprint,
    );
  });

  it("is stable when archive authority is known from list but unknown from read", () => {
    const raw = thread("completed");
    const listed = parseCodexThreadListResult({ data: [raw] }, { archived: false }).threads[0]!;
    const read = parseCodexThreadReadResult({ thread: raw }).thread;

    expect(listed.archived).toBe(false);
    expect(read.archived).toBeNull();
    expect(buildCodexNativeRevision(listed).fingerprint).toBe(
      buildCodexNativeRevision(read).fingerprint,
    );
  });

  it("handles a thread with no turns without inventing native ids", () => {
    const parsed = parseCodexThreadReadResult({
      thread: { ...thread(), turns: [] },
    }).thread;

    expect(buildCodexNativeRevision(parsed)).toMatchObject({
      lastTurnId: null,
      lastTurnStatus: null,
      lastItemId: null,
    });
  });
});
