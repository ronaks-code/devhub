import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Agent, AgentStatus, Room, WorldState } from "./contract";
import { departmentLabel } from "./contract";
import { ProviderChip } from "../components/ui/ProviderChip";
import { cn } from "../lib/utils";

/**
 * BlueprintOffice (Aurora Cockpit §3.5v2) — an actual architectural FLOOR PLAN of
 * the autonomous company, not a grid of cards: one outer building wall, interior
 * room partitions (rooms = departments/projects), desks drawn as small rects
 * INSIDE their rooms (desks = agents), draft-blue linework on a faint blueprint
 * grid, dimension letters/ticks along the margins, corridor dashed centerlines,
 * door arcs, and a corner title block + legend. Renders the `contract.ts`
 * `WorldState` (mock feed today, the M1 adapter later); every annotation line is
 * drawn ONLY when its field exists, so nothing is a placeholder.
 *
 * Working desks glow coral (pulse ring) and carry the full drafting callout
 * (agent · provider/model, status · runtime · cost · tokens, assignment,
 * worktree · diff, last action) as annotation text beside the desk with a dashed
 * leader line. Idle/reserved desks are small labeled rects. Clicking any desk
 * opens the inspector with the complete field list.
 */

const DRAFT = "#8d7fc0";
const DRAFT_DIM = "rgba(141, 127, 192, 0.34)";
const DRAFT_FAINT = "rgba(141, 127, 192, 0.12)";

// ── Plan geometry (viewBox units) ───────────────────────────────────────────
const COLS = 3; // rooms per building row
const ROOM_W = 380;
const PAD = 16; // room inner padding
const HEADER_H = 50; // room label block
const LINE_H = 12; // annotation line height
const IDLE_COLS = 4; // idle desks per row inside a room
const IDLE_BAY_W = (ROOM_W - PAD * 2) / IDLE_COLS;
const IDLE_BAY_H = 60;
const MIN_ROOM_H = 132;
const CORRIDOR_H = 52;
const MARGIN_L = 56;
const MARGIN_T = 46;
const MARGIN_R = 30;
const MARGIN_B = 40;

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

/** The status glyph + tint for a desk/callout (colors as CSS var paints). */
function statusMeta(status: AgentStatus): { glyph: string; color: string; label: string } {
  switch (status) {
    case "working":
      return { glyph: "●", color: "var(--dh-coral)", label: "ACTIVE" };
    case "talking":
      return { glyph: "◇", color: "var(--dh-coral)", label: "TALKING" };
    case "moving":
      return { glyph: "→", color: "var(--dh-warning)", label: "MOVING" };
    case "blocked":
      return { glyph: "⏸", color: "var(--dh-warning)", label: "BLOCKED" };
    case "done":
      return { glyph: "✓", color: "var(--dh-success)", label: "DONE" };
    default:
      return { glyph: "◌", color: "var(--dh-text-dim)", label: "RESERVED" };
  }
}

/** SVG text doesn't ellipsize — clip drafting annotations to the room width. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One drafting-annotation line beside a working desk. */
interface PlanLine {
  text: string;
  fill: string;
  size: number;
  weight?: number;
}

/** The working-desk callout: only lines whose real field exists are emitted. */
function calloutLines(a: Agent, nowMs: number): PlanLine[] {
  const meta = statusMeta(a.status);
  const lines: PlanLine[] = [
    { text: clip(a.name.toUpperCase(), 30), fill: "var(--dh-text-strong)", size: 10.5, weight: 700 },
  ];
  const provider = a.provider === "anthropic" ? "CLD" : a.provider === "openai" ? "CDX" : null;
  const idLine = [provider, a.model].filter(Boolean).join(" · ");
  if (idLine) lines.push({ text: clip(idLine, 44), fill: "var(--dh-text-dim)", size: 8.5 });
  const rt = runtime(a.startedAt, nowMs);
  const stat = [`${meta.glyph} ${meta.label}`];
  if (rt) stat.push(rt);
  if (a.costUsd != null) stat.push(`$${a.costUsd.toFixed(2)}`);
  if (a.tokens != null) stat.push(`${a.tokens.toLocaleString()} tk`);
  lines.push({ text: clip(stat.join(" · "), 44), fill: meta.color, size: 8.5 });
  if (a.assignment) lines.push({ text: clip(a.assignment, 44), fill: "var(--dh-text)", size: 9.5 });
  if (a.worktree)
    lines.push({
      text: clip(`⎇ ${a.worktree}${a.diff ? ` · +${a.diff.add} −${a.diff.del}` : ""}`, 44),
      fill: "var(--dh-link)",
      size: 8.5,
    });
  if (a.lastAction) lines.push({ text: clip(a.lastAction, 44), fill: "var(--dh-text-dim)", size: 8.5 });
  return lines;
}

interface WorkBay {
  agent: Agent;
  y: number; // room-local
  h: number;
  lines: PlanLine[];
}
interface IdleBay {
  agent: Agent;
  x: number; // room-local
  y: number;
}
interface RoomLayout {
  room: Room;
  agents: Agent[];
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  workBays: WorkBay[];
  idleBays: IdleBay[];
  /** Height this room's content needs (rooms in a row share the row max). */
  contentH: number;
  /** Building row index (decides which edge faces the corridor). */
  rowIndex: number;
}
interface PlanLayout {
  rooms: RoomLayout[];
  /** Absolute y + height per building row (for corridor + row-number rulers). */
  rows: Array<{ y: number; h: number }>;
  buildingW: number;
  buildingH: number;
  width: number;
  height: number;
}

/** Pure plan layout: rooms flow into COLS-wide building rows split by corridors. */
function layoutPlan(rooms: Room[], byId: Map<string, Agent>, nowMs: number): PlanLayout {
  const layouts: RoomLayout[] = rooms.map((room) => {
    const agents = room.members
      .map((id) => byId.get(id))
      .filter((a): a is Agent => !!a)
      .sort((a, b) => Number(isWorking(b)) - Number(isWorking(a)));
    const working = agents.filter(isWorking);
    const idle = agents.filter((a) => !isWorking(a));
    let cy = HEADER_H;
    const workBays: WorkBay[] = working.map((a) => {
      const lines = calloutLines(a, nowMs);
      const h = Math.max(44, 10 + lines.length * LINE_H);
      const bay = { agent: a, y: cy, h, lines };
      cy += h + 4;
      return bay;
    });
    const idleBays: IdleBay[] = idle.map((a, i) => ({
      agent: a,
      x: PAD + (i % IDLE_COLS) * IDLE_BAY_W,
      y: cy + Math.floor(i / IDLE_COLS) * IDLE_BAY_H,
    }));
    if (idle.length) cy += Math.ceil(idle.length / IDLE_COLS) * IDLE_BAY_H;
    return {
      room,
      agents,
      x: 0,
      y: 0,
      w: ROOM_W,
      h: 0,
      active: isRoomActive(room, byId),
      workBays,
      idleBays,
      contentH: Math.max(MIN_ROOM_H, cy + PAD),
      rowIndex: 0,
    };
  });

  const rows: Array<{ y: number; h: number }> = [];
  let y = MARGIN_T;
  for (let ri = 0; ri * COLS < layouts.length; ri++) {
    const row = layouts.slice(ri * COLS, ri * COLS + COLS);
    const rowH = Math.max(...row.map((r) => r.contentH));
    row.forEach((r, ci) => {
      r.x = MARGIN_L + ci * ROOM_W;
      r.y = y;
      r.h = rowH;
      r.rowIndex = ri;
    });
    rows.push({ y, h: rowH });
    y += rowH + CORRIDOR_H;
  }
  const buildingH = rows.length ? y - CORRIDOR_H - MARGIN_T : 0;
  const buildingW = Math.min(COLS, Math.max(1, layouts.length)) * ROOM_W;
  return {
    rooms: layouts,
    rows,
    buildingW,
    buildingH,
    width: MARGIN_L + buildingW + MARGIN_R,
    height: MARGIN_T + buildingH + MARGIN_B,
  };
}

/** One desk (working bay or idle bay) — a clickable plan glyph, never a card. */
function DeskGlyph({
  agent,
  working,
  selected,
  onSelect,
  children,
}: {
  agent: Agent;
  working: boolean;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <g
      className="dh-bp-desk"
      data-testid="office-desk"
      data-agent-id={agent.id}
      data-working={working}
      role="button"
      tabIndex={0}
      aria-label={`${agent.name} — ${agent.status}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style={selected ? { outline: "1px dashed var(--dh-focus)" } : undefined}
    >
      {children}
    </g>
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
          <div className="dh-mono-ui mt-0.5" style={{ color: meta.color }}>
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

/** One room drawn as plan linework: partition walls, label block, desks, door. */
function RoomPlan({
  layout,
  totalRows,
  selectedId,
  onSelect,
}: {
  layout: RoomLayout;
  totalRows: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { room, agents, w, h, active, workBays, idleBays, rowIndex } = layout;
  const occupied = agents.filter(isWorking).length;
  const kindLabel = room.kind === "project" ? "PROJECT" : "DEPT";
  const label = (room.kind === "project" ? room.label : departmentLabel(room.dept)).toUpperCase();
  const sub = [
    `${kindLabel} · ${occupied}/${agents.length} DESKS`,
    room.kind === "project" && room.status ? room.status.toUpperCase() : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Door arc on the corridor-facing edge (top for lower rows, bottom for row 0).
  const doorOnBottom = rowIndex === 0 && totalRows > 1;

  return (
    <g
      transform={`translate(${layout.x},${layout.y})`}
      data-testid="office-room"
      data-kind={room.kind}
      data-active={active}
      aria-label={`${room.label} — ${active ? "active" : "reserved"}`}
    >
      {/* Room fill + partition wall. */}
      <rect
        width={w}
        height={h}
        style={{
          fill: active ? "rgba(255, 124, 104, 0.045)" : DRAFT_FAINT,
          stroke: active ? "rgba(255, 124, 104, 0.65)" : DRAFT_DIM,
          strokeWidth: active ? 1.4 : 1,
        }}
      />
      {/* Label block. */}
      <text x={PAD} y={24} fontSize={12} fontWeight={700} letterSpacing={3} style={{ fill: active ? "#ffb3a4" : "var(--dh-text)" }}>
        {clip(label, 30)}
      </text>
      <text x={PAD} y={38} fontSize={8} letterSpacing={1.5} style={{ fill: "var(--dh-text-dim)" }}>
        {clip(sub, 52)}
      </text>

      {/* Working desks: desk rect + chair + pulse + dashed leader + annotation. */}
      {workBays.map((bay) => {
        const meta = statusMeta(bay.agent.status);
        const deskY = bay.y + 6;
        const dotCx = PAD + 22;
        const dotCy = deskY + 12;
        let ty = bay.y + 14;
        return (
          <DeskGlyph
            key={bay.agent.id}
            agent={bay.agent}
            working
            selected={selectedId === bay.agent.id}
            onSelect={() => onSelect(bay.agent.id)}
          >
            <rect
              x={PAD}
              y={deskY}
              width={44}
              height={24}
              style={{ fill: "rgba(255, 124, 104, 0.20)", stroke: "rgba(255, 124, 104, 0.75)", strokeWidth: 1 }}
            />
            <path
              d={`M ${PAD + 11} ${deskY + 30} a 11 8 0 0 0 22 0`}
              style={{ fill: "none", stroke: DRAFT_DIM, strokeWidth: 1 }}
            />
            <circle className="dh-bp-pulse" cx={dotCx} cy={dotCy} r={5} style={{ fill: "none", stroke: meta.color }} />
            <circle cx={dotCx} cy={dotCy} r={4} style={{ fill: meta.color }} />
            <path
              d={`M ${PAD + 46} ${dotCy} L ${PAD + 60} ${dotCy}`}
              style={{ stroke: DRAFT_DIM, strokeWidth: 1, strokeDasharray: "2 3" }}
            />
            {bay.lines.map((l, i) => {
              const el = (
                <text key={i} x={PAD + 66} y={ty} fontSize={l.size} fontWeight={l.weight ?? 400} style={{ fill: l.fill }}>
                  {l.text}
                </text>
              );
              ty += LINE_H;
              return el;
            })}
          </DeskGlyph>
        );
      })}

      {/* Idle/reserved desks: compact plan glyphs. */}
      {idleBays.map((bay) => {
        const meta = statusMeta(bay.agent.status);
        return (
          <g key={bay.agent.id} transform={`translate(${bay.x},${bay.y})`}>
            <DeskGlyph
              agent={bay.agent}
              working={false}
              selected={selectedId === bay.agent.id}
              onSelect={() => onSelect(bay.agent.id)}
            >
              <rect
                x={IDLE_BAY_W / 2 - 20}
                y={8}
                width={40}
                height={20}
                style={{ fill: "rgba(141, 127, 192, 0.10)", stroke: DRAFT_DIM, strokeWidth: 1 }}
              />
              <path
                d={`M ${IDLE_BAY_W / 2 - 10} ${33} a 10 7 0 0 0 20 0`}
                style={{ fill: "none", stroke: DRAFT_DIM, strokeWidth: 1 }}
              />
              <circle cx={IDLE_BAY_W / 2} cy={18} r={3.5} style={{ fill: meta.color }} />
              <text x={IDLE_BAY_W / 2} y={52} fontSize={8} textAnchor="middle" style={{ fill: "var(--dh-text-dim)" }}>
                {clip(bay.agent.name, 13)}
              </text>
            </DeskGlyph>
          </g>
        );
      })}

      {/* Vacant room note (honest: zero members right now). */}
      {agents.length === 0 ? (
        <text x={w / 2} y={h / 2 + 14} fontSize={9} letterSpacing={3} textAnchor="middle" style={{ fill: "var(--dh-text-disabled)" }}>
          VACANT
        </text>
      ) : null}

      {/* Door arc on the corridor edge. */}
      {totalRows > 1 ? (
        doorOnBottom ? (
          <path d={`M ${w - 42} ${h} a 30 30 0 0 0 -30 -30`} style={{ fill: "none", stroke: DRAFT_DIM, strokeWidth: 1 }} />
        ) : (
          <path d={`M ${w - 42} 0 a 30 30 0 0 1 -30 30`} style={{ fill: "none", stroke: DRAFT_DIM, strokeWidth: 1 }} />
        )
      ) : null}
    </g>
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

  const plan = useMemo(() => layoutPlan(rooms, byId, nowMs), [rooms, byId, nowMs]);

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
  const activeRooms = plan.rooms.filter((r) => r.active).length;
  const colLetters = "ABCDEFGH";

  return (
    <div className="dh-aurora-bg--soft relative min-w-0 flex-1 overflow-y-auto" data-testid="blueprint-office">
      <div className="relative mx-auto flex max-w-[1360px] flex-col gap-3 px-6 py-5">
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

        {/* The drafting sheet. */}
        <div className="relative">
          <svg
            viewBox={`0 0 ${plan.width} ${plan.height}`}
            className="dh-blueprint block w-full"
            role="img"
            aria-label="Office floor plan — rooms are departments, desks are agents"
          >
            <defs>
              <pattern id="dh-bp-grid" width={34} height={34} patternUnits="userSpaceOnUse">
                <path d="M34 0H0V34" fill="none" stroke={DRAFT} strokeOpacity={0.13} strokeWidth={1} />
              </pattern>
            </defs>
            {/* Faint blueprint grid across the whole sheet. */}
            <rect width={plan.width} height={plan.height} fill="url(#dh-bp-grid)" opacity={0.55} />

            {/* Margin rulers: column letters + ticks, row numbers. */}
            {plan.rooms.slice(0, COLS).map((_, ci) => (
              <text
                key={`col-${ci}`}
                x={MARGIN_L + ci * ROOM_W + ROOM_W / 2}
                y={MARGIN_T - 16}
                fontSize={9}
                textAnchor="middle"
                style={{ fill: "var(--dh-text-disabled)" }}
              >
                {colLetters[ci]}
              </text>
            ))}
            {Array.from({ length: Math.min(COLS, plan.rooms.length) + 1 }, (_, ci) => (
              <line
                key={`tick-${ci}`}
                x1={MARGIN_L + ci * ROOM_W}
                y1={MARGIN_T - 10}
                x2={MARGIN_L + ci * ROOM_W}
                y2={MARGIN_T - 4}
                style={{ stroke: DRAFT_DIM, strokeWidth: 1 }}
              />
            ))}
            {plan.rows.map((row, ri) => (
              <text
                key={`row-${ri}`}
                x={MARGIN_L - 18}
                y={row.y + row.h / 2 + 3}
                fontSize={9}
                textAnchor="middle"
                style={{ fill: "var(--dh-text-disabled)" }}
              >
                {ri + 1}
              </text>
            ))}

            {/* Outer building wall. */}
            <rect
              x={MARGIN_L}
              y={MARGIN_T}
              width={plan.buildingW}
              height={plan.buildingH}
              style={{ fill: "none", stroke: DRAFT, strokeWidth: 1.8, opacity: 0.85 }}
            />

            {/* Corridors between building rows: dashed centerline + label. */}
            {plan.rows.slice(0, -1).map((row, ri) => {
              const cy = row.y + row.h + CORRIDOR_H / 2;
              return (
                <g key={`corridor-${ri}`}>
                  <line
                    x1={MARGIN_L + 84}
                    y1={cy}
                    x2={MARGIN_L + plan.buildingW - 10}
                    y2={cy}
                    style={{ stroke: DRAFT_DIM, strokeWidth: 1, strokeDasharray: "5 7" }}
                  />
                  <text x={MARGIN_L + 10} y={cy + 3} fontSize={8} letterSpacing={4} style={{ fill: "var(--dh-text-disabled)" }}>
                    CORRIDOR
                  </text>
                </g>
              );
            })}

            {/* Rooms. */}
            {plan.rooms.map((layout) => (
              <RoomPlan
                key={layout.room.id}
                layout={layout}
                totalRows={plan.rows.length}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ))}
          </svg>

          {/* Corner title block (drafting stamp) — real counts only. */}
          <div
            className="dh-mono-ui absolute bottom-2 right-2 z-10 w-[212px] border text-[9px]"
            style={{ borderColor: DRAFT_DIM, background: "rgba(24, 19, 32, 0.82)", color: "var(--dh-text-dim)" }}
          >
            <div className="flex justify-between px-2.5 py-1.5 text-[10px] tracking-[0.14em] text-[var(--dh-text-strong)]">
              OFFICE — PLAN 02
            </div>
            <div className="flex justify-between border-t px-2.5 py-1" style={{ borderColor: DRAFT_FAINT }}>
              <span>AGENTS</span>
              <span className="text-[var(--dh-text)]">{world.agents.length} · {activeAgents} ACTIVE</span>
            </div>
            <div className="flex justify-between border-t px-2.5 py-1" style={{ borderColor: DRAFT_FAINT }}>
              <span>ROOMS</span>
              <span className="text-[var(--dh-text)]">{rooms.length} · {activeRooms} ONLINE</span>
            </div>
            <div className="flex justify-between border-t px-2.5 py-1" style={{ borderColor: DRAFT_FAINT }}>
              <span>FEED</span>
              <span className="text-[var(--dh-text)]">{(source ?? "mock").toUpperCase()} · REV {world.rev}</span>
            </div>
          </div>

          {/* Legend. */}
          <div className="dh-mono-ui absolute bottom-2 left-2 z-10 flex items-center gap-4 text-[9px] text-[var(--dh-text-dim)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px] bg-[var(--dh-coral)]" /> ACTIVE
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px] bg-[var(--dh-warning)]" /> BLOCKED
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: DRAFT_DIM }} /> RESERVED
            </span>
            <span>1 DESK = 1 AGENT</span>
          </div>
        </div>
      </div>

      {selected ? <DeskInspector agent={selected} nowMs={nowMs} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
