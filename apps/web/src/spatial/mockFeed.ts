/**
 * Mock state feed — a self-contained simulation that emits the SAME contract the
 * real M1 adapter will (snapshot then deltas). This is what makes the whole
 * spatial UI buildable/demoable today, with no M1 dependency.
 *
 * It models a believable company: a few departments, each running one or more
 * projects (rooms). Engineers sit at desks and cycle idle→working→done; leaders
 * move between rooms (lateral to peers, vertical to their reports) and light up
 * edges while they "talk". Projects occasionally spin up (spawn a room + crew)
 * and finish (drain + despawn), so rooms grow and shrink over time.
 *
 * Everything is deterministic given a seed, so tests can assert on it.
 */

import type { Agent, AgentRole, Edge, Room, ServerMessage, WorldState } from "./contract";

/** Tiny seeded RNG (mulberry32) — deterministic, dependency-free. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = ["devhub", "capture", "nerve", "company", "sensorium", "atlas"];
const TASKS = [
  "wiring the state contract",
  "fixing the isometric camera",
  "drafting the office layout",
  "reviewing the PR",
  "chasing a flaky test",
  "profiling the render loop",
  "planning the next milestone",
  "syncing with the team",
  "hardening the adapter",
  "polishing the HUD",
];

interface DeptSpec {
  dept: string;
  role: AgentRole;
  /** How many ICs a room of this dept starts with. */
  crew: number;
}

// Department composition differs by design (spec: some CS/dev, some leaders,
// some mixed). Vulcan is engineer-heavy; Apollo is PM-led; Vesta/Argus are
// specialist-heavy.
const DEPT_SPECS: DeptSpec[] = [
  { dept: "vulcan", role: "engineer", crew: 3 },
  { dept: "apollo", role: "pm", crew: 2 },
  { dept: "thoth", role: "specialist", crew: 2 },
  { dept: "talos", role: "engineer", crew: 2 },
  { dept: "vesta", role: "specialist", crew: 2 },
  { dept: "argus", role: "specialist", crew: 2 },
];

export interface MockFeedOptions {
  seed?: number;
  /** ms between simulation ticks. */
  tickMs?: number;
  /** Starting number of active rooms. */
  initialRooms?: number;
}

/**
 * Drives the simulation. Call `onMessage` to subscribe; `start()` emits an
 * initial snapshot then a delta every tick. `stop()` clears the timer. Pure
 * enough to also step manually via `tick()` in tests.
 */
export class MockFeed {
  private rand: () => number;
  private tickMs: number;
  private world: WorldState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(m: ServerMessage) => void>();
  private seq = 0; // monotonic id counter

  constructor(opts: MockFeedOptions = {}) {
    this.rand = rng(opts.seed ?? 0x5e51);
    this.tickMs = opts.tickMs ?? 1200;
    this.world = this.seedWorld(opts.initialRooms ?? 3);
  }

  subscribe(fn: (m: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    // Late subscribers get the current world immediately as a snapshot.
    fn({ type: "snapshot", world: structuredClone(this.world) });
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.timer) return;
    this.emit({ type: "snapshot", world: structuredClone(this.world) });
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getWorld(): WorldState {
    return structuredClone(this.world);
  }

  private emit(m: ServerMessage): void {
    for (const fn of this.listeners) fn(m);
  }

  private nextId(prefix: string): string {
    return `${prefix}-${(this.seq++).toString(36)}`;
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rand() * arr.length)] as T;
  }

  /** Build the initial world: N rooms across distinct dept/project pairs. */
  private seedWorld(nRooms: number): WorldState {
    const agents: Agent[] = [];
    const rooms: Room[] = [];
    const edges: Edge[] = [];
    const usedProjects = new Set<string>();

    for (let i = 0; i < nRooms; i++) {
      const spec = DEPT_SPECS[i % DEPT_SPECS.length]!;
      let project = PROJECTS[i % PROJECTS.length]!;
      while (usedProjects.has(`${spec.dept}:${project}`)) {
        project = this.pick(PROJECTS);
      }
      usedProjects.add(`${spec.dept}:${project}`);
      const { room, members } = this.makeRoom(spec, project);
      rooms.push(room);
      agents.push(...members);
    }

    // Every room gets a leader who reports to the first leader (a tiny org tree),
    // wired with standing vertical edges to their room's crew.
    const leaders = agents.filter((a) => a.role === "leader");
    const ceo = leaders[0];
    for (const leader of leaders) {
      if (ceo && leader !== ceo) leader.reports_to = ceo.id;
      const crew = agents.filter((a) => a.project === leader.project && a.id !== leader.id);
      for (const c of crew) {
        c.reports_to = leader.id;
        edges.push({
          id: this.nextId("e"),
          from: leader.id,
          to: c.id,
          kind: "vertical",
          active: false,
        });
      }
    }
    // Standing lateral edges between the leaders (peer network).
    for (let i = 0; i < leaders.length; i++) {
      for (let j = i + 1; j < leaders.length; j++) {
        edges.push({
          id: this.nextId("e"),
          from: leaders[i]!.id,
          to: leaders[j]!.id,
          kind: "lateral",
          active: false,
        });
      }
    }

    return { rev: 1, ts: Date.now(), agents, edges, rooms };
  }

  /** Create a room plus its crew: one leader + N role-typed ICs. */
  private makeRoom(spec: DeptSpec, project: string): { room: Room; members: Agent[] } {
    const roomId = this.nextId("room");
    const members: Agent[] = [];
    const leader: Agent = {
      id: this.nextId(`${spec.dept}`),
      name: `${spec.dept}-lead-${project}`,
      dept: spec.dept,
      role: "leader",
      status: "idle",
      assignment: `leading ${project}`,
      reports_to: null,
      project,
    };
    members.push(leader);
    for (let k = 0; k < spec.crew; k++) {
      members.push({
        id: this.nextId(`${spec.dept}`),
        name: `${spec.dept}-${project}-${k + 1}`,
        dept: spec.dept,
        role: spec.role,
        status: "idle",
        assignment: "",
        reports_to: leader.id,
        project,
      });
    }
    return {
      room: {
        id: roomId,
        project,
        dept: spec.dept,
        label: `${cap(spec.dept)} · ${project}`,
        members: members.map((m) => m.id),
      },
      members,
    };
  }

  /**
   * Advance the simulation one step and emit a delta. Each tick: some ICs flip
   * work status; leaders sometimes start/stop moving along an edge; rarely a new
   * project spins up or a finished one drains.
   */
  tick(): void {
    const changedAgents = new Map<string, Agent>();
    const changedEdges = new Map<string, Edge>();
    const changedRooms = new Map<string, Room>();
    const removedAgents: string[] = [];
    const removedRooms: string[] = [];
    const removedEdges: string[] = [];

    // 1) ICs cycle work state.
    for (const a of this.world.agents) {
      if (a.role === "leader") continue;
      const r = this.rand();
      if (a.status === "idle" && r < 0.35) {
        a.status = "working";
        a.assignment = this.pick(TASKS);
        changedAgents.set(a.id, a);
      } else if (a.status === "working" && r < 0.15) {
        a.status = "idle";
        a.assignment = "";
        changedAgents.set(a.id, a);
      }
    }

    // 2) Leaders move along edges (turn one active, calm the rest).
    const leaders = this.world.agents.filter((a) => a.role === "leader");
    for (const leader of leaders) {
      // Deactivate any currently-active edge from this leader.
      for (const e of this.world.edges) {
        if (e.from === leader.id && e.active) {
          e.active = false;
          changedEdges.set(e.id, e);
        }
      }
      if (this.rand() < 0.5) {
        const candidates = this.world.edges.filter((e) => e.from === leader.id);
        if (candidates.length) {
          const e = this.pick(candidates);
          e.active = true;
          e.topic = this.pick(TASKS);
          changedEdges.set(e.id, e);
          leader.status = "moving";
          changedAgents.set(leader.id, leader);
        }
      } else if (leader.status === "moving") {
        leader.status = "idle";
        changedAgents.set(leader.id, leader);
      }
    }

    // 3) Rarely: a new project room spins up.
    if (this.world.rooms.length < 6 && this.rand() < 0.08) {
      const spec = this.pick(DEPT_SPECS);
      const project = this.pick(PROJECTS);
      const dup = this.world.rooms.some((r) => r.dept === spec.dept && r.project === project);
      if (!dup) {
        const { room, members } = this.makeRoom(spec, project);
        const ceo = leaders[0];
        const newLeader = members.find((m) => m.role === "leader");
        if (newLeader && ceo) {
          newLeader.reports_to = ceo.id;
          const newEdge: Edge = {
            id: this.nextId("e"),
            from: ceo.id,
            to: newLeader.id,
            kind: "lateral",
            active: false,
          };
          this.world.edges.push(newEdge);
          changedEdges.set(newEdge.id, newEdge);
        }
        this.world.rooms.push(room);
        this.world.agents.push(...members);
        changedRooms.set(room.id, room);
        for (const m of members) changedAgents.set(m.id, m);
      }
    }

    // 4) Rarely: a room finishes and drains.
    if (this.world.rooms.length > 2 && this.rand() < 0.05) {
      const room = this.pick(this.world.rooms);
      const memberIds = new Set(room.members);
      this.world.agents = this.world.agents.filter((a) => !memberIds.has(a.id));
      this.world.rooms = this.world.rooms.filter((r) => r.id !== room.id);
      // Drop every edge touching a drained member — and REPORT those ids, so a
      // client applying this delta doesn't retain edges pointing at agents that no
      // longer exist (which would leave ghost lines in the graph).
      const keptEdges: Edge[] = [];
      for (const e of this.world.edges) {
        if (memberIds.has(e.from) || memberIds.has(e.to)) removedEdges.push(e.id);
        else keptEdges.push(e);
      }
      this.world.edges = keptEdges;
      removedAgents.push(...room.members);
      removedRooms.push(room.id);
    }

    this.world.rev += 1;
    this.world.ts = Date.now();

    this.emit({
      type: "delta",
      rev: this.world.rev,
      ts: this.world.ts,
      agents: [...changedAgents.values()],
      edges: [...changedEdges.values()],
      rooms: [...changedRooms.values()],
      removedAgents,
      removedRooms,
      removedEdges,
    });
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
