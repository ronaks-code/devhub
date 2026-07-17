/**
 * Isometric math + world layout. Pure functions — no Pixi here — so the layout
 * is unit-testable and the renderer just consumes coordinates.
 *
 * Mental model: we work in a flat "grid" space (col, row) like a chessboard,
 * then PROJECT it to screen with the classic 2:1 isometric transform so it looks
 * like a 3/4 view office. Everything spatial (rooms, desks, moving agents) is
 * placed in grid space; `toScreen` is the only thing that knows about the tilt.
 *
 * Two room TYPES are laid out in separate horizontal BANDS so the type reads at
 * a glance even before you notice the color/style: department rooms (persistent
 * home bases) sit in the top band, project rooms (ephemeral cross-dept teams) in
 * a band below, with a clear gap between them.
 */

import { DEPARTMENTS, type Agent, type Edge, type Room, type WorldState } from "../contract";

/** Half-width / half-height of one iso tile in screen px (2:1 diamond). */
export const TILE_W = 64;
export const TILE_H = 32;

export interface GridPoint {
  col: number;
  row: number;
}
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Grid (col,row) → screen (x,y). The signature 2:1 isometric projection. */
export function toScreen(col: number, row: number): ScreenPoint {
  return {
    x: (col - row) * (TILE_W / 2),
    y: (col + row) * (TILE_H / 2),
  };
}

/** A room's placed footprint in grid space plus its derived desk slots. */
export interface RoomLayout {
  room: Room;
  /** Top-left grid origin of the room's rectangle. */
  origin: GridPoint;
  /** Room size in tiles. */
  cols: number;
  rows: number;
  /** Grid center (for camera focus + edge endpoints). */
  center: GridPoint;
  /** One desk slot per member id, in grid space. */
  desks: Map<string, GridPoint>;
}

export interface WorldLayout {
  rooms: Map<string, RoomLayout>;
  /** Agent id → its CURRENT desk grid point (from whichever room it's in now). */
  deskOf: Map<string, GridPoint>;
  /** Agent id → its desk column within its room (for staggering nameplates). */
  deskCol: Map<string, number>;
  /** Overall grid bounds, for initial camera fit. */
  bounds: { minCol: number; maxCol: number; minRow: number; maxRow: number };
}

export interface ScreenBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * TRUE screen-space axis-aligned bounding box of everything drawn in the office.
 *
 * Why this exists (camera-fit bug): grid `bounds` are min/max col+row taken
 * INDEPENDENTLY, so `toScreen(minCol, minRow)` invents a corner no room actually
 * occupies — a phantom point above the real content. Fitting to it left dead
 * space at the top. Instead we project the four real corners of every room and
 * take the actual min/max of x and y. `headroom` reserves screen px above the
 * topmost room for its floating banner (which sits ~2 grid-rows up); `pad` is a
 * uniform breathing margin.
 */
export function screenBounds(
  layout: WorldLayout,
  opts: { headroom?: number; pad?: number } = {},
): ScreenBounds {
  const headroom = opts.headroom ?? 0;
  const pad = opts.pad ?? 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const rl of layout.rooms.values()) {
    const corners = [
      toScreen(rl.origin.col, rl.origin.row),
      toScreen(rl.origin.col + rl.cols, rl.origin.row),
      toScreen(rl.origin.col, rl.origin.row + rl.rows),
      toScreen(rl.origin.col + rl.cols, rl.origin.row + rl.rows),
    ];
    for (const c of corners) {
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y);
      maxY = Math.max(maxY, c.y);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - headroom - pad, maxY: maxY + pad };
}

const ROOM_GAP = 2; // empty tiles between rooms within a band
const BAND_GAP_ROWS = 1; // blank screen-rows between the dept band and project band
const DESK_COLS = 3; // desks per row inside a room
// Desks sit every DESK_STRIDE tiles so characters (and their nameplates) don't
// pile onto each other in iso space — adjacent tiles are only TILE_W/2 apart,
// far narrower than a nameplate. Stride 3 gives ~96px of horizontal breathing
// room; the renderer additionally staggers adjacent plates vertically.
const DESK_STRIDE = 3;

const ROOMS_PER_SCREEN_ROW = 4; // rooms per band-row before wrapping

/** Stable department ordering (matches DEPARTMENTS) so home rooms never shuffle. */
const DEPT_ORDER = new Map<string, number>(DEPARTMENTS.map((d, i) => [d, i]));

/** Size a room's floor from its member count (bigger crew ⇒ bigger room). */
function roomSize(memberCount: number): { cols: number; rows: number } {
  const deskRows = Math.ceil(Math.max(memberCount, 1) / DESK_COLS);
  // Footprint spans the strided desk grid plus a 1-tile wall/walkway border.
  return { cols: DESK_COLS * DESK_STRIDE + 1, rows: deskRows * DESK_STRIDE + 1 };
}

/**
 * Place rooms on a regular SCREEN-space grid (not a raw grid-space band). Raw
 * grid banding overlaps under the iso projection because +col and +row both push
 * down-and-sideways; instead we pin each room's top vertex to a screen cell whose
 * spacing exceeds the largest room's diamond footprint, so rooms can never
 * overlap no matter how many spawn. Origins are back-projected from those screen
 * points via the inverse iso transform.
 *
 * Rooms are split into two BANDS: department rooms first (ordered by DEPARTMENTS,
 * then id), then project rooms (by id) on fresh screen-rows below a gap. Stable
 * ordering keeps a room in the same spot across ticks, so agents don't teleport
 * when unrelated rooms spawn/despawn.
 */
export function computeLayout(world: WorldState): WorldLayout {
  const deptRooms = world.rooms
    .filter((r) => r.kind === "department")
    .sort((a, b) => (DEPT_ORDER.get(a.dept) ?? 99) - (DEPT_ORDER.get(b.dept) ?? 99) || a.id.localeCompare(b.id));
  const projRooms = world.rooms
    .filter((r) => r.kind !== "department")
    .sort((a, b) => a.id.localeCompare(b.id));

  const roomLayouts = new Map<string, RoomLayout>();
  const deskOf = new Map<string, GridPoint>();
  const deskCol = new Map<string, number>();

  // Largest room's footprint drives a uniform, overlap-proof cell size.
  let maxCols = 1;
  let maxRows = 1;
  for (const room of world.rooms) {
    const { cols, rows } = roomSize(room.members.length);
    maxCols = Math.max(maxCols, cols);
    maxRows = Math.max(maxRows, rows);
  }
  // A diamond of size (cols+rows) is (cols+rows)*TILE_W/2 wide and *TILE_H/2 tall
  // in screen px; add ROOM_GAP tiles of walkway so neighbors clearly separate.
  const span = maxCols + maxRows + ROOM_GAP;
  const cellW = span * (TILE_W / 2);
  const cellH = span * (TILE_H / 2);

  const deptBandRows = Math.max(1, Math.ceil(deptRooms.length / ROOMS_PER_SCREEN_ROW));
  const projBandStart = deptRooms.length ? deptBandRows + BAND_GAP_ROWS : 0;

  let minCol = 0;
  let maxCol = 0;
  let minRow = 0;
  let maxRow = 0;

  const place = (room: Room, gx: number, gy: number): void => {
    const { cols, rows: rowsSize } = roomSize(room.members.length);
    const sx = gx * cellW;
    const sy = gy * cellH;
    // Inverse of toScreen: col-row = x/(TILE_W/2), col+row = y/(TILE_H/2).
    const a = sx / (TILE_W / 2);
    const b = sy / (TILE_H / 2);
    const origin: GridPoint = { col: (a + b) / 2, row: (b - a) / 2 };
    const center: GridPoint = { col: origin.col + cols / 2, row: origin.row + rowsSize / 2 };

    const desks = new Map<string, GridPoint>();
    room.members.forEach((memberId, idx) => {
      const dc = idx % DESK_COLS;
      const dr = Math.floor(idx / DESK_COLS);
      const p: GridPoint = {
        col: origin.col + 1 + dc * DESK_STRIDE,
        row: origin.row + 1 + dr * DESK_STRIDE,
      };
      desks.set(memberId, p);
      deskOf.set(memberId, p);
      deskCol.set(memberId, dc);
    });

    roomLayouts.set(room.id, { room, origin, cols, rows: rowsSize, center, desks });

    minCol = Math.min(minCol, origin.col);
    minRow = Math.min(minRow, origin.row);
    maxCol = Math.max(maxCol, origin.col + cols);
    maxRow = Math.max(maxRow, origin.row + rowsSize);
  };

  deptRooms.forEach((room, i) => {
    place(room, i % ROOMS_PER_SCREEN_ROW, Math.floor(i / ROOMS_PER_SCREEN_ROW));
  });
  projRooms.forEach((room, i) => {
    place(room, i % ROOMS_PER_SCREEN_ROW, projBandStart + Math.floor(i / ROOMS_PER_SCREEN_ROW));
  });

  return { rooms: roomLayouts, deskOf, deskCol, bounds: { minCol, maxCol, minRow, maxRow } };
}

/**
 * Where an agent should be drawn RIGHT NOW in grid space. A desk-bound agent is
 * at its current desk. A "moving" leader is interpolated along its active edge
 * toward the target's desk by `phase` (0..1), so it visibly walks toward whoever
 * it's talking to. (Bigger dept→project moves are handled by the scene lerping
 * toward the new desk when room membership changes.)
 */
export function agentGridPosition(
  agent: Agent,
  layout: WorldLayout,
  world: WorldState,
  phase: number,
): GridPoint {
  const home = layout.deskOf.get(agent.id);
  if (!home) return { col: 0, row: 0 };
  if (agent.status !== "moving") return home;

  const activeEdge = world.edges.find((e) => e.from === agent.id && e.active);
  if (!activeEdge) return home;
  const target = layout.deskOf.get(activeEdge.to);
  if (!target) return home;

  // Ease in/out so the leader glides rather than sliding linearly.
  const t = easeInOut(phase);
  return {
    col: home.col + (target.col - home.col) * t,
    row: home.row + (target.row - home.row) * t,
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * The relationship lines to draw for a focused agent: ALL edges touching `id`
 * (in either direction) whose both endpoints have a known desk — standing
 * structure (who reports to whom / peers) AND currently-active talk. The renderer
 * styles active edges bright+pulsing and inactive ones dim+static, so hovering
 * any agent reveals its place in the org even when it isn't talking right now.
 * Returning only the focused agent's edges (vs the whole graph) keeps the default
 * scene clean and the per-hover draw cheap. `id === null` ⇒ none (clean scene).
 */
export function edgesForAgent(
  edges: Edge[],
  id: string | null,
  deskOf: Map<string, GridPoint>,
): Edge[] {
  if (!id) return [];
  return edges.filter(
    (e) => (e.from === id || e.to === id) && deskOf.has(e.from) && deskOf.has(e.to),
  );
}

/** A stable accent color per department, for home rooms/characters. */
export function deptColor(dept: string): number {
  const palette: Record<string, number> = {
    athena: 0xfcd34d, // gold — company desk / orchestrator
    vulcan: 0xff6b3d, // clay/orange — engineering
    apollo: 0xf472b6, // pink — marketing
    thoth: 0xa78bfa, // violet — research
    talos: 0x34d399, // green — lab ops
    vesta: 0x38bdf8, // sky — ops & finance
    argus: 0xf87171, // red — fleet health
    hermes: 0x818cf8, // indigo — outbound
  };
  return palette[dept] ?? 0x9ca3af;
}

/**
 * The single accent for ALL project rooms — deliberately one shared, non-dept
 * hue (bright amber) so the room TYPE reads instantly regardless of which depts
 * are inside. The scene pairs this with a dashed border + a "PROJECT" tag, vs a
 * dept room's solid dept-colored border, so the two types can't be confused.
 */
export function projectAccent(): number {
  return 0xf59e0b;
}
