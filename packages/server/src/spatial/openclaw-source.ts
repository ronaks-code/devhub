/**
 * OpenClaw source — how the adapter READS the live swarm state off M1.
 *
 * Reality check (why this is build-only): OpenClaw (the M1 gateway) is the
 * authority on which agent instances exist, their assignments, and the dispatch
 * graph. This module defines the raw shape we expect from it and a couple of
 * tolerant readers, but we do NOT know M1's exact internal schema yet — so the
 * raw type is deliberately loose and the mapper (mapper.ts) is defensive. Wiring
 * the *real* reader (which file/endpoint on M1 to poll) is the Ronak-gated step.
 *
 * Two readers are provided:
 *  - `fileSource(path)` — poll a JSON file OpenClaw writes (simplest, no network).
 *  - `httpSource(url)`  — poll a read-only HTTP endpoint OpenClaw exposes.
 * Both return `RawOpenClawState | null` (null on any read/parse failure, so the
 * adapter keeps serving its last good world instead of crashing).
 */

import { readFile } from "node:fs/promises";

/**
 * Raw agent instance as OpenClaw is expected to report it. Every field is
 * optional except an id, because we don't control the upstream schema — the
 * mapper fills sensible defaults. Field-name aliases (e.g. `task` vs
 * `assignment`) are handled in the mapper, not here.
 */
export interface RawOpenClawAgent {
  id: string;
  name?: string;
  dept?: string;
  department?: string;
  role?: string;
  kind?: string;
  status?: string;
  state?: string;
  assignment?: string;
  task?: string;
  reportsTo?: string | null;
  parentId?: string | null;
  project?: string;
}

/** Raw dispatch/message edge as OpenClaw reports it. */
export interface RawOpenClawMessage {
  id?: string;
  from?: string;
  src?: string;
  to?: string;
  dst?: string;
  /** "lateral" | "vertical" — inferred from the hierarchy if absent. */
  kind?: string;
  active?: boolean;
  topic?: string;
  subject?: string;
}

export interface RawOpenClawState {
  agents?: RawOpenClawAgent[];
  messages?: RawOpenClawMessage[];
  edges?: RawOpenClawMessage[];
}

/** A source is anything that can hand us the latest raw state (or null). */
export interface OpenClawSource {
  read(): Promise<RawOpenClawState | null>;
  describe(): string;
}

/** Poll a JSON file that OpenClaw writes on M1. */
export function fileSource(path: string): OpenClawSource {
  return {
    describe: () => `file:${path}`,
    async read() {
      try {
        const buf = await readFile(path, "utf8");
        const parsed = JSON.parse(buf) as unknown;
        return coerceRaw(parsed);
      } catch {
        return null;
      }
    },
  };
}

/** Poll a read-only HTTP endpoint OpenClaw exposes on M1. */
export function httpSource(url: string, fetchImpl: typeof fetch = fetch): OpenClawSource {
  return {
    describe: () => `http:${url}`,
    async read() {
      try {
        const res = await fetchImpl(url, { method: "GET" });
        if (!res.ok) return null;
        const parsed = (await res.json()) as unknown;
        return coerceRaw(parsed);
      } catch {
        return null;
      }
    },
  };
}

/** A static source for tests / offline demos. */
export function staticSource(state: RawOpenClawState): OpenClawSource {
  return {
    describe: () => "static",
    read: async () => state,
  };
}

/** Best-effort coercion of an untrusted parsed value into RawOpenClawState. */
export function coerceRaw(value: unknown): RawOpenClawState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const agents = Array.isArray(v.agents) ? (v.agents as RawOpenClawAgent[]) : [];
  const messages = Array.isArray(v.messages)
    ? (v.messages as RawOpenClawMessage[])
    : Array.isArray(v.edges)
      ? (v.edges as RawOpenClawMessage[])
      : [];
  return { agents, messages };
}
