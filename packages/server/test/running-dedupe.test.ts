/**
 * GET /api/running dedupe: Claude Code can leave multiple live `<pid>.json`
 * files pointing at the SAME sessionId (e.g. a resumed session whose old
 * process/file lingers). Serving the id twice produced duplicate React keys,
 * phantom Live Ops cards, and contradictory counts. `dedupeRunningSessions`
 * collapses each sessionId to its best entry while leaving unidentifiable
 * (empty-id) entries untouched.
 */
import { describe, expect, it } from "vitest";
import type { RunningSession } from "@devhub/engine/types";
import { dedupeRunningSessions } from "../src/routes/running.js";

function session(over: Partial<RunningSession>): RunningSession {
  return {
    pid: 1,
    sessionId: "s-1",
    cwd: "/tmp/proj",
    status: "busy",
    alive: true,
    model: null,
    startedAt: 1_000,
    updatedAt: 2_000,
    name: null,
    entrypoint: "cli",
    waitingFor: null,
    statusUpdatedAt: 2_000,
    needsYou: false,
    stale: false,
    ...over,
  };
}

describe("dedupeRunningSessions", () => {
  it("returns a list with no duplicate sessionId", () => {
    const out = dedupeRunningSessions([
      session({ pid: 10, sessionId: "dup", updatedAt: 5_000 }),
      session({ pid: 20, sessionId: "other" }),
      session({ pid: 30, sessionId: "dup", updatedAt: 1_000 }),
    ]);
    expect(out.map((s) => s.sessionId)).toEqual(["dup", "other"]);
  });

  it("keeps the most recently updated entry for a duplicated id", () => {
    const out = dedupeRunningSessions([
      session({ pid: 10, sessionId: "dup", updatedAt: 1_000, status: "idle" }),
      session({ pid: 30, sessionId: "dup", updatedAt: 9_000, status: "busy" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(30);
    expect(out[0].status).toBe("busy");
  });

  it("prefers a live process over a dead one regardless of updatedAt", () => {
    const out = dedupeRunningSessions([
      session({ pid: 10, sessionId: "dup", alive: false, status: "dead", updatedAt: 9_000 }),
      session({ pid: 30, sessionId: "dup", alive: true, updatedAt: 1_000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(30);
    expect(out[0].alive).toBe(true);
  });

  it("breaks a full tie toward the newest pid, deterministically", () => {
    const out = dedupeRunningSessions([
      session({ pid: 10, sessionId: "dup" }),
      session({ pid: 30, sessionId: "dup" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(30);
  });

  it("preserves the input ordering (winner sits where the id first appeared)", () => {
    const out = dedupeRunningSessions([
      session({ pid: 1, sessionId: "a", updatedAt: 1 }),
      session({ pid: 2, sessionId: "b" }),
      session({ pid: 3, sessionId: "a", updatedAt: 99 }),
      session({ pid: 4, sessionId: "c" }),
    ]);
    expect(out.map((s) => `${s.sessionId}:${s.pid}`)).toEqual(["a:3", "b:2", "c:4"]);
  });

  it("never merges entries with an empty sessionId", () => {
    const out = dedupeRunningSessions([
      session({ pid: 1, sessionId: "" }),
      session({ pid: 2, sessionId: "" }),
    ]);
    expect(out).toHaveLength(2);
  });
});
