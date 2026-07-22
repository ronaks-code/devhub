import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
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
 * Working desks glow indigo (pulse ring) and carry the full drafting callout
 * (agent · provider/model, status · runtime · cost · tokens, assignment,
 * worktree · diff, last action) as annotation text beside the desk with a dashed
 * leader line. Idle/reserved desks are small labeled rects. Clicking any desk
 * opens the inspector with the complete field list.
 */

const DRAFT = "#8d7fc0";
const DRAFT_DIM = "rgba(141, 127, 192, 0.34)";
const DRAFT_FAINT = "rgba(141, 127, 192, 0.12)";
// Active treatment = the Nebula indigo brand accent (#818cf8 → rgb 129 140 248),
// matching --dh-brand / statusMeta. Coral is reserved for the Claude provider mark.
const ACTIVE_FILL = "rgba(129, 140, 248, 0.06)";
const ACTIVE_FILL_STRONG = "rgba(129, 140, 248, 0.22)";
const ACTIVE_STROKE = "rgba(129, 140, 248, 0.6)";
const ACTIVE_STROKE_STRONG = "rgba(129, 140, 248, 0.78)";

// ── Plan geometry (viewBox units) ───────────────────────────────────────────
const COLS = 3; // rooms per building row
const ROOM_W = 380;
const PAD = 16; // room inner padding
const HEADER_H = 50; // room label block
const LINE_H = 15; // annotation line height (kept ahead of the m10 font-size bump below)
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
      return { glyph: "●", color: "var(--dh-brand)", label: "ACTIVE" };
    case "talking":
      return { glyph: "◇", color: "var(--dh-brand)", label: "TALKING" };
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

/** The working-desk callout: only lines whose real field exists are emitted.
 *  Sizes are viewBox units, not screen px — at the default "fit whole plan"
 *  zoom these get scaled down with everything else, so the floor here is
 *  raised (was 9.5–11) and the clip widths pulled in to match, so the
 *  now-wider glyphs still fit inside ROOM_W without spilling into the next
 *  room. */
function calloutLines(a: Agent, nowMs: number): PlanLine[] {
  const meta = statusMeta(a.status);
  const lines: PlanLine[] = [
    { text: clip(a.name.toUpperCase(), 26), fill: "var(--dh-text-strong)", size: 13, weight: 700 },
  ];
  const provider = a.provider === "anthropic" ? "CLD" : a.provider === "openai" ? "CDX" : null;
  const idLine = [provider, a.model].filter(Boolean).join(" · ");
  if (idLine) lines.push({ text: clip(idLine, 38), fill: "var(--dh-text-muted)", size: 11 });
  const rt = runtime(a.startedAt, nowMs);
  const stat = [`${meta.glyph} ${meta.label}`];
  if (rt) stat.push(rt);
  if (a.costUsd != null) stat.push(`$${a.costUsd.toFixed(2)}`);
  if (a.tokens != null) stat.push(`${a.tokens.toLocaleString()} tk`);
  lines.push({ text: clip(stat.join(" · "), 38), fill: meta.color, size: 11, weight: 600 });
  if (a.assignment) lines.push({ text: clip(a.assignment, 38), fill: "var(--dh-text)", size: 11.5 });
  if (a.worktree)
    lines.push({
      text: clip(`⎇ ${a.worktree}${a.diff ? ` · +${a.diff.add} −${a.diff.del}` : ""}`, 38),
      fill: "var(--dh-link)",
      size: 11,
    });
  if (a.lastAction) lines.push({ text: clip(a.lastAction, 38), fill: "var(--dh-text-muted)", size: 11 });
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
          fill: active ? ACTIVE_FILL : DRAFT_FAINT,
          stroke: active ? ACTIVE_STROKE : DRAFT_DIM,
          strokeWidth: active ? 1.4 : 1,
        }}
      />
      {/* Label block. */}
      <text x={PAD} y={24} fontSize={12} fontWeight={700} letterSpacing={3} style={{ fill: active ? "var(--dh-brand)" : "var(--dh-text)" }}>
        {clip(label, 30)}
      </text>
      <text x={PAD} y={38} fontSize={8.5} letterSpacing={1.5} style={{ fill: "var(--dh-text-muted)" }}>
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
              style={{ fill: ACTIVE_FILL_STRONG, stroke: ACTIVE_STROKE_STRONG, strokeWidth: 1 }}
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
              <text x={IDLE_BAY_W / 2} y={52} fontSize={9} textAnchor="middle" style={{ fill: "var(--dh-text-muted)" }}>
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

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const MAX_ZOOM = 4;

export function BlueprintOffice({
  world,
  source,
}: {
  world: WorldState;
  /** Feed source, surfaced honestly in the corner stamp ("Demo data" vs "Live"). */
  source?: "mock" | "live";
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Pan/zoom viewport. `zoom === 1` + `center === null` means "fit the whole
  // plan" — the default. It auto-follows plan-size changes so the ENTIRE floor
  // plan (every room, the legend, the title block) is always visible at any pane
  // size; zoom + drag then let you read the fine drafting callouts.
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState<{ cx: number; cy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ startX: number; startY: number; cx: number; cy: number; scale: number } | null>(null);

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

  // The visible viewBox, derived from zoom + center and clamped to the plan.
  const view: Rect = useMemo(() => {
    const w = plan.width / zoom;
    const h = plan.height / zoom;
    const cx = center?.cx ?? plan.width / 2;
    const cy = center?.cy ?? plan.height / 2;
    const x = clampN(cx - w / 2, 0, Math.max(0, plan.width - w));
    const y = clampN(cy - h / 2, 0, Math.max(0, plan.height - h));
    return { x, y, w, h };
  }, [plan.width, plan.height, zoom, center]);

  const resetView = useCallback(() => {
    setZoom(1);
    setCenter(null);
  }, []);

  /** Zoom to `nextZoom`, keeping the plan-space `anchor` fixed on screen. */
  const zoomTo = useCallback(
    (nextZoom: number, anchor?: { x: number; y: number }) => {
      const z = clampN(nextZoom, 1, MAX_ZOOM);
      if (z === 1) {
        setZoom(1);
        setCenter(null);
        return;
      }
      const w = plan.width / z;
      const h = plan.height / z;
      const ax = anchor?.x ?? view.x + view.w / 2;
      const ay = anchor?.y ?? view.y + view.h / 2;
      // Keep the anchor at the same fractional position in the view rect. Because
      // the view rect always carries the plan aspect and preserveAspectRatio is
      // constant, equal fraction ⇒ equal screen position, so the point stays put.
      const fx = view.w > 0 ? (ax - view.x) / view.w : 0.5;
      const fy = view.h > 0 ? (ay - view.y) / view.h : 0.5;
      setZoom(z);
      setCenter({ cx: ax - fx * w + w / 2, cy: ay - fy * h + h / 2 });
    },
    [plan.width, plan.height, view],
  );

  /** Map client (screen) coords to plan (viewBox) coords via the live SVG CTM. */
  const clientToPlan = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg || typeof svg.getScreenCTM !== "function") return null;
    const ctm = svg.getScreenCTM();
    if (!ctm || typeof DOMPoint === "undefined") return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  // Wheel-zoom toward the cursor. A native non-passive listener lets us swallow
  // the scroll (so the page doesn't move) while zooming the plan instead.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const anchor = clientToPlan(e.clientX, e.clientY) ?? undefined;
      zoomTo(zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), anchor);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [clientToPlan, zoomTo, zoom]);

  // Drag-to-pan on the plan BACKGROUND (a click on a desk still selects it).
  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom === 1) return; // whole plan is visible — nothing to pan
    if ((e.target as Element).closest?.('[data-testid="office-desk"]')) return;
    const svg = svgRef.current;
    const scale = svg && typeof svg.getScreenCTM === "function" ? svg.getScreenCTM()?.a ?? 0 : 0;
    if (!scale) return;
    drag.current = { startX: e.clientX, startY: e.clientY, cx: view.x + view.w / 2, cy: view.y + view.h / 2, scale };
    svg?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setCenter({ cx: d.cx - (e.clientX - d.startX) / d.scale, cy: d.cy - (e.clientY - d.startY) / d.scale });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      svgRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
  };

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
    <div className="dh-aurora-bg--soft relative flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="blueprint-office">
      {/* Header row (always visible). */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-6 pb-2 pt-4">
        <h1 className="text-[17px] font-[680] tracking-[-0.01em] text-[var(--dh-text-strong)]">Office</h1>
        <span className="dh-mono-ui text-[var(--dh-text-muted)]">
          {rooms.length} rooms · {world.agents.length} agents · {activeAgents} active
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-[var(--dh-control)] px-2 py-0.5 text-[12px] text-[var(--dh-text-muted)]"
          title={source === "live" ? "Live fleet feed" : "Sample data for preview"}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: source === "live" ? "var(--dh-success)" : "var(--dh-text-dim)" }}
          />
          {source === "live" ? "Live" : "Demo data"}
        </span>
      </div>

      {/* The drafting sheet — a fit-to-container, scroll-free viewport. The whole
          plan always fits; zoom controls / wheel / drag reveal the fine detail. */}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden px-4 pb-4">
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          className={cn("dh-blueprint block h-full w-full select-none", zoom > 1 ? "cursor-grab" : undefined)}
          style={{ touchAction: "none" }}
          role="img"
          aria-label="Office floor plan — rooms are departments, desks are agents"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={endDrag}
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

        {/* Zoom / fit controls (always visible). */}
        <div className="glass-card absolute right-3 top-3 z-10 flex flex-col overflow-hidden p-1" role="group" aria-label="Plan zoom">
          {(
            [
              { icon: ZoomIn, label: "Zoom in", onClick: () => zoomTo(zoom * 1.4), disabled: zoom >= MAX_ZOOM },
              { icon: ZoomOut, label: "Zoom out", onClick: () => zoomTo(zoom / 1.4), disabled: zoom <= 1 },
              { icon: Maximize, label: "Fit whole plan", onClick: resetView, disabled: zoom === 1 && center === null },
            ] as const
          ).map(({ icon: Icon, label, onClick, disabled }) => (
            <button
              key={label}
              type="button"
              onClick={onClick}
              disabled={disabled}
              aria-label={label}
              title={label}
              className="rounded-[7px] p-1.5 text-[var(--dh-text-muted)] transition hover:bg-[var(--dh-hover)] hover:text-[var(--dh-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dh-focus)] disabled:pointer-events-none disabled:opacity-35"
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>

        {/* Corner title block (drafting stamp) — real counts only. */}
        <div
          className="dh-mono-ui absolute bottom-3 right-3 z-10 w-[212px] border text-[9px]"
          style={{
            borderColor: "var(--dh-glass-border)",
            background: "var(--dh-glass-chrome-bg)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            color: "var(--dh-text-muted)",
          }}
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
            <span>SOURCE</span>
            <span className="text-[var(--dh-text)]">{source === "live" ? "LIVE" : "DEMO DATA"}</span>
          </div>
        </div>

        {/* Legend. */}
        <div className="dh-mono-ui absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] text-[var(--dh-text-dim)]">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px] bg-[var(--dh-brand)]" /> ACTIVE
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

      {selected ? <DeskInspector agent={selected} nowMs={nowMs} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
