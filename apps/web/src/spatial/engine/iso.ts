/**
 * Isometric math + world layout. Pure functions — no Pixi here — so the layout
 * is unit-testable and the renderer just consumes coordinates.
 *
 * Mental model: we work in a flat "grid" space (col, row) like a chessboard,
 * then PROJECT it to screen with the classic 2:1 isometric transform so it looks
 * like a 3/4 view office. Everything spatial (rooms, desks, moving leaders) is
 * placed in grid space; `toScreen` is the only thing that knows about the tilt.
 */

import type { Agent, Room, WorldState } from "../contract";

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
  /** Agent id → its home desk grid point (from its room). */
  deskOf: Map<string, GridPoint>;
  /** Overall grid bounds, for initial camera fit. */
  bounds: { minCol: number; maxCol: number; minRow: number; maxRow: number };
}

const ROOM_GAP = 2; // empty tiles between rooms
const DESK_COLS = 3; // desks per row inside a room

/**
 * Deterministically place rooms on a coarse grid (wrapping every ROOMS_PER_BAND)
 * and lay desks inside each. Room size grows with member count so a busy project
 * literally takes up more floor — the "rooms extend as projects grow" behavior.
 *
 * Stable ordering by room id keeps a room in the same spot across ticks, so
 * agents don't teleport when unrelated rooms spawn/despawn.
 */
export function computeLayout(world: WorldState): WorldLayout {
  const rooms = [...world.rooms].sort((a, b) => a.id.localeCompare(b.id));
  const roomLayouts = new Map<string, RoomLayout>();
  const deskOf = new Map<string, GridPoint>();

  const ROOMS_PER_BAND = 3;
  let bandCol = 0;
  let bandRow = 0;
  let tallestInBand = 0;

  let minCol = 0;
  let maxCol = 0;
  let minRow = 0;
  let maxRow = 0;

  rooms.forEach((room, i) => {
    const memberCount = Math.max(room.members.length, 1);
    const deskRows = Math.ceil(memberCount / DESK_COLS);
    // +2 tiles of padding all around for walls/walkway.
    const cols = DESK_COLS + 2;
    const rowsSize = deskRows + 2;

    if (i > 0 && i % ROOMS_PER_BAND === 0) {
      bandCol = 0;
      bandRow += tallestInBand + ROOM_GAP;
      tallestInBand = 0;
    }

    const origin: GridPoint = { col: bandCol, row: bandRow };
    const center: GridPoint = {
      col: origin.col + cols / 2,
      row: origin.row + rowsSize / 2,
    };

    const desks = new Map<string, GridPoint>();
    room.members.forEach((memberId, idx) => {
      const dc = idx % DESK_COLS;
      const dr = Math.floor(idx / DESK_COLS);
      const p: GridPoint = { col: origin.col + 1 + dc, row: origin.row + 1 + dr };
      desks.set(memberId, p);
      deskOf.set(memberId, p);
    });

    roomLayouts.set(room.id, { room, origin, cols, rows: rowsSize, center, desks });

    minCol = Math.min(minCol, origin.col);
    minRow = Math.min(minRow, origin.row);
    maxCol = Math.max(maxCol, origin.col + cols);
    maxRow = Math.max(maxRow, origin.row + rowsSize);

    bandCol += cols + ROOM_GAP;
    tallestInBand = Math.max(tallestInBand, rowsSize);
  });

  return { rooms: roomLayouts, deskOf, bounds: { minCol, maxCol, minRow, maxRow } };
}

/**
 * Where an agent should be drawn RIGHT NOW in grid space. A desk-bound agent is
 * at its desk. A "moving" leader is interpolated along its active edge toward the
 * target's desk/room by `phase` (0..1), so it visibly walks room→room.
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

/** A stable accent color per department, for rooms/characters. */
export function deptColor(dept: string): number {
  const palette: Record<string, number> = {
    vulcan: 0xff6b3d, // clay/orange — engineering
    apollo: 0x4d9bff, // blue — product
    thoth: 0xa78bfa, // violet — research
    talos: 0x34d399, // green — infra
    vesta: 0xf472b6, // pink — design
    argus: 0xfbbf24, // amber — QA/security
  };
  return palette[dept] ?? 0x9ca3af;
}
