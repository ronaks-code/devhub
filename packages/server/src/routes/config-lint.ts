/**
 * Config LINT surface — a read-only health check over Claude Code's own
 * configuration files, so a settings UI can surface mistakes BEFORE they bite the
 * user at runtime (a hook that never fires, a permission rule the engine ignores,
 * an MCP server with no command).
 *
 *   GET /api/config/lint            → lint the GLOBAL config only
 *   GET /api/config/lint?cwd=...     → also lint that project's settings layers
 *   GET /api/config/lint?projectId=… → same, resolved from a known project id
 *
 * Returns `{ issues: [{ level, file, message }], ... }` where `level` is
 * "error" | "warning" | "info". An EMPTY issues list means everything we know how
 * to check looks well-formed — it is NOT a guarantee Claude Code will accept every
 * value (Claude Code owns the inner grammar of hooks / matchers / permission
 * rules); we only validate the SHAPES and cross-references we can see.
 *
 * What we check, per file:
 *   settings.json (user / project / local scopes, via the engine's scope-diff reader):
 *     - unknown TOP-LEVEL keys (likely typos, e.g. "permission" vs "permissions")
 *     - the `hooks` block: must be an object of event -> matcher-entry arrays; each
 *       entry needs a `hooks` array of `{ type, command }`; unknown event names are
 *       flagged; a `command` that points at a missing local script file is flagged
 *     - the `permissions` block: allow/ask/deny must be string arrays; rules must be
 *       single-line, non-empty, control-char-free, and look like `Tool(...)` /
 *       `Tool` / `mcp__server` (a loose check that catches obvious typos)
 *   ~/.claude.json:
 *     - `mcpServers` (global + the per-project block when a cwd is given): each entry
 *       must be an object; a stdio server needs a `command`; an sse/http server needs
 *       a `url`; an unknown `type` is flagged
 *
 * SECURITY — project allowlist: a `cwd`/`projectId` is resolved against the set of
 * KNOWN projects (archived included). An unknown project is rejected with 400, so we
 * never read config under an arbitrary host directory. This is READ-ONLY: it opens
 * config files and never writes anything.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import type { Engine, SettingsScopeName } from "@devhub/engine";
import { resolveSettings } from "@devhub/engine";

/** Severity of one lint finding. */
type LintLevel = "error" | "warning" | "info";

/** One lint finding: a level, the file it was found in, and a human message. */
interface LintIssue {
  level: LintLevel;
  /** Absolute path of the config file the issue is about. */
  file: string;
  message: string;
}

// ---- Known-shape tables ----------------------------------------------------

/**
 * Top-level keys Claude Code's settings.json is known to use. An unknown key is
 * surfaced as a WARNING (likely a typo) rather than an error — Claude Code may grow
 * new keys, and an extra key is harmless, just probably-a-mistake.
 */
const KNOWN_SETTINGS_KEYS = new Set<string>([
  "$schema",
  "apiKeyHelper",
  "cleanupPeriodDays",
  "env",
  "includeCoAuthoredBy",
  "permissions",
  "hooks",
  "model",
  "statusLine",
  "outputStyle",
  "forceLoginMethod",
  "forceLoginOrgUUID",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "awsAuthRefresh",
  "awsCredentialExport",
  "preferredNotifChannel",
  "autoUpdates",
  "autoUpdatesChannel",
  "verbose",
  "spinnerTipsEnabled",
  "alwaysThinkingEnabled",
  "disableAllHooks",
  "additionalDirectories",
  // UI / editor / theme preferences the CLI persists here.
  "theme",
  "editorMode",
  "effortLevel",
  // Plugins + marketplaces.
  "enabledPlugins",
  "extraKnownMarketplaces",
  // Notification toggles.
  "inputNeededNotifEnabled",
  "agentPushNotifEnabled",
  "voiceEnabled",
  // Permission-prompt / workflow suppression flags.
  "skipDangerousModePermissionPrompt",
  "skipAutoPermissionPrompt",
  "skipWorkflowUsageWarning",
]);

/**
 * Hook event names Claude Code dispatches. An unknown event name in the `hooks`
 * block means that hook NEVER fires, so it's a WARNING (a silent no-op the user
 * almost certainly didn't intend).
 */
const KNOWN_HOOK_EVENTS = new Set<string>([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
]);

/** The three permission buckets. */
const PERMISSION_BUCKETS = ["allow", "ask", "deny"] as const;

// Control chars (U+0000–U+001F and U+007F): a permission rule / hook command with
// one of these would corrupt the line, so we flag it.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** `~/.claude.json` — holds the mcpServers map (global + per-project). */
function claudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

// ---- Tolerant file read ----------------------------------------------------

/**
 * Read a config file and JSON.parse it. Returns:
 *   - `{ obj }`        on a valid top-level object
 *   - `{ obj: null, parseError }` when the file exists but is not parseable JSON
 *     (or not an object) — a finding the caller turns into an ERROR
 *   - `null`           when the file simply doesn't exist (nothing to lint)
 */
async function readConfigFile(
  file: string,
): Promise<{ obj: Record<string, unknown> | null; parseError?: string } | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null; // absent — not an issue
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { obj: null, parseError: (err as Error).message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { obj: null, parseError: "top-level value is not a JSON object" };
  }
  return { obj: parsed as Record<string, unknown> };
}

/** True when `p` resolves to an existing path on disk. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---- settings.json linting -------------------------------------------------

/**
 * Lint one settings.json object (already parsed). `dir` is the directory the file
 * lives in, used to resolve RELATIVE hook `command` script paths so we can flag a
 * referenced file that doesn't exist. Pushes findings onto `issues`.
 */
async function lintSettingsObject(
  file: string,
  dir: string,
  cfg: Record<string, unknown>,
  issues: LintIssue[],
): Promise<void> {
  // Unknown top-level keys -> probable typo.
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_SETTINGS_KEYS.has(key)) {
      issues.push({
        level: "warning",
        file,
        message: `unknown settings key "${key}" (possible typo; it will be ignored)`,
      });
    }
  }

  await lintHooksBlock(file, dir, cfg.hooks, issues);
  lintPermissionsBlock(file, cfg.permissions, issues);
}

/**
 * Validate the `hooks` block. Expected shape:
 *   { "<Event>": [ { matcher?: string, hooks: [ { type: "command", command: string } ] } ] }
 * Flags: a non-object block; an unknown event name; a non-array event value; a
 * malformed matcher entry; a hook missing `type`/`command`; and a `command` that
 * names a LOCAL script file (absolute, or `./` / `.claude/` relative) which is missing.
 */
async function lintHooksBlock(
  file: string,
  dir: string,
  hooks: unknown,
  issues: LintIssue[],
): Promise<void> {
  if (hooks === undefined) return; // no hooks configured — fine
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    issues.push({ level: "error", file, message: `"hooks" must be an object of event -> entries` });
    return;
  }

  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!KNOWN_HOOK_EVENTS.has(event)) {
      issues.push({
        level: "warning",
        file,
        message: `unknown hook event "${event}" (this hook will never fire)`,
      });
    }
    if (!Array.isArray(entries)) {
      issues.push({
        level: "error",
        file,
        message: `hook event "${event}" must be an array of matcher entries`,
      });
      continue;
    }
    for (const entry of entries) {
      await lintHookEntry(file, dir, event, entry, issues);
    }
  }
}

/** Validate one matcher entry within a hook event's array. */
async function lintHookEntry(
  file: string,
  dir: string,
  event: string,
  entry: unknown,
  issues: LintIssue[],
): Promise<void> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    issues.push({ level: "error", file, message: `"${event}" entry must be an object` });
    return;
  }
  const e = entry as Record<string, unknown>;
  if (e.matcher !== undefined && typeof e.matcher !== "string") {
    issues.push({ level: "error", file, message: `"${event}" entry "matcher" must be a string` });
  }
  const list = e.hooks;
  if (!Array.isArray(list)) {
    issues.push({
      level: "error",
      file,
      message: `"${event}" entry must have a "hooks" array`,
    });
    return;
  }
  for (const hook of list) {
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
      issues.push({ level: "error", file, message: `"${event}" hook must be an object` });
      continue;
    }
    const h = hook as Record<string, unknown>;
    if (h.type !== undefined && h.type !== "command") {
      issues.push({
        level: "warning",
        file,
        message: `"${event}" hook has unexpected type "${String(h.type)}" (expected "command")`,
      });
    }
    if (typeof h.command !== "string" || h.command.trim() === "") {
      issues.push({
        level: "error",
        file,
        message: `"${event}" hook is missing a non-empty "command"`,
      });
      continue;
    }
    if (CONTROL_CHARS.test(h.command)) {
      issues.push({
        level: "error",
        file,
        message: `"${event}" hook "command" contains control characters`,
      });
    }
    await checkHookCommandFile(file, dir, event, h.command, issues);
  }
}

/**
 * When a hook `command` clearly references a LOCAL script file, flag it if missing.
 * We only check the obvious cases (an absolute path, or a `./`/`../`/`.claude/`
 * relative path), taking the FIRST whitespace-delimited token as the program — a
 * shell one-liner like `jq . | foo` is left alone, since we can't safely resolve it.
 */
async function checkHookCommandFile(
  file: string,
  dir: string,
  event: string,
  command: string,
  issues: LintIssue[],
): Promise<void> {
  const first = command.trim().split(/\s+/)[0];
  if (!first) return;
  const looksLikePath =
    path.isAbsolute(first) ||
    first.startsWith("./") ||
    first.startsWith("../") ||
    first.startsWith(".claude/") ||
    first.startsWith("~/");
  if (!looksLikePath) return;

  const resolved = first.startsWith("~/")
    ? path.join(os.homedir(), first.slice(2))
    : path.isAbsolute(first)
      ? first
      : path.join(dir, first);

  if (!(await pathExists(resolved))) {
    issues.push({
      level: "error",
      file,
      message: `"${event}" hook command references a missing file: ${first}`,
    });
  }
}

/**
 * Validate the `permissions` block: allow/ask/deny must be string arrays of
 * well-formed rules. Claude Code owns the inner matcher grammar, so we stay loose:
 * a rule must be a non-empty single-line string and look like `Tool(...)`, a bare
 * `Tool`, or an `mcp__server` name — enough to catch obvious typos / malformed rows.
 */
function lintPermissionsBlock(file: string, permissions: unknown, issues: LintIssue[]): void {
  if (permissions === undefined) return; // no permissions configured — fine
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    issues.push({ level: "error", file, message: `"permissions" must be an object` });
    return;
  }
  const p = permissions as Record<string, unknown>;
  for (const bucket of PERMISSION_BUCKETS) {
    const list = p[bucket];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issues.push({
        level: "error",
        file,
        message: `"permissions.${bucket}" must be an array of rule strings`,
      });
      continue;
    }
    for (const rule of list) {
      lintPermissionRule(file, bucket, rule, issues);
    }
  }
}

/** A permission rule is roughly `Tool`, `Tool(matcher)`, or an `mcp__server` token. */
const RULE_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(\(.*\))?$/;

/** Validate a single permission rule string. */
function lintPermissionRule(
  file: string,
  bucket: string,
  rule: unknown,
  issues: LintIssue[],
): void {
  if (typeof rule !== "string") {
    issues.push({
      level: "error",
      file,
      message: `"permissions.${bucket}" contains a non-string rule`,
    });
    return;
  }
  const trimmed = rule.trim();
  if (!trimmed) {
    issues.push({ level: "error", file, message: `"permissions.${bucket}" has an empty rule` });
    return;
  }
  if (CONTROL_CHARS.test(rule)) {
    issues.push({
      level: "error",
      file,
      message: `"permissions.${bucket}" rule "${trimmed}" contains control characters`,
    });
    return;
  }
  // An unbalanced "(" usually means a truncated matcher (e.g. `Bash(git status`).
  const open = (trimmed.match(/\(/g) ?? []).length;
  const close = (trimmed.match(/\)/g) ?? []).length;
  if (open !== close) {
    issues.push({
      level: "warning",
      file,
      message: `"permissions.${bucket}" rule "${trimmed}" has unbalanced parentheses`,
    });
    return;
  }
  // Loose typo check: a rule that doesn't begin Tool-style is probably malformed.
  if (!RULE_SHAPE.test(trimmed) && !trimmed.startsWith("mcp__")) {
    issues.push({
      level: "warning",
      file,
      message: `"permissions.${bucket}" rule "${trimmed}" doesn't look like a valid rule (expected Tool or Tool(matcher))`,
    });
  }
}

// ---- ~/.claude.json (mcpServers) linting -----------------------------------

/**
 * Lint the `mcpServers` map in `~/.claude.json`: the top-level (global) map plus the
 * `projects[<cwd>].mcpServers` block when a cwd is given. Each entry must be an
 * object; a stdio server needs a `command`; an sse/http server needs a `url`.
 */
function lintMcpServers(
  file: string,
  cfg: Record<string, unknown>,
  cwd: string | undefined,
  issues: LintIssue[],
): void {
  const asMap = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  // Global servers.
  const globalMap = asMap(cfg.mcpServers);
  if (cfg.mcpServers !== undefined && !globalMap) {
    issues.push({ level: "error", file, message: `"mcpServers" must be an object` });
  } else if (globalMap) {
    for (const [name, entry] of Object.entries(globalMap)) {
      lintMcpEntry(file, `mcpServers.${name}`, entry, issues);
    }
  }

  // Per-project servers (only when a cwd was supplied AND the block exists).
  if (!cwd) return;
  const projects = asMap(cfg.projects);
  const block = projects ? asMap(projects[cwd]) : null;
  const projMap = block ? asMap(block.mcpServers) : null;
  if (block && block.mcpServers !== undefined && !projMap) {
    issues.push({
      level: "error",
      file,
      message: `"projects[${cwd}].mcpServers" must be an object`,
    });
  } else if (projMap) {
    for (const [name, entry] of Object.entries(projMap)) {
      lintMcpEntry(file, `projects[${cwd}].mcpServers.${name}`, entry, issues);
    }
  }
}

/** Validate one MCP server entry (transport-specific required fields). */
function lintMcpEntry(file: string, where: string, entry: unknown, issues: LintIssue[]): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    issues.push({ level: "error", file, message: `"${where}" must be an object` });
    return;
  }
  const e = entry as Record<string, unknown>;
  // Type is optional; Claude Code defaults stdio when a `command` is present.
  const type = typeof e.type === "string" ? e.type : e.command !== undefined ? "stdio" : undefined;
  if (e.type !== undefined && typeof e.type !== "string") {
    issues.push({ level: "error", file, message: `"${where}.type" must be a string` });
    return;
  }
  if (type === undefined) {
    issues.push({
      level: "error",
      file,
      message: `"${where}" has neither a "command" (stdio) nor a "type"`,
    });
    return;
  }
  if (type === "stdio") {
    if (typeof e.command !== "string" || e.command.trim() === "") {
      issues.push({
        level: "error",
        file,
        message: `"${where}" is a stdio server but has no non-empty "command"`,
      });
    }
    if (e.args !== undefined && !Array.isArray(e.args)) {
      issues.push({ level: "error", file, message: `"${where}.args" must be an array` });
    }
  } else if (type === "sse" || type === "http") {
    if (typeof e.url !== "string" || e.url.trim() === "") {
      issues.push({
        level: "error",
        file,
        message: `"${where}" is a ${type} server but has no non-empty "url"`,
      });
    }
  } else {
    issues.push({
      level: "warning",
      file,
      message: `"${where}" has unknown type "${type}" (expected stdio | sse | http)`,
    });
  }
}

// ---- Querystring schema -----------------------------------------------------

/** Optional `cwd` / `projectId` selector (omit both for a global-only lint). */
const lintQuerySchema = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
  },
} as const;

// ---- Route ------------------------------------------------------------------

/**
 * Wire GET /api/config/lint onto an app. The project allowlist is recomputed per
 * request (cheap, in-memory) so a project added at runtime is reachable without a
 * restart — matching the other config / git routes.
 */
export function registerConfigLintRoutes(app: FastifyInstance, engine: Engine): void {
  /** Resolve an optional cwd/projectId to a KNOWN project cwd (undefined when none given). */
  const resolveCwd = (q: { cwd?: string; projectId?: string }): string | undefined => {
    const projects = engine.getProjects({ includeArchived: true });
    if (q.projectId) return projects.find((p) => p.id === q.projectId)?.cwd;
    if (q.cwd) return projects.some((p) => p.cwd === q.cwd) ? q.cwd : undefined;
    return undefined;
  };

  app.get<{ Querystring: { cwd?: string; projectId?: string } }>(
    "/api/config/lint",
    { schema: { querystring: lintQuerySchema } },
    async (req, reply) => {
      // A supplied-but-unresolvable project param is an unknown project (400).
      if ((req.query.cwd || req.query.projectId) && !resolveCwd(req.query)) {
        return reply.code(400).send({ error: "unknown project" });
      }
      const cwd = resolveCwd(req.query);

      const issues: LintIssue[] = [];

      // 1) settings.json across scopes. The engine's scope-diff reader gives us each
      // scope's file path + parsed object (null when missing/corrupt) in one place,
      // so the global/project/local layering stays single-sourced. We re-read the
      // raw text only to distinguish "missing" (skip) from "present but unparseable"
      // (an ERROR), which the scope reader collapses to null.
      const resolved = await resolveSettings(cwd);
      // enterprise managed-settings are a machine policy we don't lint (read-only OS
      // file the user can't fix here); restrict to the user-editable scopes.
      const lintableScopes: SettingsScopeName[] = ["user", "project", "local"];
      for (const scope of resolved.scopes) {
        if (!lintableScopes.includes(scope.scope)) continue;
        const read = await readConfigFile(scope.filePath);
        if (read === null) continue; // file absent — nothing to lint
        if (read.obj === null) {
          issues.push({
            level: "error",
            file: scope.filePath,
            message: `invalid settings.json: ${read.parseError ?? "could not parse"}`,
          });
          continue;
        }
        await lintSettingsObject(scope.filePath, path.dirname(scope.filePath), read.obj, issues);
      }

      // 2) ~/.claude.json mcpServers (global + the per-project block when cwd given).
      const claudeJson = claudeJsonPath();
      const cj = await readConfigFile(claudeJson);
      if (cj && cj.obj === null) {
        issues.push({
          level: "error",
          file: claudeJson,
          message: `invalid .claude.json: ${cj.parseError ?? "could not parse"}`,
        });
      } else if (cj && cj.obj) {
        lintMcpServers(claudeJson, cj.obj, cwd, issues);
      }

      // Order errors first, then warnings, then info — most actionable on top.
      const rank: Record<LintLevel, number> = { error: 0, warning: 1, info: 2 };
      issues.sort((a, b) => rank[a.level] - rank[b.level]);

      return {
        scope: cwd ? "project" : "global",
        ok: issues.length === 0,
        counts: {
          error: issues.filter((i) => i.level === "error").length,
          warning: issues.filter((i) => i.level === "warning").length,
          info: issues.filter((i) => i.level === "info").length,
        },
        issues,
      };
    },
  );
}
