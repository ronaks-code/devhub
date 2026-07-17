/**
 * mapOpenClawToWorld — the pure heart of the adapter. Turns raw, loosely-typed
 * OpenClaw state into a strict, self-consistent `WorldState` the renderer can
 * trust. This is the one function to unit-test hard, because it's where "M1's
 * reality" becomes "the contract".
 *
 * Guarantees it enforces (so the renderer never has to defend itself):
 *  - Every agent has a valid role/status (defaulted if the raw value is junk).
 *  - Rooms are DERIVED into two types: a DEPARTMENT room per dept (holding the
 *    agents currently home, i.e. not on a project) and a PROJECT room per active
 *    project (holding the cross-dept agents pulled onto it). Membership follows
 *    each agent's `project`.
 *  - Edges reference only agents that exist; direction/kind is inferred from the
 *    reporting hierarchy when the raw message doesn't say.
 */

import type { Agent, AgentRole, AgentStatus, Edge, Room, WorldState } from "./contract.js";
import type { RawOpenClawAgent, RawOpenClawMessage, RawOpenClawState } from "./openclaw-source.js";

const ROLES: AgentRole[] = ["leader", "engineer", "pm", "specialist"];
const STATUSES: AgentStatus[] = ["idle", "working", "talking", "moving", "blocked", "done"];

function normRole(raw?: string): AgentRole {
  const r = (raw ?? "").toLowerCase();
  if (ROLES.includes(r as AgentRole)) return r as AgentRole;
  // Check product/PM BEFORE the leader pattern: "product manager" contains
  // "manager" but is a PM, not a VP-level leader.
  if (/pm|product/.test(r)) return "pm";
  if (/lead|vp|principal|manager|director|chief/.test(r)) return "leader";
  if (/eng|dev|coder|swe/.test(r)) return "engineer";
  return "specialist";
}

function normStatus(raw?: string): AgentStatus {
  const s = (raw ?? "").toLowerCase();
  if (STATUSES.includes(s as AgentStatus)) return s as AgentStatus;
  if (/run|busy|active|work/.test(s)) return "working";
  if (/talk|chat|dispatch/.test(s)) return "talking";
  if (/move|transit/.test(s)) return "moving";
  if (/block|wait|gate|stuck/.test(s)) return "blocked";
  if (/done|finish|complete/.test(s)) return "done";
  return "idle";
}

function mapAgent(raw: RawOpenClawAgent): Agent {
  const dept = (raw.dept ?? raw.department ?? "unknown").toLowerCase();
  // Empty project = the agent is home in its department room. A non-empty
  // project pulls it into that project's (cross-department) team room.
  const project = raw.project ?? "";
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    dept,
    role: normRole(raw.role ?? raw.kind),
    status: normStatus(raw.status ?? raw.state),
    assignment: raw.assignment ?? raw.task ?? "",
    reports_to: raw.reportsTo ?? raw.parentId ?? null,
    project,
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Derive the two room types from agents:
 *  - one DEPARTMENT room per dept, holding agents currently home (project === "");
 *  - one PROJECT room per active project, holding the agents pulled onto it.
 */
function deriveRooms(agents: Agent[]): Room[] {
  const deptRooms = new Map<string, Room>();
  const projRooms = new Map<string, Room>();
  for (const a of agents) {
    if (a.project) {
      let room = projRooms.get(a.project);
      if (!room) {
        room = { id: `proj-${slug(a.project)}`, kind: "project", dept: "", project: a.project, label: a.project, members: [] };
        projRooms.set(a.project, room);
      }
      room.members.push(a.id);
    } else {
      let room = deptRooms.get(a.dept);
      if (!room) {
        room = { id: `dept-${a.dept}`, kind: "department", dept: a.dept, project: "", label: cap(a.dept), members: [] };
        deptRooms.set(a.dept, room);
      }
      room.members.push(a.id);
    }
  }
  return [...deptRooms.values(), ...projRooms.values()].sort((x, y) => x.id.localeCompare(y.id));
}

function mapEdge(raw: RawOpenClawMessage, i: number, byId: Map<string, Agent>): Edge | null {
  const from = raw.from ?? raw.src;
  const to = raw.to ?? raw.dst;
  if (!from || !to) return null;
  const fromA = byId.get(from);
  const toA = byId.get(to);
  if (!fromA || !toA) return null; // drop edges to ghosts
  // Infer kind from the hierarchy when not stated: a leader talking to its
  // report is vertical; everything else is lateral.
  let kind: Edge["kind"];
  if (raw.kind === "vertical" || raw.kind === "lateral") kind = raw.kind;
  else kind = toA.reports_to === fromA.id || fromA.reports_to === toA.id ? "vertical" : "lateral";
  return {
    id: raw.id ?? `e-${from}-${to}-${i}`,
    from,
    to,
    kind,
    active: raw.active ?? true,
    topic: raw.topic ?? raw.subject,
  };
}

export interface MapOptions {
  rev?: number;
  ts?: number;
}

export function mapOpenClawToWorld(raw: RawOpenClawState | null, opts: MapOptions = {}): WorldState {
  const rev = opts.rev ?? 1;
  const ts = opts.ts ?? Date.now();
  if (!raw) return { rev, ts, agents: [], edges: [], rooms: [] };

  // De-dupe agents by id (last wins), then map.
  const rawById = new Map<string, RawOpenClawAgent>();
  for (const a of raw.agents ?? []) {
    if (a && typeof a.id === "string") rawById.set(a.id, a);
  }
  const agents = [...rawById.values()].map(mapAgent);
  const byId = new Map(agents.map((a) => [a.id, a]));

  const rooms = deriveRooms(agents);

  const rawMsgs = raw.messages ?? [];
  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  rawMsgs.forEach((m, i) => {
    const e = mapEdge(m, i, byId);
    if (e && !seenEdge.has(e.id)) {
      seenEdge.add(e.id);
      edges.push(e);
    }
  });

  return { rev, ts, agents, edges, rooms };
}
