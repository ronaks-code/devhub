/**
 * Scope-diff resolver for Claude Code's `settings.json` layering.
 *
 * Claude Code reads settings from up to four files, each a SCOPE, in increasing
 * precedence:
 *   1. user        ~/.claude/settings.json                     (lowest)
 *   2. project     <projectCwd>/.claude/settings.json
 *   3. local       <projectCwd>/.claude/settings.local.json
 *   4. enterprise  OS-managed managed-settings.json            (highest — wins)
 *
 * NOTE on precedence: enterprise "managed" settings are a hard override an admin
 * pushes to the machine, so they sit ABOVE the user's own files. The existing
 * {@link readSettings} layered reader only models user/project/local and merges
 * everything into one bag (hooks override per-event, permission lists accumulate).
 * That's right for ACTUAL use, but a settings UI also wants to show, per key, the
 * full picture: what each scope set, and which scope ended up winning.
 *
 * {@link resolveSettings} answers exactly that. For every top-level settings key it
 * returns:
 *   - the EFFECTIVE value (the winning scope's raw value), and
 *   - which scope won (`winner`), and
 *   - the raw value each scope contributed (`perScope`), so the UI can render a
 *     "this key is overridden by <scope>" diff.
 *
 * It does NOT merge nested structures (no deep permission-list union here) — that's
 * a faithful per-scope view, not the effective merged config. Use `readSettings`
 * when you want the merged hooks/permissions the runtime actually applies.
 *
 * Tolerant: every file read swallows missing/corrupt files (treated as "this scope
 * said nothing"), so a half-configured machine never throws.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { claudeConfigDir } from "../paths.js";

/** The four settings scopes, lowest precedence first. */
export type SettingsScopeName = "enterprise" | "user" | "project" | "local";

/** Precedence order, LOWEST first. The last scope to set a key wins. */
const SCOPE_PRECEDENCE: SettingsScopeName[] = ["user", "project", "local", "enterprise"];

/** One scope's source file and the raw settings object it parsed to (null if absent). */
export interface ResolvedScope {
  scope: SettingsScopeName;
  /** Absolute path of the settings file this scope reads from. */
  filePath: string;
  /** Whether the file existed and parsed (false => this scope contributed nothing). */
  present: boolean;
  /** The parsed top-level object, or null when the file is missing/corrupt. */
  raw: Record<string, unknown> | null;
}

/** The resolved view of one top-level settings key across all scopes. */
export interface ResolvedKey {
  key: string;
  /** The winning (highest-precedence present) value, or undefined when no scope set it. */
  effectiveValue: unknown;
  /** Which scope's value won, or null when no scope sets this key. */
  winner: SettingsScopeName | null;
  /** Per-scope raw value for this key. A scope absent from the map didn't set it. */
  perScope: Partial<Record<SettingsScopeName, unknown>>;
  /** True when more than one scope set this key (so the UI can flag an override). */
  overridden: boolean;
}

/** Full scope-diff result: ordered scopes + per-key resolution. */
export interface ResolvedSettings {
  /** The scopes that were considered, lowest precedence first. */
  scopes: ResolvedScope[];
  /** Every top-level key seen in any scope, resolved. Sorted by key name. */
  keys: ResolvedKey[];
}

/**
 * OS-specific path for enterprise "managed" settings an admin pushes machine-wide.
 * These take precedence over the user's own files. We don't read it on every OS the
 * runtime might run on beyond the three documented locations; an absent file just
 * means "no enterprise policy", which is the common case.
 */
function managedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return path.join(
        process.env.PROGRAMDATA ?? "C:\\ProgramData",
        "ClaudeCode",
        "managed-settings.json",
      );
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

/** The settings file path for each scope. Project/local require a projectCwd. */
function scopeFilePath(scope: SettingsScopeName, projectCwd?: string): string | null {
  switch (scope) {
    case "enterprise":
      return managedSettingsPath();
    case "user":
      return path.join(claudeConfigDir(), "settings.json");
    case "project":
      return projectCwd ? path.join(projectCwd, ".claude", "settings.json") : null;
    case "local":
      return projectCwd ? path.join(projectCwd, ".claude", "settings.local.json") : null;
  }
}

/** Read + JSON.parse a top-level object, tolerating missing/corrupt files. */
async function readObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(file, "utf8");
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Build a per-key scope-diff of Claude Code's settings. For each top-level key seen
 * in ANY scope, reports the winning value + scope and every scope's raw value.
 *
 * Precedence (highest wins): enterprise > local > project > user.
 *
 * `projectCwd` is required to surface the project/local scopes; omit it for a
 * user-vs-enterprise (machine-global) view.
 */
export async function resolveSettings(projectCwd?: string): Promise<ResolvedSettings> {
  // Read each scope's file (skip scopes with no applicable path, e.g. project
  // without a projectCwd).
  const scopes: ResolvedScope[] = [];
  for (const scope of SCOPE_PRECEDENCE) {
    const filePath = scopeFilePath(scope, projectCwd);
    if (filePath === null) continue;
    const raw = await readObject(filePath);
    scopes.push({ scope, filePath, present: raw !== null, raw });
  }

  // Collect the union of top-level keys across present scopes.
  const allKeys = new Set<string>();
  for (const s of scopes) {
    if (s.raw) for (const k of Object.keys(s.raw)) allKeys.add(k);
  }

  // Precedence rank: later in SCOPE_PRECEDENCE => higher rank => wins.
  const rank = new Map<SettingsScopeName, number>();
  SCOPE_PRECEDENCE.forEach((s, i) => rank.set(s, i));

  const keys: ResolvedKey[] = [];
  for (const key of [...allKeys].sort()) {
    const perScope: Partial<Record<SettingsScopeName, unknown>> = {};
    let winner: SettingsScopeName | null = null;
    let winnerRank = -1;
    let effectiveValue: unknown = undefined;
    let setCount = 0;

    for (const s of scopes) {
      if (!s.raw || !Object.prototype.hasOwnProperty.call(s.raw, key)) continue;
      perScope[s.scope] = s.raw[key];
      setCount++;
      const r = rank.get(s.scope) ?? -1;
      if (r >= winnerRank) {
        winnerRank = r;
        winner = s.scope;
        effectiveValue = s.raw[key];
      }
    }

    keys.push({ key, effectiveValue, winner, perScope, overridden: setCount > 1 });
  }

  return { scopes, keys };
}
