/**
 * Chat attachment upload. Backs the composer's image-paste / file-drop:
 *
 *   POST /api/attachments  { filename, dataBase64 }
 *     -> decode, validate (type + size), write under ~/.claude-ui/attachments/,
 *        return { path, url:"/api/assets?path=<abs>" } so the chat UI can render
 *        the image straight back through the existing read-only assets endpoint.
 *
 * We take a BASE64 JSON body on purpose: it needs no multipart parser dependency
 * (and this package must add no new deps). The browser already has the bytes in
 * memory after a paste/drop, so base64-encoding them is cheap.
 *
 * SECURITY / SAFETY:
 *   • Size-capped at ~10MB of DECODED bytes (the base64 string is ~33% larger, so
 *     the Fastify body limit is set wider to let the cap be enforced precisely with
 *     a clear 413 rather than a generic parse error).
 *   • Type-restricted by extension: a fixed allowlist of images plus a few small
 *     text types. The extension is derived from the supplied filename and then
 *     re-stamped onto a RANDOM basename, so the stored name is never attacker
 *     controlled and can't contain path separators / traversal.
 *   • Files land in a dedicated temp dir under appData; the returned `url` points at
 *     /api/assets, which has its own allowlist — note that endpoint only serves
 *     IMAGES inline, so text attachments are stored + path-returned but not
 *     image-served (the composer uses the path for upload references, the url for
 *     image previews).
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";
import { paths } from "@claude-ui/engine";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/** Max DECODED attachment size: 10 MB. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Allowed extensions -> a stable label. Images mirror the assets endpoint's inline
 * set; a few small text types are allowed for pasted snippets/logs. Anything else
 * is rejected with a 415.
 */
const ALLOWED_EXTS = new Set([
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
  ".heic", ".tif", ".tiff",
  // small text
  ".txt", ".md", ".log", ".json", ".csv",
]);

/** Where uploaded attachments are written: ~/.claude-ui/attachments/. */
function attachmentsDir(): string {
  return path.join(paths.appDataDir(), "attachments");
}

const attachmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["filename", "dataBase64"],
  properties: {
    filename: { type: "string", minLength: 1, maxLength: 255 },
    // Generous string cap; the real limit is the DECODED byte count (MAX_BYTES),
    // enforced after decode. Base64 is ~4/3 the byte size, so allow that overhead.
    dataBase64: { type: "string", minLength: 1, maxLength: Math.ceil(MAX_BYTES * 1.4) },
  },
} as const;

/**
 * Strip any base64 data-URL prefix (`data:image/png;base64,...`) so we decode just
 * the payload. Returns the raw base64 string when there's no prefix.
 */
function stripDataUrl(s: string): string {
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma !== -1 ? s.slice(comma + 1) : s;
}

/** Wire POST /api/attachments onto an app. */
export function registerAttachmentsRoutes(app: FastifyInstance, _engine: Engine): void {
  app.post<{ Body: { filename: string; dataBase64: string } }>(
    "/api/attachments",
    {
      // Raise the route's body limit so a ~10MB file (base64-inflated) reaches the
      // handler and is rejected with a precise 413 rather than Fastify's generic
      // "body too large". ceil(10MB * 1.4) + small JSON envelope overhead.
      bodyLimit: Math.ceil(MAX_BYTES * 1.4) + 4096,
      schema: { body: attachmentSchema },
    },
    async (req, reply) => {
      const { filename, dataBase64 } = req.body;

      const ext = path.extname(filename).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) {
        return reply.code(415).send({ error: "unsupported file type" });
      }

      // Decode + enforce the real (decoded) size cap.
      let bytes: Buffer;
      try {
        bytes = Buffer.from(stripDataUrl(dataBase64), "base64");
      } catch {
        return reply.code(400).send({ error: "invalid base64" });
      }
      if (bytes.length === 0) {
        return reply.code(400).send({ error: "empty file" });
      }
      if (bytes.length > MAX_BYTES) {
        return reply.code(413).send({ error: "file too large" });
      }

      // Random basename + validated extension: the stored name is never attacker
      // controlled, so it can't carry path separators or traversal.
      const dir = attachmentsDir();
      const name = `${randomBytes(16).toString("hex")}${ext}`;
      const dest = path.join(dir, name);

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(dest, bytes);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }

      return {
        ok: true,
        path: dest,
        url: `/api/assets?path=${encodeURIComponent(dest)}`,
        size: bytes.length,
      };
    },
  );
}
