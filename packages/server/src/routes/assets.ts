/**
 * Asset + project-file surface. Two read-only endpoints that back the chat UI:
 *
 *   GET /api/assets?path=<abs>
 *     → Serve a single transcript image inline. Used by MessageView to render the
 *       `{type:"image"}` content blocks (the engine's image variant carries only a
 *       mediaType + a path on disk, never the bytes, so the browser fetches them
 *       here). The response sets the right Content-Type and streams the file.
 *
 *   GET /api/files?cwd=<abs>&q=<filter>&limit=<n>
 *     → List project files for the composer's @-mention autocomplete. Walks the
 *       project tree (skipping node_modules/.git/dist, oversized + binary files),
 *       fuzzy/prefix-filters by `q`, and returns up to `limit` RELATIVE paths.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SECURITY — allowlist (the whole point of this module):
 *
 *   • /api/assets honors a `path` only when, after symlink-free resolution, it
 *     lives UNDER either ~/.claude/projects (paths.projectsDir() — where saved
 *     transcript assets sit) or a KNOWN project cwd from the engine. Anything
 *     else is 400. This stops the endpoint from being a read-any-file-on-disk
 *     primitive. It must also look like an image (by extension) — non-images 400.
 *
 *   • /api/files honors a `cwd` only when it EXACTLY matches a known project's
 *     cwd (archived included), mirroring the git route's gate. The walk is then
 *     additionally clamped to never escape that root (resolved entries that fall
 *     outside the root are dropped), so symlinks can't be used to wander out.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from "fastify";
import { type Engine, paths } from "@claude-ui/engine";
import path from "node:path";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";

/** Image extensions we will serve inline, mapped to their Content-Type. */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** Directories we never descend into while walking a project for @-mentions. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".svn",
  ".hg",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

/** File extensions treated as binary/asset noise and skipped from the listing. */
const BINARY_EXTS = new Set([
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif",
  ".heic", ".tif", ".tiff", ".svg",
  // archives / binaries
  ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".class",
  ".wasm", ".node", ".pyc",
  // media
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg",
  ".webm", ".m4a",
  // fonts / docs / db
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".db", ".sqlite", ".sqlite3", ".lock",
]);

/** Skip files larger than this from the @-mention listing (1 MB). */
const MAX_FILE_BYTES = 1024 * 1024;

/** Hard cap on entries scanned so a pathological tree can't hang the walk. */
const MAX_SCAN_ENTRIES = 20_000;

interface AssetQuery {
  path: string;
}

interface FilesQuery {
  cwd: string;
  q?: string;
  limit?: number;
}

const assetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1 },
  },
} as const;

const filesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    q: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
} as const;

/** True when `child` is the same as, or nested under, `root` (path-segment safe). */
function isUnder(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root + path.sep);
}

/**
 * Subsequence match: every char of `needle` appears in `hay` in order. This is
 * the cheap "fuzzy" used by editor @-mention pickers (e.g. "scfg" ⊂ "src/config").
 * Case-insensitive; an empty needle matches everything.
 */
function fuzzyMatch(hay: string, needle: string): boolean {
  if (needle.length === 0) return true;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) i++;
  }
  return i === n.length;
}

/**
 * Walk `root` breadth-ish (recursive readdir) collecting relative file paths that
 * pass the skip/size/binary filters and (if provided) the fuzzy `q`. Stops once
 * `limit` matches are gathered or the scan cap is hit. Stays strictly inside
 * `root`: each entry is resolved and dropped if it would escape.
 */
async function listProjectFiles(
  root: string,
  q: string,
  limit: number,
): Promise<string[]> {
  const out: string[] = [];
  let scanned = 0;

  // Iterative stack walk to avoid deep recursion on big trees.
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < limit && scanned < MAX_SCAN_ENTRIES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip quietly
    }
    for (const entry of entries) {
      if (out.length >= limit || scanned >= MAX_SCAN_ENTRIES) break;
      scanned++;
      const abs = path.join(dir, entry.name);
      // Never let a symlink (or odd entry) walk outside the project root.
      if (!isUnder(abs, root)) continue;

      if (entry.isDirectory()) {
        // Skip known-noise dirs (node_modules/.git/dist/…) and all dotdirs.
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, fifos, symlinks-to-nowhere, etc.

      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;

      const rel = path.relative(root, abs);
      if (!fuzzyMatch(rel, q)) continue;

      // Size guard last (it costs a stat) — only for entries we'd otherwise keep.
      try {
        const st = await stat(abs);
        if (st.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }

      out.push(rel);
    }
  }

  // Shortest paths first — closer-to-root files tend to be what's wanted.
  out.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return out.slice(0, limit);
}

/**
 * Wire GET /api/assets and GET /api/files onto an app, backed by the engine for
 * its project allowlist. Both endpoints are read-only.
 */
export function registerAssetsRoutes(app: FastifyInstance, engine: Engine): void {
  /** All known project cwds (archived included), resolved for prefix checks. */
  const knownCwds = (): string[] =>
    engine
      .getProjects({ includeArchived: true })
      .map((p) => path.resolve(p.cwd));

  /** Exact-match gate for /api/files, mirroring the git route. */
  const isKnownCwd = (cwd: string): boolean =>
    knownCwds().includes(path.resolve(cwd));

  // -- GET /api/assets --------------------------------------------------------
  app.get<{ Querystring: AssetQuery }>(
    "/api/assets",
    { schema: { querystring: assetSchema } },
    async (req, reply) => {
      const ext = path.extname(req.query.path).toLowerCase();
      const contentType = IMAGE_CONTENT_TYPES[ext];
      if (!contentType) {
        return reply.code(400).send({ error: "not an image" });
      }

      // Resolve through symlinks so the allowlist can't be bypassed via a link.
      // A missing file throws → 404; everything else maps to a 400 (bad path).
      let resolved: string;
      try {
        resolved = await realpath(req.query.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(404).send({ error: "not found" });
        }
        return reply.code(400).send({ error: "invalid path" });
      }

      const projectsRoot = path.resolve(paths.projectsDir());
      const allowed =
        isUnder(resolved, projectsRoot) ||
        knownCwds().some((root) => isUnder(resolved, root));
      if (!allowed) {
        return reply.code(400).send({ error: "path not allowed" });
      }

      // Must be a regular file (not a dir we happened to point an .png name at).
      let st;
      try {
        st = await stat(resolved);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!st.isFile()) {
        return reply.code(400).send({ error: "not a file" });
      }

      reply.header("Content-Type", contentType);
      reply.header("Content-Length", st.size);
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(createReadStream(resolved));
    },
  );

  // -- GET /api/files ---------------------------------------------------------
  app.get<{ Querystring: FilesQuery }>(
    "/api/files",
    { schema: { querystring: filesSchema } },
    async (req, reply) => {
      const { cwd, q, limit } = req.query;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const root = path.resolve(cwd);
      const files = await listProjectFiles(root, q ?? "", limit ?? 50);
      return { cwd, files };
    },
  );
}
