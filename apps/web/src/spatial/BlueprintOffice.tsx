import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Agent, Room, WorldState } from "./contract";
import { departmentLabel } from "./contract";
import { ProviderChip } from "../components/ui/ProviderChip";
import { cn } from "../lib/utils";

/**
 * BlueprintOffice (Aurora Cockpit §3.5) — a legible DOM/SVG "blueprint" of the
 * autonomous company: rooms = departments, desks = agents. Renders the
 * `contract.ts` `WorldState` (mock feed today, the M1 adapter later); every
 * callout line is drawn ONLY when its field exists, so nothing is a placeholder.
 *
 * Aesthetic: draft-blue room walls on a faint blueprint grid, glass room fills, a
 * corner title block and a legend. Working desks glow coral and carry the full
 * info contract (agent · model, status · runtime · cost, assignment, worktree ·
 * diff, last-action); reserved/idle desks show the compact 2-line form.
 */

const DRAFT = "#8d7fc0";

/** True when a room has any working/talking/moving occupant (drives the active treatment). */
function isRoomActive(room: Room, byId: Map<string, Agent>): boolean {
  return room.members.some((id) => {
    const a = byId.get(id);
    return a && a.status !== "idle" && a.status !== "done";
  });
}

/** An agent is "working" for callout purposes when it's not idle/done. */
function isWorking(a: Agent): boolean {
  return a.status !== "idle" && a.status !== "done";
}

/** Compact elapsed since an epoch-ms start (e.g. 12s / 4m / 2h). */
function runtime(startedAt: number | undefined, nowMs: number): string | null {
  if (!startedAt) return null;
  const sec = Math.max(0, Math.round((nowMs - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

/** The status glyph + tint for a desk/callout. */
function statusMeta(status: Agent["status"]): { glyph: string; cls: string; label: string } {
  switch (status) {
    case "working":
      return { glyph: "●", cls: "text-[var(--dh-coral)]", label: "ACTIVE" };
    case "talking":
      return { glyph: "◇", cls: "text-[var(--dh-coral)]", label: "TALKING" };
    case "moving":
      return { glyph: "→", cls: "text-[var(--dh-warning)]", label: "MOVING" };
    case "blocked":
      return { glyph: "⏸", cls: "text-[var(--dh-warning)]", label: "BLOCKED" };
    case "done":
      return { glyph: "✓", cls: "text-[var(--dh-success)]", label: "DONE" };
    default:
      return { glyph: "◌", cls: "text-[var(--dh-text-dim)]", label: "RESERVED" };
  }
}

/** One desk = one agent. Working desks glow + carry the full callout; else compact. */
function Desk({
  agent,
  nowMs,
  selected,
  onSelect,
}: {
  agent: Agent;
  nowMs: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const working = isWorking(agent);
  const meta = statusMeta(agent.status);
  const rt = runtime(agent.startedAt, nowMs);
  const provider = agent.provider ?? null;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="office-desk"
      data-agent-id={agent.id}
      data-working={working}
      className={cn(
        "flex flex-col gap-1 rounded-[9px] border px-2.5 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dh-focus)]",
        working
          ? "border-[var(--dh-coral)]/45 bg-[color-mix(in_srgb,var(--dh-coral)_9%,transparent)]"
          : "border-dashed border-[color-mix(in_srgb,var(--draft-color)_40%,transparent)] bg-[color-mix(in_srgb,var(--draft-color)_5%,transparent)]",
        selected && "ring-2 ring-[var(--dh-focus)]",
      )}
      style={{ ["--draft-color" as string]: DRAFT }}
    >
      {/* Line 1: agent name + provider·model. */}
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            working ? "bg-[var(--dh-coral)] shadow-[0_0_6px_var(--dh-coral)] motion-safe:animate-pulse" : "bg-[var(--dh-text-dim)]",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold tracking-tight text-[var(--dh-text-strong)]">
          {agent.name}
        </span>
        {provider ? <ProviderChip provider={provider} /> : null}
      </div>

      {agent.model ? (
        <div className="dh-mono-ui truncate text-[var(--dh-text-dim)]">{agent.model}</div>
      ) : null}

      {working ? (
        <>
          {/* Line 2: status · runtime · cost. */}
          <div className={cn("dh-mono-ui flex items-center gap-1.5", meta.cls)}>
            <span aria-hidden>{meta.glyph}</span>
            <span>{meta.label}</span>
            {rt ? <span className="text-[var(--dh-text-muted)]">· {rt}</span> : null}
            {agent.costUsd != null ? <span className="text-[var(--dh-text-muted)]">· ${agent.costUsd.toFixed(2)}</span> : null}
          </div>
          {/* Line 3: current assignment. */}
          {agent.assignment ? (
            <div className="truncate text-[11px] leading-4 text-[var(--dh-text)]">{agent.assignment}</div>
          ) : null}
          {/* Line 4: worktree · diff (mono). */}
          {agent.worktree ? (
            <div className="dh-mono-ui truncate text-[var(--dh-text-muted)]">
              ⎇ {agent.worktree}
              {agent.diff ? ` · +${agent.diff.add} −${agent.diff.del}` : ""}
            </div>
          ) : null}
          {/* Line 5: last action + blinking caret. */}
          {agent.lastAction ? (
            <div className="dh-mono-ui truncate text-[var(--dh-text-dim)]">
              {agent.lastAction} <span className="motion-safe:animate-pulse">▮</span>
            </div>
          ) : null}
        </>
      ) : (
        <div className={cn("dh-mono-ui flex items-center gap-1.5", meta.cls)}>
          <span aria-hidden>{meta.glyph}</span>
          <span>{meta.label}</span>
        </div>
      )}
    </button>
  );
}

/** One room = a department (or a spawned project). Draft-blue walls + glass fill. */
function RoomPanel({
  room,
  agents,
  active,
  nowMs,
  selectedId,
  onSelect,
}: {
  room: Room;
  agents: Agent[];
  active: boolean;
  nowMs: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const occupied = agents.filter(isWorking).length;
  const kindLabel = room.kind === "project" ? "PROJECT" : "DEPT";
  return (
    <section
      data-testid="office-room"
      data-kind={room.kind}
      data-active={active}
      aria-label={`${room.label} — ${active ? "active" : "reserved"}`}
      className={cn(
        "relative flex min-w-0 flex-col gap-2.5 rounded-[16px] border p-3",
        active
          ? "border-[var(--dh-coral)]/50 bg-[color-mix(in_srgb,var(--dh-coral)_5%,transparent)]"
          : "border-[color-mix(in_srgb,var(--draft-color)_55%,transparent)]",
      )}
      style={{
        ["--draft-color" as string]: DRAFT,
        background: active
          ? undefined
          : "linear-gradient(160deg, rgba(220,205,245,0.05), transparent 45%), rgba(141,127,192,0.045)",
      }}
    >
      {/* Corner title block. */}
      <div className="flex items-start justify-between gap-2 border-b border-[color-mix(in_srgb,var(--draft-color)_30%,transparent)] pb-2" style={{ ["--draft-color" as string]: DRAFT }}>
        <div className="min-w-0">
          <h2
            className={cn(
              "truncate text-[13px] font-bold uppercase tracking-[0.12em]",
              active ? "text-[var(--dh-coral)]" : "text-[var(--dh-text)]",
            )}
          >
            {room.kind === "project" ? room.label : departmentLabel(room.dept)}
          </h2>
          <div className="dh-mono-ui text-[var(--dh-text-dim)]">
            {kindLabel} · {occupied}/{agents.length} desks
            {room.kind === "project" && room.status ? ` · ${room.status}` : ""}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em]",
            active ? "bg-[var(--dh-coral)]/15 text-[var(--dh-coral)]" : "bg-[var(--dh-control)] text-[var(--dh-text-dim)]",
          )}
        >
          {active ? "online" : "reserved"}
        </span>
      </div>

      {/* Desks. */}
      {agents.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {agents.map((a) => (
            <Desk key={a.id} agent={a} nowMs={nowMs} selected={selectedId === a.id} onSelect={() => onSelect(a.id)} />
          ))}
        </div>
      ) : (
        <div className="dh-mono-ui rounded-[9px] border border-dashed border-[color-mix(in_srgb,var(--draft-color)_35%,transparent)] px-2.5 py-3 text-center text-[var(--dh-text-dim)]" style={{ ["--draft-color" as string]: DRAFT }}>
          empty
        </div>
      )}
    </section>
  );
}

/** Right-side inspector slide-over for a clicked desk. Only real fields render. */
function DeskInspector({ agent, nowMs, onClose }: { agent: Agent; nowMs: number; onClose: () => void }) {
  const meta = statusMeta(agent.status);
  const rt = runtime(agent.startedAt, nowMs);
  const rows: Array<[string, string | null]> = [
    ["Department", departmentLabel(agent.dept)],
    ["Role", agent.role],
    ["Reports to", agent.reports_to],
    ["Project", agent.project || "— (home)"],
    ["Status", meta.label.toLowerCase()],
    ["Model", agent.model ?? null],
    ["Assignment", agent.assignment || null],
    ["Runtime", rt],
    ["Cost", agent.costUsd != null ? `$${agent.costUsd.toFixed(2)}` : null],
    ["Tokens", agent.tokens != null ? agent.tokens.toLocaleString() : null],
    ["Worktree", agent.worktree ?? null],
    ["Diff", agent.diff ? `+${agent.diff.add} −${agent.diff.del}` : null],
    ["Last action", agent.lastAction ?? null],
  ];
  return (
    <aside
      className="glass-card absolute inset-y-3 right-3 z-20 flex w-[300px] flex-col gap-3 p-4"
      role="dialog"
      aria-label={`${agent.name} details`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-bold text-[var(--dh-text-strong)]">{agent.name}</span>
            {agent.provider ? <ProviderChip provider={agent.provider} /> : null}
          </div>
          <div className={cn("dh-mono-ui mt-0.5", meta.cls)}>
            {meta.glyph} {meta.label}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[7px] p-1 text-[var(--dh-text-muted)] transition hover:bg-[var(--dh-hover)] hover:text-[var(--dh-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dh-focus)]"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <dl className="flex flex-col gap-1.5">
        {rows
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-[var(--dh-border-subtle)] pb-1.5 last:border-0">
              <dt className="dh-label shrink-0">{k}</dt>
              <dd className="dh-mono-ui min-w-0 truncate text-right text-[var(--dh-text)]">{v}</dd>
            </div>
          ))}
      </dl>
    </aside>
  );
}

export function BlueprintOffice({
  world,
  source,
}: {
  world: WorldState;
  /** Feed source, surfaced honestly in the corner stamp (MOCK vs LIVE). */
  source?: "mock" | "live";
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const byId = useMemo(() => new Map(world.agents.map((a) => [a.id, a])), [world.agents]);

  // Departments first (stable order), then any spawned project rooms.
  const rooms = useMemo(() => {
    const depts = world.rooms.filter((r) => r.kind === "department");
    const projects = world.rooms.filter((r) => r.kind === "project");
    return [...depts, ...projects];
  }, [world.rooms]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const activeAgents = world.agents.filter(isWorking).length;
  const activeRooms = rooms.filter((r) => isRoomActive(r, byId)).length;

  return (
    <div className="dh-aurora-bg--soft relative min-w-0 flex-1 overflow-y-auto" data-testid="blueprint-office">
      {/* Faint blueprint grid wash. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage: `linear-gradient(${DRAFT}22 1px, transparent 1px), linear-gradient(90deg, ${DRAFT}22 1px, transparent 1px)`,
          backgroundSize: "34px 34px",
          maskImage: "linear-gradient(to bottom, black, transparent 88%)",
        }}
      />

      <div className="relative mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[17px] font-[680] tracking-[-0.01em] text-[var(--dh-text-strong)]">Office</h1>
          <span className="dh-mono-ui text-[var(--dh-text-muted)]">
            {rooms.length} rooms · {world.agents.length} agents · {activeAgents} active
          </span>
          <span
            className="dh-mono-ui ml-auto rounded-full bg-[var(--dh-control)] px-2 py-0.5 text-[var(--dh-text-dim)]"
            title="Feed source"
          >
            {(source ?? "mock").toUpperCase()} FEED
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => (
            <RoomPanel
              key={room.id}
              room={room}
              agents={room.members.map((id) => byId.get(id)).filter((a): a is Agent => !!a)}
              active={isRoomActive(room, byId)}
              nowMs={nowMs}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ))}
        </div>

        {/* Corner title block + legend. */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-[color-mix(in_srgb,var(--draft-color)_30%,transparent)] pt-3" style={{ ["--draft-color" as string]: DRAFT }}>
          <div className="flex items-center gap-4 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--dh-text-dim)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--dh-coral)] shadow-[0_0_6px_var(--dh-coral)]" /> Active
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--dh-text-dim)]" /> Reserved
            </span>
          </div>
          <div className="dh-mono-ui text-right text-[var(--dh-text-dim)]">
            OFFICE · PLAN 02 · AGENTS {world.agents.length} · {activeAgents} ACTIVE · ROOMS {rooms.length} · {activeRooms} ONLINE
          </div>
        </div>
      </div>

      {selected ? <DeskInspector agent={selected} nowMs={nowMs} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
