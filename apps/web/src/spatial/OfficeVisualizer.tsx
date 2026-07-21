import { Building2, UsersRound } from "lucide-react";
import type { Agent, AgentStatus, Room, WorldState } from "./contract";
import { departmentLabel } from "./contract";
import { ProviderChip } from "../components/ui/ProviderChip";

/**
 * OfficeVisualizer — the "Nameplates" renderer. A card-grid view of the SAME live
 * `WorldState` the Blueprint floor plan draws (mock feed today, the M1 adapter
 * later), kept as a one-click rollback from the plan. It shares the app's glass /
 * violet / coral theme and the identical agent roster + status semantics, so
 * toggling renderers only changes the *shape* of the view, never the data or the
 * palette.
 */

export interface OfficeVisualizerProps {
  world: WorldState;
  /** Feed source, surfaced honestly in the header badge (MOCK vs LIVE). */
  source?: "mock" | "live";
}

/** An agent is "working" (drives the active treatment) when not idle/done. */
function isWorking(status: AgentStatus): boolean {
  return status !== "idle" && status !== "done";
}

/** Status label + accent — matches the Blueprint renderer's palette exactly. */
function statusMeta(status: AgentStatus): { label: string; color: string } {
  switch (status) {
    case "working":
      return { label: "active", color: "var(--dh-coral)" };
    case "talking":
      return { label: "talking", color: "var(--dh-coral)" };
    case "moving":
      return { label: "moving", color: "var(--dh-warning)" };
    case "blocked":
      return { label: "blocked", color: "var(--dh-warning)" };
    case "done":
      return { label: "done", color: "var(--dh-success)" };
    default:
      return { label: "reserved", color: "var(--dh-text-dim)" };
  }
}

/** Room title: department banner or project label. */
function roomTitle(room: Room): string {
  return room.kind === "project" ? room.label : departmentLabel(room.dept);
}

function AgentNameplate({ agent }: { agent: Agent }): React.JSX.Element {
  const meta = statusMeta(agent.status);
  const detail = agent.assignment || agent.lastAction || "At their desk";
  return (
    <article
      data-testid="office-agent"
      data-agent-id={agent.id}
      className="rounded-[10px] border border-[var(--dh-border-subtle)] bg-[var(--dh-control)] px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-tight text-[var(--dh-text-strong)]">
            {agent.name}
          </div>
          <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--dh-text-muted)]">
            {agent.role}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {agent.provider ? <ProviderChip provider={agent.provider} /> : null}
          <span
            className="dh-mono-ui inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: meta.color, background: "color-mix(in srgb, currentColor 12%, transparent)" }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
            {meta.label}
          </span>
        </div>
      </div>
      <p className="mt-2 min-w-0 truncate border-t border-[var(--dh-border-subtle)] pt-2 text-[11px] leading-4 text-[var(--dh-text-muted)]">
        {detail}
      </p>
    </article>
  );
}

export function OfficeVisualizer({ world, source }: OfficeVisualizerProps): React.JSX.Element {
  const byId = new Map(world.agents.map((agent) => [agent.id, agent]));

  // Departments first (stable order), then any spawned project rooms — same
  // ordering the Blueprint plan uses, so the two views agree room-for-room.
  const rooms = [
    ...world.rooms.filter((r) => r.kind === "department"),
    ...world.rooms.filter((r) => r.kind === "project"),
  ];
  const roomModels = rooms.map((room) => {
    const agents = room.members
      .map((id) => byId.get(id))
      .filter((a): a is Agent => !!a)
      .sort((a, b) => Number(isWorking(b.status)) - Number(isWorking(a.status)));
    const active = agents.some((a) => isWorking(a.status));
    return { room, agents, active };
  });

  const activeRoomCount = roomModels.filter(({ active }) => active).length;
  const activeAgentCount = world.agents.filter((a) => isWorking(a.status)).length;

  return (
    <section
      data-testid="office-visualizer"
      className="dh-aurora-bg--soft relative min-w-0 flex-1 overflow-y-auto"
      aria-labelledby="fleet-office-title"
    >
      <div className="relative mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-col gap-4 border-b border-[var(--dh-border-subtle)] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--dh-rail-active)] text-[var(--dh-brand)] ring-1 ring-inset ring-[var(--dh-glass-border-hi)]">
              <Building2 aria-hidden="true" className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 id="fleet-office-title" className="text-[17px] font-[680] tracking-[-0.01em] text-[var(--dh-text-strong)]">
                Office
              </h1>
              <p className="dh-mono-ui mt-0.5 text-[var(--dh-text-muted)]">
                {rooms.length} rooms · {world.agents.length} agents · {activeAgentCount} active
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-[var(--dh-text-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <Building2 aria-hidden="true" className="h-3.5 w-3.5 text-[var(--dh-text-dim)]" />
              <strong className="font-semibold text-[var(--dh-text)]">{activeRoomCount}</strong> online
            </span>
            <span className="inline-flex items-center gap-1.5">
              <UsersRound aria-hidden="true" className="h-3.5 w-3.5 text-[var(--dh-text-dim)]" />
              <strong className="font-semibold text-[var(--dh-text)]">{activeAgentCount}</strong> active
            </span>
            <span
              className="dh-mono-ui rounded-full bg-[var(--dh-control)] px-2 py-0.5 text-[var(--dh-text-dim)]"
              title="Feed source"
            >
              {(source ?? "mock").toUpperCase()} FEED
            </span>
          </div>
        </header>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="dh-mono-ui text-[11px] text-[var(--dh-text-muted)]">
            {activeRoomCount} online · {rooms.length - activeRoomCount} reserved
          </p>
          <div
            className="flex items-center gap-4 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--dh-text-muted)]"
            aria-label="Room lifecycle legend"
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--dh-coral)] motion-safe:animate-pulse" />
              Active
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--dh-text-dim)]" />
              Reserved
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {roomModels.map(({ room, agents, active }) => {
            const lifecycle = active ? "active" : "reserved";
            const occupied = agents.filter((a) => isWorking(a.status)).length;
            return (
              <section
                key={room.id}
                role="region"
                aria-label={`${roomTitle(room)} — ${lifecycle}`}
                data-testid="office-room"
                data-kind={room.kind}
                data-lifecycle={lifecycle}
                className="glass-card relative flex flex-col gap-3 p-4 transition-opacity"
                style={
                  active
                    ? { borderColor: "var(--dh-glass-border-hi)", boxShadow: "inset 2px 0 0 var(--dh-coral)" }
                    : { opacity: 0.66 }
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[12px] font-black uppercase ring-1 ring-inset"
                      style={
                        active
                          ? { background: "color-mix(in srgb, var(--dh-coral) 15%, transparent)", color: "var(--dh-coral)", borderColor: "transparent" }
                          : { background: "var(--dh-control)", color: "var(--dh-text-muted)" }
                      }
                    >
                      {roomTitle(room).charAt(0)}
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-[14px] font-semibold tracking-tight text-[var(--dh-text-strong)]">
                        {roomTitle(room)}
                      </h2>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--dh-text-muted)]">
                        {room.kind} · {agents.length} {agents.length === 1 ? "desk" : "desks"}
                      </p>
                    </div>
                  </div>
                  <span
                    className="dh-mono-ui inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
                    style={{
                      color: active ? "var(--dh-coral)" : "var(--dh-text-dim)",
                      background: "var(--dh-control)",
                    }}
                  >
                    <span
                      className={"h-1.5 w-1.5 rounded-full " + (active ? "motion-safe:animate-pulse" : "")}
                      style={{ background: active ? "var(--dh-coral)" : "var(--dh-text-dim)" }}
                    />
                    {occupied}/{agents.length}
                  </span>
                </div>

                {agents.length === 0 ? (
                  <p className="dh-mono-ui py-4 text-center text-[10px] uppercase tracking-[0.3em] text-[var(--dh-text-disabled)]">
                    Vacant
                  </p>
                ) : (
                  <div className={active ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
                    {agents.map((agent) => (
                      <AgentNameplate key={agent.id} agent={agent} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}
