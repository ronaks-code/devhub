/**
 * Live Ops grid dedupe: /api/running could return the same sessionId under two
 * pids, giving the grid duplicate React keys, phantom panels, and a watching
 * count that disagreed with the Ops board's "N running". The server now dedupes,
 * and `dedupeBySessionId` mirrors that defensively in the grid.
 */
import { describe, expect, it } from "vitest";
import type { RunningSession } from "../lib/types";
import { dedupeBySessionId } from "./MultiSessionGrid";

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
  } as RunningSession;
}

describe("dedupeBySessionId", () => {
  it("keeps only the first entry per sessionId (server order = best first)", () => {
    const out = dedupeBySessionId([
      session({ pid: 10, sessionId: "dup" }),
      session({ pid: 20, sessionId: "other" }),
      session({ pid: 30, sessionId: "dup" }),
    ]);
    expect(out.map((s) => `${s.sessionId}:${s.pid}`)).toEqual(["dup:10", "other:20"]);
  });

  it("passes through entries with an empty sessionId untouched", () => {
    const out = dedupeBySessionId([
      session({ pid: 1, sessionId: "" }),
      session({ pid: 2, sessionId: "" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("leaves an already-unique list unchanged", () => {
    const input = [session({ sessionId: "a" }), session({ sessionId: "b", pid: 2 })];
    expect(dedupeBySessionId(input)).toEqual(input);
  });
});
