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
    const a = new MockFeed({ seed: 42 });
    const b = new MockFeed({ seed: 42 });
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
    // Rooms stay within the simulation's bounds.
    expect(world.rooms.length).toBeGreaterThanOrEqual(2);
    expect(world.rooms.length).toBeLessThanOrEqual(6);
  });

  it("emits frames that survive the wire parser", () => {
    const feed = new MockFeed({ seed: 3 });
    feed.tick();
    // Round-trip a snapshot through JSON like a real WS frame would.
    const snap = JSON.parse(JSON.stringify({ type: "snapshot", world: feed.getWorld() }));
    expect(parseWorldState(snap.world)).toBeTruthy();
  });
});
