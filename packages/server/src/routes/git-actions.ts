/**
 * Git mutation surface for the working-copy actions the file view drives:
 * UNSTAGE (move paths out of the index) and DISCARD (throw away working-tree
 * changes). These complement the stage/commit/branch writes in routes/git.ts —
 * we deliberately do NOT redefine `/api/git/stage` here.
 *
 * SECURITY — cwd allowlist: identical gate to routes/git.ts. A `cwd` is only
 * honored when it exactly matches a known project's cwd from the engine
 * (archived included); an unknown cwd is rejected with 400. Without this gate
 * these endpoints would run destructive git in an arbitrary host directory.
 *
 * DISCARD is DESTRUCTIVE and irreversible (it permanently drops uncommitted
 * edits and deletes untracked files), so on top of the cwd gate it requires an
 * explicit `{ confirm: true }` in the body; anything else is a 400. This is the
 * one write in the package that can lose user work, so the confirm flag makes
 * "yes, really" a property of the request rather than a UI-only convention.
 */
import type { FastifyInstance } from "fastify";
import type { Engine, GitService, GitStatus, GitWriteResult } from "@claude-ui/engine";

/** Body for unstage: a `cwd` plus the paths to remove from the index. */
const unstageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd", "files"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    files: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
  },
} as const;

/**
 * Body for discard: a `cwd`, a required `confirm` (must be true — DESTRUCTIVE),
 * and an OPTIONAL `files` list. Omitting `files` means "discard everything"
 * (discardAll). `additionalProperties:false` keeps the destructive surface tight.
 */
const discardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    confirm: { type: "boolean" },
    files: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
  },
} as const;

/**
 * The discard methods the engine's GitService is EXPECTED to grow but does not
 * expose yet (only `unstage` exists today). We forward to them when present and
 * fall back to a typed failure otherwise, so the route typechecks and degrades
 * gracefully — mirroring the duck-typed `setNotes` lookup in app.ts.
 *
 * NOTE (missing engine symbols): add `discardFile(file: string)` and
 * `discardAll()` to `GitService` (engine/src/git.ts), each returning
 * `Promise<GitWriteResult>`. Then replace this runtime lookup with direct typed
 * calls (`engine.git(cwd).discardFile(file)` / `.discardAll()`).
 */
interface GitDiscardOps {
  discardFile(file: string): Promise<GitWriteResult>;
  discardAll(): Promise<GitWriteResult>;
}

/** True when `git` carries the (not-yet-typed) discard methods at runtime. */
function hasDiscardOps(git: GitService): git is GitService & GitDiscardOps {
  const g = git as unknown as Record<string, unknown>;
  return typeof g.discardFile === "function" && typeof g.discardAll === "function";
}

/**
 * Register the git mutation routes (unstage + discard) on `app`, backed by the
 * engine. The allowlist is recomputed per request (cheap, in-memory) so a project
 * added at runtime is reachable without a restart — same as registerGitRoutes.
 */
export function registerGitActionRoutes(app: FastifyInstance, engine: Engine): void {
  /** True when `cwd` is a known project path (archived projects included). */
  const isKnownCwd = (cwd: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.cwd === cwd);

  // Unstage: drop `files` from the index (keep their working-tree changes), then
  // return fresh status so the face re-renders in one round-trip. Engine's
  // `unstage` already no-ops cleanly on an empty list and fails typed on a non-repo.
  app.post<{ Body: { cwd: string; files: string[] } }>(
    "/api/git/unstage",
    { schema: { body: unstageSchema } },
    async (req, reply) => {
      const { cwd, files } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const git = engine.git(cwd);
      const res = await git.unstage(files);
      if (!res.ok) {
        return reply.code(502).send({ error: res.error || "failed to unstage" });
      }
      return git.status();
    },
  );

  // Discard: DESTRUCTIVE. With `files`, discard each path's working-tree changes
  // (discardFile per file); without `files`, discard everything (discardAll).
  // Requires `{ confirm: true }` on top of the cwd gate — anything else is a 400.
  app.post<{ Body: { cwd: string; confirm?: boolean; files?: string[] } }>(
    "/api/git/discard",
    { schema: { body: discardSchema } },
    async (req, reply) => {
      const { cwd, confirm, files } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      // Destructive guard: the caller must say "yes, really" explicitly.
      if (confirm !== true) {
        return reply.code(400).send({ error: "discard requires confirm: true" });
      }

      const git = engine.git(cwd);
      if (!hasDiscardOps(git)) {
        // Engine hasn't grown discardFile/discardAll yet (see NOTE above). Surface
        // a clear 501 rather than silently no-op-ing a destructive request.
        return reply.code(501).send({ error: "discard not supported by engine" });
      }

      // Per file when a list is given; otherwise the whole working tree. Stop at the
      // first failure and report it so the face can show *why* (e.g. not a repo).
      if (files && files.length > 0) {
        for (const file of files) {
          const res = await git.discardFile(file);
          if (!res.ok) {
            return reply
              .code(502)
              .send({ error: res.error || `failed to discard ${file}` });
          }
        }
      } else {
        const res = await git.discardAll();
        if (!res.ok) {
          return reply.code(502).send({ error: res.error || "failed to discard" });
        }
      }

      return git.status() as Promise<GitStatus | null>;
    },
  );
}
