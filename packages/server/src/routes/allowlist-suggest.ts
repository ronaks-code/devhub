/**
 * Permission-allowlist SUGGESTIONS from observed Bash usage.
 *
 *   GET /api/permissions/suggest?cwd=&projectId=&limit=
 *     → a de-duplicated, COUNT-ranked list of suggested `allow` rules derived from
 *       the Bash commands this index has actually seen, e.g.
 *         [{ rule: "Bash(git:*)", prefix: "git", count: 42, samples: [...] }, ...]
 *
 * WHY: hand-curating the permissions allowlist is tedious. The engine already
 * mirrors every `tool_use` block for search (a Bash call is stored as the row
 * `"Bash: <command>"`, role="tool", toolName="Bash"), so we can mine those rows for
 * the command prefixes the user runs most and PROPOSE allowlist entries for them.
 *
 * This route ONLY SUGGESTS — it never writes. The user applies a suggestion through
 * the existing PUT /api/permissions (which does the safe, backed-up settings write).
 * Suggestions already covered by the current merged allowlist (optionally layered by
 * `cwd`/`projectId`, exactly like GET /api/permissions) are filtered out, so we only
 * surface NEW rules worth adding.
 *
 * Implemented entirely on existing engine APIs:
 *   • `engine.search("", { toolName:"Bash", role:"tool", limit })` — recent sessions
 *     that used Bash (one best row per session), to discover candidate sessions.
 *   • `engine.searchInSession(sessionId, "Bash", { limit })` — EVERY Bash row within a
 *     session, so a heavily-scripted session contributes all of its commands, not just
 *     one. (`searchInSession` is read via the same in-package structural type the
 *     session-search route uses — see note below.)
 *   • `config.readSettings(cwd)` — the merged allowlist, to drop already-allowed rules.
 */
import type { FastifyInstance } from "fastify";
import type { Engine, SearchHit } from "@claude-ui/engine";
import { config } from "@claude-ui/engine";

/**
 * The session-scoped search method we rely on. `Engine.searchInSession` exists at
 * runtime (and on the current `Engine` type), but to stay resilient to type drift
 * across concurrently-landing lanes we call through a narrow in-package structural
 * type — mirroring `routes/search.ts`. No `.d.ts` shim, no engine edit.
 */
interface SessionSearchEngine {
  searchInSession(
    sessionId: string,
    query: string,
    opts?: { limit?: number },
  ): SearchHit[];
}

/** How many recent Bash-using sessions to mine, and how many rows to pull per session. */
const MAX_SESSIONS = 200;
const ROWS_PER_SESSION = 500;
/** Cap on returned suggestions and on the per-rule sample list. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SAMPLES = 3;

/**
 * Commands whose FIRST word alone is too coarse to be a useful allowlist prefix —
 * the meaningful unit is "<command> <subcommand>" (e.g. `git status`, `npm run`).
 * For these we prefer a two-word prefix when a plausible subcommand follows. Mirrors
 * the granularity of the hand-written rules already in the user's settings
 * (`Bash(npm run:*)`, `Bash(gh pr:*)`, `Bash(brew install:*)`).
 */
const TWO_WORD_COMMANDS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "gh",
  "brew",
  "apt",
  "apt-get",
  "pip",
  "pip3",
  "poetry",
  "make",
  "terraform",
]);

/**
 * Shell control keywords / builtins that frequently LEAD a compound command (e.g.
 * `for f in ...; do`, `set -euo`, `if [ ... ]`). They aren't program names, so they
 * make poor — even misleading — allowlist prefixes, and we drop them.
 */
const SHELL_KEYWORDS = new Set([
  "for",
  "while",
  "until",
  "do",
  "done",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "case",
  "esac",
  "set",
  "export",
  "unset",
  "local",
  "function",
  "return",
  "exit",
  "source",
  "eval",
  "exec",
  "trap",
  "shift",
  "read",
  "test",
]);

/** A subcommand-looking token: a short, plain word (not a flag/path/glob/var). */
function isPlainSubcommand(tok: string): boolean {
  return /^[a-z][a-z0-9:_-]{0,30}$/i.test(tok);
}

/**
 * Reduce a raw Bash command line to a stable allowlist PREFIX, or null when it has
 * no usable head (empty, an env-assignment, a bare path, a subshell, a shell keyword,
 * etc.). The prefix is the command name, extended to "<cmd> <sub>" for
 * {@link TWO_WORD_COMMANDS} when a plain subcommand follows. We deliberately stay
 * conservative: anything that doesn't start with a simple command word yields null
 * and is ignored.
 */
function commandPrefix(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  // Split on whitespace; the first token must look like a bare command name. Reject
  // leading redirects/subshells/pipes/vars (`(`, `VAR=...`, `./x`, `/abs`, `$x`).
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0]!;
  if (!/^[a-z][a-z0-9._-]*$/i.test(head)) return null;
  if (SHELL_KEYWORDS.has(head.toLowerCase())) return null;

  if (TWO_WORD_COMMANDS.has(head.toLowerCase())) {
    const sub = tokens[1];
    if (sub && isPlainSubcommand(sub)) return `${head} ${sub}`;
  }
  return head;
}

/**
 * Pull the command out of a stored Bash row's snippet, returning "" for anything
 * that isn't a Bash tool_use row. The mirrored text is `"Bash: <command>"`, but a
 * snippet can arrive in two shapes:
 *   • clean (facets-only / LIKE path):  `Bash: <command>`
 *   • FTS-highlighted (session path):   `[Bash]: <command…>`  (the matched token
 *     "Bash" wrapped in the `[`/`]` highlight delimiters, and the tail elided with
 *     `…` after a few tokens).
 * We accept both, strip the highlight delimiters, and drop a trailing ellipsis. The
 * head (the command prefix we actually care about) survives the FTS truncation
 * because the snippet is centered on the leading "Bash" match.
 */
function extractCommand(text: string): string {
  const m = /^\[?Bash\]?:\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return "";
  // Remove FTS highlight delimiters and a trailing elision marker.
  return m[1]!.replace(/[[\]]/g, "").replace(/…\s*$/, "").trim();
}

/** One ranked suggestion. */
interface Suggestion {
  /** The ready-to-apply permission rule, e.g. `Bash(git status:*)`. */
  rule: string;
  /** The bare command prefix the rule allows, e.g. `git status`. */
  prefix: string;
  /** How many observed Bash calls matched this prefix. */
  count: number;
  /** A few distinct observed command lines for this prefix (capped, truncated). */
  samples: string[];
}

const suggestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
} as const;

interface SuggestQuery {
  cwd?: string;
  projectId?: string;
  limit?: number;
}

/**
 * Wire GET /api/permissions/suggest onto an app. Read-only: it mines observed Bash
 * usage and proposes allowlist rules; it never persists anything.
 */
export function registerAllowlistSuggestRoutes(app: FastifyInstance, engine: Engine): void {
  /** Resolve an optional cwd/projectId to a known project cwd (mirrors permissions.ts). */
  const resolveCwd = (q: { cwd?: string; projectId?: string }): string | undefined => {
    const projects = engine.getProjects({ includeArchived: true });
    if (q.projectId) return projects.find((pr) => pr.id === q.projectId)?.cwd;
    if (q.cwd) return projects.some((pr) => pr.cwd === q.cwd) ? q.cwd : undefined;
    return undefined;
  };

  app.get<{ Querystring: SuggestQuery }>(
    "/api/permissions/suggest",
    { schema: { querystring: suggestSchema } },
    async (req, reply) => {
      // A project param that doesn't resolve is an unknown project (same as GET
      // /api/permissions). A blank/absent param means "global" — no project layer.
      if ((req.query.cwd || req.query.projectId) && !resolveCwd(req.query)) {
        return reply.code(400).send({ error: "unknown project" });
      }
      const cwd = resolveCwd(req.query);
      const limit = Math.max(1, Math.min(req.query.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

      // Already-allowed Bash rules, layered by the optional project — so we don't
      // re-suggest something the merged allowlist already covers.
      const settings = await config.readSettings(cwd);
      const allowed = new Set(
        (settings.permissions?.allow ?? []).map((r) => r.trim()),
      );

      // 1) Recent sessions that used Bash (one row per session is enough to find them).
      const sessionHits = engine.search("", {
        toolName: "Bash",
        role: "tool",
        limit: MAX_SESSIONS,
      });
      const sessionIds = [...new Set(sessionHits.map((h) => h.sessionId))];

      // 2) Tally by prefix. We feed two sources through one `note`:
      //   a) the clean, one-per-session cross-session hits (full, un-highlighted text);
      //   b) every Bash row WITHIN each session (more volume; FTS may highlight/elide
      //      the snippet, which `extractCommand` normalizes).
      const sessionSearch = engine as unknown as SessionSearchEngine;
      const counts = new Map<string, { count: number; samples: string[] }>();
      const note = (prefix: string, command: string) => {
        let entry = counts.get(prefix);
        if (!entry) {
          entry = { count: 0, samples: [] };
          counts.set(prefix, entry);
        }
        entry.count += 1;
        // Keep a few DISTINCT short samples for UI context.
        if (entry.samples.length < MAX_SAMPLES && !entry.samples.includes(command)) {
          entry.samples.push(command.slice(0, 120));
        }
      };
      // Assistant tool_use rows are mirrored as "Bash: <command>"; the matching
      // tool_result bodies are stored as raw result text (no "Bash:" head), so
      // `extractCommand` naturally skips them — `SearchHit` doesn't surface the
      // toolName column to filter on directly.
      const tally = (hit: SearchHit) => {
        const command = extractCommand(hit.snippet ?? "");
        if (!command) return;
        const prefix = commandPrefix(command);
        if (!prefix) return;
        note(prefix, command);
      };

      for (const hit of sessionHits) tally(hit);
      for (const sessionId of sessionIds) {
        const rows = sessionSearch.searchInSession(sessionId, "Bash", {
          limit: ROWS_PER_SESSION,
        });
        for (const row of rows) tally(row);
      }

      // 3) Rank by observed count (desc), then prefix (asc) for a stable order; drop
      // prefixes the merged allowlist already covers; cap to `limit`.
      const suggestions: Suggestion[] = [...counts.entries()]
        .map(([prefix, { count, samples }]) => ({
          rule: `Bash(${prefix}:*)`,
          prefix,
          count,
          samples,
        }))
        .filter((s) => !allowed.has(s.rule))
        .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix))
        .slice(0, limit);

      return {
        scope: cwd ? "project" : "global",
        observedSessions: sessionIds.length,
        suggestions,
      };
    },
  );
}
