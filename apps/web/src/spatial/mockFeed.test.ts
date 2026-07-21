import { describe, expect, it } from "vitest";
import { applyDelta, parseWorldState, type ServerMessage, type WorldState } from "./contract";
import { MockFeed } from "./mockFeed";

/**
 * Mock feed invariants. The renderer trusts that every frame is self-consistent
 * (no edges/members pointing at absent agents) and that rev advances by exactly
 * one per delta — these guard both.
 */

function assertConsistent(w: WorldState) {
  const ids = new Set(w.agents.map((a) => a.id));
  for (const e of w.edges) {
    expect(ids.has(e.from), `edge ${e.id} from`).toBe(true);
    expect(ids.has(e.to), `edge ${e.id} to`).toBe(true);
  }
  for (const r of w.rooms) {
    for (const m of r.members) expect(ids.has(m), `room ${r.id} member ${m}`).toBe(true);
  }
}

describe("MockFeed", () => {
  it("emits a snapshot immediately on subscribe", () => {
    const feed = new MockFeed({ seed: 1 });
    const msgs: ServerMessage[] = [];
    feed.subscribe((m) => msgs.push(m));
    expect(msgs[0]!.type).toBe("snapshot");
    assertConsistent((msgs[0] as { world: WorldState }).world);
  });

  it("is deterministic given a seed", () => {
    // Pin an identical deterministic clock on both so wall-clock fields (world.ts,
    // agent startedAt) can't diverge — the simulation itself is seed-deterministic.
    const clock = () => {
      let t = 1_000_000;
      return () => (t += 1500);
    };
    const a = new MockFeed({ seed: 42, now: clock() });
    const b = new MockFeed({ seed: 42, now: clock() });
    for (let i = 0; i < 20; i++) {
      a.tick();
      b.tick();
    }
    expect(a.getWorld()).toEqual(b.getWorld());
  });

  it("keeps the world self-consistent and rev monotonic across many ticks", () => {
    const feed = new MockFeed({ seed: 7 });
    let world = feed.getWorld();
    let lastRev = world.rev;
    const deltas: ServerMessage[] = [];
    feed.subscribe((m) => deltas.push(m));
    deltas.length = 0; // drop the initial snapshot from subscribe

    for (let i = 0; i < 200; i++) {
      feed.tick();
      const m = deltas.pop()!;
      expect(m.type).toBe("delta");
      if (m.type === "delta") {
        expect(m.rev).toBe(lastRev + 1);
        lastRev = m.rev;
        world = applyDelta(world, m);
      }
      assertConsistent(world);
    }
    // The 8 department rooms are persistent; projects add 0..4 more.
    const deptRooms = world.rooms.filter((r) => r.kind === "department");
    expect(deptRooms).toHaveLength(8);
    expect(world.rooms.length).toBeGreaterThanOrEqual(8);
    expect(world.rooms.length).toBeLessThanOrEqual(12);
  });

  it("seeds the 8 real OpenClaw departments and never the code repos", () => {
    const world = new MockFeed({ seed: 5 }).getWorld();
    const depts = new Set(world.rooms.filter((r) => r.kind === "department").map((r) => r.dept));
    expect([...depts].sort()).toEqual(
      ["apollo", "argus", "athena", "hermes", "talos", "thoth", "vesta", "vulcan"],
    );
    // Code repos must never appear as a dept or a project.
    const repos = ["devhub", "capture", "nerve", "company", "sensorium", "atlas"];
    for (const r of world.rooms) {
      expect(repos).not.toContain(r.dept);
      expect(repos).not.toContain(r.project);
    }
    for (const a of world.agents) expect(repos).not.toContain(a.dept);
  });

  it("moves an agent out of its home room and into a project room when pulled", () => {
    const feed = new MockFeed({ seed: 11 });
    // Run until at least one project room exists.
    let world = feed.getWorld();
    for (let i = 0; i < 400 && !world.rooms.some((r) => r.kind === "project"); i++) {
      feed.tick();
      world = feed.getWorld();
    }
    const proj = world.rooms.find((r) => r.kind === "project");
    expect(proj).toBeTruthy();
    expect(proj!.members.length).toBeGreaterThan(0);
    // Every project member has project set and is NOT listed in any dept room.
    for (const id of proj!.members) {
      const agent = world.agents.find((a) => a.id === id)!;
      expect(agent.project).toBe(proj!.project);
      const inHome = world.rooms.some((r) => r.kind === "department" && r.members.includes(id));
      expect(inHome).toBe(false);
    }
  });

  it("emits frames that survive the wire parser", () => {
    const feed = new MockFeed({ seed: 3 });
    feed.tick();
    // Round-trip a snapshot through JSON like a real WS frame would.
    const snap = JSON.parse(JSON.stringify({ type: "snapshot", world: feed.getWorld() }));
    expect(parseWorldState(snap.world)).toBeTruthy();
  });
});
