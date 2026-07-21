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
  | "moving" // in transit between rooms (dept home ⇄ project room, or a leader visiting)
  | "blocked" // waiting on a gate/human/dependency
  | "done"; // finished; will despawn shortly

/** What kind of worker this is. Drives room placement + movement rules. */
export type AgentRole =
  | "leader" // VP/principal — MOVES between rooms (lateral + vertical)
  | "engineer" // heads-down IC, stays at a desk
  | "pm" // coordinates; occasional movement
  | "specialist"; // research/marketing/ops/QA/etc — desk-bound like an engineer

/**
 * A single live agent instance. `id` is stable for the instance's lifetime
 * (e.g. `vulcan-3`).
 *
 * Home vs. current location: `dept` is the agent's PERMANENT home department —
 * it never changes, and its home is that department's room. `project` is what
 * it's CURRENTLY pulled onto: "" means it's home in its department room; a
 * non-empty project name means it has moved into that project's team room. The
 * renderer figures out which room to draw an agent in from room membership (the
 * room whose `members[]` contains this id), so an agent moving dept→project is
 * just a membership change + a `project` flip, and the scene walks it over.
 */
export interface Agent {
  id: string;
  /** Display name — the codename, e.g. `vulcan-3` or `athena-lead`. */
  name: string;
  /** PERMANENT home department (one of DEPARTMENTS). Never changes. */
  dept: string;
  role: AgentRole;
  status: AgentStatus;
  /** Human-readable current task; shown on the floating nameplate. Empty when idle. */
  assignment: string;
  /** Agent id of this agent's leader, or null for a top-level leader. */
  reports_to: string | null;
  /** Current project name, or "" when the agent is home in its department room. */
  project: string;

  // ── Optional enrichment (Aurora Cockpit §3.5 Blueprint callouts) ──────────
  // ADDITIVE and OPTIONAL: the mock feed populates all of these; the real M1
  // adapter fills only what it truly has. The renderer draws a callout line ONLY
  // when the field exists — an absent field is never a placeholder. Snapshot /
  // delta compatibility is preserved (unknown-to-old-clients fields are ignored).
  /** Model id this agent is running on, e.g. "claude-opus-4-8" / "gpt-5.6". */
  model?: string;
  /** Provider identity (never guessed from behavior; from the model/runtime). */
  provider?: "anthropic" | "openai";
  /** Approximate spend on this assignment so far (USD). */
  costUsd?: number;
  /** Tokens consumed on this assignment so far. */
  tokens?: number;
  /** Epoch ms this assignment started (drives the runtime clock). */
  startedAt?: number;
  /** Last observable action line, e.g. "pytest test_reconnect — 12s". */
  lastAction?: string;
  /** Worktree / branch the agent is operating in, when it has one. */
  worktree?: string;
  /** Line delta on the agent's worktree, when known. */
  diff?: { add: number; del: number };
}

/** Directionality of a message/dispatch edge in the graph. */
export type EdgeKind =
  | "lateral" // peer ↔ peer (leaders ideating with peers)
  | "vertical"; // leader → report (relaying work down)

/**
 * A message/report relationship between two agents. `active` marks an edge that
 * is *currently* carrying traffic — the renderer draws a live line and rides a
 * pulse along it. Inactive edges are the standing org graph (drawn faint or not
 * at all).
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
 * The two ROOM TYPES, color/style-coded distinctly in the renderer:
 *  - "department": a persistent home base for one department (always present).
 *  - "project":    an ephemeral team room spawned per active project. It pulls a
 *                  CROSS-department mix of agents, grows/shrinks as the project
 *                  needs, and despawns when the project finishes.
 */
export type RoomKind = "department" | "project";

/**
 * A room. `kind` decides how it's drawn and what it means:
 *  - department room: `dept` set, `project` empty. `members` are that dept's
 *    agents currently at home (i.e. not pulled onto a project).
 *  - project room: `project` set, `dept` empty (it's cross-department).
 *    `members` are the agents currently pulled onto the project; `status` is a
 *    short "what's being worked on" line shown on the room nameplate.
 * `members` always reflects who is PHYSICALLY in the room right now.
 */
export interface Room {
  id: string;
  kind: RoomKind;
  /** Department codename for a department room; "" for a project room. */
  dept: string;
  /** Project name for a project room; "" for a department room. */
  project: string;
  /** Display title (e.g. "Vulcan · Engineering" or "Q3 GTM push"). */
  label: string;
  members: string[]; // agent ids currently in this room
  /** Project rooms only: a short current-focus line for the room nameplate. */
  status?: string;
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

/**
 * The real OpenClaw departments — the agent TEAMS in the company (grounded in
 * company-platform's `company_workforce`). Deliberately NOT the fleet code repos:
 * capture / nerve / devhub / company / sensorium / atlas are repositories, not
 * teams, and must never appear as a department or a room here.
 */
export const DEPARTMENTS = [
  "athena", // company desk — orchestration / PM / strategy / arbitration
  "vulcan", // engineering
  "apollo", // marketing
  "thoth", // research / product intelligence
  "talos", // lab operations — hardware
  "vesta", // company operations — ops / finance
  "argus", // fleet reliability — health / security
  "hermes", // outbound — comms & reply handling
] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Human-readable department names for room banners + the legend. */
export const DEPARTMENT_LABELS: Record<string, string> = {
  athena: "Athena · Company Desk",
  vulcan: "Vulcan · Engineering",
  apollo: "Apollo · Marketing",
  thoth: "Thoth · Research",
  talos: "Talos · Lab Ops",
  vesta: "Vesta · Ops & Finance",
  argus: "Argus · Fleet Health",
  hermes: "Hermes · Outbound",
};

/** Label for a department (falls back to a capitalized codename). */
export function departmentLabel(dept: string): string {
  return DEPARTMENT_LABELS[dept] ?? dept.charAt(0).toUpperCase() + dept.slice(1);
}

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
    (r.kind === "department" || r.kind === "project") &&
    typeof r.dept === "string" &&
    typeof r.project === "string" &&
    typeof r.label === "string" &&
    Array.isArray(r.members) &&
    r.members.every((m) => typeof m === "string")
  );
}
