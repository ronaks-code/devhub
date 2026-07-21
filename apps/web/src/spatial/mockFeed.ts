/**
 * Mock state feed — a self-contained simulation that emits the SAME contract the
 * real M1 adapter will (snapshot then deltas). This is what makes the whole
 * spatial UI buildable/demoable today, with no M1 dependency.
 *
 * It models the real OpenClaw company:
 *  - 8 DEPARTMENT rooms (persistent home bases): Athena (company desk /
 *    orchestration), Vulcan (eng), Apollo (marketing), Thoth (research), Talos
 *    (lab), Vesta (ops/finance), Argus (fleet health), Hermes (outbound).
 *    Composition differs by dept (some PM-led, some engineer-heavy, some
 *    specialist).
 *  - PROJECT rooms spawn per active initiative and pull a CROSS-department mix of
 *    agents out of their home rooms; they scale up as the project needs more
 *    hands and drain (everyone walks home) when it finishes. Projects are real
 *    company initiatives (GTM, a customer pilot, an investor update…) — NOT the
 *    fleet code repos.
 *  - Leaders light up talking edges (lateral to peers, vertical to reports).
 *
 * Movement is modeled purely as ROOM MEMBERSHIP changes + an agent's `project`
 * flip; the renderer walks the character from its old desk to the new one. No
 * agent is ever deleted (they move home instead), so the world can never point at
 * a ghost. Everything is deterministic given a seed, so tests can assert on it.
 */

import type { Agent, AgentRole, Edge, Room, ServerMessage, WorldState } from "./contract";
import { DEPARTMENT_LABELS } from "./contract";

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

/** Department composition — deliberately heterogeneous (spec: some PM-led, some
 *  engineer-heavy, some specialist). `icRole` is the role of the department's ICs. */
interface DeptSpec {
  dept: string;
  icRole: AgentRole;
  crew: number;
}
const DEPT_SPECS: DeptSpec[] = [
  { dept: "athena", icRole: "pm", crew: 2 }, // orchestration / PM
  { dept: "vulcan", icRole: "engineer", crew: 3 }, // engineering (heaviest)
  { dept: "apollo", icRole: "specialist", crew: 2 }, // marketing
  { dept: "thoth", icRole: "specialist", crew: 2 }, // research
  { dept: "talos", icRole: "engineer", crew: 2 }, // lab / hardware
  { dept: "vesta", icRole: "specialist", crew: 2 }, // ops / finance
  { dept: "argus", icRole: "specialist", crew: 2 }, // fleet health
  { dept: "hermes", icRole: "specialist", crew: 2 }, // outbound
];

/** Real cross-department company initiatives. Each pulls from a specific dept mix. */
interface ProjectSpec {
  name: string;
  depts: string[]; // departments this project draws its team from (cross-dept)
  focus: string[]; // rotating "what's being worked on" lines for the room banner
}
const PROJECT_SPECS: ProjectSpec[] = [
  { name: "Q3 GTM push", depts: ["apollo", "hermes", "athena"], focus: ["segmenting the ICP", "drafting the sequence", "prepping the launch"] },
  { name: "Kosha tactile pilot", depts: ["vulcan", "talos", "thoth", "athena"], focus: ["wiring the rig", "collecting a capture set", "validating tactile>vision"] },
  { name: "Fleet reliability sprint", depts: ["argus", "talos", "vulcan"], focus: ["triaging alerts", "chasing a flaky node", "hardening the runner"] },
  { name: "Investor update", depts: ["athena", "vesta", "apollo"], focus: ["pulling the metrics", "writing the memo", "polishing the deck"] },
  { name: "Burn & cost audit", depts: ["vesta", "argus"], focus: ["reconciling spend", "tagging cloud cost", "modeling runway"] },
  { name: "Sim-to-real research", depts: ["thoth", "vulcan"], focus: ["reading the literature", "running an ablation", "writing up findings"] },
  { name: "Outbound: humanoid labs", depts: ["hermes", "apollo", "athena"], focus: ["building the list", "personalizing intros", "handling replies"] },
  { name: "Data QA pipeline", depts: ["argus", "vulcan", "thoth"], focus: ["labeling a batch", "spot-checking sync", "flagging bad takes"] },
];

/** Generic dept-work tasks for agents pottering at home. */
const HOME_TASKS = [
  "reviewing a PR",
  "answering a question",
  "planning the week",
  "cleaning up docs",
  "prepping a handoff",
  "triaging the inbox",
];

/** Deterministic model roster (§3.5 callouts). Provider is FROM the model, never guessed. */
const MODELS: ReadonlyArray<{ model: string; provider: "anthropic" | "openai" }> = [
  { model: "claude-opus-4-8", provider: "anthropic" },
  { model: "claude-sonnet-5", provider: "anthropic" },
  { model: "gpt-5.6", provider: "openai" },
  { model: "claude-haiku-4-5", provider: "anthropic" },
];

/** kebab a project name for a worktree branch (e.g. "Q3 GTM push" → "q3-gtm-push"). */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A stable model assignment per agent id (deterministic, so tests/screens repeat). */
function modelFor(id: string): { model: string; provider: "anthropic" | "openai" } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return MODELS[Math.abs(h) % MODELS.length]!;
}

/** Observable "last action" lines for the working-desk caret line. */
const LAST_ACTIONS = [
  "pytest test_reconnect — 12s",
  "edit src/App.tsx +18 −4",
  "grep -r usb enumerate",
  "reading capture logs",
  "typecheck — 0 errors",
  "git commit -m wip",
  "curl /api/running",
  "drafting the summary",
];

export interface MockFeedOptions {
  seed?: number;
  /** ms between simulation ticks. */
  tickMs?: number;
  /**
   * Clock source for frame timestamps (`world.ts`, agent `startedAt`). Defaults to
   * `Date.now`. Injectable so tests can pin a deterministic clock — otherwise two
   * independently-constructed feeds diverge on wall-clock fields even at the same
   * seed (the simulation itself is fully seed-deterministic).
   */
  now?: () => number;
}

const MAX_PROJECTS = 4;

/**
 * Drives the simulation. Call `subscribe` to get an initial snapshot then deltas;
 * `start()` runs the timer; `stop()` clears it. Pure enough to step manually via
 * `tick()` in tests.
 */
export class MockFeed {
  private rand: () => number;
  private tickMs: number;
  private now: () => number;
  private world: WorldState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(m: ServerMessage) => void>();
  private seq = 0; // monotonic id counter

  constructor(opts: MockFeedOptions = {}) {
    this.rand = rng(opts.seed ?? 0x5e51);
    this.tickMs = opts.tickMs ?? 1200;
    this.now = opts.now ?? (() => Date.now());
    this.world = this.seedWorld();
  }

  subscribe(fn: (m: ServerMessage) => void): () => void {
    this.listeners.add(fn);
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

  private homeRoomId(dept: string): string {
    return `dept-${dept}`;
  }

  private roomById(id: string): Room | undefined {
    return this.world.rooms.find((r) => r.id === id);
  }

  private agentById(id: string): Agent | undefined {
    return this.world.agents.find((a) => a.id === id);
  }

  /** Build the initial world: 8 department rooms with their home crews + org graph. */
  private seedWorld(): WorldState {
    const agents: Agent[] = [];
    const rooms: Room[] = [];
    const edges: Edge[] = [];
    const leadByDept = new Map<string, string>();

    for (const spec of DEPT_SPECS) {
      const leadId = `${spec.dept}-lead`;
      const lead: Agent = {
        id: leadId,
        name: `${spec.dept}-lead`,
        dept: spec.dept,
        role: "leader",
        status: "idle",
        assignment: "",
        reports_to: null,
        project: "",
        ...modelFor(leadId),
      };
      agents.push(lead);
      leadByDept.set(spec.dept, leadId);
      const memberIds = [leadId];
      for (let k = 0; k < spec.crew; k++) {
        const id = `${spec.dept}-${k + 1}`;
        agents.push({
          id,
          name: id,
          dept: spec.dept,
          role: spec.icRole,
          status: "idle",
          assignment: "",
          reports_to: leadId,
          project: "",
          ...modelFor(id),
        });
        memberIds.push(id);
      }
      rooms.push({
        id: this.homeRoomId(spec.dept),
        kind: "department",
        dept: spec.dept,
        project: "",
        label: DEPARTMENT_LABELS[spec.dept] ?? spec.dept,
        members: memberIds,
      });
    }

    // Org graph: Athena's lead is the top; every other dept lead reports to it.
    const athenaLead = leadByDept.get("athena")!;
    for (const spec of DEPT_SPECS) {
      const leadId = leadByDept.get(spec.dept)!;
      if (leadId !== athenaLead) {
        this.agentSet(agents, leadId, { reports_to: athenaLead });
        edges.push({ id: this.nextId("e"), from: athenaLead, to: leadId, kind: "lateral", active: false });
      }
      // Vertical standing edges: dept lead → its home ICs.
      for (const a of agents) {
        if (a.dept === spec.dept && a.id !== leadId) {
          edges.push({ id: this.nextId("e"), from: leadId, to: a.id, kind: "vertical", active: false });
        }
      }
    }

    const now = this.now();
    for (const a of agents) this.enrich(a, now);
    return { rev: 1, ts: now, agents, edges, rooms };
  }

  /**
   * Populate the OPTIONAL §3.5 callout fields from an agent's current state.
   * Working agents accrue tokens/cost + a live action line + (engineers) a diff;
   * an agent that went home drops those assignment-linked fields (honest — that
   * work ended), keeping only its identity (model/provider). The renderer draws a
   * callout line ONLY for a field that exists, so this never invents a placeholder.
   */
  private enrich(a: Agent, now: number): void {
    const working = a.status === "working" || (a.project !== "" && a.status !== "idle");
    if (working) {
      if (!a.startedAt) a.startedAt = now - Math.floor(this.rand() * 600_000);
      a.tokens = (a.tokens ?? 0) + 800 + Math.floor(this.rand() * 4000);
      a.costUsd = Math.round((a.tokens / 1_000_000) * 12 * 100) / 100;
      a.lastAction = this.pick(LAST_ACTIONS);
      a.worktree = a.project ? `wt/${slug(a.project)}` : a.role === "engineer" ? "main" : undefined;
      if (a.role === "engineer") {
        const d = a.diff ?? { add: 0, del: 0 };
        a.diff = { add: d.add + Math.floor(this.rand() * 12), del: d.del + Math.floor(this.rand() * 5) };
      }
    } else {
      a.startedAt = undefined;
      a.tokens = undefined;
      a.costUsd = undefined;
      a.lastAction = undefined;
      a.diff = undefined;
      a.worktree = a.role === "engineer" ? "main" : undefined;
    }
  }

  private agentSet(agents: Agent[], id: string, patch: Partial<Agent>): void {
    const a = agents.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
  }

  /** Advance one step and emit a delta describing what changed. */
  tick(): void {
    const changedAgents = new Map<string, Agent>();
    const changedEdges = new Map<string, Edge>();
    const changedRooms = new Map<string, Room>();
    const removedRooms: string[] = [];
    const removedEdges: string[] = [];

    // 1) Home ICs potter (idle ⇄ working on dept tasks) so home rooms feel alive.
    for (const a of this.world.agents) {
      if (a.role === "leader" || a.project !== "") continue;
      const r = this.rand();
      if (a.status === "idle" && r < 0.3) {
        a.status = "working";
        a.assignment = this.pick(HOME_TASKS);
        changedAgents.set(a.id, a);
      } else if (a.status === "working" && r < 0.2) {
        a.status = "idle";
        a.assignment = "";
        changedAgents.set(a.id, a);
      }
    }

    // 2) Project members occasionally re-pick a task (stay heads-down).
    for (const a of this.world.agents) {
      if (a.project !== "" && a.role !== "leader" && this.rand() < 0.25) {
        const spec = PROJECT_SPECS.find((p) => p.name === a.project);
        a.assignment = spec ? this.pick(spec.focus) : this.pick(HOME_TASKS);
        a.status = "working";
        changedAgents.set(a.id, a);
      }
    }

    // 3) Leaders light up one talking edge each (lateral peer / vertical report).
    const leaders = this.world.agents.filter((a) => a.role === "leader");
    for (const leader of leaders) {
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
          e.topic = this.pick(HOME_TASKS);
          changedEdges.set(e.id, e);
          leader.status = "moving";
          changedAgents.set(leader.id, leader);
        }
      } else if (leader.status === "moving") {
        leader.status = leader.project ? "working" : "idle";
        changedAgents.set(leader.id, leader);
      }
    }

    // 4) Occasionally spin up a new project (cross-dept team).
    const activeProjectNames = new Set(this.world.rooms.filter((r) => r.kind === "project").map((r) => r.project));
    if (activeProjectNames.size < MAX_PROJECTS && this.rand() < 0.12) {
      this.spinUpProject(activeProjectNames, changedAgents, changedEdges, changedRooms);
    }

    // 5) Occasionally scale an active project up (pull one more hand in).
    if (activeProjectNames.size > 0 && this.rand() < 0.18) {
      this.scaleUpProject(changedAgents, changedRooms);
    }

    // 6) Occasionally a project finishes and drains (everyone walks home).
    //    Kept low so project rooms persist long enough to read, not flicker away.
    if (activeProjectNames.size > 0 && this.rand() < 0.05) {
      this.drainProject(changedAgents, changedRooms, removedRooms, removedEdges);
    }

    // 7) Refresh a project room's focus line now and then.
    for (const room of this.world.rooms) {
      if (room.kind === "project" && this.rand() < 0.15) {
        const spec = PROJECT_SPECS.find((p) => p.name === room.project);
        if (spec) {
          room.status = this.pick(spec.focus);
          changedRooms.set(room.id, room);
        }
      }
    }

    const now = this.now();
    // Refresh the §3.5 callout fields for every agent that changed this tick.
    for (const a of changedAgents.values()) this.enrich(a, now);

    this.world.rev += 1;
    this.world.ts = now;

    this.emit({
      type: "delta",
      rev: this.world.rev,
      ts: this.world.ts,
      agents: [...changedAgents.values()],
      edges: [...changedEdges.values()],
      rooms: [...changedRooms.values()],
      removedAgents: [],
      removedRooms,
      removedEdges,
    });
  }

  /** Find a home agent (project==="") in a dept, preferring ICs; null if none. */
  private takeHomeAgent(dept: string, wantLeader: boolean): Agent | null {
    const pool = this.world.agents.filter(
      (a) => a.dept === dept && a.project === "" && (wantLeader ? a.role === "leader" : a.role !== "leader"),
    );
    return pool.length ? (this.pick(pool) as Agent) : null;
  }

  /** Move an agent from its home dept room into a project room. */
  private moveToProject(agent: Agent, room: Room, task: string, changedRooms: Map<string, Room>): void {
    const home = this.roomById(this.homeRoomId(agent.dept));
    if (home) {
      home.members = home.members.filter((m) => m !== agent.id);
      changedRooms.set(home.id, home);
    }
    room.members.push(agent.id);
    changedRooms.set(room.id, room);
    agent.project = room.project;
    agent.status = "working";
    agent.assignment = task;
  }

  private spinUpProject(
    activeNames: Set<string>,
    changedAgents: Map<string, Agent>,
    changedEdges: Map<string, Edge>,
    changedRooms: Map<string, Room>,
  ): void {
    const available = PROJECT_SPECS.filter((p) => !activeNames.has(p.name));
    if (!available.length) return;
    const spec = this.pick(available);

    // A lead: the first dept in the mix whose lead is currently home.
    let lead: Agent | null = null;
    for (const dept of spec.depts) {
      lead = this.takeHomeAgent(dept, true);
      if (lead) break;
    }
    if (!lead) return; // all relevant leaders busy — try again later

    const room: Room = {
      id: this.nextId("proj"),
      kind: "project",
      dept: "",
      project: spec.name,
      label: spec.name,
      members: [],
      status: this.pick(spec.focus),
    };
    this.world.rooms.push(room);
    activeNames.add(spec.name);

    // Pull the lead in first.
    this.moveToProject(lead, room, `leading ${spec.name}`, changedRooms);
    lead.status = "working";
    changedAgents.set(lead.id, lead);

    // Then pull one IC from a couple of the project's OTHER departments.
    const otherDepts = spec.depts.filter((d) => d !== lead!.dept);
    const wanted = Math.min(otherDepts.length, 2 + Math.floor(this.rand() * 2)); // 2–3 total-ish
    for (let i = 0; i < wanted; i++) {
      const dept = otherDepts[i]!;
      const ic = this.takeHomeAgent(dept, false);
      if (!ic) continue;
      this.moveToProject(ic, room, this.pick(spec.focus), changedRooms);
      changedAgents.set(ic.id, ic);
      // Vertical edge: project lead → this member.
      const e: Edge = { id: this.nextId("pe"), from: lead.id, to: ic.id, kind: "vertical", active: false };
      this.world.edges.push(e);
      changedEdges.set(e.id, e);
    }
  }

  private scaleUpProject(changedAgents: Map<string, Agent>, changedRooms: Map<string, Room>): void {
    const projRooms = this.world.rooms.filter((r) => r.kind === "project");
    if (!projRooms.length) return;
    const room = this.pick(projRooms);
    const spec = PROJECT_SPECS.find((p) => p.name === room.project);
    if (!spec) return;
    // Pull one more home IC from any of the project's departments.
    for (const dept of shuffleDeterministic(spec.depts, this.rand)) {
      const ic = this.takeHomeAgent(dept, false);
      if (ic) {
        this.moveToProject(ic, room, this.pick(spec.focus), changedRooms);
        changedAgents.set(ic.id, ic);
        return;
      }
    }
  }

  private drainProject(
    changedAgents: Map<string, Agent>,
    changedRooms: Map<string, Room>,
    removedRooms: string[],
    removedEdges: string[],
  ): void {
    const projRooms = this.world.rooms.filter((r) => r.kind === "project");
    if (!projRooms.length) return;
    const room = this.pick(projRooms);
    const memberIds = new Set(room.members);

    // Everyone walks home: flip project→"", idle, and re-add to their dept room.
    for (const id of room.members) {
      const agent = this.agentById(id);
      if (!agent) continue;
      agent.project = "";
      agent.status = "idle";
      agent.assignment = "";
      changedAgents.set(agent.id, agent);
      const home = this.roomById(this.homeRoomId(agent.dept));
      if (home && !home.members.includes(agent.id)) {
        home.members.push(agent.id);
        changedRooms.set(home.id, home);
      }
    }

    // Drop the project room and every project edge touching it.
    const keptEdges: Edge[] = [];
    for (const e of this.world.edges) {
      if (memberIds.has(e.from) && memberIds.has(e.to) && e.id.startsWith("pe-")) {
        removedEdges.push(e.id);
      } else {
        keptEdges.push(e);
      }
    }
    this.world.edges = keptEdges;
    this.world.rooms = this.world.rooms.filter((r) => r.id !== room.id);
    removedRooms.push(room.id);
    changedRooms.delete(room.id);
  }
}

/** Deterministic Fisher–Yates using the feed's RNG (keeps ticks reproducible). */
function shuffleDeterministic<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
