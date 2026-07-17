/**
 * Spatial visualizer STATE CONTRACT — the single source of truth for the
 * "office game" view. Both the local mock feed and the real M1 OpenClaw adapter
 * emit exactly this shape, so the renderer never knows (or cares) which one it's
 * talking to.
 *
 * Mental model: M1 is the authoritative world; devhub is a window into it. M1
 * streams *state* (who exists, where they belong, who's talking to whom) — NOT
 * pixels. The renderer derives all positions client-side from room membership +
 * the message graph. Nothing spatial is stored server-side.
 *
 * Transport: a websocket that sends one `snapshot` on connect, then `delta`
 * frames as the world changes. A snapshot is always a complete, self-consistent
 * world; a delta is a shallow patch (add/update/remove of agents, edges, rooms).
 * A client that only ever applies snapshots is still correct — deltas are an
 * optimization, not a requirement.
 */

/** Lifecycle of an agent instance, mapped to how its character looks/behaves. */
export type AgentStatus =
  | "idle" // spawned, no active assignment — standing at their desk
  | "working" // heads-down on an assignment
  | "talking" // currently on an active edge (see WorldState.edges)
  | "moving" // a leader in transit between rooms
  | "blocked" // waiting on a gate/human/dependency
  | "done"; // finished; will despawn shortly

/** What kind of worker this is. Drives room placement + movement rules. */
export type AgentRole =
  | "leader" // VP/principal — MOVES between rooms (lateral + vertical)
  | "engineer" // heads-down IC, stays at a desk
  | "pm" // coordinates; occasional movement
  | "specialist"; // design/marketing/QA/etc — desk-bound like an engineer

/**
 * A single live agent instance. `id` is stable for the instance's lifetime
 * (e.g. `vulcan-devhub-3`). `dept` maps to a room's department; `assignment` is
 * the human-readable task shown on the desk label. `reports_to` builds the
 * vertical hierarchy (leader → reports); null for top-level leaders.
 */
export interface Agent {
  id: string;
  /** Display name — usually `<dept>-<project>` or the codename. */
  name: string;
  dept: string;
  role: AgentRole;
  status: AgentStatus;
  /** Human-readable current task; shown as the desk label. Empty when idle. */
  assignment: string;
  /** Agent id of this agent's leader, or null for a top-level leader. */
  reports_to: string | null;
  /** Project this instance is working under; ties it to a room. */
  project: string;
}

/** Directionality of a message/dispatch edge in the graph. */
export type EdgeKind =
  | "lateral" // peer ↔ peer (leaders ideating with peers)
  | "vertical"; // leader → report (relaying work down)

/**
 * A message/report relationship between two agents. `active` marks an edge that
 * is *currently* carrying traffic — the renderer animates a leader moving along
 * active edges and draws a live line. Inactive edges are the standing org graph
 * (drawn faint or not at all).
 */
export interface Edge {
  id: string;
  from: string; // agent id
  to: string; // agent id
  kind: EdgeKind;
  active: boolean;
  /** Optional one-line label for what's being said/relayed. */
  topic?: string;
}

/**
 * A room = a department working on a project. Rooms spawn when a project starts
 * and extend/shrink as members join/leave. `members` are agent ids currently
 * assigned here (their "home" room). Leaders may visit other rooms but their
 * home membership stays here.
 */
export interface Room {
  id: string;
  project: string;
  dept: string;
  /** Display title, e.g. "Vulcan · devhub". */
  label: string;
  members: string[]; // agent ids
}

/**
 * A complete world. Always internally consistent: every `edge.from/to` and every
 * `room.members[]` references an agent present in `agents`. `rev` increments on
 * every change so a client can detect gaps and request a fresh snapshot.
 */
export interface WorldState {
  rev: number;
  /** Epoch ms of this state's server-side timestamp. */
  ts: number;
  agents: Agent[];
  edges: Edge[];
  rooms: Room[];
}

/** WS envelope: full world on connect / resync. */
export interface SnapshotMessage {
  type: "snapshot";
  world: WorldState;
}

/**
 * WS envelope: a shallow patch. Each list holds only the entities that changed;
 * `removed*` holds ids to drop. Applying a delta bumps the client's `rev` to the
 * delta's `rev`. If `rev` isn't exactly prevRev+1 the client should resync.
 */
export interface DeltaMessage {
  type: "delta";
  rev: number;
  ts: number;
  agents?: Agent[]; // upserts (add or replace by id)
  edges?: Edge[]; // upserts
  rooms?: Room[]; // upserts
  removedAgents?: string[];
  removedEdges?: string[];
  removedRooms?: string[];
}

export type ServerMessage = SnapshotMessage | DeltaMessage;

/** Apply a delta to a world, returning a new (immutable) world. */
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

/** The known company departments (codenames) → a stable display accent index. */
export const DEPARTMENTS = [
  "vulcan", // engineering
  "apollo", // product/PM
  "thoth", // research/knowledge
  "talos", // infra/ops
  "vesta", // design
  "argus", // QA/security
] as const;
export type Department = (typeof DEPARTMENTS)[number];

/**
 * Validate an untrusted parsed JSON value as a WorldState. Tolerant by intent:
 * returns null on anything malformed rather than throwing, so a bad frame from
 * either feed degrades (client keeps its last good world) instead of crashing.
 */
export function parseWorldState(value: unknown): WorldState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.rev !== "number" || typeof v.ts !== "number") return null;
  if (!Array.isArray(v.agents) || !Array.isArray(v.edges) || !Array.isArray(v.rooms)) return null;
  const agents = v.agents.filter(isAgent);
  const rooms = v.rooms.filter(isRoom);
  const ids = new Set(agents.map((a) => a.id));
  // Drop edges/members that reference unknown agents so the renderer never
  // dereferences a ghost.
  const edges = v.edges.filter(isEdge).filter((e) => ids.has(e.from) && ids.has(e.to));
  for (const r of rooms) r.members = r.members.filter((m) => ids.has(m));
  return { rev: v.rev, ts: v.ts, agents, edges, rooms };
}

function isAgent(x: unknown): x is Agent {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    typeof a.dept === "string" &&
    typeof a.role === "string" &&
    typeof a.status === "string" &&
    typeof a.assignment === "string" &&
    typeof a.project === "string" &&
    (a.reports_to === null || typeof a.reports_to === "string")
  );
}

function isEdge(x: unknown): x is Edge {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.from === "string" &&
    typeof e.to === "string" &&
    (e.kind === "lateral" || e.kind === "vertical") &&
    typeof e.active === "boolean"
  );
}

function isRoom(x: unknown): x is Room {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.project === "string" &&
    typeof r.dept === "string" &&
    typeof r.label === "string" &&
    Array.isArray(r.members) &&
    r.members.every((m) => typeof m === "string")
  );
}
