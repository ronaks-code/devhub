import { describe, expect, it } from "vitest";
import {
  ClaudeBackendDiagnosticStore,
  claudeBackendDiagnosticTaskScope,
  type ClaudeBackendDiagnosticRecordInput,
} from "../../src/providers/claude/backend-diagnostic-store.js";

const SESSION = "519f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TASK_SCOPE = claudeBackendDiagnosticTaskScope("/canonical/claude-home");

const record = (
  eventId: string,
  raw = JSON.stringify({ type: "future_event", credential: "sk-1234567890abcdefghijkl" }),
): ClaudeBackendDiagnosticRecordInput => ({
  taskScope: TASK_SCOPE,
  sessionId: SESSION,
  generation: 3,
  eventId,
  raw,
  truncated: false,
});

describe("ClaudeBackendDiagnosticStore", () => {
  it("redacts, bounds, deduplicates, and reports every lossy retention outcome", () => {
    const store = new ClaudeBackendDiagnosticStore(2);

    const first = store.retain(record("event-1"));
    expect(first?.raw).not.toContain("sk-1234567890abcdefghijkl");
    expect(first).toMatchObject({ sessionId: SESSION, generation: 3, eventId: "event-1" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(store.retain(record("event-1"))).toBeNull();
    expect(store.retain(record("event-1", "different payload"))).toBeNull();

    const hostile = {};
    Object.defineProperty(hostile, "sessionId", {
      enumerable: true,
      get: () => { throw new Error("hostile getter"); },
    });
    expect(store.retain(hostile as ClaudeBackendDiagnosticRecordInput)).toBeNull();

    store.retain(record("event-2", "second"));
    store.retain(record("event-3", "third"));
    const snapshot = store.snapshot();

    expect(snapshot).toMatchObject({
      accepted: 3,
      collisions: 1,
      dropped: 2,
      duplicates: 1,
      evicted: 1,
    });
    expect(snapshot.records.map(({ eventId }) => eventId)).toEqual(["event-2", "event-3"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("configHome");
    expect(JSON.stringify(snapshot)).not.toContain("cwd");
  });

  it("rejects unsafe bounds before allocating storage", () => {
    expect(() => new ClaudeBackendDiagnosticStore(0)).toThrow();
    expect(() => new ClaudeBackendDiagnosticStore(4_097)).toThrow();
  });

  it("keeps identical session and event ids isolated across opaque home scopes", () => {
    const store = new ClaudeBackendDiagnosticStore(2);
    const otherScope = claudeBackendDiagnosticTaskScope("/canonical/other-claude-home");

    store.retain(record("same-event", "first home"));
    store.retain({ ...record("same-event", "second home"), taskScope: otherScope });

    const snapshot = store.snapshot();
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.duplicates).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain("/canonical/");
  });
});
