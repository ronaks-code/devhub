/**
 * SpatialAdapter — the read-only brain of the M1 OpenClaw feed. It ties the two
 * halves together: an `OpenClawSource` (how we READ M1's live state) and the
 * `mapOpenClawToWorld` mapper (how we turn that into the strict contract), then
 * emits the SAME `snapshot`/`delta` wire messages the browser's mock feed does.
 *
 * BUILD-ONLY, by design (hard gate): this module opens no socket and no port and
 * touches M1 nothing. A future deploy shim wires it to a websocket in one place —
 *
 *   const adapter = new SpatialAdapter(httpSource("http://127.0.0.1:PORT/state"));
 *   setInterval(async () => {
 *     const msg = await adapter.poll();
 *     if (msg) ws.send(JSON.stringify(msg));
 *   }, 1000);
 *   ws.on("connection", (c) => { const s = adapter.snapshot(); if (s) c.send(JSON.stringify(s)); });
 *
 * — until then the UI runs on the browser mock and this stays exercised only by
 * tests. Keeping the poll/diff logic here (pure, testable) is what lets us swap
 * mock→real behind the contract without touching the renderer.
 */

import { mapOpenClawToWorld } from "./mapper.js";
import type { OpenClawSource } from "./openclaw-source.js";
import type { Agent, DeltaMessage, Edge, Room, ServerMessage, SnapshotMessage, WorldState } from "./contract.js";

export interface SpatialAdapterOptions {
  /** Suggested poll cadence for the deploy shim (ms). The adapter itself never
   *  starts a timer — the caller owns the loop. Purely advisory. */
  pollMs?: number;
}

/** Shallow-by-JSON diff of two id-keyed lists → upserts + removed ids. */
function diffList<T extends { id: string }>(prev: T[], next: T[]): { changed: T[]; removed: string[] } {
  const prevById = new Map(prev.map((x) => [x.id, x]));
  const nextIds = new Set(next.map((x) => x.id));
  const changed: T[] = [];
  for (const n of next) {
    const p = prevById.get(n.id);
    if (!p || JSON.stringify(p) !== JSON.stringify(n)) changed.push(n);
  }
  const removed: string[] = [];
  for (const id of prevById.keys()) if (!nextIds.has(id)) removed.push(id);
  return { changed, removed };
}

/** Compute the delta that turns `prev` into `next` at revision `rev`. */
export function diffWorld(prev: WorldState, next: WorldState, rev: number): DeltaMessage {
  const a = diffList<Agent>(prev.agents, next.agents);
  const e = diffList<Edge>(prev.edges, next.edges);
  const r = diffList<Room>(prev.rooms, next.rooms);
  return {
    type: "delta",
    rev,
    ts: next.ts,
    agents: a.changed,
    edges: e.changed,
    rooms: r.changed,
    removedAgents: a.removed,
    removedEdges: e.removed,
    removedRooms: r.removed,
  };
}

export class SpatialAdapter {
  private readonly source: OpenClawSource;
  readonly pollMs: number;
  private last: WorldState | null = null;
  private rev = 0;

  constructor(source: OpenClawSource, opts: SpatialAdapterOptions = {}) {
    this.source = source;
    this.pollMs = opts.pollMs ?? 1000;
  }

  describe(): string {
    return `SpatialAdapter(${this.source.describe()})`;
  }

  /** The current full world as a snapshot, or null before the first good read.
   *  Send this to every new websocket client on connect. */
  snapshot(): SnapshotMessage | null {
    return this.last ? { type: "snapshot", world: this.last } : null;
  }

  /**
   * Read the source once and produce the next wire message:
   *  - null           → the source gave us nothing (down/malformed); keep serving
   *                      the last good world, emit nothing.
   *  - snapshot       → first successful read (client has no baseline yet).
   *  - delta          → subsequent reads (only the entities that changed).
   * A delta whose lists are all empty is still returned so `rev` advances in
   * lockstep with the client (the client relies on prevRev+1).
   */
  async poll(): Promise<ServerMessage | null> {
    const raw = await this.source.read();
    if (!raw) return null;
    this.rev += 1;
    const world = mapOpenClawToWorld(raw, { rev: this.rev, ts: Date.now() });
    if (!this.last) {
      this.last = world;
      return { type: "snapshot", world };
    }
    const delta = diffWorld(this.last, world, this.rev);
    this.last = world;
    return delta;
  }
}
