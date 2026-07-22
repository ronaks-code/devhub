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
      return { glyph: "●", color: "var(--bp-active)", label: "ACTIVE" };
    case "talking":
      return { glyph: "◇", color: "var(--bp-active)", label: "TALKING" };
    case "moving":
      return { glyph: "→", color: "var(--bp-warning)", label: "MOVING" };
    case "blocked":
      return { glyph: "⏸", color: "var(--bp-warning)", label: "BLOCKED" };
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
  // --dh-text (not -muted) for these micro annotation lines: at the fit-to-plan
  // zoom they shrink to ~6-7px, where muted-on-pale-room reads as faint/illegible
  // in light theme (QA). Legibility beats hierarchy at this size.
  if (idLine) lines.push({ text: clip(idLine, 38), fill: "var(--dh-text)", size: 11 });
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
  if (a.lastAction) lines.push({ text: clip(a.lastAction, 38), fill: "var(--dh-text)", size: 11 });
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
  focused,
  focusAgentId,
  onSelect,
}: {
  layout: RoomLayout;
  totalRows: number;
  selectedId: string | null;
  /** Keyboard focus (h/l): draws a dashed focus outline around the room. */
  focused: boolean;
  /** Keyboard-focused desk (j/k): gets the selection dash like a click. */
  focusAgentId: string | null;
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
      {/* Keyboard room focus (h/l) — a visible dashed outline. */}
      {focused ? (
        <rect
          x={2}
          y={2}
          width={w - 4}
          height={h - 4}
          style={{ fill: "none", stroke: "var(--dh-focus)", strokeWidth: 1.4, strokeDasharray: "7 5" }}
        />
      ) : null}
      {/* Label block. */}
      <text x={PAD} y={24} fontSize={12} fontWeight={700} letterSpacing={3} style={{ fill: active ? "var(--bp-active)" : "var(--dh-text)" }}>
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
            selected={selectedId === bay.agent.id || focusAgentId === bay.agent.id}
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
              selected={selectedId === bay.agent.id || focusAgentId === bay.agent.id}
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

const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const MAX_ZOOM = 4;
/** Legibility floor (screen px per plan unit): SVG text scales with the drawing,
 *  so fitting a wide plan into a narrow pane would shrink 13px names to ~6-8px.
 *  The fit-to-width base scale never drops below this — instead of shrinking the
 *  drafting text into illegibility, the sheet grows past the pane and the stage
 *  SCROLLS (vertically, and horizontally at the floor) so every room stays
 *  reachable rather than cropped off-canvas. */
const MIN_TEXT_SCALE = 0.8;

/** Component-scoped color vars: the active/warning status inks the drafting
 *  callouts use. Dark inherits the brand tokens; light overrides to darker
 *  inks because 13px→~10px SVG status text in --dh-brand (#6366f1, 4.0:1) and
 *  --dh-warning (#b07617, 3.5:1) sits under WCAG AA 4.5:1 on the near-white
 *  board. #4f46e5 ≈ 5.7:1 and #92580a ≈ 5.2:1 against the light canvas. */
const BP_THEME_CSS = `
.dh-bp-root { --bp-active: var(--dh-brand); --bp-warning: var(--dh-warning); }
:root[data-theme="light"] .dh-bp-root { --bp-active: #4f46e5; --bp-warning: #92580a; }
`;

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
  // Zoom multiplier over the fit-to-WIDTH base scale. `zoom === 1` is the default
  // "fit the plan to the pane width" view; the drafting sheet then SCROLLS
  // vertically (and horizontally when zoomed, or when the legibility floor makes
  // the sheet wider than the pane) so EVERY room is reachable regardless of floor
  // count — nothing is cropped permanently off-canvas. Zoom in/out + the keyboard
  // `z` reveal the fine callouts.
  const [zoom, setZoom] = useState(1);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const effScaleRef = useRef<number | null>(null);
  const drag = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Track the stage's content box so the fit-to-width scale + legibility floor
  // can be computed in real screen pixels. Guarded for jsdom/SSR (no observer ⇒
  // stageSize stays null ⇒ the SVG renders the whole plan responsively).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setStageSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(world.agents.map((a) => [a.id, a])), [world.agents]);

  // Departments first (stable order), then any spawned project rooms.
  const rooms = useMemo(() => {
    const depts = world.rooms.filter((r) => r.kind === "department");
    const projects = world.rooms.filter((r) => r.kind === "project");
    return [...depts, ...projects];
  }, [world.rooms]);

  const plan = useMemo(() => layoutPlan(rooms, byId, nowMs), [rooms, byId, nowMs]);

  // Base scale (screen px per plan unit): fit the plan to the pane WIDTH, but
  // never below the legibility floor. SVG text scales with the drawing, so on a
  // narrow pane fitting to width alone would shrink 13px names into illegibility;
  // there we hold the floor and let the sheet run wider than the pane (it scrolls
  // horizontally too). Null in jsdom/SSR ⇒ the SVG renders the whole plan
  // responsively (every room visible), preserving the pre-scroll behavior.
  const baseScale = useMemo(() => {
    if (!stageSize || stageSize.w <= 0) return null;
    return Math.max(stageSize.w / plan.width, MIN_TEXT_SCALE);
  }, [stageSize, plan.width]);

  // Effective scale + rendered sheet size (px). The viewBox stays the FULL plan,
  // so the sheet is never cropped — it grows to its natural size and the stage
  // scrolls to whatever doesn't fit.
  const effScale = baseScale == null ? null : baseScale * zoom;
  const sheetW = effScale == null ? null : plan.width * effScale;
  const sheetH = effScale == null ? null : plan.height * effScale;
  const canScroll =
    !!stageSize &&
    sheetW != null &&
    sheetH != null &&
    (sheetH > stageSize.h + 1 || sheetW > stageSize.w + 1);

  useEffect(() => {
    effScaleRef.current = effScale;
  }, [effScale]);

  const resetView = useCallback(() => {
    setZoom(1);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, []);

  const zoomTo = useCallback((nextZoom: number) => {
    setZoom(clampN(nextZoom, 1, MAX_ZOOM));
  }, []);

  // Ctrl/⌘ + wheel zooms the plan; a plain wheel / trackpad scrolls the sheet
  // natively (the whole point — vertical reach without hidden gestures). Only the
  // zoom case swallows the event so the page doesn't move.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // let the browser scroll the sheet
      e.preventDefault();
      zoomTo(zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo, zoom]);

  // Mouse drag-to-pan translates into native scroll (a click on a desk still
  // selects it; touch keeps its native momentum scroll, so we ignore it here).
  const onPointerDown = (e: React.PointerEvent) => {
    if (!canScroll || e.pointerType !== "mouse") return;
    if ((e.target as Element).closest?.('[data-testid="office-desk"]')) return;
    const el = scrollRef.current;
    if (!el) return;
    drag.current = { startX: e.clientX, startY: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d || !el) return;
    el.scrollLeft = d.left - (e.clientX - d.startX);
    el.scrollTop = d.top - (e.clientY - d.startY);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      scrollRef.current?.releasePointerCapture?.(e.pointerId);
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

  // Keyboard nav (§3.5): h/l cycle rooms, j/k cycle desks in the focused room,
  // ⏎ opens the inspector, z zooms to the focused room. The focus is VISIBLE:
  // the focused room gets a dashed outline, the focused desk the selection dash.
  // Focus is keyed to stable room/agent IDS, not array indices: the demo world
  // reshuffles every few seconds, so an index-keyed focus would silently jump to
  // whatever room/agent later lands in that slot (focus changing identity behind
  // the user's back). Tracking ids keeps focus on the SAME room/desk across
  // reshuffles, and cleanly clears if the focused target disappears.
  const [kb, setKb] = useState<{ roomId: string; agentId: string | null } | null>(null);
  const kbRoom = kb ? plan.rooms.find((r) => r.room.id === kb.roomId) ?? null : null;
  const kbAgent = kbRoom && kb?.agentId ? kbRoom.agents.find((a) => a.id === kb.agentId) ?? null : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const nRooms = plan.rooms.length;
      if (!nRooms) return;
      if (e.key === "h" || e.key === "l") {
        e.preventDefault();
        const dir = e.key === "l" ? 1 : -1;
        setKb((f) => {
          const cur = f ? plan.rooms.findIndex((r) => r.room.id === f.roomId) : -1;
          const nextIdx = cur < 0 ? (dir === 1 ? 0 : nRooms - 1) : (cur + dir + nRooms) % nRooms;
          return { roomId: plan.rooms[nextIdx]!.room.id, agentId: null };
        });
      } else if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const dir = e.key === "j" ? 1 : -1;
        setKb((f) => {
          const roomIdx = f ? Math.max(plan.rooms.findIndex((r) => r.room.id === f.roomId), 0) : 0;
          const room = plan.rooms[roomIdx]!;
          const agents = room.agents;
          if (!agents.length) return { roomId: room.room.id, agentId: null };
          const cur = f?.agentId ? agents.findIndex((a) => a.id === f.agentId) : -1;
          const nextIdx = cur < 0 ? (dir === 1 ? 0 : agents.length - 1) : (cur + dir + agents.length) % agents.length;
          return { roomId: room.room.id, agentId: agents[nextIdx]!.id };
        });
      } else if (e.key === "Enter") {
        // A DOM-focused desk glyph already handles its own Enter.
        if (kbAgent && !t?.closest?.('[data-testid="office-desk"]')) {
          e.preventDefault();
          setSelectedId(kbAgent.id);
        }
      } else if (e.key === "z") {
        e.preventDefault();
        const room = kbRoom ?? plan.rooms[0];
        if (!room) return;
        // Focus the room (a NEW kb identity so the scroll-into-view effect fires)
        // and zoom so it fills the pane with a margin; the effect scrolls to it.
        setKb({ roomId: room.room.id, agentId: kbRoom ? kbAgent?.id ?? null : null });
        if (baseScale != null && stageSize) {
          const m = 28; // plan-unit margin around the zoomed room
          const zEff = Math.min(
            stageSize.w / ((room.w + m * 2) * baseScale),
            stageSize.h / ((room.h + m * 2) * baseScale),
          );
          setZoom(clampN(zEff, 1, MAX_ZOOM));
        }
      } else if (e.key === "Escape" && !selected) {
        setKb(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plan, kbRoom, kbAgent, baseScale, stageSize, selected]);

  // Keep the keyboard-focused room in view as the sheet scrolls (h/l/j/k/z). Keyed
  // on `kb` (nav) only — not the per-tick `plan` — so it never fights the user's
  // own scrolling; the latest plan/scale are read from refs.
  const planRef = useRef(plan);
  planRef.current = plan;
  useEffect(() => {
    const el = scrollRef.current;
    const scale = effScaleRef.current;
    if (!el || scale == null || !kb) return;
    const room = planRef.current.rooms.find((r) => r.room.id === kb.roomId);
    if (!room) return;
    const cx = (room.x + room.w / 2) * scale;
    const cy = (room.y + room.h / 2) * scale;
    el.scrollTo({
      left: clampN(cx - el.clientWidth / 2, 0, Math.max(0, el.scrollWidth - el.clientWidth)),
      top: clampN(cy - el.clientHeight / 2, 0, Math.max(0, el.scrollHeight - el.clientHeight)),
      behavior: "smooth",
    });
  }, [kb]);

  const activeAgents = world.agents.filter(isWorking).length;
  const colLetters = "ABCDEFGH";

  // Title-block facts (§3.5 corner stamp) — real data only, dash when unknown.
  const worktrees = useMemo(() => {
    const dirtyByTree = new Map<string, boolean>();
    for (const a of world.agents) {
      if (!a.worktree) continue;
      const dirty = !!(a.diff && (a.diff.add > 0 || a.diff.del > 0));
      dirtyByTree.set(a.worktree, (dirtyByTree.get(a.worktree) ?? false) || dirty);
    }
    return { n: dirtyByTree.size, dirty: [...dirtyByTree.values()].filter(Boolean).length };
  }, [world.agents]);
  const projectRooms = rooms.filter((r) => r.kind === "project");
  const projectLine =
    projectRooms.length > 1 ? `${projectRooms.length} ACTIVE` : projectRooms[0] ? clip(projectRooms[0].label.toUpperCase(), 20) : "—";
  const revDate = world.ts ? new Date(world.ts).toISOString().slice(0, 10) : "—";

  return (
    <div className="dh-bp-root dh-aurora-bg--soft relative flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="blueprint-office">
      <style>{BP_THEME_CSS}</style>
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

      {/* The drafting sheet — fit-to-WIDTH inside a vertically (and, at the
          legibility floor, horizontally) SCROLLING viewport, so no room is ever
          cropped off-canvas no matter how many floors the office grows. The
          overlays (zoom controls / stamp / legend) sit on the non-scrolling
          stage so they stay pinned while the sheet scrolls under them. */}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden px-4 pb-4">
        <div
          ref={scrollRef}
          className={cn("h-full w-full overflow-auto", canScroll ? "cursor-grab" : undefined)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={endDrag}
        >
          <svg
            viewBox={`0 0 ${plan.width} ${plan.height}`}
            preserveAspectRatio="xMidYMid meet"
            className="dh-blueprint block select-none"
            style={sheetW != null && sheetH != null ? { width: sheetW, height: sheetH } : { width: "100%", height: "auto" }}
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
                focused={kbRoom?.room.id === layout.room.id}
                focusAgentId={kbAgent?.id ?? null}
                onSelect={setSelectedId}
              />
            ))}
          </svg>
        </div>

        {/* Zoom / fit controls (always visible). */}
        <div className="glass-card absolute right-3 top-3 z-10 flex flex-col overflow-hidden p-1" role="group" aria-label="Plan zoom">
          {(
            [
              { icon: ZoomIn, label: "Zoom in", onClick: () => zoomTo(zoom * 1.4), disabled: zoom >= MAX_ZOOM },
              { icon: ZoomOut, label: "Zoom out", onClick: () => zoomTo(zoom / 1.4), disabled: zoom <= 1 },
              { icon: Maximize, label: zoom > 1 ? "Reset view" : "Fit to width", onClick: resetView, disabled: zoom === 1 },
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
            <span>PROJECT</span>
            <span className="text-[var(--dh-text)]">{projectLine}</span>
          </div>
          <div className="flex justify-between border-t px-2.5 py-1" style={{ borderColor: DRAFT_FAINT }}>
            <span>AGENTS</span>
            <span className="text-[var(--dh-text)]">{world.agents.length} · {activeAgents} ACTIVE</span>
          </div>
          <div className="flex justify-between border-t px-2.5 py-1" style={{ borderColor: DRAFT_FAINT }}>
            <span>WORKTREES</span>
            <span className="text-[var(--dh-text)]">{worktrees.n > 0 ? `${worktrees.n} · ${worktrees.dirty} DIRTY` : "—"}</span>
          </div>
          <div className="flex justify-between border-t px-2.5 py-1" style={{ borderColor: DRAFT_FAINT }}>
            <span>REV</span>
            <span className="text-[var(--dh-text)]">{world.rev} · {revDate}</span>
          </div>
          <div className="flex justify-between border-t px-2.5 py-1" style={{ borderColor: DRAFT_FAINT }}>
            <span>SOURCE</span>
            <span className="text-[var(--dh-text)]">{source === "live" ? "LIVE" : "DEMO DATA"}</span>
          </div>
        </div>

        {/* Legend. Sits over the drafting sheet, so it carries the same
            translucent glass backing as the corner stamp — otherwise, when the
            legibility floor crops the sheet, its bare text collides illegibly
            with the desk callouts underneath. The max-width keeps it from
            running under the bottom-right stamp on a narrow pane. */}
        <div
          className="dh-mono-ui absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-15.5rem)] flex-wrap items-center gap-x-4 gap-y-1 rounded-[6px] border px-2.5 py-1.5 text-[9px] text-[var(--dh-text-dim)]"
          style={{
            borderColor: "var(--dh-glass-border)",
            background: "var(--dh-glass-chrome-bg)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
          }}
        >
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
          <span>H/L ROOMS · J/K DESKS · ⏎ INSPECT · Z ZOOM</span>
        </div>
      </div>

      {selected ? <DeskInspector agent={selected} nowMs={nowMs} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
