/**
 * One-click pull request: POST /api/pr { cwd, base? }
 *
 * The flow, all server-side:
 *   1. Push the current branch to its remote (`git push -u origin <branch>`).
 *   2. Draft a PR title + body with a single planning-mode model turn over the
 *      branch's commits + diff against `base` (NOTHING is run/committed by the
 *      model — plan mode).
 *   3. Open the PR with the `gh` CLI (`gh pr create --title --body --base`).
 *
 * SECURITY — cwd allowlist: identical gate to routes/git.ts. A `cwd` is only
 * honored when it exactly matches a known project's cwd (archived included), so
 * these endpoints can never push/PR from an arbitrary host directory.
 *
 * ROBUSTNESS: `gh` may be missing or unauthenticated. We NEVER let that crash the
 * server — a missing/unauthed/failed `gh` (or a failed push) returns a 4xx/5xx
 * with a clear `error` string the face can show, not a thrown 500 stack.
 *
 * We shell out with execFile (NO shell): every arg is an array element, so a
 * branch name / title / body can't be interpreted as shell syntax.
 */
import type { FastifyInstance } from "fastify";
import { createDriver, type Engine } from "@claude-ui/engine";
import { execFile } from "node:child_process";

/** Body for the PR endpoint: a `cwd` plus an optional `base` branch. */
const prSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
  },
} as const;

interface PrBody {
  cwd: string;
  base?: string;
}

/** Safety timeout for a single git/gh invocation. */
const EXEC_TIMEOUT_MS = 30_000;
/** Cap on the diff text handed to the model when drafting the PR body. */
const MAX_PR_DIFF_BYTES = 16 * 1024;
/** Cap on commit-subject text fed to the model. */
const MAX_PR_LOG_BYTES = 4 * 1024;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the binary itself could not be spawned (ENOENT — not installed). */
  notFound: boolean;
}

/**
 * Run `<cmd> <args>` in `cwd`, capturing both streams + exit status. NEVER rejects:
 * a non-zero exit is `ok:false` with stderr; a missing binary is `notFound:true`.
 */
function run(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (stdout ?? "").trim();
        const errOut = (stderr ?? "").trim();
        if (err) {
          // ENOENT => the command isn't on PATH (e.g. `gh` not installed).
          const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
          resolve({ ok: false, stdout: out, stderr: errOut || err.message.trim(), notFound });
          return;
        }
        resolve({ ok: true, stdout: out, stderr: errOut, notFound: false });
      },
    );
  });
}

/** Extract the PR url from `gh pr create` stdout (it prints the URL on success). */
function extractUrl(stdout: string): string | null {
  const m = stdout.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

/**
 * Build the model prompt for drafting a PR title + body from the branch's commits
 * and diff. Asks for a strict, machine-parsable shape (first line = title, rest =
 * body) so we can split it deterministically.
 */
function buildPrompt(branch: string, base: string, log: string, diff: string): string {
  return [
    `Draft a GitHub pull request for branch "${branch}" merging into "${base}".`,
    "Output EXACTLY this shape and nothing else:",
    "  - The FIRST line is the PR title (concise, imperative, <=72 chars, no prefix).",
    "  - A blank line.",
    "  - Then a short markdown body: a one-paragraph summary plus a brief",
    "    bullet list of the key changes. No code fences around the whole thing,",
    "    no preamble, no sign-off.",
    "",
    "Commits on this branch:",
    "```",
    log || "(no commit subjects available)",
    "```",
    "",
    "Diff against base:",
    "```diff",
    diff || "(diff unavailable or empty)",
    "```",
  ].join("\n");
}

/** Split the model output into a title (first non-empty line) + body (the rest). */
function splitTitleBody(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const title = (lines[i] ?? "").trim();
  const body = lines
    .slice(i + 1)
    .join("\n")
    .trim();
  return { title, body };
}

/**
 * Wire POST /api/pr onto an app. The allowlist is recomputed per request (cheap,
 * in-memory) so a project added at runtime is reachable without a restart.
 */
export function registerPrRoutes(app: FastifyInstance, engine: Engine): void {
  const isKnownCwd = (cwd: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.cwd === cwd);

  app.post<{ Body: PrBody }>(
    "/api/pr",
    { schema: { body: prSchema } },
    async (req, reply) => {
      const { cwd } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }

      const git = engine.git(cwd);
      const status = await git.status();
      if (!status) {
        return reply.code(400).send({ error: "not a git repository" });
      }
      const branch = status.branch;
      if (!branch) {
        return reply.code(400).send({ error: "detached HEAD — checkout a branch first" });
      }

      // Resolve the base branch: explicit > a sensible default. We don't assume
      // "main" exists, but it's the overwhelming convention and gh validates it.
      const base = req.body.base?.trim() || "main";
      if (base === branch) {
        return reply.code(400).send({ error: "base and head are the same branch" });
      }

      // 1) Push the branch (set upstream). A failure here (no remote, auth, etc.)
      //    is surfaced verbatim rather than crashing.
      const push = await run("git", ["push", "-u", "origin", branch], cwd);
      if (!push.ok) {
        if (push.notFound) {
          return reply.code(500).send({ error: "git is not installed or not on PATH" });
        }
        return reply.code(502).send({ error: `git push failed: ${push.stderr}` });
      }

      // 2) Draft title + body from the branch's commits + diff vs base. Best-effort:
      //    if the model turn fails we fall back to a minimal title so the PR still opens.
      const logRes = await run(
        "git",
        ["log", `${base}..${branch}`, "--pretty=format:- %s"],
        cwd,
      );
      const diffRes = await run("git", ["diff", `${base}...${branch}`], cwd);
      const log = (logRes.ok ? logRes.stdout : "").slice(0, MAX_PR_LOG_BYTES);
      let diff = diffRes.ok ? diffRes.stdout : "";
      if (diff.length > MAX_PR_DIFF_BYTES) {
        diff = diff.slice(0, MAX_PR_DIFF_BYTES) + "\n…(diff truncated)…";
      }

      let title = `Merge ${branch} into ${base}`;
      let body = "";
      try {
        const turn = createDriver().runTurn(
          {
            cwd,
            prompt: buildPrompt(branch, base, log, diff),
            permissionMode: "plan",
            includePartial: false,
          },
          {},
        );
        const result = await turn.done;
        const drafted = result?.resultText?.trim() ?? "";
        if (drafted) {
          const split = splitTitleBody(drafted);
          if (split.title) title = split.title;
          body = split.body;
        }
      } catch {
        // Drafting is best-effort; keep the fallback title and an empty body.
      }

      // 3) Open the PR with gh. `--body-file -` is avoided (stdin plumbing); a body
      //    arg is fine since execFile passes it as a single literal. An empty body
      //    is allowed by gh, so pass at least a space-safe placeholder when blank.
      const args = ["pr", "create", "--base", base, "--head", branch, "--title", title];
      args.push("--body", body || title);
      const pr = await run("gh", args, cwd);
      if (!pr.ok) {
        if (pr.notFound) {
          return reply
            .code(500)
            .send({ error: "the GitHub CLI (`gh`) is not installed or not on PATH" });
        }
        const msg = pr.stderr || pr.stdout || "gh pr create failed";
        // gh emits a recognizable hint when the user isn't logged in.
        if (/auth|login|gh auth login|not logged/i.test(msg)) {
          return reply
            .code(401)
            .send({ error: `GitHub CLI is not authenticated — run \`gh auth login\`. (${msg})` });
        }
        return reply.code(502).send({ error: `gh pr create failed: ${msg}` });
      }

      const url = extractUrl(pr.stdout) ?? pr.stdout;
      return { url, title, base, head: branch };
    },
  );
}
