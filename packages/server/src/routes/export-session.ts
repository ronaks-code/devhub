/**
 * Single-session export: GET /api/sessions/:id/export?format=md|json
 *
 * Pulls ONE session's normalized transcript through the engine and streams it back
 * as a downloadable file (`Content-Disposition: attachment`), so the user can keep
 * an offline copy or share one conversation outside the app. Two shapes:
 *
 *   format=json → the normalized session (its {@link SessionSummary} metadata + the
 *                 normalized messages) as pretty JSON — a machine-readable record.
 *   format=md   → a human-readable Markdown transcript: a title/metadata header, then
 *                 one section per message (role heading + timestamp, text/thinking,
 *                 fenced tool calls, and tool results).
 *
 * `md` is the default. An unknown session is a 404 (the engine returns undefined);
 * any other `format` is a 400 so a typo doesn't silently return the wrong shape.
 *
 * Read-only: this never writes a transcript — it reads through the engine by session
 * id (no arbitrary path), the same way `/api/sessions/:id/messages` does.
 *
 * INPUT CAP: a full session can be enormous, so we read a bounded tail of the
 * transcript (`TAIL_BYTES`); when older messages were dropped we note that in the
 * export (a `truncatedFromStart` flag in json, a leading marker line in md) so the
 * export never silently looks complete when it isn't.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";
import type {
  ContentBlock,
  NormalizedMessage,
  SessionMessagesPage,
} from "@claude-ui/engine/types";

type ExportFormat = "md" | "json";
const FORMATS: ExportFormat[] = ["md", "json"];

const exportSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    // No `enum` here on purpose: an unknown format is a 400 we raise ourselves (with
    // a clear message), rather than Fastify's generic schema rejection.
    format: { type: "string", default: "md" },
  },
} as const;

interface ExportQuery {
  format?: string;
}

/**
 * Tail size (bytes) read off the transcript before normalizing. Generous enough to
 * carry a long conversation whole, while still capping a pathological multi-hundred-MB
 * session so one export can't read an unbounded file into memory. Mirrors the cap the
 * messages route applies (`Math.max(64 * 1024, …)`).
 */
const TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Make a filesystem-friendly slug from a session title/id for the download filename:
 * lower-cased, non-alphanumerics collapsed to single dashes, trimmed, length-capped.
 * Falls back to the session id when a title slugs to nothing.
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Build the `<session>-<slug>.<ext>` download filename for a session export. */
function exportFilename(page: SessionMessagesPage, ext: ExportFormat): string {
  const slug = slugify(page.session.title) || slugify(page.session.sessionId) || "session";
  return `${page.session.sessionId}-${slug}.${ext}`;
}

/** Render one content block to Markdown (text/thinking inline, tools fenced). */
function blockToMarkdown(block: ContentBlock): string | null {
  switch (block.type) {
    case "text":
      return block.text.trim() || null;
    case "thinking": {
      const t = block.text.trim();
      return t ? `> _thinking_\n>\n${t.replace(/^/gm, "> ")}` : null;
    }
    case "tool_use": {
      // Pretty-print the input, but tolerate anything non-serializable.
      let input: string;
      try {
        input = JSON.stringify(block.input, null, 2);
      } catch {
        input = String(block.input);
      }
      return [`**Tool call: \`${block.name}\`**`, "", "```json", input, "```"].join("\n");
    }
    case "tool_result": {
      const label = block.isError ? "Tool result (error)" : "Tool result";
      const body = block.content.trim() || (block.spilledPath ? `(large output: ${block.spilledPath})` : "(empty)");
      return [`**${label}:**`, "", "```", body, "```"].join("\n");
    }
    case "image":
      return `_[image${block.mediaType ? ` ${block.mediaType}` : ""}]_`;
    default:
      return null;
  }
}

/** Render one normalized message to a Markdown section (heading + blocks). */
function messageToMarkdown(m: NormalizedMessage): string {
  const heading = m.model ? `## ${m.role} (${m.model})` : `## ${m.role}`;
  const ts = m.timestamp ? `_${m.timestamp}_` : "";
  const parts: string[] = [heading];
  if (ts) parts.push(ts);
  const rendered = m.blocks.map(blockToMarkdown).filter((b): b is string => b !== null);
  if (rendered.length) parts.push(rendered.join("\n\n"));
  return parts.join("\n\n");
}

/** Build the full Markdown transcript (header + per-message sections) for a session. */
function toMarkdown(page: SessionMessagesPage): string {
  const s = page.session;
  const header = [
    `# ${s.title}`,
    "",
    `- **Session:** \`${s.sessionId}\``,
    `- **Project:** ${s.projectId}`,
    s.cwd ? `- **Working directory:** \`${s.cwd}\`` : null,
    s.model ? `- **Model:** ${s.model}` : null,
    s.gitBranch ? `- **Branch:** ${s.gitBranch}` : null,
    s.firstTimestamp ? `- **Started:** ${s.firstTimestamp}` : null,
    s.lastTimestamp ? `- **Last activity:** ${s.lastTimestamp}` : null,
    `- **Messages:** ${s.messageCount}`,
    s.tags.length ? `- **Tags:** ${s.tags.join(", ")}` : null,
  ].filter((l): l is string => l !== null);

  const body = page.messages.map(messageToMarkdown);
  const sections = [header.join("\n")];
  if (page.truncatedFromStart) {
    sections.push("_…earlier messages omitted (session tailed for export)…_");
  }
  sections.push(...body);
  return sections.join("\n\n---\n\n") + "\n";
}

/**
 * Wire GET /api/sessions/:id/export onto an app, backed by the engine. An unknown
 * session id yields 404; an unrecognized `format` yields 400 (default `md`).
 */
export function registerExportSessionRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Params: { id: string }; Querystring: ExportQuery }>(
    "/api/sessions/:id/export",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        querystring: exportSchema,
      },
    },
    async (req, reply) => {
      const format = (req.query.format ?? "md") as string;
      if (!FORMATS.includes(format as ExportFormat)) {
        return reply.code(400).send({ error: `unknown format "${format}" (expected md|json)` });
      }

      const page = await engine.getSessionMessages(req.params.id, { tailBytes: TAIL_BYTES });
      if (!page) {
        return reply.code(404).send({ error: "session not found" });
      }

      if (format === "json") {
        // The normalized session: metadata + messages, plus the tail flag so a
        // consumer knows whether older messages were dropped.
        const payload = {
          session: page.session,
          messages: page.messages,
          truncatedFromStart: page.truncatedFromStart,
          subagents: page.subagents,
        };
        const filename = exportFilename(page, "json");
        reply
          .header("Content-Type", "application/json; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="${filename}"`);
        return JSON.stringify(payload, null, 2) + "\n";
      }

      // format === "md"
      const md = toMarkdown(page);
      const filename = exportFilename(page, "md");
      reply
        .header("Content-Type", "text/markdown; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`);
      return md;
    },
  );
}
