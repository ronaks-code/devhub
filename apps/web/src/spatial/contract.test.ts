import { describe, expect, it } from "vitest";
import {
  applyDelta,
  parseWorldState,
  type Agent,
  type DeltaMessage,
  type WorldState,
} from "./contract";

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    dept: "vulcan",
    role: "engineer",
    status: "idle",
    assignment: "",
    reports_to: null,
    project: "devhub",
    ...over,
  };
}

const base: WorldState = {
  rev: 1,
  ts: 100,
  agents: [agent("a"), agent("b")],
  edges: [{ id: "e1", from: "a", to: "b", kind: "vertical", active: false }],
  rooms: [{ id: "r1", project: "devhub", dept: "vulcan", label: "R1", members: ["a", "b"] }],
};

describe("applyDelta", () => {
  it("upserts agents/edges/rooms and removes by id", () => {
    const delta: DeltaMessage = {
      type: "delta",
      rev: 2,
      ts: 200,
      agents: [agent("a", { status: "working" }), agent("c")],
      removedAgents: ["b"],
    };
    const next = applyDelta(base, delta);
    expect(next.rev).toBe(2);
    expect(next.agents.find((x) => x.id === "a")!.status).toBe("working");
    expect(next.agents.find((x) => x.id === "c")).toBeTruthy();
    expect(next.agents.find((x) => x.id === "b")).toBeUndefined();
    // Untouched lists are preserved.
    expect(next.rooms).toHaveLength(1);
  });

  it("does not mutate the input world", () => {
    const before = structuredClone(base);
    applyDelta(base, { type: "delta", rev: 2, ts: 200, agents: [agent("a", { status: "done" })] });
    expect(base).toEqual(before);
  });
});

describe("parseWorldState", () => {
  it("accepts a well-formed world", () => {
    expect(parseWorldState(structuredClone(base))).toBeTruthy();
  });

  it("returns null on malformed input rather than throwing", () => {
    expect(parseWorldState(null)).toBeNull();
    expect(parseWorldState({ rev: "x" })).toBeNull();
    expect(parseWorldState({ rev: 1, ts: 1, agents: {}, edges: [], rooms: [] })).toBeNull();
  });

  it("drops edges and room members that reference unknown agents (no ghosts)", () => {
    const dirty = {
      rev: 1,
      ts: 1,
      agents: [agent("a")],
      edges: [
        { id: "ok", from: "a", to: "a", kind: "lateral", active: true },
        { id: "ghost", from: "a", to: "zzz", kind: "vertical", active: true },
      ],
      rooms: [{ id: "r1", project: "p", dept: "vulcan", label: "R", members: ["a", "zzz"] }],
    };
    const parsed = parseWorldState(dirty)!;
    expect(parsed.edges.map((e) => e.id)).toEqual(["ok"]);
    expect(parsed.rooms[0]!.members).toEqual(["a"]);
  });
});
