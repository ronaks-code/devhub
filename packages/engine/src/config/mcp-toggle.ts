/**
 * Per-project MCP server enable/disable TOGGLES — reversible on/off switches that
 * never delete a server's definition.
 *
 * Claude Code separates a project MCP server's DEFINITION from whether it's ACTIVE:
 *   - The definition lives in the project's `.mcp.json` (`mcpServers` map) — a file
 *     checked into the repo — or under `~/.claude.json` `projects[<cwd>].mcpServers`.
 *   - Whether each `.mcp.json` server runs is gated by three fields in the project's
 *     `.claude/settings.json`:
 *       • `disableAllProjectMcpServers` — when true, NOTHING in `.mcp.json` runs unless
 *         it's also been explicitly opted back in via `enabledMcpjsonServers`.
 *       • `disabledMcpjsonServers: string[]` — a denylist (a name here is off).
 *       • `enabledMcpjsonServers: string[]`  — an allowlist (an explicit opt-in; also
 *         what re-enables a server while `disableAllProjectMcpServers` is true).
 *
 * So toggling a server is purely a settings edit — we add/remove the server NAME in
 * those lists, never touching the `mcpServers` definition. That makes every toggle
 * reversible: flip it back and the server returns exactly as configured.
 *
 * Resolved enabled state (matching the runtime's gate):
 *   off  if name ∈ disabledMcpjsonServers
 *   off  if disableAllProjectMcpServers && name ∉ enabledMcpjsonServers
 *   on   otherwise
 *
 * Writes go through the existing {@link safeWriteFile} primitive (validate → rotating
 * `.bak` backup → atomic write), so the project's `.claude/settings.json` is snapshotted
 * before each change. We NEVER touch transcripts — only this one config file. Reads are
 * tolerant: a missing/corrupt `.mcp.json` or `settings.json` is treated as empty.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeWriteFile } from "./safe-write.js";
import { listMcpServers } from "./index.js";

/** The project `.claude/settings.json` that carries the toggle fields. */
function projectSettingsPath(projectPath: string): string {
  return path.join(projectPath, ".claude", "settings.json");
}

/** The project `.mcp.json` that defines the project-scoped servers. */
function projectMcpJsonPath(projectPath: string): string {
  return path.join(projectPath, ".mcp.json");
}

/** Read + JSON.parse a top-level object, tolerating missing/corrupt files (returns {}). */
async function readObject(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(file, "utf8");
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Coerce a settings value to a clean string[] (drops non-strings); [] when absent. */
function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** One project MCP server's name + its resolved on/off state under the project settings. */
export interface McpToggle {
  /** The server name (as written in `.mcp.json` / `projects[<cwd>].mcpServers`). */
  name: string;
  /** Resolved enabled state per the disableAll/disabled/enabled gate above. */
  enabled: boolean;
}

/**
 * Compute whether a project MCP server NAME is enabled, given the three settings fields.
 * Mirrors the runtime gate: a denylisted name is off; with `disableAllProjectMcpServers`
 * on, only allowlisted names are on; otherwise a server is on by default.
 */
function isEnabled(
  name: string,
  disableAll: boolean,
  disabled: string[],
  enabled: string[],
): boolean {
  if (disabled.includes(name)) return false;
  if (disableAll) return enabled.includes(name);
  return true;
}

/**
 * The known project MCP server names for `projectPath`: every server defined in the
 * project's `.mcp.json` plus the per-project block of `~/.claude.json`
 * (`projects[<cwd>].mcpServers`, surfaced by {@link listMcpServers} as scope "project").
 * De-duplicated, sorted. Tolerant of a project with no MCP config (returns []).
 */
async function knownProjectServers(projectPath: string): Promise<string[]> {
  const names = new Set<string>();

  // .mcp.json's `mcpServers` map (the repo-checked-in definitions).
  const mcpJson = await readObject(projectMcpJsonPath(projectPath));
  const fromFile = mcpJson.mcpServers;
  if (fromFile && typeof fromFile === "object" && !Array.isArray(fromFile)) {
    for (const name of Object.keys(fromFile as Record<string, unknown>)) names.add(name);
  }

  // The per-project block of ~/.claude.json (scope "project" from listMcpServers).
  for (const s of await listMcpServers(projectPath)) {
    if (s.scope === "project") names.add(s.name);
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * List every known project MCP server for `projectPath` with its resolved enabled state.
 * Read-only; tolerant of a half-configured project (a missing `.mcp.json`/`settings.json`
 * yields fewer entries / all-enabled defaults rather than throwing).
 */
export async function listMcpToggles(projectPath: string): Promise<McpToggle[]> {
  if (typeof projectPath !== "string" || !projectPath.trim()) {
    throw new Error("listMcpToggles: projectPath must be a non-empty string");
  }
  const settings = await readObject(projectSettingsPath(projectPath));
  const disableAll = settings.disableAllProjectMcpServers === true;
  const disabled = asStringList(settings.disabledMcpjsonServers);
  const enabled = asStringList(settings.enabledMcpjsonServers);

  const names = await knownProjectServers(projectPath);
  return names.map((name) => ({
    name,
    enabled: isEnabled(name, disableAll, disabled, enabled),
  }));
}

/**
 * SAFE toggle of one project MCP server on/off by editing the project's
 * `.claude/settings.json` — never the server's definition (so the toggle is reversible).
 *
 *  - To DISABLE: add `serverName` to `disabledMcpjsonServers` and drop it from
 *    `enabledMcpjsonServers` (a denylist entry wins regardless of `disableAll`).
 *  - To ENABLE: drop `serverName` from `disabledMcpjsonServers`, and — only when
 *    `disableAllProjectMcpServers` is on — add it to `enabledMcpjsonServers` so it's
 *    opted back in past the master switch. (When `disableAll` is off, removal from the
 *    denylist is enough; we don't add a redundant allowlist entry.)
 *
 * Every other settings key is preserved and the file is snapshotted to a rotating `.bak`
 * before the atomic write (via {@link safeWriteFile}). Returns the new resolved state.
 */
export async function setMcpEnabled(
  projectPath: string,
  serverName: string,
  enabled: boolean,
): Promise<McpToggle> {
  if (typeof projectPath !== "string" || !projectPath.trim()) {
    throw new Error("setMcpEnabled: projectPath must be a non-empty string");
  }
  if (typeof serverName !== "string" || !serverName.trim()) {
    throw new Error("setMcpEnabled: serverName must be a non-empty string");
  }

  const file = projectSettingsPath(projectPath);
  // Start from the existing settings (or {}), so we never drop unrelated keys.
  const settings = await readObject(file);
  const disableAll = settings.disableAllProjectMcpServers === true;
  let disabled = asStringList(settings.disabledMcpjsonServers);
  let enabledList = asStringList(settings.enabledMcpjsonServers);

  if (enabled) {
    // Remove from the denylist; opt in past the master switch only when it's on.
    disabled = disabled.filter((n) => n !== serverName);
    if (disableAll && !enabledList.includes(serverName)) {
      enabledList = [...enabledList, serverName];
    }
  } else {
    // Denylist it (a denylist entry is off regardless of disableAll); drop any opt-in.
    if (!disabled.includes(serverName)) disabled = [...disabled, serverName];
    enabledList = enabledList.filter((n) => n !== serverName);
  }

  // Persist only the lists we touched; leave the master switch and other keys as-is.
  settings.disabledMcpjsonServers = disabled;
  settings.enabledMcpjsonServers = enabledList;

  await safeWriteFile(file, JSON.stringify(settings, null, 2) + "\n");

  return { name: serverName, enabled: isEnabled(serverName, disableAll, disabled, enabledList) };
}
