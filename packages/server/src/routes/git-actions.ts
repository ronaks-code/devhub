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
 *
 * SYNC (fetch / pull / push): network-touching git ops that move commits between
 * the local repo and its remote. Same cwd allowlist as everything else here; each
 * returns the FRESH status() after the op so the face can re-render ahead/behind in
 * one round-trip. These forward to engine GitService methods that aren't typed yet
 * (see the GitSyncOps NOTE below) via the same runtime-lookup pattern as discard.
 */
import type { FastifyInstance } from "fastify";
import type { Engine, GitService, GitStatus, GitWriteResult } from "@devhub/engine";

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

/** Body for fetch: just a `cwd` (refresh remote-tracking refs, no merge). */
const fetchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
  },
} as const;

/** Body for pull: a `cwd` plus an optional `rebase` (use `--rebase` instead of merge). */
const pullSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    rebase: { type: "boolean" },
  },
} as const;

/**
 * Body for push: a `cwd` plus an optional `setUpstream` (`-u`, to link the current
 * branch to its remote on first push). We deliberately DON'T accept a refspec or a
 * `--force` flag — push only ever uses the repo's configured remote/branch.
 */
const pushSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    setUpstream: { type: "boolean" },
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
 * The remote-sync methods the engine's GitService is EXPECTED to grow but does not
 * expose yet. We forward to them when present and fall back to a typed 501 otherwise,
 * so the routes typecheck and degrade gracefully — same pattern as discard above.
 *
 * NOTE (missing engine symbols): add `fetch()`, `pull(opts?: { rebase?: boolean })`,
 * and `push(opts?: { setUpstream?: boolean })` to `GitService` (engine/src/git.ts),
 * each returning `Promise<GitWriteResult>` (guarding a non-git dir like the other
 * writes, running `git fetch` / `git pull [--rebase]` / `git push [-u]` with no
 * shell). Then replace this runtime lookup with direct typed calls
 * (`engine.git(cwd).fetch()` / `.pull({ rebase })` / `.push({ setUpstream })`).
 */
interface GitSyncOps {
  fetch(): Promise<GitWriteResult>;
  pull(opts?: { rebase?: boolean }): Promise<GitWriteResult>;
  push(opts?: { setUpstream?: boolean }): Promise<GitWriteResult>;
}

/** True when `git` carries the (not-yet-typed) sync methods at runtime. */
function hasSyncOps(git: GitService): git is GitService & GitSyncOps {
  const g = git as unknown as Record<string, unknown>;
  return (
    typeof g.fetch === "function" &&
    typeof g.pull === "function" &&
    typeof g.push === "function"
  );
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

  // -- Remote sync (fetch / pull / push) -------------------------------------
  //
  // Network-touching ops behind the same cwd allowlist. Each forwards to the engine's
  // (not-yet-typed) GitService sync method via `hasSyncOps`; if the engine hasn't
  // grown them yet we return a clear 501 rather than silently doing nothing. On
  // success we return the FRESH status() so the face re-renders ahead/behind in one
  // round-trip; a git failure (no remote, auth, conflict) is a typed 502 with the
  // git error so the face can show *why*.

  // Fetch: refresh remote-tracking refs (no working-tree change). The ahead/behind in
  // the returned status updates even though no merge happened.
  app.post<{ Body: { cwd: string } }>(
    "/api/git/fetch",
    { schema: { body: fetchSchema } },
    async (req, reply) => {
      const { cwd } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const git = engine.git(cwd);
      if (!hasSyncOps(git)) {
        return reply.code(501).send({ error: "fetch not supported by engine" });
      }
      const res = await git.fetch();
      if (!res.ok) {
        return reply.code(502).send({ error: res.error || "failed to fetch" });
      }
      return git.status();
    },
  );

  // Pull: integrate the remote into the current branch (merge by default, or rebase
  // when `{ rebase: true }`). A conflict surfaces as a typed 502 with git's message.
  app.post<{ Body: { cwd: string; rebase?: boolean } }>(
    "/api/git/pull",
    { schema: { body: pullSchema } },
    async (req, reply) => {
      const { cwd, rebase } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const git = engine.git(cwd);
      if (!hasSyncOps(git)) {
        return reply.code(501).send({ error: "pull not supported by engine" });
      }
      const res = await git.pull({ rebase: rebase === true });
      if (!res.ok) {
        return reply.code(502).send({ error: res.error || "failed to pull" });
      }
      return git.status();
    },
  );

  // Push: publish local commits to the configured remote. `{ setUpstream: true }`
  // links the current branch to its remote on first push (`-u`). A rejected push
  // (non-fast-forward, no upstream, auth) surfaces as a typed 502.
  app.post<{ Body: { cwd: string; setUpstream?: boolean } }>(
    "/api/git/push",
    { schema: { body: pushSchema } },
    async (req, reply) => {
      const { cwd, setUpstream } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const git = engine.git(cwd);
      if (!hasSyncOps(git)) {
        return reply.code(501).send({ error: "push not supported by engine" });
      }
      const res = await git.push({ setUpstream: setUpstream === true });
      if (!res.ok) {
        return reply.code(502).send({ error: res.error || "failed to push" });
      }
      return git.status();
    },
  );
}
