/**
 * Permissions REST surface — the allow/ask/deny rules Claude Code enforces.
 *
 * READ (GET /api/permissions): the *merged* view across the settings.json layers
 * (global < project < project-local), read through the engine config module so we
 * see exactly what the engine sees. An optional `cwd` adds the project layers.
 *
 * WRITE (PUT /api/permissions): add or remove a single rule, persisted to the USER
 * settings.json (~/.claude/settings.json). We only ever touch that one file, and
 * we follow the engine's safe-write contract: VALIDATE the rule, write a `<file>.bak`
 * backup of the prior file, then write atomically (temp file + rename). Every other
 * key in settings.json is preserved untouched.
 *
 * Why the write helper lives here and not in the engine: this package owns its own
 * HTTP boundary, and the user settings.json is a *config* file (never a transcript),
 * so the narrow, validated write is safe to perform from the server. The read side
 * still goes through the engine config module so the layering logic stays single-sourced.
 */
import { readFile, writeFile, copyFile, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";
import { config, paths } from "@devhub/engine";

/** The three rule buckets (deny wins, then ask, then allow). */
type RuleAction = "allow" | "ask" | "deny";
const RULE_ACTIONS: readonly RuleAction[] = ["allow", "ask", "deny"];

/** Path to the USER settings.json — the single file PUT ever writes. */
function userSettingsPath(): string {
  return path.join(paths.claudeConfigDir(), "settings.json");
}

// ---- Safe write (validate -> .bak backup -> atomic rename) -----------------

/** Read + JSON.parse a file, tolerating a missing/corrupt file (returns {}). */
async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Back up `file` to `<file>.bak` when it exists (no-op when absent). */
async function backup(file: string): Promise<void> {
  try {
    await stat(file);
  } catch {
    return;
  }
  await copyFile(file, `${file}.bak`);
}

/** Atomic write: temp file in the same dir, then rename over the target. */
async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

// Control chars (U+0000–U+001F and U+007F) are rejected so a rule can't smuggle
// newlines / corrupt the settings file. Escaped form keeps the source ASCII-clean.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * A permission rule is a non-empty, single-line string with no control chars,
 * e.g. `Bash(git status:*)` or `Read(~/.zshrc)`. Validation stays permissive on the
 * *inner* matcher syntax (Claude Code owns that grammar) but rejects obviously
 * malformed values that would corrupt the settings file.
 */
function validateRule(rule: unknown): string {
  if (typeof rule !== "string") throw new Error("rule must be a string");
  const trimmed = rule.trim();
  if (!trimmed) throw new Error("rule must be non-empty");
  if (trimmed.length > 1000) throw new Error("rule too long");
  if (CONTROL_CHARS.test(trimmed)) throw new Error("rule contains control characters");
  return trimmed;
}

/**
 * Apply one add/remove of `rule` in the `action` bucket to the USER settings.json.
 * Returns the new `{ allow, ask, deny }` lists for that file (de-duplicated). The
 * other two buckets and every unrelated key are preserved.
 */
async function writeUserPermissionRule(
  action: RuleAction,
  rule: string,
  op: "add" | "remove",
): Promise<{ allow: string[]; ask: string[]; deny: string[] }> {
  const file = userSettingsPath();
  const cfg = await readJsonObject(file);

  const permsRaw = cfg.permissions;
  const perms: Record<string, unknown> =
    permsRaw && typeof permsRaw === "object" && !Array.isArray(permsRaw)
      ? (permsRaw as Record<string, unknown>)
      : {};

  const result = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  for (const a of RULE_ACTIONS) {
    const list = perms[a];
    result[a] = Array.isArray(list)
      ? list.filter((x): x is string => typeof x === "string")
      : [];
  }

  if (op === "add") {
    if (!result[action].includes(rule)) result[action] = [...result[action], rule];
  } else {
    result[action] = result[action].filter((r) => r !== rule);
  }

  // Write back the three buckets, preserving any other permission keys (e.g.
  // defaultMode, additionalDirectories) the engine doesn't surface.
  perms.allow = result.allow;
  perms.ask = result.ask;
  perms.deny = result.deny;
  cfg.permissions = perms;

  await backup(file);
  await atomicWrite(file, JSON.stringify(cfg, null, 2) + "\n");
  return result;
}

// ---- Schemas ---------------------------------------------------------------

const getQuerySchema = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
  },
} as const;

const putBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "rule", "op"],
  properties: {
    action: { type: "string", enum: ["allow", "ask", "deny"] },
    rule: { type: "string", minLength: 1, maxLength: 1000 },
    op: { type: "string", enum: ["add", "remove"] },
  },
} as const;

// ---- Routes ----------------------------------------------------------------

/**
 * Wire GET/PUT /api/permissions onto an app.
 *
 *  - GET  → merged allow/ask/deny across the settings.json layers (+ contributing
 *           source paths). `cwd` (or `projectId`, validated against known projects)
 *           adds the project + project-local layers; without it you get the global
 *           layer only.
 *  - PUT  → add/remove one rule in the USER settings.json (safe-write w/ .bak).
 */
export function registerPermissionsRoutes(app: FastifyInstance, engine: Engine): void {
  /** Resolve an optional cwd/projectId to a known project cwd (or undefined). */
  const resolveCwd = (q: { cwd?: string; projectId?: string }): string | undefined => {
    const projects = engine.getProjects({ includeArchived: true });
    if (q.projectId) {
      return projects.find((pr) => pr.id === q.projectId)?.cwd;
    }
    if (q.cwd) {
      return projects.some((pr) => pr.cwd === q.cwd) ? q.cwd : undefined;
    }
    return undefined;
  };

  app.get<{ Querystring: { cwd?: string; projectId?: string } }>(
    "/api/permissions",
    { schema: { querystring: getQuerySchema } },
    async (req, reply) => {
      // If a project param was given but didn't resolve, it's an unknown project.
      if ((req.query.cwd || req.query.projectId) && !resolveCwd(req.query)) {
        return reply.code(400).send({ error: "unknown project" });
      }
      const cwd = resolveCwd(req.query);
      const settings = await config.readSettings(cwd);
      return {
        permissions: settings.permissions,
        sources: settings.sources,
        scope: cwd ? "project" : "global",
      };
    },
  );

  app.put<{ Body: { action: RuleAction; rule: string; op: "add" | "remove" } }>(
    "/api/permissions",
    { schema: { body: putBodySchema } },
    async (req, reply) => {
      let rule: string;
      try {
        rule = validateRule(req.body.rule);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const result = await writeUserPermissionRule(req.body.action, rule, req.body.op);
      return { ok: true, file: userSettingsPath(), permissions: result };
    },
  );
}
