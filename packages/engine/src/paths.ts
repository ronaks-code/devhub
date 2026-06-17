import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/** Root of Claude Code's config/data dir. Honors CLAUDE_CONFIG_DIR. */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), ".claude");
}

export function projectsDir(): string {
  return path.join(claudeConfigDir(), "projects");
}

export function liveSessionsDir(): string {
  return path.join(claudeConfigDir(), "sessions");
}

export function historyFile(): string {
  return path.join(claudeConfigDir(), "history.jsonl");
}

/** Where Claude UI keeps its own data (SQLite index, etc.). */
export function appDataDir(): string {
  const override = process.env.CLAUDE_UI_DATA?.trim();
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), ".claude-ui");
}

/**
 * Claude Code's LOSSY folder encoding: every non-alphanumeric char becomes "-".
 * (Existing "-" maps to "-" too, so a single regex reproduces the algorithm.)
 * Only useful for locating a folder from a known cwd — never the reverse.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Stable short id for a project, derived from its true cwd. */
export function projectIdFromCwd(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

/** Display name for a project (last meaningful path segment). */
export function projectName(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
