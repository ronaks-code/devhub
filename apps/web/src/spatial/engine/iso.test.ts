import { describe, expect, it } from "vitest";
import type { Agent, Room, WorldState } from "../contract";
import {
  TILE_H,
  TILE_W,
  agentGridPosition,
  computeLayout,
  deptColor,
  screenBounds,
  toScreen,
} from "./iso";

/**
 * iso layout tests. The load-bearing guarantee here is that rooms NEVER overlap
 * in screen space (the bug the screen-grid placement fixed) and that a moving
 * leader interpolates between its desk and the target's desk.
 */

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    dept: "vulcan",
    role: "engineer",
    status: "idle",
    assignment: "",
    reports_to: null,
    project: "",
    ...over,
  };
}

function room(id: string, members: string[], over: Partial<Room> = {}): Room {
  return { id, kind: "department", project: "", dept: "vulcan", label: id, members, ...over };
}

/** Screen-space axis-aligned bounding box of a room's iso footprint. */
function roomBBox(origin: { col: number; row: number }, cols: number, rows: number) {
  const corners = [
    toScreen(origin.col, origin.row),
    toScreen(origin.col + cols, origin.row),
    toScreen(origin.col, origin.row + rows),
    toScreen(origin.col + cols, origin.row + rows),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function overlaps(a: ReturnType<typeof roomBBox>, b: ReturnType<typeof roomBBox>): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

describe("toScreen", () => {
  it("is the 2:1 isometric projection", () => {
    expect(toScreen(0, 0)).toEqual({ x: 0, y: 0 });
    expect(toScreen(1, 0)).toEqual({ x: TILE_W / 2, y: TILE_H / 2 });
    expect(toScreen(0, 1)).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
  });
});

describe("computeLayout room placement", () => {
  it("gives every member a distinct desk", () => {
    const world: WorldState = {
      rev: 1,
      ts: 0,
      agents: [agent("a"), agent("b"), agent("c"), agent("d")],
      edges: [],
      rooms: [room("r1", ["a", "b", "c", "d"])],
    };
    const layout = computeLayout(world);
    const desks = [...layout.rooms.get("r1")!.desks.values()];
    expect(desks).toHaveLength(4);
    const keys = new Set(desks.map((d) => `${d.col},${d.row}`));
    expect(keys.size).toBe(4); // all distinct
  });

  it("never lets two rooms overlap in screen space, even at many/varied sizes", () => {
    // Mix of small and large rooms across multiple screen rows.
    const rooms: Room[] = [];
    const agents: Agent[] = [];
    for (let i = 0; i < 8; i++) {
      const size = 1 + (i % 5); // 1..5 members — different footprints
      const ids: string[] = [];
      for (let m = 0; m < size; m++) {
        const id = `r${i}-a${m}`;
        ids.push(id);
        agents.push(agent(id));
      }
      rooms.push(room(`r${i}`, ids));
    }
    const layout = computeLayout({ rev: 1, ts: 0, agents, edges: [], rooms });
    const boxes = [...layout.rooms.values()].map((rl) => roomBBox(rl.origin, rl.cols, rl.rows));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  it("places rooms deterministically regardless of input order (stable by id)", () => {
    const mk = (order: string[]): WorldState => ({
      rev: 1,
      ts: 0,
      agents: [agent("a"), agent("b")],
      edges: [],
      rooms: order.map((id) => room(id, id === "r1" ? ["a"] : ["b"])),
    });
    const l1 = computeLayout(mk(["r1", "r2"]));
    const l2 = computeLayout(mk(["r2", "r1"]));
    expect(l1.rooms.get("r1")!.origin).toEqual(l2.rooms.get("r1")!.origin);
    expect(l1.rooms.get("r2")!.origin).toEqual(l2.rooms.get("r2")!.origin);
  });
});

describe("agentGridPosition", () => {
  const world: WorldState = {
    rev: 1,
    ts: 0,
    agents: [
      agent("lead", { role: "leader", status: "moving" }),
      agent("rep", { role: "engineer" }),
    ],
    edges: [{ id: "e1", from: "lead", to: "rep", kind: "vertical", active: true }],
    rooms: [room("r1", ["lead", "rep"])],
  };
  const layout = computeLayout(world);

  it("sits a non-moving agent at its own desk", () => {
    const idle = agent("rep", { role: "engineer", status: "idle" });
    expect(agentGridPosition(idle, layout, world, 0)).toEqual(layout.deskOf.get("rep"));
  });

  it("interpolates a moving leader from its desk toward the target", () => {
    const lead = world.agents[0]!;
    const home = layout.deskOf.get("lead")!;
    const target = layout.deskOf.get("rep")!;
    const at0 = agentGridPosition(lead, layout, world, 0);
    const at1 = agentGridPosition(lead, layout, world, 1);
    expect(at0).toEqual(home);
    // At phase 1 it has essentially reached the target desk.
    expect(at1.col).toBeCloseTo(target.col, 5);
    expect(at1.row).toBeCloseTo(target.row, 5);
    // Midway it is strictly between the two.
    const mid = agentGridPosition(lead, layout, world, 0.5);
    expect(mid.col).not.toBe(home.col);
  });
});

describe("screenBounds", () => {
  // Two dept rooms placed on different screen cells: minCol comes from one room,
  // minRow from another. The OLD camera fit combined them via
  // toScreen(minCol, minRow), inventing a top corner ABOVE all real content.
  // screenBounds must instead return the true union of the rooms' projected
  // corners — so its top (minY) equals the highest actual room corner, no higher.
  const world: WorldState = {
    rev: 1,
    ts: 0,
    agents: [agent("a"), agent("b"), agent("c")],
    edges: [],
    rooms: [
      room("r1", ["a"]),
      room("r2", ["b"]),
      room("r3", ["c"]),
    ],
  };
  const layout = computeLayout(world);

  it("returns the true AABB — top matches the highest real room corner, no phantom space", () => {
    const b = screenBounds(layout);
    // Highest (smallest y) corner across all rooms.
    let realTop = Infinity;
    for (const rl of layout.rooms.values()) {
      for (const c of [
        toScreen(rl.origin.col, rl.origin.row),
        toScreen(rl.origin.col + rl.cols, rl.origin.row),
        toScreen(rl.origin.col, rl.origin.row + rl.rows),
        toScreen(rl.origin.col + rl.cols, rl.origin.row + rl.rows),
      ]) {
        realTop = Math.min(realTop, c.y);
      }
    }
    expect(b.minY).toBeCloseTo(realTop, 5);

    // A phantom corner from independent minima would sit strictly above realTop.
    const gb = layout.bounds;
    const phantom = toScreen(gb.minCol, gb.minRow).y;
    expect(phantom).toBeLessThan(realTop); // the bug we avoid
  });

  it("applies headroom + pad symmetrically except extra room above for the banner", () => {
    const base = screenBounds(layout);
    const padded = screenBounds(layout, { headroom: 72, pad: 48 });
    expect(padded.minX).toBeCloseTo(base.minX - 48, 5);
    expect(padded.maxX).toBeCloseTo(base.maxX + 48, 5);
    expect(padded.maxY).toBeCloseTo(base.maxY + 48, 5);
    expect(padded.minY).toBeCloseTo(base.minY - 72 - 48, 5);
  });

  it("is safe on an empty layout", () => {
    const empty = computeLayout({ rev: 1, ts: 0, agents: [], edges: [], rooms: [] });
    expect(screenBounds(empty)).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });
});

describe("deptColor", () => {
  it("is stable per known dept and falls back for unknown", () => {
    expect(deptColor("vulcan")).toBe(deptColor("vulcan"));
    expect(deptColor("nope")).toBe(0x9ca3af);
  });
});
