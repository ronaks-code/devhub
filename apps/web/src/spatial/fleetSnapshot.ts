/** One live crew member rendered by the DevHub office visualizer. */
export interface AgentState {
  employeeId: string;
  displayName: string;
  kind: "persistent_lead" | "ephemeral_worker";
  department: string;
  role: string;
  lifecycle: "active" | "reserved";
  task?: {
    missionId: string;
    runKind: string;
    missionMode?: string;
    label: string;
    workItemRef?: string;
  };
  status:
    | "idle"
    | "planning"
    | "working"
    | "reviewing"
    | "verifying"
    | "blocked"
    | "awaiting_approval"
    | "retiring";
  authorityLevel?: "A0" | "A1" | "A2" | "A3";
  evidenceLevel?: "E0" | "E1" | "E2" | "E3" | "E4";
  roomId: string;
  movement?: {
    from: string;
    to: string;
    kind: "lateral" | "vertical" | "activation" | "retire";
    ts: number;
  };
  talkingTo?: string[];
  heartbeatTs: number;
  budgetConsumed?: number;
  updatedAt: number;
}

/** One department or project room rendered by the visualizer. */
export interface RoomState {
  roomId: string;
  type: "department" | "project";
  label: string;
  ownerLeadId: string;
  members: string[];
  status: "home" | "active" | "spawning" | "closing";
  projectRef?: string;
  spawnedAt?: number;
  closedAt?: number;
}

/** A current communication edge between two live agents. */
export interface FleetEdge {
  from: string;
  to: string;
  kind: "dispatch" | "message" | "report";
  ts: number;
}

/** One bounded, versioned frame consumed by the read-only renderer. */
export interface FleetSnapshot {
  version: number;
  ts: number;
  rooms: RoomState[];
  agents: AgentState[];
  edges: FleetEdge[];
}

const SNAPSHOT_TS = Date.UTC(2026, 6, 20, 8, 0, 0);

const RESERVED_DEPARTMENTS = [
  ["athena", "Minerva", "Athena"],
  ["vulcan", "Forge", "Vulcan"],
  ["apollo", "Sol", "Apollo"],
  ["thoth", "Scribe", "Thoth"],
  ["talos", "Aegis", "Talos"],
  ["vesta", "Ember", "Vesta"],
  ["argus", "Watchtower", "Argus"],
] as const;

/** Deterministic overnight fixture. This route intentionally has no live source. */
export const fleetSnapshotFixture: FleetSnapshot = {
  version: 1,
  ts: SNAPSHOT_TS,
  rooms: [
    {
      roomId: "department-hermes",
      type: "department",
      label: "Hermes",
      ownerLeadId: "hermes-lead",
      members: ["hermes-lead", "hermes-relay", "hermes-caduceus"],
      status: "active",
    },
    {
      roomId: "department-athena",
      type: "department",
      label: "Athena",
      ownerLeadId: "athena-lead",
      members: ["athena-lead"],
      status: "home",
    },
    {
      roomId: "department-vulcan",
      type: "department",
      label: "Vulcan",
      ownerLeadId: "vulcan-lead",
      members: ["vulcan-lead"],
      status: "home",
    },
    {
      roomId: "department-apollo",
      type: "department",
      label: "Apollo",
      ownerLeadId: "apollo-lead",
      members: ["apollo-lead"],
      status: "home",
    },
    {
      roomId: "department-thoth",
      type: "department",
      label: "Thoth",
      ownerLeadId: "thoth-lead",
      members: ["thoth-lead"],
      status: "home",
    },
    {
      roomId: "department-talos",
      type: "department",
      label: "Talos",
      ownerLeadId: "talos-lead",
      members: ["talos-lead"],
      status: "home",
    },
    {
      roomId: "department-vesta",
      type: "department",
      label: "Vesta",
      ownerLeadId: "vesta-lead",
      members: ["vesta-lead"],
      status: "home",
    },
    {
      roomId: "department-argus",
      type: "department",
      label: "Argus",
      ownerLeadId: "argus-lead",
      members: ["argus-lead"],
      status: "home",
    },
  ],
  agents: [
    {
      employeeId: "hermes-lead",
      displayName: "Mercury",
      kind: "persistent_lead",
      department: "Hermes",
      role: "leader",
      lifecycle: "active",
      task: {
        missionId: "hermes-outbound-01",
        runKind: "department",
        missionMode: "continuous",
        label: "Triage outbound replies",
        workItemRef: "HERMES-01",
      },
      status: "reviewing",
      authorityLevel: "A2",
      evidenceLevel: "E2",
      roomId: "department-hermes",
      talkingTo: ["hermes-relay", "hermes-caduceus"],
      heartbeatTs: SNAPSHOT_TS - 2_000,
      budgetConsumed: 0.41,
      updatedAt: SNAPSHOT_TS - 2_000,
    },
    {
      employeeId: "hermes-relay",
      displayName: "Relay",
      kind: "ephemeral_worker",
      department: "Hermes",
      role: "worker",
      lifecycle: "active",
      task: {
        missionId: "hermes-outbound-01",
        runKind: "mission",
        label: "Draft robotics lab follow-up",
        workItemRef: "HERMES-02",
      },
      status: "working",
      authorityLevel: "A1",
      evidenceLevel: "E1",
      roomId: "department-hermes",
      heartbeatTs: SNAPSHOT_TS - 4_000,
      budgetConsumed: 0.18,
      updatedAt: SNAPSHOT_TS - 4_000,
    },
    {
      employeeId: "hermes-caduceus",
      displayName: "Caduceus",
      kind: "ephemeral_worker",
      department: "Hermes",
      role: "worker",
      lifecycle: "active",
      task: {
        missionId: "hermes-outbound-01",
        runKind: "mission",
        label: "Verify founder reply queue",
        workItemRef: "HERMES-03",
      },
      status: "verifying",
      authorityLevel: "A1",
      evidenceLevel: "E2",
      roomId: "department-hermes",
      heartbeatTs: SNAPSHOT_TS - 6_000,
      budgetConsumed: 0.23,
      updatedAt: SNAPSHOT_TS - 6_000,
    },
    ...RESERVED_DEPARTMENTS.map(([slug, displayName, department]): AgentState => ({
      employeeId: `${slug}-lead`,
      displayName,
      kind: "persistent_lead",
      department,
      role: "leader",
      lifecycle: "reserved",
      status: "idle",
      authorityLevel: "A0",
      evidenceLevel: "E0",
      roomId: `department-${slug}`,
      heartbeatTs: SNAPSHOT_TS,
      updatedAt: SNAPSHOT_TS,
    })),
  ],
  edges: [
    {
      from: "hermes-lead",
      to: "hermes-relay",
      kind: "dispatch",
      ts: SNAPSHOT_TS - 20_000,
    },
    {
      from: "hermes-lead",
      to: "hermes-caduceus",
      kind: "report",
      ts: SNAPSHOT_TS - 12_000,
    },
  ],
};
