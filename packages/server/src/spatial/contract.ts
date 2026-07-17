/**
 * MIRROR of `apps/web/src/spatial/contract.ts` — the spatial state contract, as
 * seen from the server/adapter end. Kept as a separate copy on purpose: this
 * module is Node-side (the M1 adapter) and must not pull the browser package.
 * The two ends agree on the WIRE (JSON) shape, which the round-trip test in
 * `contract.test.ts` pins so the copies can't silently drift.
 *
 * If you change one side, change both and run the server + web spatial tests.
 */

export type AgentStatus = "idle" | "working" | "talking" | "moving" | "blocked" | "done";
export type AgentRole = "leader" | "engineer" | "pm" | "specialist";

export interface Agent {
  id: string;
  name: string;
  dept: string;
  role: AgentRole;
  status: AgentStatus;
  assignment: string;
  reports_to: string | null;
  project: string;
}

export type EdgeKind = "lateral" | "vertical";

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  active: boolean;
  topic?: string;
}

export interface Room {
  id: string;
  project: string;
  dept: string;
  label: string;
  members: string[];
}

export interface WorldState {
  rev: number;
  ts: number;
  agents: Agent[];
  edges: Edge[];
  rooms: Room[];
}

export interface SnapshotMessage {
  type: "snapshot";
  world: WorldState;
}

export interface DeltaMessage {
  type: "delta";
  rev: number;
  ts: number;
  agents?: Agent[];
  edges?: Edge[];
  rooms?: Room[];
  removedAgents?: string[];
  removedEdges?: string[];
  removedRooms?: string[];
}

export type ServerMessage = SnapshotMessage | DeltaMessage;

/** Apply a delta to a world (used by the round-trip test to prove the differ). */
export function applyDelta(world: WorldState, delta: DeltaMessage): WorldState {
  const upsert = <T extends { id: string }>(list: T[], ups?: T[], removed?: string[]): T[] => {
    const byId = new Map(list.map((x) => [x.id, x]));
    for (const u of ups ?? []) byId.set(u.id, u);
    for (const r of removed ?? []) byId.delete(r);
    return [...byId.values()];
  };
  return {
    rev: delta.rev,
    ts: delta.ts,
    agents: upsert(world.agents, delta.agents, delta.removedAgents),
    edges: upsert(world.edges, delta.edges, delta.removedEdges),
    rooms: upsert(world.rooms, delta.rooms, delta.removedRooms),
  };
}
