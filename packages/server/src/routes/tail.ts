/**
 * Live tail of one session's transcript while it runs:
 *
 *   GET /api/sessions/:id/tail  (Server-Sent Events)
 *
 * On connect we send the current tail of the session (the same bounded
 * `tailBytes` window `/api/sessions/:id/messages` uses), then subscribe to the
 * engine's event bus. Whenever the watcher reports a `session-changed` /
 * `session-added` for THIS session, we re-read the tail and emit ONLY the
 * messages appended since the last frame — so a long-lived stream never resends
 * the whole tail. This complements `/api/sessions/:id/messages` (a one-shot read)
 * by following an active session as Claude Code writes to it.
 *
 * HIGH-WATER MARK: we remember the last message we emitted (by `uuid`, falling
 * back to the running count for the rare uuid-less line). On each re-read we drop
 * everything up to and including that mark and emit the remainder. The tail
 * window is bounded, so the worst case is re-reading a fixed byte budget — never
 * the whole file.
 *
 * This mirrors the SSE handler in app.ts (`/api/events`): `reply.hijack()`,
 * text/event-stream headers, a `: connected` preamble, a 25s `: ping` heartbeat,
 * and full cleanup (unsubscribe + clear heartbeat) when the request closes. The
 * token-auth `onRequest` hook in app.ts applies here too — nothing to bypass.
 *
 * SECURITY / SAFETY: read-only. Sessions are addressed by id through the engine
 * (no arbitrary path), and we only ever READ the transcript tail — never write.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";
import type { EngineEvent, NormalizedMessage } from "@claude-ui/engine/types";

/**
 * Tail window (bytes) read off the transcript per frame. Matches the floor
 * `/api/sessions/:id/messages` applies (`Math.max(64 * 1024, …)`) so a live
 * follower sees the same recent slice the one-shot read would return.
 */
const TAIL_BYTES = 64 * 1024;

/**
 * Stable key for one message in the tail window: its `uuid` when present, else a
 * synthetic position key (uuid-less lines are rare — meta/hook rows — and never
 * collide with a real uuid because of the prefix).
 */
function keyOf(m: NormalizedMessage, index: number): string {
  return m.uuid ?? `@${index}`;
}

/** Wire GET /api/sessions/:id/tail (SSE) onto an app, backed by the engine. */
export function registerTailRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/tail",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    (req, reply) => {
      const sessionId = req.params.id;
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      raw.write(": connected\n\n");

      // High-water mark: the key of the last message we've emitted. Everything up
      // to and including this key is dropped on the next re-read.
      let lastKey: string | null = null;
      // Guard against overlapping re-reads when events fire faster than a tail read
      // completes; a pending event sets `dirty` so we re-read once the current pass
      // finishes (coalesced — bursts collapse to a single follow-up read).
      let reading = false;
      let dirty = false;
      // Set once the request closes so an in-flight async read stops writing.
      let closed = false;

      const sendMessages = (messages: NormalizedMessage[]): void => {
        // Find where we left off. With no mark yet, emit the whole tail; otherwise
        // emit everything AFTER the last key we saw. If the mark fell out of the
        // (bounded) window — e.g. heavy churn pushed it past the tail — fall back
        // to emitting nothing new rather than replaying the window.
        let startIdx = 0;
        if (lastKey !== null) {
          const at = messages.findIndex((m, i) => keyOf(m, i) === lastKey);
          startIdx = at === -1 ? messages.length : at + 1;
        }
        const fresh = messages.slice(startIdx);
        const last = messages[messages.length - 1];
        if (last) {
          lastKey = keyOf(last, messages.length - 1);
        }
        if (fresh.length === 0) return;
        raw.write(
          `data: ${JSON.stringify({ kind: "tail", sessionId, messages: fresh })}\n\n`,
        );
      };

      const readTail = async (): Promise<void> => {
        if (closed) return;
        if (reading) {
          dirty = true;
          return;
        }
        reading = true;
        try {
          do {
            dirty = false;
            const page = await engine.getSessionMessages(sessionId, { tailBytes: TAIL_BYTES });
            if (closed) return;
            // Unknown session (or its source vanished): signal once and stop reading,
            // but keep the stream open so the client controls the connection.
            if (!page) {
              raw.write(`data: ${JSON.stringify({ kind: "tail-end", sessionId })}\n\n`);
              return;
            }
            sendMessages(page.messages);
          } while (dirty && !closed);
        } catch {
          // A transient read failure (file mid-rotation, etc.) is swallowed; the next
          // session-changed event re-reads the tail.
        } finally {
          reading = false;
        }
      };

      // Initial frame: the current tail.
      void readTail();

      // Follow the session: re-read on any change/add event for THIS session.
      const unsub = engine.on((e: EngineEvent) => {
        if (
          (e.kind === "session-changed" || e.kind === "session-added") &&
          e.sessionId === sessionId
        ) {
          void readTail();
        }
      });

      const hb = setInterval(() => raw.write(": ping\n\n"), 25000);
      req.raw.on("close", () => {
        closed = true;
        clearInterval(hb);
        unsub();
      });
    },
  );
}
