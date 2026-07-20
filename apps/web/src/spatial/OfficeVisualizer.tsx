import { Building2, CircleDot, Radio, UsersRound } from "lucide-react";
import type { AgentState, FleetSnapshot, RoomState } from "./fleetSnapshot";

export interface OfficeVisualizerProps {
  snapshot: FleetSnapshot;
}

type RoomLifecycle = AgentState["lifecycle"];

const STATUS_STYLES: Record<AgentState["status"], string> = {
  idle: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/25",
  planning: "bg-sky-500/15 text-sky-300 ring-sky-500/25",
  working: "bg-cyan-500/15 text-cyan-300 ring-cyan-500/25",
  reviewing: "bg-violet-500/15 text-violet-300 ring-violet-500/25",
  verifying: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25",
  blocked: "bg-red-500/15 text-red-300 ring-red-500/25",
  awaiting_approval: "bg-amber-500/15 text-amber-300 ring-amber-500/25",
  retiring: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/25",
};

const DEPARTMENT_MARKS: Record<string, string> = {
  Hermes: "H",
  Athena: "A",
  Vulcan: "V",
  Apollo: "A",
  Thoth: "T",
  Talos: "T",
  Vesta: "V",
  Argus: "A",
};

function lifecycleForRoom(room: RoomState, agentById: ReadonlyMap<string, AgentState>): RoomLifecycle {
  return room.members.some((employeeId) => agentById.get(employeeId)?.lifecycle === "active")
    ? "active"
    : "reserved";
}

function readableStatus(status: AgentState["status"]): string {
  return status.replaceAll("_", " ");
}

function snapshotTimestamp(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace("T", " · ")} UTC`;
}

function AgentNameplate({ agent }: { agent: AgentState }): React.JSX.Element {
  const isActive = agent.lifecycle === "active";

  return (
    <article
      data-testid="office-agent"
      data-agent-id={agent.employeeId}
      className={
        "relative overflow-hidden rounded-lg border px-3 py-2.5 " +
        (isActive
          ? "border-zinc-700/80 bg-zinc-950/75 shadow-sm shadow-black/30"
          : "border-zinc-800/70 bg-zinc-950/45")
      }
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-tight text-zinc-100">
            {agent.displayName}
          </div>
          <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
            {agent.role}
          </div>
        </div>
        <span
          className={
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1 ring-inset " +
            STATUS_STYLES[agent.status]
          }
        >
          {readableStatus(agent.status)}
        </span>
      </div>
      <div className="mt-2 flex items-start gap-2 border-t border-zinc-800/70 pt-2">
        <CircleDot
          aria-hidden="true"
          className={
            "mt-0.5 h-3 w-3 shrink-0 " +
            (isActive ? "text-emerald-400" : "text-zinc-600")
          }
        />
        <p className="min-w-0 text-[11px] leading-4 text-zinc-400">
          {agent.task?.label ?? "Awaiting activation"}
        </p>
      </div>
    </article>
  );
}

export function OfficeVisualizer({ snapshot }: OfficeVisualizerProps): React.JSX.Element {
  const agentById = new Map(snapshot.agents.map((agent) => [agent.employeeId, agent]));
  const roomModels = snapshot.rooms.map((room) => ({
    room,
    lifecycle: lifecycleForRoom(room, agentById),
    agents: room.members.flatMap((employeeId) => {
      const agent = agentById.get(employeeId);
      return agent ? [agent] : [];
    }),
  }));
  const activeRoomCount = roomModels.filter(({ lifecycle }) => lifecycle === "active").length;
  const activeAgentCount = snapshot.agents.filter(({ lifecycle }) => lifecycle === "active").length;
  const assignedTaskCount = snapshot.agents.filter(({ task }) => task !== undefined).length;

  return (
    <section
      data-testid="office-visualizer"
      className="relative min-w-0 flex-1 overflow-y-auto bg-zinc-950 text-zinc-100"
      aria-labelledby="fleet-office-title"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(63,63,70,0.18)_1px,transparent_1px),linear-gradient(90deg,rgba(63,63,70,0.18)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:linear-gradient(to_bottom,black,transparent_82%)]"
      />

      <div className="relative mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <header className="mb-5 flex flex-col gap-4 border-b border-zinc-800/80 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-sky-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-sky-300 ring-1 ring-inset ring-sky-400/20">
                <Radio aria-hidden="true" className="h-3 w-3" />
                Fixture · read only
              </span>
              <span className="text-[11px] text-zinc-500">
                Snapshot v{snapshot.version} · <time dateTime={new Date(snapshot.ts).toISOString()}>{snapshotTimestamp(snapshot.ts)}</time>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
                <Building2 aria-hidden="true" className="h-5 w-5" />
              </span>
              <div>
                <h1 id="fleet-office-title" className="text-xl font-semibold tracking-tight sm:text-2xl">
                  Fleet Office
                </h1>
                <p className="mt-0.5 max-w-2xl text-[12px] leading-5 text-zinc-400">
                  A quiet floor plan for the autonomous company. Hermes is on shift; the rest of the floor is held in reserve.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <Building2 aria-hidden="true" className="h-3.5 w-3.5 text-zinc-500" />
              <strong className="font-semibold text-zinc-200">{snapshot.rooms.length}</strong> departments
            </span>
            <span className="inline-flex items-center gap-1.5">
              <UsersRound aria-hidden="true" className="h-3.5 w-3.5 text-zinc-500" />
              <strong className="font-semibold text-zinc-200">{snapshot.agents.length}</strong> agents
            </span>
            <span>
              <strong className="font-semibold text-emerald-300">{activeAgentCount}</strong> active
            </span>
            <span>
              <strong className="font-semibold text-zinc-200">{assignedTaskCount}</strong> assigned
            </span>
          </div>
        </header>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-zinc-500">
            {activeRoomCount} room online · {snapshot.rooms.length - activeRoomCount} reserved
          </p>
          <div className="flex items-center gap-4 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500" aria-label="Room lifecycle legend">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)] motion-safe:animate-pulse" />
              Active
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-zinc-600" />
              Reserved
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {roomModels.map(({ room, lifecycle, agents }) => {
            const active = lifecycle === "active";
            return (
              <section
                key={room.roomId}
                role="region"
                aria-label={`${room.label} department — ${lifecycle}`}
                data-testid="office-room"
                data-lifecycle={lifecycle}
                className={
                  "relative min-h-44 overflow-hidden rounded-xl border p-3.5 transition-colors " +
                  (active
                    ? "border-emerald-400/60 bg-emerald-400/[0.07] shadow-[0_0_28px_rgba(16,185,129,0.08)] md:col-span-2"
                    : "border-zinc-800/80 bg-zinc-900/50 grayscale-[0.25]")
                }
              >
                {active ? (
                  <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/80 to-transparent" />
                ) : null}
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className={
                        "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[12px] font-black ring-1 ring-inset " +
                        (active
                          ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/25"
                          : "bg-zinc-800/70 text-zinc-400 ring-zinc-700/70")
                      }
                    >
                      {DEPARTMENT_MARKS[room.label] ?? room.label.slice(0, 1)}
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-[14px] font-semibold tracking-tight text-zinc-100">
                        {room.label}
                      </h2>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-zinc-400">
                        Department · {agents.length} {agents.length === 1 ? "agent" : "agents"}
                      </p>
                    </div>
                  </div>
                  <span
                    className={
                      "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ring-1 ring-inset " +
                      (active
                        ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25"
                        : "bg-zinc-800/70 text-zinc-400 ring-zinc-700/70")
                    }
                  >
                    <span className={"h-1.5 w-1.5 rounded-full " + (active ? "bg-emerald-400 motion-safe:animate-pulse" : "bg-zinc-600")} />
                    {lifecycle}
                  </span>
                </div>

                <div className={active ? "grid gap-2 sm:grid-cols-2 lg:grid-cols-3" : "grid gap-2"}>
                  {agents.map((agent) => (
                    <AgentNameplate key={agent.employeeId} agent={agent} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/70 pt-4 text-[10px] text-zinc-600">
          <span>Static FleetSnapshot · no controls · no network source</span>
          <span>{snapshot.edges.length} fixture communication edges</span>
        </footer>
      </div>
    </section>
  );
}
