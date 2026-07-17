import { describe, expect, it } from "vitest";
import { SpatialAdapter, diffWorld } from "../src/spatial/adapter.js";
import { applyDelta } from "../src/spatial/contract.js";
import type { WorldState } from "../src/spatial/contract.js";
import type { OpenClawSource, RawOpenClawState } from "../src/spatial/openclaw-source.js";

/** A source whose state we can mutate between polls, to drive the adapter. */
function mutableSource(): OpenClawSource & { set: (s: RawOpenClawState | null) => void } {
  let state: RawOpenClawState | null = null;
  return {
    describe: () => "mutable",
    read: async () => state,
    set: (s) => {
      state = s;
    },
  };
}

describe("diffWorld", () => {
  it("captures upserts and removals so applyDelta reconstructs next", () => {
    const prev: WorldState = {
      rev: 1,
      ts: 1,
      agents: [
        { id: "a", name: "a", dept: "vulcan", role: "engineer", status: "idle", assignment: "", reports_to: null, project: "p" },
        { id: "b", name: "b", dept: "vulcan", role: "engineer", status: "idle", assignment: "", reports_to: null, project: "p" },
      ],
      edges: [{ id: "e", from: "a", to: "b", kind: "lateral", active: false }],
      rooms: [{ id: "r", project: "p", dept: "vulcan", label: "R", members: ["a", "b"] }],
    };
    const next: WorldState = {
      rev: 2,
      ts: 2,
      // a changed status, b removed, c added.
      agents: [
        { ...prev.agents[0]!, status: "working" },
        { id: "c", name: "c", dept: "vulcan", role: "engineer", status: "idle", assignment: "", reports_to: null, project: "p" },
      ],
      edges: [],
      rooms: [{ id: "r", project: "p", dept: "vulcan", label: "R", members: ["a", "c"] }],
    };
    const delta = diffWorld(prev, next, 2);
    expect(delta.removedAgents).toEqual(["b"]);
    expect(delta.removedEdges).toEqual(["e"]);
    const rebuilt = applyDelta(prev, delta);
    // Sort-insensitive comparison by id.
    const byId = (w: WorldState) => ({
      agents: [...w.agents].sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...w.edges].sort((x, y) => x.id.localeCompare(y.id)),
      rooms: [...w.rooms].sort((x, y) => x.id.localeCompare(y.id)),
    });
    expect(byId(rebuilt)).toEqual(byId(next));
  });
});

describe("SpatialAdapter", () => {
  it("emits nothing while the source is down (keeps last good world)", async () => {
    const src = mutableSource();
    const adapter = new SpatialAdapter(src);
    expect(await adapter.poll()).toBeNull();
    expect(adapter.snapshot()).toBeNull();
  });

  it("emits a snapshot on first good read, then deltas, with rev in lockstep", async () => {
    const src = mutableSource();
    const adapter = new SpatialAdapter(src);

    src.set({ agents: [{ id: "a", dept: "vulcan", project: "p" }] });
    const first = await adapter.poll();
    expect(first?.type).toBe("snapshot");

    // No change → still a delta, rev advances, empty change lists.
    const second = await adapter.poll();
    expect(second?.type).toBe("delta");
    if (second?.type === "delta") {
      expect(second.rev).toBe(2);
      expect(second.agents).toEqual([]);
    }

    // A new agent appears → delta carries it.
    src.set({ agents: [{ id: "a", dept: "vulcan", project: "p" }, { id: "b", dept: "vulcan", project: "p" }] });
    const third = await adapter.poll();
    expect(third?.type).toBe("delta");
    if (third?.type === "delta") {
      expect(third.rev).toBe(3);
      expect(third.agents.map((a) => a.id)).toContain("b");
    }
  });

  it("replays a full session: snapshot + deltas reconstruct every world", async () => {
    const src = mutableSource();
    const adapter = new SpatialAdapter(src);
    const states: RawOpenClawState[] = [
      { agents: [{ id: "a", dept: "vulcan", project: "p", role: "leader" }] },
      { agents: [{ id: "a", dept: "vulcan", project: "p", role: "leader" }, { id: "b", dept: "vulcan", project: "p", reportsTo: "a" }] },
      { agents: [{ id: "b", dept: "vulcan", project: "p" }] }, // a leaves
    ];

    let client: WorldState | null = null;
    for (const s of states) {
      src.set(s);
      const msg = await adapter.poll();
      if (msg?.type === "snapshot") client = msg.world;
      else if (msg?.type === "delta" && client) client = applyDelta(client, msg);
    }
    // Client's reconstructed world matches the adapter's authoritative snapshot.
    expect(client!.agents.map((a) => a.id).sort()).toEqual(["b"]);
    expect(client!.agents).toEqual(adapter.snapshot()!.world.agents);
  });
});
