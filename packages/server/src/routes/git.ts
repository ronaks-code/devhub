/**
 * Git REST surface. Each route is a thin pass-through to the engine's GitService
 * for a project working directory: status / diff / branches / log (read) plus
 * stage / commit / branch (write) and an AI-drafted commit message.
 *
 * SECURITY — cwd allowlist: a `cwd` is only honored when it exactly matches a
 * known project's cwd from the engine (archived included). This is the whole
 * point of the gate: without it, anyone hitting these endpoints could run git
 * in an arbitrary directory on the host. An unknown cwd is rejected with 400.
 * The write endpoints share the SAME allowlist as the read ones — git mutations
 * are only ever permitted inside a project we already know about.
 */
import type { FastifyInstance } from "fastify";
import { createDriver, type Engine } from "@devhub/engine";

/** Querystring requiring only a `cwd` (status / branches). */
const cwdSchema = {
  type: "object",
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
  },
} as const;

/** Querystring for diff: a required `cwd` plus an optional `file` to scope it. */
const diffSchema = {
  type: "object",
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    file: { type: "string" },
  },
} as const;

/** Querystring for log: a required `cwd` plus an optional commit `limit`. */
const logSchema = {
  type: "object",
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 20 },
  },
} as const;

/** Body for stage: a `cwd` plus the paths to add to the index. */
const stageSchema = {
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
 * Body for commit: a `cwd` and a non-empty `message`. `all` (`-a`) stages
 * tracked-file modifications first, mirroring `git commit -a`.
 */
const commitSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd", "message"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    all: { type: "boolean", default: false },
  },
} as const;

/** Body for branch: a `cwd`, the new branch `name`, and whether to check it out. */
const branchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd", "name"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    checkout: { type: "boolean", default: false },
  },
} as const;

/** Body for the AI commit-message draft: just a `cwd` (diff is read server-side). */
const suggestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
  },
} as const;

/**
 * Body for adding a worktree: a `cwd` (the main repo), a target `path` for the new
 * worktree, plus an optional `branch` to check out there OR `newBranch` to create.
 */
const addWorktreeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd", "path"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    branch: { type: "string", minLength: 1 },
    newBranch: { type: "string", minLength: 1 },
  },
} as const;

/** Body for removing a worktree: a `cwd` (the main repo), the worktree `path`, optional `force`. */
const removeWorktreeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd", "path"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    force: { type: "boolean", default: false },
  },
} as const;

/**
 * Cap on the staged-diff text handed to the model. A commit message only needs
 * the gist of the change, and an unbounded diff would blow the prompt budget, so
 * we send at most this many bytes (truncated, with a marker).
 */
const MAX_SUGGEST_DIFF_BYTES = 12 * 1024;

/**
 * Wire the read-only git routes onto an app, backed by the engine. The allowlist
 * is recomputed per request (cheap, in-memory) so a project added at runtime is
 * immediately reachable without a server restart.
 */
export function registerGitRoutes(app: FastifyInstance, engine: Engine): void {
  /** True when `cwd` is a known project path (archived projects included). */
  const isKnownCwd = (cwd: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.cwd === cwd);

  app.get<{ Querystring: { cwd: string } }>(
    "/api/git/status",
    { schema: { querystring: cwdSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).status();
    },
  );

  app.get<{ Querystring: { cwd: string; file?: string } }>(
    "/api/git/diff",
    { schema: { querystring: diffSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).diff(req.query.file);
    },
  );

  app.get<{ Querystring: { cwd: string } }>(
    "/api/git/branches",
    { schema: { querystring: cwdSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).branchList();
    },
  );

  app.get<{ Querystring: { cwd: string; limit?: number } }>(
    "/api/git/log",
    { schema: { querystring: logSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).log(req.query.limit ?? 20);
    },
  );

  // -- Writes (same cwd allowlist as the reads above) ------------------------

  app.post<{ Body: { cwd: string; files: string[] } }>(
    "/api/git/stage",
    { schema: { body: stageSchema } },
    async (req, reply) => {
      const { cwd, files } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      await engine.git(cwd).stage(files);
      return engine.git(cwd).status();
    },
  );

  app.post<{ Body: { cwd: string; message: string; all?: boolean } }>(
    "/api/git/commit",
    { schema: { body: commitSchema } },
    async (req, reply) => {
      const { cwd, message, all } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      // Schema enforces minLength, but a whitespace-only message would still slip
      // through — reject it so we never create an empty-subject commit.
      if (message.trim().length === 0) {
        return reply.code(400).send({ error: "empty commit message" });
      }
      return engine.git(cwd).commit(message, { all: all === true });
    },
  );

  app.post<{ Body: { cwd: string; name: string; checkout?: boolean } }>(
    "/api/git/branch",
    { schema: { body: branchSchema } },
    async (req, reply) => {
      const { cwd, name, checkout } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const created = await engine.git(cwd).createBranch(name);
      if (created.ok && checkout === true) await engine.git(cwd).checkoutBranch(name);
      return engine.git(cwd).branchList();
    },
  );

  // AI-drafted conventional-commit message from the *staged* diff. We read the
  // diff server-side (capped), then run a single planning-mode turn that is asked
  // for ONLY the message — no commands run, nothing is committed.
  app.post<{ Body: { cwd: string } }>(
    "/api/git/suggest-message",
    { schema: { body: suggestSchema } },
    async (req, reply) => {
      const { cwd } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }

      const diff = await engine.git(cwd).diff();
      const patch = diff?.patch?.trim() ?? "";
      if (patch.length === 0) {
        return reply.code(400).send({ error: "no changes to summarize" });
      }

      const capped =
        patch.length > MAX_SUGGEST_DIFF_BYTES
          ? patch.slice(0, MAX_SUGGEST_DIFF_BYTES) + "\n…(diff truncated)…"
          : patch;

      const prompt = [
        "Write a single Conventional Commits message for the following git diff.",
        "Output ONLY the commit message: a concise one-line subject (<=72 chars,",
        "type(scope): summary, imperative mood) and an OPTIONAL short body after a",
        "blank line. No code fences, no preamble, no explanation.",
        "",
        "```diff",
        capped,
        "```",
      ].join("\n");

      const turn = createDriver().runTurn(
        { cwd, prompt, permissionMode: "plan", includePartial: false },
        {},
      );
      const result = await turn.done;
      const message = result?.resultText?.trim() ?? "";
      if (!message) {
        return reply.code(502).send({ error: "could not draft a message" });
      }
      return { message };
    },
  );

  // -- Worktrees (same cwd allowlist as the reads/writes above) ----------------
  //
  // `git worktree` lets one repo have several working trees checked out at once
  // (e.g. a branch per feature on disk). These three routes pass through to the
  // engine's GitService worktree methods. add/remove return a typed result; we map
  // a failure to 502 with the git error rather than throwing, then re-list so the
  // face gets the fresh worktree set in one round-trip.

  app.get<{ Querystring: { cwd: string } }>(
    "/api/git/worktrees",
    { schema: { querystring: cwdSchema } },
    async (req, reply) => {
      if (!isKnownCwd(req.query.cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      return engine.git(req.query.cwd).listWorktrees();
    },
  );

  app.post<{ Body: { cwd: string; path: string; branch?: string; newBranch?: string } }>(
    "/api/git/worktree",
    { schema: { body: addWorktreeSchema } },
    async (req, reply) => {
      const { cwd, path, branch, newBranch } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const git = engine.git(cwd);
      const res = await git.addWorktree(path, { branch, newBranch });
      if (!res.ok) {
        return reply.code(502).send({ error: res.error || "failed to add worktree" });
      }
      return git.listWorktrees();
    },
  );

  app.delete<{ Body: { cwd: string; path: string; force?: boolean } }>(
    "/api/git/worktree",
    { schema: { body: removeWorktreeSchema } },
    async (req, reply) => {
      const { cwd, path, force } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const git = engine.git(cwd);
      const res = await git.removeWorktree(path, { force: force === true });
      if (!res.ok) {
        return reply.code(502).send({ error: res.error || "failed to remove worktree" });
      }
      return git.listWorktrees();
    },
  );
}
