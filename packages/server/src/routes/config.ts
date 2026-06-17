/**
 * Config REST surface — exposes the engine config module comprehensively so the
 * MCP / hooks / agents / skills / commands / CLAUDE.md UIs (this wave + later) have
 * one place to read from and write to.
 *
 * READS (all go through `@claude-ui/engine` `config`, so the global/project layering
 * lives in exactly one place):
 *   GET /api/config/mcp       ?cwd=|?projectId=   → global + per-project MCP servers
 *   GET /api/config/agents    ?cwd=|?projectId=   → global + per-project agents
 *   GET /api/config/skills    ?cwd=|?projectId=   → global + per-project skills
 *   GET /api/config/commands  ?cwd=|?projectId=   → global + per-project commands
 *   GET /api/config/hooks     ?cwd=|?projectId=   → layered hooks (+ source paths)
 *   GET /api/config/claudemd  ?scope=&cwd=|?projectId= → CLAUDE.md contents
 *
 * WRITES (safe: validate → `<file>.bak` backup → atomic write; only config files):
 *   PUT    /api/config/claudemd  → write a CLAUDE.md (engine `writeClaudeMd`)
 *   PUT    /api/config/mcp       → upsert an MCP server (engine `setMcpServer`)
 *   DELETE /api/config/mcp       → remove an MCP server from `~/.claude.json`
 *   PUT    /api/config/hooks     → replace the `hooks` block in a settings.json
 *                                  (global → `~/.claude/settings.json`; project →
 *                                  `<cwd>/.claude/settings.json`). Mirrors the
 *                                  permission-write pattern: every other key in the
 *                                  file is preserved untouched.
 *
 * SECURITY — project allowlist: any `cwd`/`projectId` is resolved against the set of
 * KNOWN projects (archived included). An unknown project is rejected with 400 so we
 * never read/write config under an arbitrary host directory.
 */
import { readFile, writeFile, copyFile, rename, mkdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";
import { config, paths } from "@claude-ui/engine";

// ---- Shared helpers --------------------------------------------------------

/** `~/.claude.json` — holds the mcpServers map (global + per-project). */
function claudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

/**
 * The settings.json a hooks write targets:
 *   - global  → `~/.claude/settings.json`        (the USER settings file)
 *   - project → `<cwd>/.claude/settings.json`    (matches the layer the engine's
 *               `readSettings` reads as the project layer; we never write the
 *               `.local` variant, mirroring the permission-write behavior).
 */
function settingsPathFor(scope: "global" | "project", cwd?: string): string {
  if (scope === "project") {
    if (!cwd) throw new Error("project scope requires a cwd");
    return path.join(cwd, ".claude", "settings.json");
  }
  return path.join(paths.claudeConfigDir(), "settings.json");
}

/**
 * Validate the incoming `hooks` block. Claude Code owns the inner grammar (event
 * names -> matcher arrays), so we only guard the SHAPE here: it must be a plain
 * object (not an array / primitive). Returns it narrowed; throws on a bad shape.
 */
function validateHooks(hooks: unknown): Record<string, unknown> {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("hooks must be an object");
  }
  return hooks as Record<string, unknown>;
}

/**
 * SAFE replace of the `hooks` block in a settings.json. Reads the current file,
 * swaps in the new `hooks`, preserves every other key (permissions, env, etc.),
 * then backs up to `<file>.bak` and atomic-writes. Returns the file path written.
 */
async function writeHooksBlock(
  scope: "global" | "project",
  hooks: Record<string, unknown>,
  cwd?: string,
): Promise<string> {
  const file = settingsPathFor(scope, cwd);
  const cfg = await readJsonObject(file);
  cfg.hooks = hooks;
  await backup(file);
  await atomicWrite(file, JSON.stringify(cfg, null, 2) + "\n");
  return file;
}

/** Read + JSON.parse an object file, tolerating a missing/corrupt file (returns {}). */
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

/**
 * SAFE remove of an MCP server from `~/.claude.json`. Mirrors the engine's
 * `setMcpServer` contract (backup + atomic write, preserve every other key); the
 * engine has no remover, so this narrow, config-only delete lives here. `projectCwd`
 * targets `projects[<cwd>].mcpServers`; otherwise the top-level `mcpServers`.
 * Returns whether the named server existed.
 */
async function removeMcpServer(name: string, projectCwd?: string): Promise<boolean> {
  const file = claudeJsonPath();
  const cfg = await readJsonObject(file);

  const getMap = (parent: Record<string, unknown>): Record<string, unknown> | undefined => {
    const m = parent.mcpServers;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
  };

  let map: Record<string, unknown> | undefined;
  if (projectCwd) {
    const projects = cfg.projects;
    const block =
      projects && typeof projects === "object" && !Array.isArray(projects)
        ? (projects as Record<string, unknown>)[projectCwd]
        : undefined;
    map =
      block && typeof block === "object" && !Array.isArray(block)
        ? getMap(block as Record<string, unknown>)
        : undefined;
  } else {
    map = getMap(cfg);
  }

  if (!map || !(name in map)) return false;
  delete map[name];

  await backup(file);
  await atomicWrite(file, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

// ---- Backups (list + restore) ----------------------------------------------
//
// Every safe-write in this package backs the prior file up to `<file>.bak` (see
// `backup` above + the engine's identical helper). So a config file has AT MOST
// one backup — the bytes from immediately before the last write. These two helpers
// expose that single backup for a "revert my last edit" UX. The engine has no
// backup API, so this config-only surface lives here, reusing the same convention.

/** A backup descriptor for the listing response. `id` is always "bak". */
interface BackupInfo {
  id: string;
  path: string;
  /** Bytes of the backup file. */
  size: number;
  /** mtime of the backup (epoch ms) — when the prior version was captured. */
  modifiedAt: number;
}

/**
 * List the available backup(s) for a config `file`. With the `<file>.bak`
 * convention there is exactly zero or one, but the response is an array so the
 * shape can grow (e.g. timestamped backups) without an API break.
 */
async function listBackups(file: string): Promise<BackupInfo[]> {
  const bak = `${file}.bak`;
  let st: Stats;
  try {
    st = await stat(bak);
  } catch {
    return [];
  }
  if (!st.isFile()) return [];
  return [{ id: "bak", path: bak, size: st.size, modifiedAt: st.mtimeMs }];
}

/**
 * Restore a config `file` from its backup. Only `backupId: "bak"` exists today
 * (the `<file>.bak`). SAFE: before overwriting, the CURRENT file is itself backed
 * up to `<file>.bak` (so a restore is reversible by another restore), then the
 * backup bytes are atomic-written over the target. Returns false when no such
 * backup exists. Reads/writes only the config file + its sibling `.bak`.
 */
async function restoreBackup(file: string, backupId: string): Promise<boolean> {
  if (backupId !== "bak") return false;
  const bak = `${file}.bak`;
  let bakData: string;
  try {
    bakData = await readFile(bak, "utf8");
  } catch {
    return false; // no backup to restore from
  }
  // Snapshot the current bytes into `.bak` first so this restore is undoable. This
  // overwrites the same `.bak` we just read, hence we read it fully into memory above.
  await backup(file);
  await atomicWrite(file, bakData);
  return true;
}

// ---- Schemas ---------------------------------------------------------------

/** Optional `cwd` / `projectId` selector for the list endpoints. */
const scopeQuerySchema = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
  },
} as const;

const claudeMdGetSchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["global", "project"], default: "global" },
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
  },
} as const;

const claudeMdPutSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "content"],
  properties: {
    scope: { type: "string", enum: ["global", "project"] },
    content: { type: "string" },
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
  },
} as const;

const mcpPutSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    server: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["stdio", "sse", "http"] },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        env: { type: "object", additionalProperties: { type: "string" } },
        url: { type: "string" },
      },
    },
  },
} as const;

const mcpDeleteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
  },
} as const;

// PUT /api/config/hooks. `hooks` is an arbitrary object (event -> matcher entries);
// the schema only pins the SHAPE (object), the route validates further. A project
// scope requires a resolvable cwd/projectId.
const hooksPutSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "hooks"],
  properties: {
    scope: { type: "string", enum: ["global", "project"] },
    cwd: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    hooks: { type: "object" },
  },
} as const;

// GET /api/config/backups?path=<abs config file>. The path is validated against the
// known-config-file allowlist in the handler (not the schema).
const backupsGetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1 },
  },
} as const;

// POST /api/config/restore { path, backupId }. Path allowlisted in the handler.
const restorePostSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "backupId"],
  properties: {
    path: { type: "string", minLength: 1 },
    backupId: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

// ---- Routes ----------------------------------------------------------------

/**
 * Wire the /api/config/* routes onto an app. The project allowlist is recomputed
 * per request (cheap, in-memory) so a project added at runtime is reachable without
 * a restart, matching the git routes' behavior.
 */
export function registerConfigRoutes(app: FastifyInstance, engine: Engine): void {
  /** Resolve an optional cwd/projectId to a KNOWN project cwd (undefined when none given). */
  const resolveCwd = (q: { cwd?: string; projectId?: string }): string | undefined => {
    const projects = engine.getProjects({ includeArchived: true });
    if (q.projectId) return projects.find((p) => p.id === q.projectId)?.cwd;
    if (q.cwd) return projects.some((p) => p.cwd === q.cwd) ? q.cwd : undefined;
    return undefined;
  };

  /** True when a project param was supplied. */
  const hasProjectParam = (q: { cwd?: string; projectId?: string }): boolean =>
    Boolean(q.cwd || q.projectId);

  /**
   * The KNOWN config files this package backs up / restores — exactly the files the
   * safe-writes above target. Anything else is rejected so backup/restore can never
   * read or overwrite an arbitrary host file. Recomputed per request (cheap) so a
   * project added at runtime is reachable without a restart, like the other gates.
   *
   *   global  : ~/.claude/settings.json, ~/.claude/CLAUDE.md, ~/.claude.json
   *   project : <cwd>/.claude/settings.json, <cwd>/CLAUDE.md  (per known project)
   */
  const knownConfigFiles = (): Set<string> => {
    const files = new Set<string>([
      path.resolve(settingsPathFor("global")),
      path.resolve(path.join(paths.claudeConfigDir(), "CLAUDE.md")),
      path.resolve(claudeJsonPath()),
    ]);
    for (const p of engine.getProjects({ includeArchived: true })) {
      files.add(path.resolve(settingsPathFor("project", p.cwd)));
      files.add(path.resolve(path.join(p.cwd, "CLAUDE.md")));
    }
    return files;
  };

  /** Resolve + allowlist a config-file path; undefined when it isn't a known config file. */
  const resolveConfigFile = (raw: string): string | undefined => {
    const resolved = path.resolve(raw);
    return knownConfigFiles().has(resolved) ? resolved : undefined;
  };

  // ---- List endpoints (global + per-project where relevant) ----------------

  const listRoutes: Array<{
    path: string;
    fn: (cwd?: string) => Promise<unknown>;
  }> = [
    { path: "/api/config/mcp", fn: config.listMcpServers },
    { path: "/api/config/agents", fn: config.listAgents },
    { path: "/api/config/skills", fn: config.listSkills },
    { path: "/api/config/commands", fn: config.listCommands },
  ];

  for (const { path: routePath, fn } of listRoutes) {
    app.get<{ Querystring: { cwd?: string; projectId?: string } }>(
      routePath,
      { schema: { querystring: scopeQuerySchema } },
      async (req, reply) => {
        if (hasProjectParam(req.query) && !resolveCwd(req.query)) {
          return reply.code(400).send({ error: "unknown project" });
        }
        const cwd = resolveCwd(req.query);
        return fn(cwd);
      },
    );
  }

  // Hooks are layered (global < project < project-local); return the source paths too.
  app.get<{ Querystring: { cwd?: string; projectId?: string } }>(
    "/api/config/hooks",
    { schema: { querystring: scopeQuerySchema } },
    async (req, reply) => {
      if (hasProjectParam(req.query) && !resolveCwd(req.query)) {
        return reply.code(400).send({ error: "unknown project" });
      }
      const cwd = resolveCwd(req.query);
      const settings = await config.readSettings(cwd);
      return {
        hooks: settings.hooks,
        sources: settings.sources,
        scope: cwd ? "project" : "global",
      };
    },
  );

  // Safe-write the hooks block. Global → ~/.claude/settings.json; project →
  // <cwd>/.claude/settings.json (cwd/projectId validated against known projects).
  // The named scope wins: a `project` scope without a resolvable project is a 400.
  app.put<{
    Body: {
      scope: "global" | "project";
      cwd?: string;
      projectId?: string;
      hooks: unknown;
    };
  }>(
    "/api/config/hooks",
    { schema: { body: hooksPutSchema } },
    async (req, reply) => {
      let hooks: Record<string, unknown>;
      try {
        hooks = validateHooks(req.body.hooks);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      let cwd: string | undefined;
      if (req.body.scope === "project") {
        cwd = resolveCwd(req.body);
        if (!cwd) return reply.code(400).send({ error: "unknown or missing project" });
      }

      const file = await writeHooksBlock(req.body.scope, hooks, cwd);
      return { ok: true, scope: req.body.scope, file, hooks };
    },
  );

  // ---- CLAUDE.md (read + safe write) ---------------------------------------

  app.get<{ Querystring: { scope?: "global" | "project"; cwd?: string; projectId?: string } }>(
    "/api/config/claudemd",
    { schema: { querystring: claudeMdGetSchema } },
    async (req, reply) => {
      const scope = req.query.scope ?? "global";
      if (scope === "project") {
        const cwd = resolveCwd(req.query);
        if (!cwd) return reply.code(400).send({ error: "unknown or missing project" });
        return (await config.readProjectClaudeMd(cwd)) ?? { scope, filePath: null, content: "" };
      }
      return (await config.readGlobalClaudeMd()) ?? { scope: "global", filePath: null, content: "" };
    },
  );

  app.put<{
    Body: { scope: "global" | "project"; content: string; cwd?: string; projectId?: string };
  }>(
    "/api/config/claudemd",
    { schema: { body: claudeMdPutSchema } },
    async (req, reply) => {
      const { scope, content } = req.body;
      let cwd: string | undefined;
      if (scope === "project") {
        cwd = resolveCwd(req.body);
        if (!cwd) return reply.code(400).send({ error: "unknown or missing project" });
      }
      const filePath = await config.writeClaudeMd(scope, content, cwd);
      return { ok: true, scope, filePath };
    },
  );

  // ---- MCP servers (upsert + remove, safe-write) ---------------------------

  app.put<{
    Body: {
      name: string;
      cwd?: string;
      projectId?: string;
      server?: config.McpServerInput;
    };
  }>(
    "/api/config/mcp",
    { schema: { body: mcpPutSchema } },
    async (req, reply) => {
      if (hasProjectParam(req.body) && !resolveCwd(req.body)) {
        return reply.code(400).send({ error: "unknown project" });
      }
      const cwd = resolveCwd(req.body);
      try {
        const saved = await config.setMcpServer(req.body.name, req.body.server ?? {}, cwd);
        return { ok: true, name: req.body.name, scope: cwd ? "project" : "global", server: saved };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.delete<{ Body: { name: string; cwd?: string; projectId?: string } }>(
    "/api/config/mcp",
    { schema: { body: mcpDeleteSchema } },
    async (req, reply) => {
      if (hasProjectParam(req.body) && !resolveCwd(req.body)) {
        return reply.code(400).send({ error: "unknown project" });
      }
      const cwd = resolveCwd(req.body);
      const removed = await removeMcpServer(req.body.name, cwd);
      if (!removed) return reply.code(404).send({ error: "no such mcp server" });
      return { ok: true, name: req.body.name, scope: cwd ? "project" : "global" };
    },
  );

  // ---- Backups (list + restore the prior version of a config file) ---------

  // GET /api/config/backups?path= -> the available backup(s) for a KNOWN config
  // file. An unknown path is 400 (never lists arbitrary host files).
  app.get<{ Querystring: { path: string } }>(
    "/api/config/backups",
    { schema: { querystring: backupsGetSchema } },
    async (req, reply) => {
      const file = resolveConfigFile(req.query.path);
      if (!file) return reply.code(400).send({ error: "unknown config file" });
      return { path: file, backups: await listBackups(file) };
    },
  );

  // POST /api/config/restore { path, backupId } -> restore the prior version. The
  // current bytes are themselves backed up first (reversible). Unknown path -> 400;
  // no such backup -> 404.
  app.post<{ Body: { path: string; backupId: string } }>(
    "/api/config/restore",
    { schema: { body: restorePostSchema } },
    async (req, reply) => {
      const file = resolveConfigFile(req.body.path);
      if (!file) return reply.code(400).send({ error: "unknown config file" });
      const ok = await restoreBackup(file, req.body.backupId);
      if (!ok) return reply.code(404).send({ error: "no such backup" });
      return { ok: true, path: file, backupId: req.body.backupId };
    },
  );
}
