/**
 * AI session summary. Reads the recent messages of one session via the engine,
 * folds them into a compact transcript, and runs a single planning-mode driver
 * turn asking for a concise 3-5 bullet summary. Nothing is written or committed:
 *
 *   POST /api/summary { sessionId } → { summary }
 *
 * This complements the read/search surfaces (`/api/sessions/:id/messages`,
 * `/api/search`) — those return raw rows; here we want a human one-glance recap
 * of "what happened in this session".
 *
 * SECURITY / SAFETY: this route never writes a transcript. The driver turn runs
 * in `plan` mode (no edits, no commands) and is asked for ONLY the bullets. We
 * read the session through the engine (no arbitrary path), so there's no cwd gate
 * to apply here — the session is addressed by id, not by a host directory.
 *
 * INPUT CAP: a full session can be enormous. We pull a bounded tail of the
 * transcript (`tailBytes`), then flatten only the human-readable text/thinking
 * and tool names, and finally hard-cap the assembled prompt text to
 * `MAX_PROMPT_BYTES` so a giant session can't blow the model's context budget.
 */
import type { FastifyInstance } from "fastify";
import { createDriver, type Engine } from "@claude-ui/engine";
import type { NormalizedMessage } from "@claude-ui/engine/types";

const summarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: { type: "string", minLength: 1 },
  },
} as const;

interface SummaryBody {
  sessionId: string;
}

/**
 * Tail size (bytes) read off the transcript before flattening. The recap only
 * needs the gist of the recent conversation, so we cap what we even read.
 */
const TAIL_BYTES = 128 * 1024;

/**
 * Hard cap on the flattened conversation text handed to the model. Even after
 * tailing we truncate (with a marker) so an oversized session can't overflow the
 * prompt budget.
 */
const MAX_PROMPT_BYTES = 24 * 1024;

/** Per-message cap so one huge message can't dominate the flattened transcript. */
const MAX_BLOCK_CHARS = 2000;

/**
 * Flatten a normalized message to a single readable line: its role plus the
 * human-readable text (text/thinking blocks) and a compact note of any tool the
 * turn used. Tool *results* are intentionally dropped — they're often large and
 * add little to a high-level recap.
 */
function flattenMessage(m: NormalizedMessage): string | null {
  const parts: string[] = [];
  for (const block of m.blocks) {
    if (block.type === "text" || block.type === "thinking") {
      const t = block.text.trim();
      if (t) parts.push(t);
    } else if (block.type === "tool_use") {
      parts.push(`[used tool: ${block.name}]`);
    }
  }
  const body = parts.join(" ").trim();
  if (!body) return null;
  const clipped = body.length > MAX_BLOCK_CHARS ? body.slice(0, MAX_BLOCK_CHARS) + "…" : body;
  return `${m.role}: ${clipped}`;
}

/**
 * Wire POST /api/summary onto an app, backed by the engine. An unknown session
 * yields 404 (the engine returns undefined); an empty/contentless session yields
 * 400 so we never ask the model to summarize nothing.
 */
export function registerSummaryRoutes(app: FastifyInstance, engine: Engine): void {
  app.post<{ Body: SummaryBody }>(
    "/api/summary",
    { schema: { body: summarySchema } },
    async (req, reply) => {
      const { sessionId } = req.body;

      const page = await engine.getSessionMessages(sessionId, { tailBytes: TAIL_BYTES });
      if (!page) {
        return reply.code(404).send({ error: "session not found" });
      }

      const lines: string[] = [];
      for (const m of page.messages) {
        const line = flattenMessage(m);
        if (line) lines.push(line);
      }
      let transcript = lines.join("\n");
      if (transcript.trim().length === 0) {
        return reply.code(400).send({ error: "session has no summarizable content" });
      }
      if (transcript.length > MAX_PROMPT_BYTES) {
        transcript = "…(earlier messages omitted)…\n" + transcript.slice(-MAX_PROMPT_BYTES);
      }

      const prompt = [
        "Summarize the following coding-session transcript as 3-5 concise bullet",
        "points capturing what was worked on, key decisions, and the outcome.",
        "Output ONLY the bullets (one per line, each starting with '- '). No",
        "preamble, no heading, no code fences.",
        "",
        "<transcript>",
        transcript,
        "</transcript>",
      ].join("\n");

      // Run in the session's own cwd when known so any context the model needs is
      // local; fall back to the server cwd otherwise. Plan mode → no edits/commands.
      const cwd = page.session.cwd ?? process.cwd();

      const turn = createDriver().runTurn(
        { cwd, prompt, permissionMode: "plan", includePartial: false },
        {},
      );
      const result = await turn.done;
      const summary = result?.resultText?.trim() ?? "";
      if (!summary) {
        return reply.code(502).send({ error: "could not generate a summary" });
      }
      return { summary };
    },
  );
}
