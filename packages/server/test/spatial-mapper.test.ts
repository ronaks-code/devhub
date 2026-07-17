import { describe, expect, it } from "vitest";
import { mapOpenClawToWorld } from "../src/spatial/mapper.js";
import { coerceRaw } from "../src/spatial/openclaw-source.js";
import type { RawOpenClawState } from "../src/spatial/openclaw-source.js";

/**
 * Adapter mapper tests — the pure function that turns loose, untrusted OpenClaw
 * state into a strict, self-consistent WorldState the renderer can trust. This is
 * the highest-value thing to lock down because it's where "M1's reality" becomes
 * "the contract".
 */

describe("mapOpenClawToWorld", () => {
  it("returns an empty, valid world for null input (never throws)", () => {
    const w = mapOpenClawToWorld(null);
    expect(w.agents).toEqual([]);
    expect(w.rooms).toEqual([]);
    expect(w.edges).toEqual([]);
    expect(typeof w.rev).toBe("number");
  });

  it("normalizes fuzzy roles and statuses to the contract's enums", () => {
    const raw: RawOpenClawState = {
      agents: [
        { id: "1", role: "VP of Eng", status: "running" },
        { id: "2", kind: "software engineer", state: "blocked on gate" },
        { id: "3", role: "product manager", status: "chatting" },
        { id: "4", role: "designer", status: "garbage-value" },
      ],
    };
    const byId = new Map(mapOpenClawToWorld(raw).agents.map((a) => [a.id, a]));
    expect(byId.get("1")!.role).toBe("leader");
    expect(byId.get("1")!.status).toBe("working");
    expect(byId.get("2")!.role).toBe("engineer");
    expect(byId.get("2")!.status).toBe("blocked");
    expect(byId.get("3")!.role).toBe("pm");
    expect(byId.get("3")!.status).toBe("talking");
    expect(byId.get("4")!.role).toBe("specialist");
    expect(byId.get("4")!.status).toBe("idle"); // safe default
  });

  it("accepts field aliases (dept/department, assignment/task, reportsTo/parentId)", () => {
    const raw: RawOpenClawState = {
      agents: [{ id: "x", department: "Talos", task: "hardening the adapter", parentId: "boss" }],
    };
    const a = mapOpenClawToWorld(raw).agents[0]!;
    expect(a.dept).toBe("talos");
    expect(a.assignment).toBe("hardening the adapter");
    expect(a.reports_to).toBe("boss");
  });

  it("derives one room per (dept, project) with correct membership", () => {
    const raw: RawOpenClawState = {
      agents: [
        { id: "a", dept: "vulcan", project: "devhub" },
        { id: "b", dept: "vulcan", project: "devhub" },
        { id: "c", dept: "vulcan", project: "capture" },
      ],
    };
    const rooms = mapOpenClawToWorld(raw).rooms;
    expect(rooms).toHaveLength(2);
    const devhub = rooms.find((r) => r.project === "devhub")!;
    expect(devhub.members.sort()).toEqual(["a", "b"]);
  });

  it("drops edges pointing at non-existent agents and dedupes by id", () => {
    const raw: RawOpenClawState = {
      agents: [{ id: "a" }, { id: "b" }],
      messages: [
        { id: "e1", from: "a", to: "b" },
        { id: "e1", from: "a", to: "b" }, // duplicate id
        { from: "a", to: "ghost" }, // dangling target
      ],
    };
    const edges = mapOpenClawToWorld(raw).edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe("a");
    expect(edges[0]!.to).toBe("b");
  });

  it("infers vertical vs lateral edges from the reporting hierarchy when unstated", () => {
    const raw: RawOpenClawState = {
      agents: [
        { id: "lead", role: "leader" },
        { id: "rep", role: "engineer", reportsTo: "lead" },
        { id: "peer", role: "leader" },
      ],
      messages: [
        { from: "lead", to: "rep" }, // leader → its report ⇒ vertical
        { from: "lead", to: "peer" }, // leader ↔ leader ⇒ lateral
      ],
    };
    const edges = mapOpenClawToWorld(raw).edges;
    expect(edges.find((e) => e.to === "rep")!.kind).toBe("vertical");
    expect(edges.find((e) => e.to === "peer")!.kind).toBe("lateral");
  });

  it("de-dupes agents by id (last wins)", () => {
    const raw: RawOpenClawState = {
      agents: [
        { id: "a", assignment: "first" },
        { id: "a", assignment: "second" },
      ],
    };
    const agents = mapOpenClawToWorld(raw).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.assignment).toBe("second");
  });
});

describe("coerceRaw", () => {
  it("reads the `edges` alias when `messages` is absent, and tolerates junk", () => {
    expect(coerceRaw(null)).toBeNull();
    expect(coerceRaw(42)).toBeNull();
    const r = coerceRaw({ agents: [{ id: "a" }], edges: [{ from: "a", to: "a" }] })!;
    expect(r.agents).toHaveLength(1);
    expect(r.messages).toHaveLength(1);
  });
});
