import { describe, expect, it } from "vitest";
import {
  buildClaudeNativeRevision,
  type ClaudeNativeRevisionInput,
} from "../../src/providers/claude/revision.js";

const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const USER = "119f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const ASSISTANT = "219f5b78-18c0-7b60-8f0c-6afc120ecd7d";

const input = (overrides: Partial<ClaudeNativeRevisionInput> = {}): ClaudeNativeRevisionInput => ({
  sessionId: SESSION,
  createdAt: "2026-07-13T16:00:00.000Z",
  updatedAt: "2026-07-13T16:01:00.000Z",
  fileSize: 1_024,
  status: "complete",
  messages: [
    { id: USER, role: "user" },
    { id: ASSISTANT, role: "assistant" },
  ],
  ...overrides,
});

describe("buildClaudeNativeRevision", () => {
  it("builds a frozen content-free native revision with the last provider ids", () => {
    const revision = buildClaudeNativeRevision(input());
    expect(revision).toEqual({
      updatedAt: Date.parse("2026-07-13T16:01:00.000Z"),
      status: "complete",
      lastTurnId: USER,
      lastTurnStatus: "complete",
      lastItemId: ASSISTANT,
      fingerprint: expect.stringMatching(/^claude:v1:[A-Za-z0-9_-]{43}$/u),
    });
    expect(Object.isFrozen(revision)).toBe(true);
  });

  it("changes for provider metadata/topology but never accepts transcript text", () => {
    const base = buildClaudeNativeRevision(input());
    expect(buildClaudeNativeRevision(input({ fileSize: 1_025 })).fingerprint)
      .not.toBe(base.fingerprint);
    expect(buildClaudeNativeRevision(input({
      messages: [{ id: USER, role: "user" }],
    })).fingerprint).not.toBe(base.fingerprint);
    expect(() => buildClaudeNativeRevision(input({
      messages: [{ id: USER, role: "user", text: "must not hash" } as never],
    }))).toThrow(/revision/i);
    expect(JSON.stringify(base)).not.toContain("must not hash");
  });

  it("supports summary-only revision checks and rejects malformed ownership", () => {
    const revision = buildClaudeNativeRevision(input({ messages: [] }));
    expect(revision.lastTurnId).toBeNull();
    expect(revision.lastItemId).toBeNull();
    expect(() => buildClaudeNativeRevision(input({ sessionId: "not-a-uuid" })))
      .toThrow(/revision/i);
    expect(() => buildClaudeNativeRevision(input({ updatedAt: "yesterday" })))
      .toThrow(/revision/i);
    expect(() => buildClaudeNativeRevision(input({ fileSize: -1 })))
      .toThrow(/revision/i);
  });

  it("rejects credential and content-shaped statuses without changing safe semantics", () => {
    const safe = buildClaudeNativeRevision(input());
    expect(buildClaudeNativeRevision(input({ status: "complete" }))).toEqual(safe);
    for (const status of [
      "sk-1234567890abcdefghijkl",
      "completed with private transcript detail",
      "complete\nprivate-detail",
    ]) {
      expect(() => buildClaudeNativeRevision(input({ status }))).toThrow(/revision/i);
    }
  });

  it("rejects slug-shaped private content instead of hashing or returning it", () => {
    expect(() => buildClaudeNativeRevision(input({
      status: "private-transcript-detail",
    }))).toThrow(/revision/i);
  });

  it.each(["ſecret", "Key"])(
    "rejects Unicode case-folded status lookalike %s",
    (status) => {
      expect(() => buildClaudeNativeRevision(input({ status }))).toThrow(/revision/i);
    },
  );

  it.each([
    "active",
    "canceled",
    "cancelled",
    "complete",
    "error",
    "failed",
    "idle",
    "interrupted",
    "running",
    "starting",
    "stopped",
    "streaming",
    "success",
  ])("accepts the explicit content-free provider state %s", (status) => {
    const revision = buildClaudeNativeRevision(input({ status }));
    expect(revision.status).toBe(status);
    expect(revision.lastTurnStatus).toBe(status);
  });
});
