/**
 * Typed READ API over Claude Code's own configuration files, plus narrow, SAFE
 * write helpers.
 *
 * What it reads (global = under {@link claudeConfigDir}, project = under
 * `<projectCwd>/.claude`):
 *   - agents     (~/.claude/agents/*.md         + <proj>/.claude/agents/*.md)
 *   - skills     (~/.claude/skills/<name>/SKILL.md + project)
 *   - commands   (~/.claude/commands/**.md       + project)
 *   - mcpServers (~/.claude.json `mcpServers` + that file's per-project entry)
 *   - hooks/permissions (settings.json LAYERED: global < project < project-local)
 *   - CLAUDE.md  (global + project)
 *
 * Safety contract for writes:
 *   - We NEVER touch transcripts. These helpers only touch config files.
 *   - Every write goes through {@link safeWriteFile}: VALIDATE the input, snapshot the
 *     existing file to a rotating `<file>.bak.<ts>` backup, then write atomically
 *     (temp file + rename). {@link listBackups}/{@link restoreBackup} (re-exported
 *     below) power a restore picker over those snapshots.
 *
 * Tolerance: every reader swallows missing files / parse errors and returns an
 * empty/null result, so a half-configured machine never throws.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { claudeConfigDir } from "../paths.js";
import { safeWriteFile } from "./safe-write.js";

// Re-export the backup history API so it surfaces on `Engine.config` (the engine
// re-exports this module as the `config` namespace).
export { safeWriteFile, listBackups, restoreBackup, DEFAULT_BACKUP_KEEP } from "./safe-write.js";
export type { BackupInfo } from "./safe-write.js";

// Per-project MCP enable/disable toggles (reversible; edit settings, never definitions).
// Re-exported here so they surface on the `config` namespace alongside the readers above.
export { setMcpEnabled, listMcpToggles } from "./mcp-toggle.js";
export type { McpToggle } from "./mcp-toggle.js";

// ---- Types -----------------------------------------------------------------

/** Where a config entry was found. */
export type ConfigScope = "global" | "project";

/** A subagent definition (an `agents/*.md` file with YAML-ish frontmatter). */
export interface AgentDef {
  name: string;
  description: string | null;
  /** Preferred model alias from frontmatter (e.g. "sonnet"), if set. */
  model: string | null;
  scope: ConfigScope;
  filePath: string;
}

/** A skill (`skills/<dir>/SKILL.md`). */
export interface SkillDef {
  name: string;
  description: string | null;
  version: string | null;
  scope: ConfigScope;
  /** Directory holding SKILL.md. */
  dirPath: string;
  filePath: string;
}

/** A slash command (`commands/**.md`). */
export interface CommandDef {
  /** Command name derived from the file path (nested dirs become "ns:name"). */
  name: string;
  description: string | null;
  scope: ConfigScope;
  filePath: string;
}

/** One configured MCP server. `raw` keeps the full original entry for display. */
export interface McpServerDef {
  name: string;
  /** "stdio" | "sse" | "http" | ... as written in config; null when unspecified. */
  type: string | null;
  command: string | null;
  args: string[];
  scope: ConfigScope;
  raw: Record<string, unknown>;
}

/** Permissions block from settings.json (allow/deny/ask lists). */
export interface PermissionsConfig {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** Merged hooks + permissions, with the per-layer settings.json paths that fed them. */
export interface SettingsLayered {
  /** Hook events -> matcher entries (shape is passed through as-is). */
  hooks: Record<string, unknown[]>;
  permissions: PermissionsConfig;
  /** settings.json files that contributed, lowest precedence first. */
  sources: string[];
}

/** Contents of a CLAUDE.md, or null when the file doesn't exist. */
export interface ClaudeMdDoc {
  scope: ConfigScope;
  filePath: string;
  content: string;
}

// ---- Path helpers ----------------------------------------------------------

/**
 * `~/.claude.json` — the big config file holding mcpServers + per-project blocks.
 * Honors CLAUDE_CONFIG_DIR (parallel to paths.claudeConfigDir): a custom config dir
 * keeps its own `.claude.json`, which also keeps config resolution hermetic under tests.
 * The default (no override) is unchanged: the real `~/.claude.json`.
 */
function claudeJsonPath(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override
    ? path.join(override, ".claude.json")
    : path.join(os.homedir(), ".claude.json");
}

/** Project-scoped `.claude` dir for a given working directory. */
function projectClaudeDir(projectCwd: string): string {
  return path.join(projectCwd, ".claude");
}

// ---- Tiny tolerant frontmatter / JSON readers ------------------------------

/**
 * Extract a leading `---\n...\n---` YAML frontmatter block's TOP-LEVEL scalar
 * fields into a flat string map. Deliberately minimal (no nested YAML): we only
 * need `name`/`description`/`model`/`version`, which are simple scalars. Quotes
 * are stripped; unknown/complex lines are ignored.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  const body = text.slice(text.indexOf("\n") + 1, end);
  for (const line of body.split("\n")) {
    // Only flat "key: value" pairs (skip list items "- x" and indented children).
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = (m[2] ?? "").trim();
    if (!value) continue; // a key with a block value (list/map) — skip the scalar
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read + JSON.parse a file, tolerating missing/corrupt files (returns null). */
async function readJson<T = unknown>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** List files under `dir` (one level) matching `suffix`; [] when dir is missing. */
async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(suffix))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Recursively list `*.md` files under `dir` (commands may nest). */
async function listMdRecursive(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listMdRecursive(full)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// ---- Agents ----------------------------------------------------------------

async function readAgentsIn(dir: string, scope: ConfigScope): Promise<AgentDef[]> {
  const files = await listFiles(dir, ".md");
  const out: AgentDef[] = [];
  for (const file of files) {
    const text = await readTextOrNull(file);
    const fm = text ? parseFrontmatter(text) : {};
    out.push({
      name: fm.name ?? path.basename(file, ".md"),
      description: fm.description ?? null,
      model: fm.model ?? null,
      scope,
      filePath: file,
    });
  }
  return out;
}

/** All agents: global (~/.claude/agents) then project (<proj>/.claude/agents). */
export async function listAgents(projectCwd?: string): Promise<AgentDef[]> {
  const global = await readAgentsIn(path.join(claudeConfigDir(), "agents"), "global");
  const project = projectCwd
    ? await readAgentsIn(path.join(projectClaudeDir(projectCwd), "agents"), "project")
    : [];
  return [...global, ...project];
}

// ---- Skills ----------------------------------------------------------------

async function readSkillsIn(dir: string, scope: ConfigScope): Promise<SkillDef[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillDef[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirPath = path.join(dir, e.name);
    const filePath = path.join(dirPath, "SKILL.md");
    const text = await readTextOrNull(filePath);
    if (text === null) continue; // a dir without SKILL.md isn't a skill
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name ?? e.name,
      description: fm.description ?? null,
      version: fm.version ?? null,
      scope,
      dirPath,
      filePath,
    });
  }
  return out;
}

/** All skills: global (~/.claude/skills) then project (<proj>/.claude/skills). */
export async function listSkills(projectCwd?: string): Promise<SkillDef[]> {
  const global = await readSkillsIn(path.join(claudeConfigDir(), "skills"), "global");
  const project = projectCwd
    ? await readSkillsIn(path.join(projectClaudeDir(projectCwd), "skills"), "project")
    : [];
  return [...global, ...project];
}

// ---- Commands --------------------------------------------------------------

async function readCommandsIn(dir: string, scope: ConfigScope): Promise<CommandDef[]> {
  const files = await listMdRecursive(dir);
  const out: CommandDef[] = [];
  for (const file of files) {
    const text = await readTextOrNull(file);
    const fm = text ? parseFrontmatter(text) : {};
    // Nested path becomes a namespaced name, e.g. "git/commit.md" -> "git:commit".
    const rel = path.relative(dir, file).replace(/\.md$/, "");
    const name = rel.split(path.sep).join(":");
    out.push({
      name,
      description: fm.description ?? null,
      scope,
      filePath: file,
    });
  }
  return out;
}

/** All slash commands: global then project. */
export async function listCommands(projectCwd?: string): Promise<CommandDef[]> {
  const global = await readCommandsIn(path.join(claudeConfigDir(), "commands"), "global");
  const project = projectCwd
    ? await readCommandsIn(path.join(projectClaudeDir(projectCwd), "commands"), "project")
    : [];
  return [...global, ...project];
}

// ---- MCP servers -----------------------------------------------------------

function normalizeMcpEntry(name: string, raw: unknown, scope: ConfigScope): McpServerDef {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    name,
    type: typeof o.type === "string" ? o.type : null,
    command: typeof o.command === "string" ? o.command : null,
    args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [],
    scope,
    raw: o,
  };
}

/**
 * MCP servers from `~/.claude.json`: the top-level `mcpServers` map (global) plus
 * the per-project `projects[<projectCwd>].mcpServers` map when `projectCwd` is given.
 */
export async function listMcpServers(projectCwd?: string): Promise<McpServerDef[]> {
  const cfg = await readJson<Record<string, unknown>>(claudeJsonPath());
  if (!cfg) return [];
  const out: McpServerDef[] = [];

  const global = cfg.mcpServers;
  if (global && typeof global === "object" && !Array.isArray(global)) {
    for (const [name, raw] of Object.entries(global as Record<string, unknown>)) {
      out.push(normalizeMcpEntry(name, raw, "global"));
    }
  }

  if (projectCwd) {
    const projects = cfg.projects;
    const block =
      projects && typeof projects === "object" && !Array.isArray(projects)
        ? (projects as Record<string, unknown>)[projectCwd]
        : undefined;
    const projMcp =
      block && typeof block === "object" && !Array.isArray(block)
        ? (block as Record<string, unknown>).mcpServers
        : undefined;
    if (projMcp && typeof projMcp === "object" && !Array.isArray(projMcp)) {
      for (const [name, raw] of Object.entries(projMcp as Record<string, unknown>)) {
        out.push(normalizeMcpEntry(name, raw, "project"));
      }
    }
  }

  return out;
}

// ---- Plugins ---------------------------------------------------------------

/** One installed Claude Code plugin (a flattened install record). */
export interface PluginInfo {
  /** Plugin name (the part before `@marketplace` in the install key). */
  name: string;
  /** Installed version string, or null when the manifest reported none/"unknown". */
  version: string | null;
  /** The marketplace it came from (the part after `@`), or null when unscoped. */
  marketplace: string | null;
  /**
   * Whether the plugin is enabled. installed_plugins.json doesn't carry an explicit
   * flag, so a plugin is enabled when it is installed AND not present in the plugins
   * blocklist (blocklist.json). A record's own `enabled: false`, if a future version
   * writes one, also wins.
   */
  enabled: boolean;
  /** Install scope as recorded ("user" | "project" | ...), or null when unspecified. */
  scope: string | null;
}

/** `~/.claude/plugins/installed_plugins.json` path. */
function installedPluginsPath(): string {
  return path.join(claudeConfigDir(), "plugins", "installed_plugins.json");
}

/** `~/.claude/plugins/known_marketplaces.json` path. */
function knownMarketplacesPath(): string {
  return path.join(claudeConfigDir(), "plugins", "known_marketplaces.json");
}

/** `~/.claude/plugins/blocklist.json` path (blocked plugins are reported disabled). */
function pluginBlocklistPath(): string {
  return path.join(claudeConfigDir(), "plugins", "blocklist.json");
}

/** Split an `name@marketplace` install key into its parts (marketplace null when absent). */
function splitPluginKey(key: string): { name: string; marketplace: string | null } {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, marketplace: null };
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) || null };
}

/**
 * Read the set of blocked plugin install-keys (`name@marketplace`) from
 * blocklist.json. Tolerant: missing/corrupt file -> empty set.
 */
async function readBlockedPluginKeys(): Promise<Set<string>> {
  const cfg = await readJson<Record<string, unknown>>(pluginBlocklistPath());
  const list = cfg?.plugins;
  const out = new Set<string>();
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object") {
        const p = (entry as Record<string, unknown>).plugin;
        if (typeof p === "string") out.add(p);
      } else if (typeof entry === "string") {
        out.add(entry);
      }
    }
  }
  return out;
}

/**
 * List installed Claude Code plugins from `~/.claude/plugins/installed_plugins.json`,
 * flattened to one {@link PluginInfo} per install record.
 *
 * Shape (observed): `{ version, plugins: { "<name>@<marketplace>": [ { scope, version,
 * installPath, ... } ] } }`. The marketplace name is also cross-checked against
 * `known_marketplaces.json` (an unknown marketplace is still reported as-is). A
 * plugin is `enabled` unless its record says `enabled: false` or it appears in
 * `blocklist.json`.
 *
 * Tolerant of a half-configured machine: a missing/corrupt plugins file yields [].
 */
export async function listPlugins(): Promise<PluginInfo[]> {
  const cfg = await readJson<Record<string, unknown>>(installedPluginsPath());
  const plugins = cfg?.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];

  // Known marketplaces (for cross-reference) + blocked keys (force-disabled).
  const marketplaces = await readJson<Record<string, unknown>>(knownMarketplacesPath());
  const knownMarkets =
    marketplaces && typeof marketplaces === "object" && !Array.isArray(marketplaces)
      ? new Set(Object.keys(marketplaces))
      : new Set<string>();
  const blocked = await readBlockedPluginKeys();

  const out: PluginInfo[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    const { name, marketplace } = splitPluginKey(key);
    // A marketplace named on the key but absent from known_marketplaces.json is kept
    // (the install record is the source of truth); knownMarkets is only a cross-check.
    void knownMarkets;
    const records = Array.isArray(value) ? value : [value];
    for (const raw of records) {
      const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const version =
        typeof rec.version === "string" && rec.version && rec.version !== "unknown" ? rec.version : null;
      const scope = typeof rec.scope === "string" ? rec.scope : null;
      const recEnabled = rec.enabled === false ? false : true;
      const enabled = recEnabled && !blocked.has(key);
      out.push({ name, version, marketplace, enabled, scope });
    }
  }
  return out;
}

// ---- Settings (hooks + permissions), layered -------------------------------

function emptyPermissions(): PermissionsConfig {
  return { allow: [], deny: [], ask: [] };
}

function mergePermissions(into: PermissionsConfig, src: unknown): void {
  if (!src || typeof src !== "object" || Array.isArray(src)) return;
  const p = src as Record<string, unknown>;
  for (const key of ["allow", "deny", "ask"] as const) {
    const list = p[key];
    if (Array.isArray(list)) {
      for (const v of list) if (typeof v === "string") into[key].push(v);
    }
  }
}

/**
 * Read + layer settings.json files in precedence order (lowest first):
 *   1. global  ~/.claude/settings.json
 *   2. project <proj>/.claude/settings.json
 *   3. project-local <proj>/.claude/settings.local.json
 * Hooks from later layers override an event's entries; permission lists accumulate
 * across layers. Returns the merged view + the paths that actually contributed.
 */
export async function readSettings(projectCwd?: string): Promise<SettingsLayered> {
  const candidates = [path.join(claudeConfigDir(), "settings.json")];
  if (projectCwd) {
    candidates.push(path.join(projectClaudeDir(projectCwd), "settings.json"));
    candidates.push(path.join(projectClaudeDir(projectCwd), "settings.local.json"));
  }

  const hooks: Record<string, unknown[]> = {};
  const permissions = emptyPermissions();
  const sources: string[] = [];

  for (const file of candidates) {
    const cfg = await readJson<Record<string, unknown>>(file);
    if (!cfg) continue;
    sources.push(file);

    const h = cfg.hooks;
    if (h && typeof h === "object" && !Array.isArray(h)) {
      for (const [event, entries] of Object.entries(h as Record<string, unknown>)) {
        if (Array.isArray(entries)) hooks[event] = entries; // later layer wins for this event
      }
    }
    mergePermissions(permissions, cfg.permissions);
  }

  return { hooks, permissions, sources };
}

// ---- CLAUDE.md -------------------------------------------------------------

/** Read the global CLAUDE.md (~/.claude/CLAUDE.md), or null when absent. */
export async function readGlobalClaudeMd(): Promise<ClaudeMdDoc | null> {
  const file = path.join(claudeConfigDir(), "CLAUDE.md");
  const content = await readTextOrNull(file);
  return content === null ? null : { scope: "global", filePath: file, content };
}

/** Read a project's CLAUDE.md (<projectCwd>/CLAUDE.md), or null when absent. */
export async function readProjectClaudeMd(projectCwd: string): Promise<ClaudeMdDoc | null> {
  const file = path.join(projectCwd, "CLAUDE.md");
  const content = await readTextOrNull(file);
  return content === null ? null : { scope: "project", filePath: file, content };
}

// ---- Safe write helpers ----------------------------------------------------
// The validate -> rotating backup -> atomic write pattern lives in safe-write.ts
// (safeWriteFile). The helpers below add per-file VALIDATION + path resolution on
// top of that primitive; they never re-implement the backup/atomic write.

/**
 * SAFE write of a CLAUDE.md. Validates the content is a string, snapshots any existing
 * file to a rotating backup, then writes atomically (all via {@link safeWriteFile}).
 *
 *  - scope "global"  => ~/.claude/CLAUDE.md
 *  - scope "project" => <projectCwd>/CLAUDE.md   (projectCwd required)
 *
 * NOTE: writes a CONFIG file only — never a transcript. Returns the path written.
 */
export async function writeClaudeMd(
  scope: ConfigScope,
  content: string,
  projectCwd?: string,
): Promise<string> {
  let file: string;
  if (scope === "global") {
    file = path.join(claudeConfigDir(), "CLAUDE.md");
  } else {
    if (!projectCwd) throw new Error("writeClaudeMd: projectCwd is required for project scope");
    file = path.join(projectCwd, "CLAUDE.md");
  }
  // safeWriteFile validates content is a string, backs up, and writes atomically.
  return safeWriteFile(file, content);
}

/** Minimal validated shape for an MCP server we'll accept on write. */
export interface McpServerInput {
  /** "stdio" | "sse" | "http"; defaults to "stdio" when omitted. */
  type?: string;
  /** Required for stdio servers. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For sse/http servers. */
  url?: string;
}

/** Validate an MCP server entry, returning a clean object to persist. */
function validateMcpServer(entry: McpServerInput): Record<string, unknown> {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("setMcpServer: entry must be an object");
  }
  const type = entry.type ?? "stdio";
  if (typeof type !== "string") throw new TypeError("setMcpServer: type must be a string");
  const out: Record<string, unknown> = { type };

  if (type === "stdio") {
    if (typeof entry.command !== "string" || !entry.command.trim()) {
      throw new Error("setMcpServer: stdio server requires a non-empty command");
    }
    out.command = entry.command;
    out.args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    if (entry.env && typeof entry.env === "object") out.env = entry.env;
  } else {
    if (typeof entry.url !== "string" || !entry.url.trim()) {
      throw new Error(`setMcpServer: ${type} server requires a url`);
    }
    out.url = entry.url;
  }
  return out;
}

/**
 * SAFE upsert of an MCP server into `~/.claude.json`.
 *
 *  - Validates `entry` first (throws on a malformed server).
 *  - Snapshots `~/.claude.json` to a rotating `~/.claude.json.bak.<ts>` backup.
 *  - Writes `mcpServers[name]` at the TOP LEVEL (global scope) when `projectCwd` is
 *    omitted, or under `projects[<projectCwd>].mcpServers[name]` when given.
 *  - Preserves every other key in the file; writes atomically.
 *
 * Returns the validated entry that was persisted.
 */
export async function setMcpServer(
  name: string,
  entry: McpServerInput,
  projectCwd?: string,
): Promise<Record<string, unknown>> {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("setMcpServer: name must be a non-empty string");
  }
  const clean = validateMcpServer(entry);
  const file = claudeJsonPath();

  // Start from the existing config (or an empty object) so we never drop keys.
  const cfg = (await readJson<Record<string, unknown>>(file)) ?? {};

  if (projectCwd) {
    const projects =
      cfg.projects && typeof cfg.projects === "object" && !Array.isArray(cfg.projects)
        ? (cfg.projects as Record<string, unknown>)
        : {};
    const block =
      projects[projectCwd] && typeof projects[projectCwd] === "object" && !Array.isArray(projects[projectCwd])
        ? (projects[projectCwd] as Record<string, unknown>)
        : {};
    const mcp =
      block.mcpServers && typeof block.mcpServers === "object" && !Array.isArray(block.mcpServers)
        ? (block.mcpServers as Record<string, unknown>)
        : {};
    mcp[name] = clean;
    block.mcpServers = mcp;
    projects[projectCwd] = block;
    cfg.projects = projects;
  } else {
    const mcp =
      cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)
        ? (cfg.mcpServers as Record<string, unknown>)
        : {};
    mcp[name] = clean;
    cfg.mcpServers = mcp;
  }

  await safeWriteFile(file, JSON.stringify(cfg, null, 2) + "\n");
  return clean;
}
