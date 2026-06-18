/**
 * Single-session HTML export: GET /api/sessions/:id/export.html
 *
 * Pulls ONE session's normalized transcript through the engine and streams it back
 * as a SELF-CONTAINED `.html` file (`Content-Disposition: attachment`) — all CSS
 * inlined, no external assets — so the user can keep an offline copy or share one
 * conversation as a single file that opens readably in any browser. This is the
 * presentation sibling of W25's `routes/export-session.ts` (md/json); that file is
 * left untouched.
 *
 * The page renders: a title/metadata header, then one role-styled block per message
 * (role + model + timestamp), with text/thinking inline, tool calls/results in
 * fenced monospace code blocks. There is no syntax highlighting on purpose — the
 * blocks are syntax-neutral monospace so the file stays small and dependency-free.
 *
 * An unknown session is a 404 (the engine returns undefined). Read-only: this never
 * writes a transcript — it reads through the engine by session id (no arbitrary
 * path), the same way `/api/sessions/:id/messages` does.
 *
 * INPUT CAP: a full session can be enormous, so we read a bounded tail of the
 * transcript (`TAIL_BYTES`); when older messages were dropped we note that in the
 * export (a leading marker) so the export never silently looks complete when it isn't.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";
import type {
  ContentBlock,
  NormalizedMessage,
  SessionMessagesPage,
} from "@claude-ui/engine/types";

/**
 * Tail size (bytes) read off the transcript before normalizing. Mirrors the cap the
 * md/json export applies — generous enough to carry a long conversation whole while
 * still capping a pathological multi-hundred-MB session so one export can't read an
 * unbounded file into memory.
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

/** Build the `<session>-<slug>.html` download filename for a session export. */
function exportFilename(page: SessionMessagesPage): string {
  const slug = slugify(page.session.title) || slugify(page.session.sessionId) || "session";
  return `${page.session.sessionId}-${slug}.html`;
}

/**
 * Escape text for safe inclusion in HTML element/attribute content. Transcripts are
 * fully untrusted (they're arbitrary conversation/tool output), so EVERYTHING that
 * lands in the page goes through this — there is no raw-HTML passthrough anywhere.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render one content block to an HTML fragment (text/thinking inline, tools fenced). */
function blockToHtml(block: ContentBlock): string | null {
  switch (block.type) {
    case "text": {
      const t = block.text.trim();
      return t ? `<div class="text">${esc(t)}</div>` : null;
    }
    case "thinking": {
      const t = block.text.trim();
      return t ? `<div class="thinking"><span class="label">thinking</span>${esc(t)}</div>` : null;
    }
    case "tool_use": {
      // Pretty-print the input, but tolerate anything non-serializable.
      let input: string;
      try {
        input = JSON.stringify(block.input, null, 2);
      } catch {
        input = String(block.input);
      }
      return [
        `<div class="tool tool-use">`,
        `<div class="tool-label">Tool call: <code>${esc(block.name)}</code></div>`,
        `<pre><code>${esc(input)}</code></pre>`,
        `</div>`,
      ].join("");
    }
    case "tool_result": {
      const label = block.isError ? "Tool result (error)" : "Tool result";
      const body =
        block.content.trim() ||
        (block.spilledPath ? `(large output: ${block.spilledPath})` : "(empty)");
      const cls = block.isError ? "tool tool-result tool-error" : "tool tool-result";
      return [
        `<div class="${cls}">`,
        `<div class="tool-label">${esc(label)}</div>`,
        `<pre><code>${esc(body)}</code></pre>`,
        `</div>`,
      ].join("");
    }
    case "image":
      return `<div class="image">[image${block.mediaType ? ` ${esc(block.mediaType)}` : ""}]</div>`;
    default:
      return null;
  }
}

/** Render one normalized message to a role-styled HTML section (header + blocks). */
function messageToHtml(m: NormalizedMessage): string {
  const roleClass = `role-${slugify(m.role) || "unknown"}`;
  const model = m.model ? ` <span class="model">${esc(m.model)}</span>` : "";
  const ts = m.timestamp ? `<span class="ts">${esc(m.timestamp)}</span>` : "";
  const rendered = m.blocks.map(blockToHtml).filter((b): b is string => b !== null);
  return [
    `<section class="msg ${roleClass}">`,
    `<header class="msg-head"><span class="role">${esc(m.role)}</span>${model}${ts}</header>`,
    `<div class="msg-body">${rendered.join("")}</div>`,
    `</section>`,
  ].join("");
}

/**
 * Inline stylesheet. Kept terse and self-contained (no external fonts/assets) so the
 * exported file is a single portable document. Dark-on-light, role tints, monospace
 * code blocks — no syntax highlighting (syntax-neutral by design).
 */
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem; line-height: 1.55;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1b1f24; background: #f6f7f9;
}
.wrap { max-width: 920px; margin: 0 auto; }
header.meta { margin-bottom: 1.5rem; }
header.meta h1 { font-size: 1.6rem; margin: 0 0 .75rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .75rem; margin: 0; font-size: .85rem; }
dl.meta dt { color: #57606a; }
dl.meta dd { margin: 0; }
.truncated { margin: 1rem 0; padding: .6rem .8rem; border-left: 3px solid #d0a000; background: #fff8e1; color: #6b5300; font-size: .85rem; border-radius: 4px; }
.msg { margin: 1rem 0; padding: .85rem 1rem; border-radius: 8px; background: #fff; border: 1px solid #e1e4e8; }
.msg-head { display: flex; align-items: baseline; gap: .6rem; margin-bottom: .5rem; font-size: .8rem; }
.msg-head .role { font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.msg-head .model { color: #57606a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .75rem; }
.msg-head .ts { margin-left: auto; color: #8b949e; font-size: .72rem; }
.role-user { border-left: 3px solid #0969da; }
.role-assistant { border-left: 3px solid #1a7f37; }
.role-system, .role-meta, .role-hook, .role-queue { border-left: 3px solid #8b949e; }
.text { white-space: pre-wrap; word-break: break-word; }
.thinking { white-space: pre-wrap; word-break: break-word; color: #57606a; font-style: italic; border-left: 2px solid #d0d7de; padding-left: .75rem; margin: .5rem 0; }
.thinking .label { display: block; font-style: normal; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #8b949e; margin-bottom: .25rem; }
.tool { margin: .6rem 0; }
.tool-label { font-size: .78rem; font-weight: 600; margin-bottom: .25rem; }
.tool-label code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.tool-error .tool-label { color: #cf222e; }
pre { margin: 0; padding: .7rem .85rem; overflow-x: auto; background: #0d1117; color: #e6edf3; border-radius: 6px; font-size: .8rem; }
pre code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
.image { font-size: .85rem; color: #57606a; font-style: italic; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  .msg { background: #161b22; border-color: #30363d; }
  dl.meta dt, .msg-head .model { color: #8b949e; }
  .truncated { background: #2d2400; color: #e3c000; }
  .thinking { color: #8b949e; border-color: #30363d; }
}
`.trim();

/** One `<dt>/<dd>` metadata row, or null when the value is absent. */
function metaRow(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`;
}

/** Build the full self-contained HTML document (header + per-message sections). */
function toHtml(page: SessionMessagesPage): string {
  const s = page.session;
  const rows = [
    metaRow("Session", s.sessionId),
    metaRow("Project", s.projectId),
    metaRow("Working directory", s.cwd),
    metaRow("Model", s.model),
    metaRow("Branch", s.gitBranch),
    metaRow("Started", s.firstTimestamp),
    metaRow("Last activity", s.lastTimestamp),
    metaRow("Messages", String(s.messageCount)),
    metaRow("Tags", s.tags.length ? s.tags.join(", ") : null),
  ].filter((r): r is string => r !== null);

  const truncated = page.truncatedFromStart
    ? `<div class="truncated">…earlier messages omitted (session tailed for export)…</div>`
    : "";

  const body = page.messages.map(messageToHtml).join("");

  return [
    "<!doctype html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(s.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    `<div class="wrap">`,
    `<header class="meta"><h1>${esc(s.title)}</h1><dl class="meta">${rows.join("")}</dl></header>`,
    truncated,
    body,
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * Wire GET /api/sessions/:id/export.html onto an app, backed by the engine. An
 * unknown session id yields 404. Streams a self-contained HTML download.
 */
export function registerExportHtmlRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/export.html",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const page = await engine.getSessionMessages(req.params.id, { tailBytes: TAIL_BYTES });
      if (!page) {
        return reply.code(404).send({ error: "session not found" });
      }

      const html = toHtml(page);
      const filename = exportFilename(page);
      reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`);
      return html;
    },
  );
}
