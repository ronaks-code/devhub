/**
 * State client — turns either feed (mock or a real websocket) into a single
 * `WorldState` stream for the renderer. The renderer subscribes and re-renders;
 * it never learns which source it's reading.
 *
 * Honesty rule (spec non-negotiable): the client reports its `source` so the UI
 * can label the world clearly as MOCK until the real M1 feed is wired.
 */

import { useEffect, useRef, useState } from "react";
import { applyDelta, parseWorldState, type ServerMessage, type WorldState } from "./contract";
import { MockFeed } from "./mockFeed";

export type FeedSource = "mock" | "live";

export interface WorldClient {
  source: FeedSource;
  /** Subscribe to full-world updates. Fires immediately with the current world if known. */
  subscribe(fn: (world: WorldState) => void): () => void;
  /** Connection state, for the HUD. */
  status: "connecting" | "open" | "closed";
  stop(): void;
}

const EMPTY: WorldState = { rev: 0, ts: 0, agents: [], edges: [], rooms: [] };

/** Wrap a raw `ServerMessage` stream (from any transport) into a WorldState stream. */
function fromMessages(
  source: FeedSource,
  attach: (onMessage: (m: ServerMessage) => void) => { stop: () => void; setStatus?: (s: WorldClient["status"]) => void },
): WorldClient {
  let world: WorldState = EMPTY;
  const listeners = new Set<(w: WorldState) => void>();
  const client: WorldClient = {
    source,
    status: "connecting",
    subscribe(fn) {
      listeners.add(fn);
      if (world.rev > 0) fn(world);
      return () => listeners.delete(fn);
    },
    stop() {
      handle.stop();
    },
  };
  const push = () => {
    for (const fn of listeners) fn(world);
  };
  const handle = attach((m) => {
    if (m.type === "snapshot") {
      const parsed = parseWorldState(m.world);
      if (parsed) {
        world = parsed;
        client.status = "open";
        push();
      }
    } else {
      // Deltas assume prevRev+1; on a gap we keep the last good world and wait
      // for the next snapshot rather than applying a torn patch.
      if (m.rev === world.rev + 1) {
        world = applyDelta(world, m);
        push();
      }
    }
  });
  return client;
}

/** A client backed by the local mock simulation. */
export function createMockClient(): WorldClient {
  let feed: MockFeed | null = null;
  return fromMessages("mock", (onMessage) => {
    feed = new MockFeed({ tickMs: 1500 });
    const unsub = feed.subscribe(onMessage);
    feed.start();
    return {
      stop() {
        unsub();
        feed?.stop();
      },
    };
  });
}

/**
 * A client backed by a real websocket speaking the contract (the M1 adapter).
 * Reconnects with backoff; a torn stream falls back to waiting for the next
 * snapshot. Only used once Ronak deploys the adapter — until then the UI runs on
 * the mock client.
 */
export function createLiveClient(url: string): WorldClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;
  let onMessageRef: ((m: ServerMessage) => void) | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMessage;
        if (msg && (msg.type === "snapshot" || msg.type === "delta")) onMessageRef?.(msg);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onopen = () => {
      backoff = 500;
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = () => ws?.close();
  };

  return fromMessages("live", (onMessage) => {
    onMessageRef = onMessage;
    connect();
    return {
      stop() {
        closed = true;
        ws?.close();
      },
    };
  });
}

/**
 * React hook: subscribe to a WorldClient and get the latest world + source label.
 * `mode` decides which feed to build; defaults to mock.
 */
export function useWorldState(mode: FeedSource = "mock", liveUrl?: string): {
  world: WorldState;
  source: FeedSource;
} {
  const [world, setWorld] = useState<WorldState>(EMPTY);
  const clientRef = useRef<WorldClient | null>(null);

  useEffect(() => {
    const client =
      mode === "live" && liveUrl ? createLiveClient(liveUrl) : createMockClient();
    clientRef.current = client;
    const unsub = client.subscribe(setWorld);
    return () => {
      unsub();
      client.stop();
    };
  }, [mode, liveUrl]);

  return { world, source: clientRef.current?.source ?? mode };
}
